// emojiRoleService.js
//
// Emoji reaction roles on EXISTING messages, with optional per-role capacity.
//
// - Reacting gives the role; un-reacting takes it away.
// - If the member already has the role, their reaction is simply kept (nothing changes).
// - If an entry has a `limit` and that many members already hold the role, a new reactor's
//   reaction is removed and they do not get the role.
//
// Storage: one object per guild under a `cache:` key (persistent, no expiry):
//   { [messageId]: { guildId, channelId, messageId, createdBy, createdAt,
//                    entries: [{ emoji, display, roleId, limit }] } }
// `entries` keeps the order the admin chose (that is also the order the bot reacts in).

import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { hasDangerousPermissions } from './reactionRoleService.js';

const storageKey = (guildId) => `cache:emoji_roles:${guildId}`;

// guildId -> { [messageId]: config }. Loaded lazily, kept in sync on every write.
const guildCache = new Map();

// roleId -> Set(userId). Roles we just handed out may not be visible in the member cache
// yet (the gateway update arrives a moment later), so they count toward capacity meanwhile.
const pendingGrants = new Map();
const PENDING_TTL_MS = 15_000;

/** Stable key for matching an emoji: custom emoji id, or the unicode char without variation selector. */
export function emojiKey(emoji) {
    if (!emoji) return '';
    if (emoji.id) return String(emoji.id);
    return String(emoji.name ?? '').replace(/️/g, '');
}

/**
 * Parse what an admin typed into an emoji. Returns
 *   { key, display, reactWith } or null if it doesn't look like an emoji.
 */
export function parseEmojiInput(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;

    const custom = raw.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/);
    if (custom) {
        const [, animated, name, id] = custom;
        return {
            key: id,
            display: raw,
            reactWith: `${animated ? 'a:' : ''}${name}:${id}`,
        };
    }

    // One unicode emoji (allows ZWJ sequences, skin tones, flags, keycaps).
    const unicodeEmoji = /^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)$/u;
    if (unicodeEmoji.test(raw)) {
        return {
            key: raw.replace(/️/g, ''),
            display: raw,
            reactWith: raw,
        };
    }

    return null;
}

/** Why a role can't be used, or null if it's fine. */
export function getRoleProblem(guild, role) {
    if (!role) return 'that role no longer exists';
    if (role.id === guild.id) return '@everyone cannot be used';
    if (role.managed) return 'it is managed by an integration/bot and cannot be assigned';
    if (hasDangerousPermissions(role)) {
        return 'it has high-privilege permissions (Administrator, Manage Server/Roles/Channels/Webhooks, Ban or Kick Members)';
    }
    const me = guild.members.me;
    if (!me || role.position >= me.roles.highest.position) {
        return 'it is equal to or above my highest role, so I cannot assign it (move my role higher in Server Settings > Roles)';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function loadGuild(client, guildId) {
    if (guildCache.has(guildId)) return guildCache.get(guildId);
    let data = null;
    try {
        data = await client.db.get(storageKey(guildId));
    } catch (error) {
        logger.error(`Failed to load emoji roles for guild ${guildId}:`, error);
    }
    const configs = data && typeof data === 'object' ? data : {};
    guildCache.set(guildId, configs);
    return configs;
}

async function persistGuild(client, guildId, configs) {
    guildCache.set(guildId, configs);
    await client.db.set(storageKey(guildId), configs);
}

export async function getEmojiRoleConfig(client, guildId, messageId) {
    return (await loadGuild(client, guildId))[messageId] ?? null;
}

export async function listEmojiRoleConfigs(client, guildId) {
    return Object.values(await loadGuild(client, guildId));
}

export async function saveEmojiRoleConfig(client, config) {
    const configs = { ...(await loadGuild(client, config.guildId)) };
    configs[config.messageId] = config;
    await persistGuild(client, config.guildId, configs);
    return config;
}

export async function deleteEmojiRoleConfig(client, guildId, messageId) {
    const existing = await loadGuild(client, guildId);
    if (!existing[messageId]) return false;
    const configs = { ...existing };
    delete configs[messageId];
    await persistGuild(client, guildId, configs);
    return true;
}

// ---------------------------------------------------------------------------
// Capacity helpers
// ---------------------------------------------------------------------------

function noteGrant(roleId, userId) {
    let set = pendingGrants.get(roleId);
    if (!set) {
        set = new Set();
        pendingGrants.set(roleId, set);
    }
    set.add(userId);
    setTimeout(() => {
        set.delete(userId);
        if (set.size === 0 && pendingGrants.get(roleId) === set) pendingGrants.delete(roleId);
    }, PENDING_TTL_MS).unref?.();
}

function noteRevoke(roleId, userId) {
    pendingGrants.get(roleId)?.delete(userId);
}

/**
 * Number of members currently holding the role (plus grants still in flight).
 * If the member list can't be fully loaded this THROWS, so callers treat the role as full
 * instead of trusting a partial count.
 */
export async function countRoleHolders(guild, role) {
    if (guild.members.cache.size < guild.memberCount) {
        await guild.members.fetch();
    }
    const ids = new Set(role.members.keys());
    const pending = pendingGrants.get(role.id);
    if (pending) for (const id of pending) ids.add(id);
    return ids.size;
}

/** Load the full member list at startup for servers that use capped roles, so the first reaction is instant. */
export async function warmCapacityCaches(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const configs = Object.values(await loadGuild(client, guild.id));
            const hasCap = configs.some((c) => c.entries?.some((e) => e.limit));
            if (hasCap && guild.members.cache.size < guild.memberCount) {
                await guild.members.fetch();
                logger.info(`Loaded ${guild.members.cache.size} members for capped emoji roles in guild ${guild.id}`);
            }
        } catch (error) {
            logger.warn(`Could not pre-load members for guild ${guild.id}:`, error.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Reaction handling (called from the raw gateway event)
// ---------------------------------------------------------------------------

async function findEntry(client, data) {
    if (!data?.guild_id || !data.message_id || !data.user_id) return null;
    if (data.user_id === client.user?.id) return null;

    const configs = await loadGuild(client, data.guild_id);
    const config = configs[data.message_id];
    if (!config) return null;

    const key = emojiKey(data.emoji);
    const entry = config.entries.find((e) => e.emoji === key);
    if (!entry) return null;

    const guild = client.guilds.cache.get(data.guild_id);
    if (!guild) return null;

    const member = await guild.members.fetch(data.user_id).catch(() => null);
    if (!member || member.user.bot) return null;

    const role = guild.roles.cache.get(entry.roleId);
    if (!role) {
        logger.warn(`Emoji role ${entry.roleId} no longer exists (message ${data.message_id}, guild ${guild.id})`);
        return null;
    }

    return { config, entry, guild, member, role };
}

/** Remove one user's reaction. Returns true if it was removed. Uses one direct API call for speed. */
async function removeUserReaction(client, data) {
    const emoji = data.emoji?.id
        ? `${data.emoji.name ?? '_'}:${data.emoji.id}`
        : encodeURIComponent(data.emoji?.name ?? '');

    try {
        await client.rest.delete(`/channels/${data.channel_id}/messages/${data.message_id}/reactions/${emoji}/${data.user_id}`);
        return true;
    } catch (directError) {
        logger.warn(`Direct reaction removal failed for user ${data.user_id} on message ${data.message_id}: ${directError.message}; trying fallback`);
    }

    try {
        const channel = client.channels.cache.get(data.channel_id) ?? await client.channels.fetch(data.channel_id);
        const message = await channel.messages.fetch(data.message_id);
        const key = emojiKey(data.emoji);
        const reaction = message.reactions.cache.find((r) => emojiKey(r.emoji) === key);
        if (reaction) await reaction.users.remove(data.user_id);
        return true;
    } catch (error) {
        logger.error(`Could not remove reaction from user ${data.user_id} on message ${data.message_id} (does the bot have Manage Messages there?):`, error.message);
        return false;
    }
}

export async function handleReactionAdd(client, data) {
    const found = await findEntry(client, data);
    if (!found) return;
    const { entry, guild, member, role } = found;

    // Already had the role (e.g. before this system existed): the reaction just stays, no change.
    if (member.roles.cache.has(role.id)) return;

    const problem = getRoleProblem(guild, role);
    if (problem) {
        logger.warn(`Not assigning role ${role.id} in guild ${guild.id}: ${problem}`);
        return;
    }

    await Mutex.runExclusive(`emojirole:${role.id}`, async () => {
        if (member.roles.cache.has(role.id)) return;

        if (entry.limit) {
            // Fail closed: if we can't prove there is room, the role is treated as full.
            let full = true;
            let holders = '?';
            try {
                holders = await countRoleHolders(guild, role);
                full = holders >= entry.limit;
            } catch (error) {
                logger.error(`Could not count holders of role ${role.id} in guild ${guild.id}; treating it as full:`, error.message);
            }
            if (full) {
                logger.info(`Emoji role ${role.name} is full (${holders}/${entry.limit}); removing reaction from ${member.id}`);
                await removeUserReaction(client, data);
                return;
            }
        }

        try {
            await member.roles.add(role, 'Emoji reaction role');
            noteGrant(role.id, member.id);
        } catch (error) {
            logger.error(`Failed to add role ${role.id} to ${member.id} in guild ${guild.id}:`, error);
        }
    });
}

export async function handleReactionRemove(client, data) {
    const found = await findEntry(client, data);
    if (!found) return;
    const { guild, member, role } = found;

    if (!member.roles.cache.has(role.id)) return;

    const problem = getRoleProblem(guild, role);
    if (problem) {
        logger.warn(`Not removing role ${role.id} in guild ${guild.id}: ${problem}`);
        return;
    }

    await Mutex.runExclusive(`emojirole:${role.id}`, async () => {
        try {
            await member.roles.remove(role, 'Emoji reaction role (reaction removed)');
            noteRevoke(role.id, member.id);
        } catch (error) {
            logger.error(`Failed to remove role ${role.id} from ${member.id} in guild ${guild.id}:`, error);
        }
    });
}

/** Called when a message is deleted so its config doesn't linger. */
export async function handleMessageDeleted(client, guildId, messageIds) {
    if (!guildId) return;
    const configs = await loadGuild(client, guildId);
    for (const id of messageIds) {
        if (configs[id]) {
            await deleteEmojiRoleConfig(client, guildId, id);
            logger.info(`Removed emoji role config for deleted message ${id} in guild ${guildId}`);
        }
    }
}

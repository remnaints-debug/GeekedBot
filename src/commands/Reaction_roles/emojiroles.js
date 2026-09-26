import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    parseEmojiInput,
    getRoleProblem,
    countRoleHolders,
    saveEmojiRoleConfig,
    getEmojiRoleConfig,
    listEmojiRoleConfigs,
    deleteEmojiRoleConfig,
} from '../../services/emojiRoleService.js';

const MAX_SLOTS = 6;
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;

function buildData() {
    const builder = new SlashCommandBuilder()
        .setName('emojiroles')
        .setDescription('Emoji reaction roles on an existing message (with optional role capacity)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    builder.addSubcommand((sub) => {
        sub.setName('setup')
            .setDescription('Add emoji reaction roles under an existing message')
            .addStringOption((o) => o.setName('message_link').setDescription('Link to the message (right click > Copy Message Link)').setRequired(true))
            .addStringOption((o) => o.setName('emoji1').setDescription('First emoji (this is also the order they appear in)').setRequired(true))
            .addRoleOption((o) => o.setName('role1').setDescription('Role for the first emoji').setRequired(true))
            .addIntegerOption((o) => o.setName('limit1').setDescription('Max members who can hold this role via this emoji (leave empty = unlimited)').setMinValue(1).setMaxValue(100000));

        const ordinal = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
        for (let i = 2; i <= MAX_SLOTS; i++) {
            sub.addStringOption((o) => o.setName(`emoji${i}`).setDescription(`The ${ordinal[i]} emoji`))
                .addRoleOption((o) => o.setName(`role${i}`).setDescription(`Role for the ${ordinal[i]} emoji`))
                .addIntegerOption((o) => o.setName(`limit${i}`).setDescription('Capacity (leave empty = unlimited)').setMinValue(1).setMaxValue(100000));
        }
        return sub;
    });

    builder.addSubcommand((sub) => sub
        .setName('list')
        .setDescription('Show every emoji role message in this server'));

    builder.addSubcommand((sub) => sub
        .setName('remove')
        .setDescription('Stop managing a message (removes the setup and the bot\'s own reactions)')
        .addStringOption((o) => o.setName('message_link').setDescription('Link to the message').setRequired(true)));

    return builder;
}

function parseMessageLink(interaction, link) {
    const match = String(link ?? '').match(MESSAGE_LINK);
    if (!match) {
        throw createError('Bad message link', ErrorTypes.VALIDATION,
            'That doesn\'t look like a message link. Right-click (or long-press) the message and choose **Copy Message Link**.');
    }
    const [, guildId, channelId, messageId] = match;
    if (guildId !== interaction.guildId) {
        throw createError('Message from another guild', ErrorTypes.VALIDATION, 'That message is in a different server.');
    }
    return { channelId, messageId };
}

async function fetchMessage(interaction, channelId, messageId) {
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
        throw createError('Channel not found', ErrorTypes.VALIDATION, 'I couldn\'t find that channel, or it isn\'t a text channel.');
    }
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
        throw createError('Message not found', ErrorTypes.VALIDATION,
            'I couldn\'t find that message. Check the link and that I can see the channel.');
    }
    return { channel, message };
}

function describeEntry(entry, roleMention, holders = null) {
    const cap = entry.limit
        ? ` — capacity **${entry.limit}**${holders !== null ? ` (${holders}/${entry.limit} taken)` : ''}`
        : ' — unlimited';
    return `${entry.display} → ${roleMention}${cap}`;
}

async function handleSetup(interaction) {
    if (!(await InteractionHelper.safeDefer(interaction))) return;
    const guild = interaction.guild;
    const me = guild.members.me ?? await guild.members.fetchMe();

    const { channelId, messageId } = parseMessageLink(interaction, interaction.options.getString('message_link'));
    const { channel, message } = await fetchMessage(interaction, channelId, messageId);

    // ---- collect the slots, in order ----
    const entries = [];
    const seenEmoji = new Set();
    const seenRoles = new Set();
    for (let i = 1; i <= MAX_SLOTS; i++) {
        const emojiInput = interaction.options.getString(`emoji${i}`);
        const role = interaction.options.getRole(`role${i}`);
        const limit = interaction.options.getInteger(`limit${i}`);

        if (!emojiInput && !role) {
            if (limit) {
                throw createError('Limit without slot', ErrorTypes.VALIDATION, `You set \`limit${i}\` but not \`emoji${i}\` and \`role${i}\`.`);
            }
            continue;
        }
        if (!emojiInput || !role) {
            throw createError('Incomplete slot', ErrorTypes.VALIDATION, `Slot ${i} needs both an \`emoji${i}\` and a \`role${i}\`.`);
        }

        const emoji = parseEmojiInput(emojiInput);
        if (!emoji) {
            throw createError('Bad emoji', ErrorTypes.VALIDATION,
                `\`${emojiInput}\` (slot ${i}) isn't a single emoji. Use a normal emoji, or a custom one from a server I'm in.`);
        }
        if (seenEmoji.has(emoji.key)) {
            throw createError('Duplicate emoji', ErrorTypes.VALIDATION, `${emoji.display} is used more than once.`);
        }
        if (seenRoles.has(role.id)) {
            throw createError('Duplicate role', ErrorTypes.VALIDATION, `${role} is used more than once. Each role can only be on one emoji.`);
        }
        const problem = getRoleProblem(guild, guild.roles.cache.get(role.id) ?? role);
        if (problem) {
            throw createError('Unusable role', ErrorTypes.VALIDATION, `I can't use ${role}: ${problem}.`);
        }

        seenEmoji.add(emoji.key);
        seenRoles.add(role.id);
        entries.push({ emoji: emoji.key, display: emoji.display, reactWith: emoji.reactWith, roleId: role.id, limit: limit ?? null });
    }

    // ---- permission checks ----
    const needsRemoval = entries.some((e) => e.limit);
    const channelPerms = channel.permissionsFor(me);
    const missing = [];
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) missing.push('Manage Roles (server)');
    if (!channelPerms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    if (!channelPerms?.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('Read Message History');
    if (!channelPerms?.has(PermissionFlagsBits.AddReactions)) missing.push('Add Reactions');
    if (needsRemoval && !channelPerms?.has(PermissionFlagsBits.ManageMessages)) missing.push('Manage Messages (needed to remove reactions once a role is full)');
    if (missing.length) {
        throw createError('Missing bot permissions', ErrorTypes.PERMISSION,
            `I'm missing these permissions in ${channel}: ${missing.join(', ')}.`);
    }

    // ---- add the bot's reactions in the chosen order ----
    const added = [];
    try {
        for (const entry of entries) {
            await message.react(entry.reactWith);
            added.push(entry);
        }
    } catch (error) {
        for (const entry of added) {
            await message.reactions.cache
                .find((r) => (r.emoji.id ?? r.emoji.name?.replace(/️/g, '')) === entry.emoji)
                ?.users.remove(interaction.client.user.id).catch(() => {});
        }
        logger.warn('Emoji role setup: failed to add reaction:', error.message);
        throw createError('Reaction failed', ErrorTypes.VALIDATION,
            'I couldn\'t add one of those emojis to the message. If it\'s a custom emoji, I must share a server with it.');
    }

    const replaced = Boolean(await getEmojiRoleConfig(interaction.client, guild.id, messageId));
    await saveEmojiRoleConfig(interaction.client, {
        guildId: guild.id,
        channelId,
        messageId,
        createdBy: interaction.user.id,
        createdAt: new Date().toISOString(),
        entries: entries.map(({ emoji, display, roleId, limit }) => ({ emoji, display, roleId, limit })),
    });

    logger.info(`Emoji roles ${replaced ? 'replaced' : 'set up'} on message ${messageId} in guild ${guild.id} by ${interaction.user.tag}`);

    const lines = entries.map((e) => describeEntry(e, `<@&${e.roleId}>`));
    const embed = successEmbed(
        replaced ? 'Emoji roles updated' : 'Emoji roles set up',
        `${message.url}\n\n${lines.join('\n')}\n\n` +
        'Reacting gives the role, un-reacting removes it. If someone already has the role, their reaction is just added. ' +
        'When a role with a capacity is full, new reactions are removed.\n' +
        '-# Reactions made before this setup, or while the bot was offline, are not counted. Emoji already on the message keep their existing order.'
    );
    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}

async function handleList(interaction) {
    if (!(await InteractionHelper.safeDefer(interaction))) return;
    const configs = await listEmojiRoleConfigs(interaction.client, interaction.guildId);

    if (!configs.length) {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [infoEmbed('Emoji roles', 'Nothing set up yet. Use `/emojiroles setup` with a message link.')],
        });
    }

    const blocks = [];
    for (const config of configs.slice(0, 10)) {
        const lines = [];
        for (const entry of config.entries) {
            const role = interaction.guild.roles.cache.get(entry.roleId);
            const holders = entry.limit && role ? await countRoleHolders(interaction.guild, role) : null;
            lines.push(describeEntry(entry, role ? `${role}` : '*(deleted role)*', holders));
        }
        blocks.push(`https://discord.com/channels/${config.guildId}/${config.channelId}/${config.messageId}\n${lines.join('\n')}`);
    }
    const extra = configs.length > 10 ? `\n\n…and ${configs.length - 10} more.` : '';
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [infoEmbed('Emoji roles', blocks.join('\n\n') + extra)],
    });
}

async function handleRemove(interaction) {
    if (!(await InteractionHelper.safeDefer(interaction))) return;
    const { channelId, messageId } = parseMessageLink(interaction, interaction.options.getString('message_link'));

    const removed = await deleteEmojiRoleConfig(interaction.client, interaction.guildId, messageId);
    if (!removed) {
        throw createError('Not configured', ErrorTypes.VALIDATION, 'That message doesn\'t have emoji roles set up.');
    }

    // Best effort: take the bot's own reactions off the message.
    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        for (const reaction of message.reactions.cache.values()) {
            if (reaction.me) await reaction.users.remove(interaction.client.user.id).catch(() => {});
        }
    } catch {
        // message or channel may be gone; the setup is already removed
    }

    logger.info(`Emoji roles removed from message ${messageId} in guild ${interaction.guildId} by ${interaction.user.tag}`);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Emoji roles removed', 'That message is no longer managed. Members keep the roles they already have.')],
    });
}

export default {
    data: buildData(),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'setup') return handleSetup(interaction);
        if (subcommand === 'list') return handleList(interaction);
        if (subcommand === 'remove') return handleRemove(interaction);
    },
};

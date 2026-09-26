import { Events } from 'discord.js';
import {
    handleReactionAdd,
    handleReactionRemove,
    handleMessageDeleted,
} from '../services/emojiRoleService.js';

// Reaction events are read straight from the gateway so they work on ANY message,
// including old ones that are not in the bot's cache (no partials needed).
export default {
    name: Events.Raw,
    once: false,

    async execute(packet, shardId, client) {
        switch (packet?.t) {
            case 'MESSAGE_REACTION_ADD':
                await handleReactionAdd(client, packet.d);
                break;
            case 'MESSAGE_REACTION_REMOVE':
                await handleReactionRemove(client, packet.d);
                break;
            case 'MESSAGE_DELETE':
                await handleMessageDeleted(client, packet.d?.guild_id, [packet.d?.id]);
                break;
            case 'MESSAGE_DELETE_BULK':
                await handleMessageDeleted(client, packet.d?.guild_id, packet.d?.ids ?? []);
                break;
            default:
                break;
        }
    },
};

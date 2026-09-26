import { Events } from 'discord.js';
import { warmCapacityCaches } from '../services/emojiRoleService.js';

// Pre-loads the member list for servers that use capped emoji roles so the first
// "role is full" check is instant instead of waiting on a big member download.
export default {
    name: Events.ClientReady,
    once: true,

    async execute(client) {
        await warmCapacityCaches(client);
    },
};

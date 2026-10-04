const { EmbedBuilder } = require('discord.js');

// Public prose goes in embeds. Only explicit notification recipients stay in
// content, since mentions inside an embed do not trigger Discord notifications.
function publicMessage(description, { title = 'ℹ️ Shop Update', color = 0x5865F2,
    users = [], roles = [], ...options } = {}) {
    return {
        ...options,
        content: [...users.map(id => `<@${id}>`), ...roles.map(id => `<@&${id}>`)].join(' ') || null,
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)],
        allowedMentions: { parse: [], users, roles }
    };
}

module.exports = { publicMessage };

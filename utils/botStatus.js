const { ActivityType } = require('discord.js');

function updateBotStatus(botClient, text, temporaryMs = 15000) {
    if (!botClient || !botClient.user) return;
    botClient.user.setActivity(text, { type: ActivityType.Custom });

    if (temporaryMs > 0) {
        setTimeout(() => {
            botClient.user.setActivity('🛒 Stocked Store Operations', { type: ActivityType.Watching });
        }, temporaryMs);
    }
}

module.exports = { updateBotStatus };
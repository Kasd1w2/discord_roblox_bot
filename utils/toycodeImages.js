const TOYCODE_EMOJI = '<:toycode:1556793052469657721>';
const TOYCODE_COLOR = 0xF59E0B;

// Discord attachment links expire. Fetch the source message to get a current
// signed URL whenever a catalog page or checkout is rendered.
async function resolveToycodeImage(botClient, item) {
    if (!item?.imageChannelId || !item.imageMessageId) return null;
    try {
        const channel = await botClient.channels.fetch(item.imageChannelId);
        if (!channel || channel.guildId !== item.guildId) return null;
        const message = await channel.messages.fetch({ message: item.imageMessageId, force: true });
        return message.attachments.get(item.imageAttachmentId)?.url || null;
    } catch {
        // Keep the item browsable if staff delete its image; do not display a
        // broken or expired URL. Restocking with a fresh image restores it.
        return null;
    }
}

module.exports = { TOYCODE_EMOJI, TOYCODE_COLOR, resolveToycodeImage };

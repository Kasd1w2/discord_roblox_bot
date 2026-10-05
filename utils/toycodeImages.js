const TOYCODE_EMOJI = '<:toycode:1556793052469657721>';
const TOYCODE_COLOR = 0xF59E0B;

function publicImageUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

// Files referenced by embeds can be absent from message.attachments. Keep the
// source message as before, and use "embed" for images returned in its embed.
function savedToycodeImage(message, { attachmentId, filename } = {}) {
    const attachments = [...(message.attachments?.values?.() || [])];
    const file = attachmentId && attachmentId !== 'embed' ? message.attachments?.get?.(attachmentId) || attachments.find(item => String(item.id) === attachmentId) :
        attachments.find(item => filename && (item.name || item.filename) === filename) ||
        (attachments.length === 1 ? attachments[0] : null);
    const fileUrl = publicImageUrl(file?.url);
    const fileId = file?.id ?? (attachmentId && attachmentId !== 'embed' ? attachmentId : null);
    if (fileId != null && fileUrl) return { id: String(fileId), url: fileUrl };
    for (const embed of message.embeds || []) {
        const image = embed.image || embed.data?.image || embed.toJSON?.().image;
        for (const value of [image?.url, image?.proxyURL, image?.proxy_url]) {
            const url = publicImageUrl(value);
            if (url) return { id: 'embed', url };
        }
    }
    return null;
}

// Discord attachment links expire. Fetch the source message to get a current
// signed URL whenever a catalog page or checkout is rendered.
async function resolveToycodeImage(botClient, item) {
    if (!item?.imageChannelId || !item.imageMessageId) return null;
    try {
        const channel = await botClient.channels.fetch(item.imageChannelId);
        if (!channel || channel.guildId !== item.guildId) return null;
        const message = await channel.messages.fetch({ message: item.imageMessageId, force: true });
        return savedToycodeImage(message, { attachmentId: item.imageAttachmentId })?.url || null;
    } catch {
        // Keep the item browsable if staff delete its image; do not display a
        // broken or expired URL. Restocking with a fresh image restores it.
        return null;
    }
}

module.exports = { TOYCODE_EMOJI, TOYCODE_COLOR, resolveToycodeImage, savedToycodeImage };

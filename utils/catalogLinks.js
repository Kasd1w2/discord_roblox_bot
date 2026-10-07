function parseUrl(value, hosts) {
    if (typeof value !== 'string') return null;
    let url;
    const input = value.trim();
    try { url = new URL(/^(?:www\.)?roblox\.com(?:\/|$)/i.test(input) ? `https://${input}` : input); } catch { return null; }
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password ||
        url.port || url.href.length > 2000) return null;
    return url;
}

function robloxUrl(value) {
    return parseUrl(value, ['roblox.com', 'www.roblox.com'])?.href || null;
}

function savedRobloxUrl(value) {
    // Rolimons item IDs are Roblox asset IDs. Resolve links saved by the previous
    // version to Roblox without rewriting listings or uploading their images again.
    const current = robloxUrl(value);
    if (current) return current;
    const legacy = parseUrl(value, ['rolimons.com', 'www.rolimons.com']);
    const itemId = legacy?.pathname.match(/^\/item\/(\d+)\/?$/)?.[1];
    return itemId ? `https://www.roblox.com/catalog/${itemId}` : null;
}

module.exports = { robloxUrl, savedRobloxUrl };

function itemUrl(value, hosts, path) {
    if (typeof value !== 'string') return null;
    let url;
    try { url = new URL(value.trim()); } catch { return null; }
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password ||
        url.port || url.href.length > 2000) return null;
    const match = url.pathname.match(path);
    return match ? `https://www.roblox.com/catalog/${match[1]}` : null;
}

function robloxCatalogUrl(value) {
    return itemUrl(value, ['roblox.com', 'www.roblox.com'], /^\/catalog\/(\d+)(?:\/[^/]+)?\/?$/);
}

function savedRobloxCatalogUrl(value) {
    // Rolimons item IDs are Roblox asset IDs. Resolve links saved by the previous
    // version to Roblox without rewriting listings or uploading their images again.
    return robloxCatalogUrl(value) || itemUrl(value, ['rolimons.com', 'www.rolimons.com'], /^\/item\/(\d+)\/?$/);
}

module.exports = { robloxCatalogUrl, savedRobloxCatalogUrl };

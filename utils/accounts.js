const TIERS = {
    high_tier: { label: '🔥 High Tier', categories: ['3d', 'real_words'] },
    mid_tier: { label: '⚡ Mid Tier', categories: ['3l', '4d', 'clean_compounds'] },
    low_tier: { label: '🌱 Low Tier', categories: ['triple', '4l', 'edgy', 'finance', 'leetspeak', 'other'] }
};
const CATEGORY_NAMES = {
    '3d': '3 Digits', real_words: 'Real Words', '3l': '3 Letters', '4d': '4 Digits',
    clean_compounds: 'Clean Compounds', triple: 'Triple Numbers', '4l': '4 Letters', edgy: 'Edgy Compounds',
    finance: 'Finance Compounds', leetspeak: 'Leetspeak', other: 'Other'
};
const ALIASES = { cat_rare_words: 'real_words', cat_4_letters: '4l', cat_5_digits: 'other' };

function normalizeAccountCategory(value) {
    const key = String(value || '').trim().toLowerCase();
    const category = ALIASES[key] || key;
    return Object.hasOwn(CATEGORY_NAMES, category) ? category : null;
}

function parseAccountEntry(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    const first = raw.indexOf(':');
    const last = raw.lastIndexOf(':');
    if (first < 1 || last <= first) return null;
    const username = raw.slice(0, first).trim().replace(/^@/, '');
    const password = raw.slice(first + 1, last);
    const price = raw.slice(last + 1).trim().replace(/^\$/, '');
    if (!/^[A-Za-z0-9_]{1,32}$/.test(username) || !password.trim() || /[\r\n]/.test(password) ||
        !/^\d+(?:\.\d{1,2})?$/.test(price)) return null;
    const [whole, fraction = ''] = price.split('.');
    const priceCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(priceCents) || priceCents < 1) return null;
    const priceLabel = `$${(priceCents / 100).toFixed(2)}`;
    return { username, password, priceCents, displayLabel: `@${username} — ${priceLabel}`,
        code: `${username}:${password}:${(priceCents / 100).toFixed(2)}` };
}

function parseAccountRestock(input) {
    const lines = String(input || '').split(/\r?\n/);
    const accounts = [];
    const usernames = new Set();
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        const account = parseAccountEntry(lines[index]);
        if (!account) throw new Error(`Line ${index + 1}: use username:password:price with a positive USD price (up to two decimals). Put each account on its own line.`);
        const key = account.username.toLowerCase();
        if (usernames.has(key)) throw new Error(`Line ${index + 1}: @${account.username} appears more than once.`);
        usernames.add(key); accounts.push(account);
    }
    if (!accounts.length) throw new Error('Enter at least one account as username:password:price.');
    return accounts;
}

// These objects are safe to serialize into embeds, option labels, and IDs.
// Credentials remain only in the saved inventory entries and private history.
function accountListings(codes = []) {
    const seen = new Set();
    const listings = [];
    for (const code of codes) {
        const account = parseAccountEntry(code);
        if (!account || seen.has(account.username.toLowerCase())) continue;
        seen.add(account.username.toLowerCase());
        const { username, priceCents, displayLabel } = account;
        listings.push({ username, priceCents, displayLabel });
    }
    return listings.sort((a, b) => a.priceCents - b.priceCents || a.username.localeCompare(b.username));
}

module.exports = { TIERS, CATEGORY_NAMES, normalizeAccountCategory, parseAccountEntry, parseAccountRestock, accountListings };

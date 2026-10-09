const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOrderStore, OrderError } = require('../utils/orderStore');
const { createToycodeCatalog, PAGE_SIZE } = require('../utils/toycodeCatalog');

const GUILD = 'shop-server';
const LINK = 'https://www.roblox.com/catalog/123456789';
const OTHER_LINK = 'https://www.roblox.com/catalog/987654321';
const listing = () => ({ guildId: GUILD, itemId: 'golden_horns', title: 'Golden Horns', priceCents: 25000,
    active: true, imageUrl: 'https://example.com/horns.png', imageChannelId: 'images',
    imageMessageId: 'original-image', imageAttachmentId: 'attachment', createdAt: new Date('2026-01-01') });

// Exercise the store's actual reads and updates without requiring live MongoDB credentials.
function databaseFixture(items = [listing()]) {
    let documents = { shop_toycode_items: structuredClone(items),
        inventory: [{ itemId: 'golden_horns', codes: ['PRIVATE-ORIGINAL'] }] };
    const matches = (document, filter) => Object.entries(filter).every(([key, value]) => document[key] === value);
    const collection = name => ({
        async findOne(filter) {
            return structuredClone((documents[name] || []).find(document => matches(document, filter)) || null);
        },
        find(filter) { return { toArray: async () => structuredClone((documents[name] || []).filter(document => matches(document, filter))) }; },
        async updateOne(filter, update, options = {}) {
            const records = documents[name] ||= [];
            let document = records.find(record => matches(record, filter));
            if (!document) {
                if (!options.upsert) return { matchedCount: 0 };
                document = { ...filter, ...structuredClone(update.$setOnInsert || {}) };
                records.push(document);
            }
            Object.assign(document, structuredClone(update.$set || {}));
            for (const [key, value] of Object.entries(update.$inc || {})) document[key] = (document[key] || 0) + value;
            return { matchedCount: 1 };
        }
    });
    const connection = {
        db: { collection },
        async startSession() {
            return {
                async withTransaction(work) {
                    const before = structuredClone(documents);
                    try { await work(); } catch (error) { documents = before; throw error; }
                },
                async endSession() {}
            };
        }
    };
    return { store: createOrderStore({ connection, Ledger: { collection: collection('ledger') },
        Inventory: { collection: collection('inventory') } }), snapshot: () => structuredClone(documents) };
}

function catalogFixture(store, overrides = {}) {
    const uploads = [];
    const downloaded = [];
    const imagePost = { id: 'new-image', attachments: new Map([['new-attachment',
        { id: 'new-attachment', name: 'product.png', url: 'https://cdn.discordapp.com/new.png' }]]) };
    const channel = { id: 'images', guildId: GUILD, isTextBased: () => true,
        send: async payload => { uploads.push(payload); return imagePost; },
        messages: { fetch: async () => ({ attachments: new Map([['attachment',
            { id: 'attachment', url: 'https://cdn.discordapp.com/original.png' }]]) }) } };
    const catalog = createToycodeCatalog({ store, adminRoleId: 'staff', imageChannelId: null,
        botClient: { channels: { fetch: async () => channel } },
        downloadImage: async url => { downloaded.push(url); return { name: 'product.png' }; },
        createTicket: async () => {}, ...overrides });
    return { catalog, channel, uploads, downloaded };
}

function restockInteraction(channel, values) {
    return { guildId: GUILD, channel, options: {
        getString: name => values[name] ?? null, getNumber: name => values[name] ?? null
    }, editReply: async () => {} };
}

async function openBrowser(catalog) {
    let payload;
    const interaction = { guildId: GUILD, user: { id: 'buyer' }, customId: 'toy_browse',
        inGuild: () => true, isChatInputCommand: () => false, isButton: () => true,
        deferReply: async () => {}, editReply: async next => { payload = next; } };
    await catalog.handleInteraction(interaction);
    return { payload, interaction };
}

function cardContent(payload) {
    return payload.embeds[0].description;
}

test('restock registers an optional Roblox link', () => {
    const command = require('../commands/commandDefinitions').find(command => command.name === 'restock').toJSON();
    const option = command.options.find(option => option.name === 'catalog_url');
    assert.equal(option.type, 3);
    assert.equal(option.required, false);
});

test('new listings save a validated link and preserve private stock', async () => {
    const db = databaseFixture([]);
    const { catalog, channel, uploads } = catalogFixture(db.store);
    const result = await catalog.restock(restockInteraction(channel, {
        item_id: 'golden_horns', title: 'Golden Horns', price: 250,
        image_url: 'https://example.com/horns.png', catalog_url: LINK, codes: 'PRIVATE-NEW'
    }));
    assert.equal(result.item.catalogUrl, LINK);
    assert.equal(result.item.imageMessageId, 'new-image');
    assert.equal(result.added, 1);
    assert.deepEqual(db.snapshot().inventory[0].codes, ['PRIVATE-ORIGINAL', 'PRIVATE-NEW']);
    assert.match(uploads[0].embeds[0].toJSON().description, /\*\*\$250\.00 USD\*\*\n\[View on Roblox\]/);
    assert(!JSON.stringify(uploads).includes('PRIVATE-'));
});

test('link-only restock updates by ID without uploads or changing existing listing data', async () => {
    const db = databaseFixture();
    const before = await db.store.getToycode(GUILD, 'golden_horns');
    const { catalog, channel, uploads, downloaded } = catalogFixture(db.store);
    const result = await catalog.restock(restockInteraction(channel, { item_id: ' golden_horns ', catalog_url: LINK }));
    const { catalogUrl, updatedAt, ...unchanged } = result.item;
    assert.equal(catalogUrl, LINK);
    assert(updatedAt instanceof Date);
    assert.deepEqual(unchanged, before);
    assert.deepEqual(db.snapshot().inventory[0].codes, ['PRIVATE-ORIGINAL']);
    assert.equal(db.snapshot().shop_toycode_items.length, 1);
    assert.equal(uploads.length, 0);
    assert.equal(downloaded.length, 0);
});

test('link updates can add codes without replacing existing stock', async () => {
    const db = databaseFixture();
    const { catalog, channel } = catalogFixture(db.store);
    const result = await catalog.restock(restockInteraction(channel, {
        item_id: 'golden_horns', catalog_url: LINK, codes: 'NEW-1, NEW-2\nNEW-3'
    }));
    assert.equal(result.added, 3);
    assert.deepEqual(db.snapshot().inventory[0].codes, ['PRIVATE-ORIGINAL', 'NEW-1', 'NEW-2', 'NEW-3']);
});

test('omitting catalog_url in a full restock preserves the existing link', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog, channel } = catalogFixture(db.store);
    const result = await catalog.restock(restockInteraction(channel, {
        item_id: 'golden_horns', title: 'Golden Horns Updated', price: 275, image_url: 'https://example.com/new.png'
    }));
    assert.equal(result.item.catalogUrl, LINK);
    assert.equal(result.item.title, 'Golden Horns Updated');
    assert.equal(result.item.priceCents, 27500);
});

test('a full restock can replace the link', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog, channel } = catalogFixture(db.store);
    const result = await catalog.restock(restockInteraction(channel, {
        item_id: 'golden_horns', title: 'Golden Horns', price: 250,
        image_url: 'https://example.com/horns.png', catalog_url: OTHER_LINK
    }));
    assert.equal(result.item.catalogUrl, OTHER_LINK);
});

test('unknown, other-server and inactive IDs cannot create or modify a listing', async () => {
    const db = databaseFixture([listing(), { ...listing(), itemId: 'inactive', active: false }]);
    const before = db.snapshot();
    for (const input of [{ guildId: GUILD, itemId: 'unknown' }, { guildId: 'other-server', itemId: 'golden_horns' },
        { guildId: GUILD, itemId: 'inactive' }]) {
        await assert.rejects(db.store.updateToycodeCatalogUrl({ ...input, catalogUrl: LINK }, ['NEW']), /No toycode listing found/);
        assert.deepEqual(db.snapshot(), before);
    }
});

test('link-only updates require a stock ID', async () => {
    const db = databaseFixture();
    const { catalog, channel, uploads } = catalogFixture(db.store);
    await assert.rejects(catalog.restock(restockInteraction(channel, { catalog_url: LINK })), /Provide item_id/);
    assert.equal(uploads.length, 0);
    assert.equal((await db.store.getToycode(GUILD, 'golden_horns')).catalogUrl, undefined);
});

test('partial listing changes return a clear error instead of silently discarding fields', async () => {
    const db = databaseFixture();
    const { catalog, channel, downloaded } = catalogFixture(db.store);
    await assert.rejects(catalog.restock(restockInteraction(channel, {
        item_id: 'golden_horns', price: 300, catalog_url: LINK
    })), /provide all three/);
    assert.equal(downloaded.length, 0);
    assert.equal((await db.store.getToycode(GUILD, 'golden_horns')).priceCents, 25000);
});

test('invalid Roblox links are rejected before changing stock or uploading an image', async () => {
    const db = databaseFixture();
    const before = db.snapshot();
    const { catalog, channel, downloaded } = catalogFixture(db.store);
    for (const catalog_url of ['not a url', 'javascript:alert(1)', 'http://www.roblox.com/catalog/123',
        'https://roblox.com.evil.example/catalog/123', 'https://evil.example/catalog/123',
        'https://user:password@www.roblox.com/catalog/123', 'https://www.roblox.com:8443/catalog/123',
        'https://www.rolimons.com/item/123456789']) {
        for (const metadata of [{}, { title: 'Golden Horns', price: 250, image_url: 'https://example.com/horns.png' }]) {
            await assert.rejects(catalog.restock(restockInteraction(channel, {
                item_id: 'golden_horns', catalog_url, codes: 'NEW', ...metadata
            })), error => error instanceof OrderError && /Roblox link/.test(error.message));
        }
    }
    assert.deepEqual(db.snapshot(), before);
    assert.equal(downloaded.length, 0);
});

test('links retain their query and fragment and render safely in clickable Markdown', async () => {
    const db = databaseFixture();
    const link = 'https://www.roblox.com/catalog/123456789?tracking=hello(world)#details';
    const result = await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns',
        catalogUrl: ` ${link} ` });
    assert.equal(result.item.catalogUrl, link);
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert(cardContent(payload).includes('[View on Roblox](https://www.roblox.com/catalog/123456789?tracking=hello%28world%29#details)'));
});

test('Roblox links preserve the provided host and path, including non-catalog pages', async () => {
    const db = databaseFixture();
    for (const catalogUrl of ['https://www.roblox.com/catalog/123456789/Golden-Horns',
        'https://roblox.com/catalog/123456789/',
        'https://www.roblox.com/users/123/profile', 'https://www.roblox.com/share?code=abc&type=AvatarItemDetails',
        'https://www.roblox.com/catalog/123456789/Golden-Horns-(Accessory)?tracking=1#details']) {
        const result = await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns', catalogUrl });
        assert.equal(result.item.catalogUrl, catalogUrl);
    }
});

test('root Roblox links work in new listings and stock-ID updates without adding catalog', async () => {
    const db = databaseFixture();
    const { catalog, channel } = catalogFixture(db.store);
    for (const [input, expected] of [['https://roblox.com/', 'https://roblox.com/'],
        ['https://www.roblox.com/', 'https://www.roblox.com/'], ['roblox.com/', 'https://roblox.com/']]) {
        const result = await catalog.restock(restockInteraction(channel, { item_id: 'golden_horns', catalog_url: input }));
        assert.equal(result.item.catalogUrl, expected);
        const { payload } = await openBrowser(catalog);
        assert(cardContent(payload).includes(`[View on Roblox](${expected})`));
        assert(!cardContent(payload).includes('/catalog'));
    }
    const result = await catalog.restock(restockInteraction(channel, {
        item_id: 'new_item', title: 'New Item', price: 100, image_url: 'https://example.com/item.png', catalog_url: 'https://roblox.com/'
    }));
    assert.equal(result.item.catalogUrl, 'https://roblox.com/');
});

test('previously saved Rolimons item links display as Roblox links without rewriting listings', async () => {
    const legacyLink = 'https://www.rolimons.com/item/123456789';
    const db = databaseFixture([{ ...listing(), catalogUrl: legacyLink }]);
    const before = db.snapshot();
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert(cardContent(payload).includes(`**$250.00 USD**\n[View on Roblox](${LINK})`));
    assert(!JSON.stringify(payload).includes('rolimons.com'));
    assert.deepEqual(db.snapshot(), before);
});

test('unsupported saved links are not labeled as Roblox links', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: 'https://evil.example/item/123456789' }]);
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert(!cardContent(payload).includes('View on Roblox'));
    assert(!JSON.stringify(payload).includes('evil.example'));
});

test('browsing shows the clickable link directly below the price and retains the image and Buy button', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert(cardContent(payload).includes(`**$250.00 USD**\n[View on Roblox](${LINK})`));
    assert.equal(payload.embeds[0].thumbnail.url, 'https://cdn.discordapp.com/original.png');
    assert.equal(payload.components[0].components[0].label, 'Buy 1: Golden Horns');
    assert(!JSON.stringify(payload).includes('PRIVATE-ORIGINAL'));
});

test('old listings without links still render, and refresh picks up an ID-based update', async () => {
    const db = databaseFixture();
    const { catalog } = catalogFixture(db.store);
    const { payload, interaction } = await openBrowser(catalog);
    assert(!cardContent(payload).includes('Roblox'));
    await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns', catalogUrl: LINK });
    const refresh = payload.components.at(-1).components.find(component => component.label === 'Refresh');
    let refreshed;
    await catalog.handleInteraction({ ...interaction, customId: refresh.custom_id,
        deferUpdate: async () => {}, editReply: async next => { refreshed = next; } });
    assert(cardContent(refreshed).includes(`[View on Roblox](${LINK})`));
    await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns', catalogUrl: OTHER_LINK });
    await catalog.handleInteraction({ ...interaction, customId: refresh.custom_id,
        deferUpdate: async () => {}, editReply: async next => { refreshed = next; } });
    assert(cardContent(refreshed).includes(`[View on Roblox](${OTHER_LINK})`));
    assert(!cardContent(refreshed).includes(LINK));
});

test('a listing remains clickable even if its image source is unavailable', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog } = catalogFixture(db.store, { botClient: { channels: { fetch: async () => { throw new Error('Missing image'); } } } });
    const { payload } = await openBrowser(catalog);
    assert.equal(payload.embeds[0].thumbnail, undefined);
    assert(cardContent(payload).includes(`[View on Roblox](${LINK})`));
});

function pageItems(count, overrides = {}) {
    return Array.from({ length: count }, (_, index) => ({ ...listing(), itemId: `item_${index + 1}`,
        title: `Item ${String(index + 1).padStart(2, '0')}`, priceCents: (index + 1) * 100, catalogUrl: LINK, ...overrides }));
}

function buyButtons(payload) {
    return payload.components.flatMap(row => row.components).filter(component => component.style === 3);
}

async function press(catalog, interaction, component, extra = {}) {
    let payload;
    await catalog.handleInteraction({ ...interaction, customId: component.custom_id, deferUpdate: async () => {},
        editReply: async next => { payload = next; }, ...extra });
    return payload;
}

function control(payload, label) {
    return payload.components.at(-1).components.find(component => component.label === label);
}

test('a full page shows ten pictured items with links and ten matching Buy buttons within Discord limits', async () => {
    const db = databaseFixture(pageItems(23));
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert.equal(PAGE_SIZE, 10);
    assert.equal(payload.embeds.length, 10);
    assert.equal(buyButtons(payload).length, 10);
    assert.equal(payload.components.length, 5);
    assert.equal(payload.flags & (1 << 15), 0);
    assert.match(payload.content, /Page 1 of 3/);
    assert.equal(control(payload, 'Previous').disabled, true);
    assert.equal(control(payload, 'Next').disabled, false);
    for (const [index, embed] of payload.embeds.entries()) {
        assert(embed.title.includes(`${index + 1}.`));
        assert(embed.title.includes(`Item ${String(index + 1).padStart(2, '0')}`));
        assert.equal(embed.thumbnail.url, 'https://cdn.discordapp.com/original.png');
        assert(embed.description.includes(`[View on Roblox](${LINK})`));
        assert.equal(embed.url, undefined);
        assert.equal(buyButtons(payload)[index].label, `Buy ${index + 1}: Item ${String(index + 1).padStart(2, '0')}`);
        assert(buyButtons(payload)[index].custom_id.endsWith(`|buy|item_${index + 1}`));
    }
    for (const row of payload.components) {
        assert(row.components.length <= 5);
        if (row.components.some(component => component.type === 3)) assert.equal(row.components.length, 1);
    }
});

test('ten-item pagination handles the last page, previous page, and stale Buy quotes', async () => {
    const db = databaseFixture(pageItems(23));
    const tickets = [];
    const { catalog } = catalogFixture(db.store, { createTicket: async (_, item) => { tickets.push(item); } });
    const { payload: first, interaction } = await openBrowser(catalog);
    const second = await press(catalog, interaction, control(first, 'Next'));
    assert.equal(second.embeds.length, 10);
    assert.match(second.content, /Page 2 of 3/);
    assert(buyButtons(second)[0].custom_id.endsWith('|buy|item_11'));
    await assert.rejects(press(catalog, interaction, buyButtons(first)[0]), /page changed/);
    const last = await press(catalog, interaction, control(second, 'Next'));
    assert.equal(last.embeds.length, 3);
    assert.equal(buyButtons(last).length, 3);
    assert.match(last.content, /Page 3 of 3/);
    assert.equal(control(last, 'Next').disabled, true);
    await press(catalog, interaction, buyButtons(last)[2]);
    assert.deepEqual(tickets, [{ itemId: 'item_23', title: 'Item 23', priceCents: 2300 }]);
    const previous = await press(catalog, interaction, control(last, 'Previous'));
    assert.equal(previous.embeds.length, 10);
    assert.match(previous.content, /Page 2 of 3/);
});

test('price sorting, filtering, search, and reset still work on ten-item pages', async () => {
    const db = databaseFixture(pageItems(23));
    const { catalog } = catalogFixture(db.store);
    const { payload, interaction } = await openBrowser(catalog);
    const sort = payload.components.flatMap(row => row.components).find(component => component.placeholder === 'Sort by price');
    const descending = await press(catalog, interaction, sort, { isButton: () => false,
        isStringSelectMenu: () => true, values: ['desc'] });
    assert(buyButtons(descending)[0].custom_id.endsWith('|buy|item_23'));
    const range = descending.components.flatMap(row => row.components).find(component => component.placeholder === 'Choose a price range');
    const empty = await press(catalog, interaction, range, { isButton: () => false,
        isStringSelectMenu: () => true, values: ['1000plus'] });
    assert.equal(empty.embeds.length, 0);
    assert.equal(buyButtons(empty).length, 0);
    assert.match(empty.content, /No matching items/);
    assert.equal(control(empty, 'Next').disabled, true);
    const reset = await press(catalog, interaction, control(empty, 'Reset Filters'));
    let modal;
    await press(catalog, interaction, control(reset, 'Search'), { showModal: async next => { modal = next.toJSON(); } });
    const search = await press(catalog, interaction, { custom_id: modal.custom_id }, { isButton: () => false,
        isStringSelectMenu: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => 'Item 23' } });
    assert.equal(search.embeds.length, 1);
    assert(buyButtons(search)[0].custom_id.endsWith('|buy|item_23'));
});

test('long Roblox links remain clickable without exceeding the shared embed text limit', async () => {
    for (const longLink of [`https://roblox.com/?value=${'x'.repeat(1700)}`,
        `https://roblox.com/?value=${'('.repeat(900)}${')'.repeat(900)}`]) {
        const db = databaseFixture(pageItems(10, { catalogUrl: longLink }));
        const { catalog } = catalogFixture(db.store);
        const { payload } = await openBrowser(catalog);
        const total = payload.embeds.reduce((length, embed) => length + embed.title.length + embed.description.length +
            (embed.author?.name.length || 0) + (embed.footer?.text.length || 0), 0);
        assert.equal(payload.embeds.length, 10);
        assert(total <= 6000);
        for (const embed of payload.embeds) {
            assert.equal(embed.author.name, 'View on Roblox');
            assert.equal(embed.author.url, longLink);
            assert.equal(embed.url, undefined);
            assert(embed.description.length <= 4096);
        }
    }
});

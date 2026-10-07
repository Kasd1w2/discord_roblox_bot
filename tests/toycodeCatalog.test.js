const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOrderStore, OrderError } = require('../utils/orderStore');
const { createToycodeCatalog } = require('../utils/toycodeCatalog');

const GUILD = 'shop-server';
const LINK = 'https://www.rolimons.com/item/123456789';
const OTHER_LINK = 'https://rolimons.com/item/987654321';
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
    const card = payload.components[1].components[0];
    return card.type === 9 ? card.components[0].content : card.content;
}

test('restock registers an optional Rolimons link', () => {
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
    assert.match(uploads[0].embeds[0].toJSON().description, /\*\*\$250\.00 USD\*\*\n\[View on Rolimons\]/);
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

test('invalid Rolimons links are rejected before changing stock or uploading an image', async () => {
    const db = databaseFixture();
    const before = db.snapshot();
    const { catalog, channel, downloaded } = catalogFixture(db.store);
    for (const catalog_url of ['not a url', 'javascript:alert(1)', 'http://www.rolimons.com/item/123',
        'https://rolimons.com.evil.example/item/123', 'https://evil.example/item/123',
        'https://user:password@www.rolimons.com/item/123', 'https://www.rolimons.com:8443/item/123',
        'https://www.rolimons.com/player/123', 'https://www.rolimons.com/item/not-an-id']) {
        for (const metadata of [{}, { title: 'Golden Horns', price: 250, image_url: 'https://example.com/horns.png' }]) {
            await assert.rejects(catalog.restock(restockInteraction(channel, {
                item_id: 'golden_horns', catalog_url, codes: 'NEW', ...metadata
            })), error => error instanceof OrderError && /Rolimons item link/.test(error.message));
        }
    }
    assert.deepEqual(db.snapshot(), before);
    assert.equal(downloaded.length, 0);
});

test('valid links are normalized for safe clickable Markdown', async () => {
    const db = databaseFixture();
    const result = await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns',
        catalogUrl: ' https://www.rolimons.com/item/123456789?tracking=hello(world)#details ' });
    assert.equal(result.item.catalogUrl, LINK);
});

test('browsing shows the clickable link directly below the price and retains the image and Buy button', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog } = catalogFixture(db.store);
    const { payload } = await openBrowser(catalog);
    assert(cardContent(payload).includes(`**$250.00 USD**\n[View on Rolimons](${LINK})`));
    assert.equal(payload.components[1].components[0].accessory.media.url, 'https://cdn.discordapp.com/original.png');
    assert.equal(payload.components[1].components[1].components[0].label, 'Buy / Open Ticket');
    assert(!JSON.stringify(payload).includes('PRIVATE-ORIGINAL'));
});

test('old listings without links still render, and refresh picks up an ID-based update', async () => {
    const db = databaseFixture();
    const { catalog } = catalogFixture(db.store);
    const { payload, interaction } = await openBrowser(catalog);
    assert(!cardContent(payload).includes('Rolimons'));
    await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns', catalogUrl: LINK });
    const refresh = payload.components.at(-1).components.find(component => component.label === 'Refresh');
    let refreshed;
    await catalog.handleInteraction({ ...interaction, customId: refresh.custom_id,
        deferUpdate: async () => {}, editReply: async next => { refreshed = next; } });
    assert(cardContent(refreshed).includes(`[View on Rolimons](${LINK})`));
    await db.store.updateToycodeCatalogUrl({ guildId: GUILD, itemId: 'golden_horns', catalogUrl: OTHER_LINK });
    await catalog.handleInteraction({ ...interaction, customId: refresh.custom_id,
        deferUpdate: async () => {}, editReply: async next => { refreshed = next; } });
    assert(cardContent(refreshed).includes(`[View on Rolimons](${OTHER_LINK})`));
    assert(!cardContent(refreshed).includes(LINK));
});

test('a listing remains clickable even if its image source is unavailable', async () => {
    const db = databaseFixture([{ ...listing(), catalogUrl: LINK }]);
    const { catalog } = catalogFixture(db.store, { botClient: { channels: { fetch: async () => { throw new Error('Missing image'); } } } });
    const { payload } = await openBrowser(catalog);
    assert.equal(payload.components[1].components[0].type, 10);
    assert(cardContent(payload).includes(`[View on Rolimons](${LINK})`));
});

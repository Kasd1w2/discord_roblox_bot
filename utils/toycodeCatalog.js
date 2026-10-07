const { randomBytes } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { OrderError } = require('./orderStore');
const { TOYCODE_EMOJI, TOYCODE_COLOR, resolveToycodeImage, savedToycodeImage } = require('./toycodeImages');
const { savedRobloxCatalogUrl } = require('./catalogLinks');

const PAGE_SIZE = 5;
const SESSION_MS = 30 * 60000;
const COMPONENTS_V2 = 1 << 15;
const PRICE_EMOJI = '<:price:1554267169800585227>';
const TERMS_CHANNEL_ID = '1555338590064746576';
const SUPPORT_CHANNEL_ID = '1542544665969164308';
const PRICE_RANGES = [
    { value: 'all', label: 'All prices', min: 0, max: Infinity },
    { value: 'under100', label: '$0–$99.99', min: 0, max: 10000 },
    { value: '100to500', label: '$100–$499.99', min: 10000, max: 50000 },
    { value: '500to1000', label: '$500–$999.99', min: 50000, max: 100000 },
    { value: '1000plus', label: '$1,000+', min: 100000, max: Infinity }
];
const money = cents => `$${(cents / 100).toFixed(2)} USD`;
const catalogLink = item => {
    const url = savedRobloxCatalogUrl(item.catalogUrl);
    return url ? `\n[View on Roblox](${url})` : '';
};
const text = value => String(value).replace(/[`*_~|<>@]/g, '').slice(0, 100);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
// Raw API components keep this layout independent of the newer SDK builders.
const display = content => ({ type: 10, content });
const container = components => ({ type: 17, accent_color: TOYCODE_COLOR, components });

function hasInvalidEmoji(error) {
    return error && typeof error === 'object' && (error.code === 'COMPONENT_INVALID_EMOJI' ||
        Object.values(error).some(value => hasInvalidEmoji(value)));
}

function removeRejectedEmojis(payload, errors) {
    if (!payload || typeof payload !== 'object' || !errors || typeof errors !== 'object') return false;
    let removed = false;
    for (const [key, detail] of Object.entries(errors)) {
        if (key === 'emoji' && hasInvalidEmoji(detail) && Object.hasOwn(payload, key)) {
            delete payload.emoji;
            removed = true;
        } else if (key !== '_errors') removed = removeRejectedEmojis(payload[key], detail) || removed;
    }
    return removed;
}

function removeComponentEmojis(component) {
    if (!component || typeof component !== 'object') return false;
    let removed = Object.hasOwn(component, 'emoji');
    if (removed) delete component.emoji;
    for (const child of Object.values(component)) removed = removeComponentEmojis(child) || removed;
    return removed;
}

async function sendShopPayload(send, payload) {
    try { return await send(payload); }
    catch (error) {
        if (Number(error?.code) !== 50035 || (!hasInvalidEmoji(error.rawError?.errors) &&
            !String(error.message).includes('COMPONENT_INVALID_EMOJI'))) throw error;
        const retry = JSON.parse(JSON.stringify(payload));
        const removed = removeRejectedEmojis(retry, error.rawError?.errors) || removeComponentEmojis(retry.components);
        if (!removed) throw error;
        // A rejected form creates no message. Retry once, preserving labels, IDs, styles and images.
        return send(retry);
    }
}

function createToycodeCatalog({ store, botClient, adminRoleId, downloadImage, createTicket,
    imageChannelId = process.env.TOYCODE_IMAGE_CHANNEL_ID }) {
    console.info('Toycode shop loaded: GREEN_BUY_EMOJI_FIX_2026_10_06');
    // Browsing never writes session state, searches or page clicks to MongoDB.
    const sessions = new Map();
    const customId = (session, action) => `toy|${session.id}|${action}`;
    const button = (session, action, label, emoji, disabled = false) => {
        const result = new ButtonBuilder().setCustomId(customId(session, action)).setLabel(label)
            .setStyle(ButtonStyle.Secondary).setDisabled(disabled);
        if (emoji) result.setEmoji(emoji);
        return result;
    };

    function newSession(interaction) {
        for (const [id, session] of sessions) if (Date.now() - session.touched > SESSION_MS) sessions.delete(id);
        while (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
        const session = { id: randomBytes(8).toString('hex'), owner: interaction.user.id, guildId: interaction.guildId,
            query: '', range: 'all', sort: 'asc', page: 0, shown: [], touched: Date.now() };
        sessions.set(session.id, session);
        return session;
    }

    function ownSession(interaction, id) {
        const session = sessions.get(id);
        if (!session || Date.now() - session.touched > SESSION_MS) {
            sessions.delete(id);
            throw new OrderError('This browser expired. Use Browse Items on the toycode shop to open it again.');
        }
        if (session.owner !== interaction.user.id || session.guildId !== interaction.guildId) {
            throw new OrderError('Open your own toycode browser from the shop.');
        }
        session.touched = Date.now();
        return session;
    }

    function publicCatalog(title = 'Toycode Shop') {
        return { embeds: [new EmbedBuilder()
            .setDescription(
    `# ${TOYCODE_EMOJI} **${title || 'Toycode Shop'}**\n` +
                    'Find your next Roblox accessory — browse the pictures, pick your item, and open a private purchase ticket.\n\n' +
                '**Unclaimed & ready to redeem**\nUnused toy codes for you to redeem on your own Roblox account.\n\n' +
                '**Private delivery**\nYour code is delivered in your ticket. You never need to share your Roblox password.\n\n' +
                `**Need help?**\nIf your code doesn’t work, open a ticket in <#${SUPPORT_CHANNEL_ID}> and staff will help you.\n\n` +
                `**Shop terms**\nRead <#${TERMS_CHANNEL_ID}> before buying.\n\n` +
                `${PRICE_EMOJI} Search by name, filter your budget, or sort prices either way. Click an item’s green Buy button to open your purchase ticket.`)
            .setColor(TOYCODE_COLOR)], components: [row(
                new ButtonBuilder().setCustomId('toy_browse').setLabel('Browse Items').setStyle(ButtonStyle.Primary).setEmoji('<a:shop1:1554264889491726377>'),
                new ButtonBuilder().setCustomId('toy_search_public').setLabel('Search').setStyle(ButtonStyle.Secondary)
            )], allowedMentions: { parse: [] } };
    }

    async function refreshPublicCatalog(interaction) {
        const message = interaction.message;
        if (!botClient.user?.id || message?.author?.id !== botClient.user.id ||
            message.guildId !== interaction.guildId || typeof message.edit !== 'function') return;
        const originalTitle = message.embeds?.[0]?.title || 'Toycode Shop';
        const title = originalTitle.startsWith(TOYCODE_EMOJI) ? originalTitle.slice(TOYCODE_EMOJI.length).trim() : originalTitle;
        const payload = publicCatalog(title), expected = payload.embeds[0].toJSON();
        const current = message.embeds?.[0];
        const search = message.components?.[0]?.components?.find(component =>
            (component.customId || component.custom_id) === 'toy_search_public');
        if (current?.title === expected.title && current?.description === expected.description &&
            current?.color === expected.color && !search?.emoji) return;
        try { await sendShopPayload(payload => message.edit(payload), payload); }
        catch { console.warn('Toycode shop welcome could not be refreshed. Repost it with /toycodes.'); }
    }

    async function listingPayload(session) {
        const range = PRICE_RANGES.find(item => item.value === session.range);
        const query = session.query.toLowerCase();
        const items = (await store.listToycodes(session.guildId)).filter(item =>
            item.title.toLowerCase().includes(query) && item.priceCents >= range.min && item.priceCents < range.max);
        items.sort((a, b) => (session.sort === 'desc' ? b.priceCents - a.priceCents : a.priceCents - b.priceCents) ||
            a.title.localeCompare(b.title) || a.itemId.localeCompare(b.itemId));
        const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        session.page = Math.min(Math.max(session.page, 0), pages - 1);
        const current = items.slice(session.page * PAGE_SIZE, (session.page + 1) * PAGE_SIZE);
        // Keep the displayed quote, so a later restock cannot silently change the purchase price or item.
        const shown = current.map(item => ({ itemId: item.itemId, priceCents: item.priceCents, title: item.title }));
        const quoteId = randomBytes(4).toString('hex');
        const purchaseId = action => customId(session, `${quoteId}|${action}`);
        const header = container([display(`## ${TOYCODE_EMOJI} Toycode Shop\n` +
            'Unclaimed codes • Redeem on your own account\n' +
            '-# Private delivery in your ticket. No Roblox password needed.\n\n' +
            `If your code doesn’t work, open a ticket in <#${SUPPORT_CHANNEL_ID}>. Read <#${TERMS_CHANNEL_ID}> before buying.\n\n` +
            `${PRICE_EMOJI} **${range.label}** • Price ${session.sort === 'asc' ? 'low → high' : 'high → low'}` +
            (session.query ? `\n🔎 Search: **${text(session.query)}**` : '') +
            (current.length ? '\nUse an item’s green Buy button to open your purchase ticket.' : '\nNo matching items. Try another search or price range.') +
            `\n-# Page ${session.page + 1} of ${pages}`)]);
        const cards = await Promise.all(current.map(async item => {
            const title = text(item.title) || 'Toycode item';
            const details = display(`### ${TOYCODE_EMOJI} ${title}\n**${money(item.priceCents)}**${catalogLink(item)}`);
            const image = await resolveToycodeImage(botClient, item);
            return [image ? { type: 9, components: [details],
                accessory: { type: 11, media: { url: image }, description: title } } : details,
                row(new ButtonBuilder().setCustomId(purchaseId(`buy|${item.itemId}`))
                    .setLabel('Buy / Open Ticket').setStyle(ButtonStyle.Success))];
        }));
        const components = [header];
        components.push(container([
    ...cards.flat(),
    display(`-# Page ${session.page + 1} of ${pages}`)
]));
        components.push(row(new StringSelectMenuBuilder().setCustomId(customId(session, 'sort')).setPlaceholder('Sort by price')
            .addOptions([
                { label: 'Price: Low to High', value: 'asc', emoji: { name: '⬆️' }, default: session.sort === 'asc' },
                { label: 'Price: High to Low', value: 'desc', emoji: { name: '⬇️' }, default: session.sort === 'desc' }
            ])));
        components.push(row(new StringSelectMenuBuilder().setCustomId(customId(session, 'range')).setPlaceholder('Choose a price range')
            .addOptions(PRICE_RANGES.map(item => ({ label: item.label, value: item.value,
                emoji: { name: 'price', id: '1554267169800585227' }, default: item.value === session.range })))));
        components.push(row(
            button(session, 'prev', 'Previous', '◀️', session.page === 0),
            button(session, 'next', 'Next', '▶️', session.page >= pages - 1),
            button(session, 'search', 'Search'),
            button(session, 'reset', 'Reset Filters', '🧹'),
            button(session, 'refresh', 'Refresh', '🔄')
        ));
        // A full five-item page uses 38 components, including nested accessories and buttons.
        session.shown = shown;
        session.quoteId = quoteId;
        return { flags: COMPONENTS_V2 | 64, content: null, embeds: [],
            components: JSON.parse(JSON.stringify(components)), allowedMentions: { parse: [] } };
    }

    function searchModal(session) {
        const input = new TextInputBuilder().setCustomId('query').setLabel('Item name (leave blank to clear)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80);
        if (session.query) input.setValue(session.query);
        return new ModalBuilder().setCustomId(customId(session, 'query')).setTitle('Search Toycode Items').addComponents(row(input));
    }

    async function restock(interaction) {
        const input = { guildId: interaction.guildId, title: interaction.options.getString('title'),
            price: interaction.options.getNumber('price'), imageUrl: interaction.options.getString('image_url'),
            itemId: interaction.options.getString('item_id'), catalogUrl: interaction.options.getString('catalog_url') };
        const codes = (interaction.options.getString('codes') || '').split(/[\r\n,]+|\s+/).map(code => code.trim()).filter(Boolean);
        if ([input.title, input.price, input.imageUrl].every(value => value == null) && input.catalogUrl != null) {
            const result = await store.updateToycodeCatalogUrl(input, codes);
            await interaction.editReply({ content: `${TOYCODE_EMOJI} Updated the Roblox link for **${text(result.item.title)}**.\n` +
                `Stock ID: \`${result.item.itemId}\`${catalogLink(result.item)}\nRefresh or reopen the toycode browser to see it.` +
                (result.added ? `\nAdded ${result.added} private code(s).` : '') });
            return result;
        }
        if (!input.title || input.price == null || !input.imageUrl) {
            throw new OrderError('For toycode listings, provide all three: title, price, and image_url. To update only the Roblox link, provide item_id and catalog_url.');
        }
        const item = store.validateToycode(input);
        const file = await downloadImage(item.imageUrl);
        const target = imageChannelId ? await interaction.guild.channels.fetch(imageChannelId) : interaction.channel;
        if (!target?.isTextBased() || typeof target.send !== 'function' || target.guildId !== interaction.guildId) {
            throw new OrderError('Use /restock in a server text channel, or set TOYCODE_IMAGE_CHANNEL_ID to a text channel in this server.');
        }
        // Keep a durable Discord attachment source. Only metadata and message
        // references go into MongoDB; codes never appear in this image post.
        const imagePost = await target.send({ embeds: [new EmbedBuilder().setTitle(`${TOYCODE_EMOJI} ${text(item.title)}`)
            .setDescription(`${PRICE_EMOJI} **${money(item.priceCents)}**${catalogLink(item)}`).setColor(TOYCODE_COLOR)
            .setImage(`attachment://${file.name}`)], files: [file], allowedMentions: { parse: [] } });
        let result;
        try {
            let image = savedToycodeImage(imagePost, { filename: file.name });
            if (!image) {
                let savedPost;
                try { savedPost = await target.messages.fetch({ message: imagePost.id, force: true }); }
                catch { throw new OrderError('The image uploaded, but the bot could not read it back. Give it View Channel and Read Message History in this channel, then retry.'); }
                image = savedToycodeImage(savedPost, { filename: file.name });
            }
            if (!image) throw new OrderError('The uploaded image could not be resolved. Use a fresh direct image link and try again.');
            result = await store.saveToycode({ ...input, imageChannelId: target.id,
                imageMessageId: imagePost.id, imageAttachmentId: image.id }, codes);
        } catch (error) {
            await imagePost.delete().catch(() => {});
            throw error;
        }
        await interaction.editReply({ content: `${TOYCODE_EMOJI} Saved **${text(result.item.title)}** for **${money(result.item.priceCents)}**.\n` +
            `Stock ID: \`${result.item.itemId}\`\nThe toycode shop updates automatically.` +
            (result.added ? `\nAdded ${result.added} private code(s).` : '') });
        return result;
    }

    async function handleInteraction(interaction) {
        const id = interaction.customId || '';
        const command = interaction.isChatInputCommand() && interaction.commandName === 'toycodes';
        const publicEntry = interaction.isButton?.() && ['toy_browse', 'toy_search_public'].includes(id);
        const privateEntry = id.startsWith('toy|') && (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.());
        if (!command && !publicEntry && !privateEntry) return false;
        if (!interaction.inGuild()) throw new OrderError('Use the toycode shop inside the server.');
        if (command) {
            if (!interaction.member?.roles?.cache?.has(adminRoleId)) throw new OrderError('Only shop staff can post the toycode shop.');
            await interaction.deferReply({ flags: 64 });
            const channelOption = interaction.options.getChannel('channel');
            const channel = channelOption ? await interaction.guild.channels.fetch(channelOption.id) : interaction.channel;
            if (!channel?.isTextBased() || typeof channel.send !== 'function' || channel.guildId !== interaction.guildId) {
                throw new OrderError('Choose a text channel in this shop server.');
            }
            await sendShopPayload(payload => channel.send(payload), publicCatalog(interaction.options.getString('title')));
            await interaction.editReply({ content: `${TOYCODE_EMOJI} Toycode shop posted in <#${channel.id}>.` });
            return true;
        }
        if (publicEntry) {
            const session = newSession(interaction);
            if (id === 'toy_search_public') {
                await interaction.showModal(searchModal(session));
                await refreshPublicCatalog(interaction);
            }
            else {
                await interaction.deferReply({ flags: 64 });
                await refreshPublicCatalog(interaction);
                await sendShopPayload(payload => interaction.editReply(payload), await listingPayload(session));
            }
            return true;
        }
        const [, sessionId, part, purchaseAction, buttonItemId] = id.split('|');
        const quoted = /^[a-f0-9]{8}$/.test(part);
        const action = quoted ? purchaseAction : part;
        const session = ownSession(interaction, sessionId);
        if (action === 'search' && interaction.isButton()) {
            await interaction.showModal(searchModal(session));
            return true;
        }
        if (action === 'buy' && interaction.isButton()) {
            if (quoted && part !== session.quoteId) throw new OrderError('This shop page changed. Refresh the shop before choosing an item.');
            const selection = session.shown.find(item => item.itemId === buttonItemId);
            if (!quoted || !selection) throw new OrderError('Choose an item from your current page.');
            // Reply separately: leave the browser and its filters available to the buyer.
            await interaction.deferReply({ flags: 64 });
            await createTicket(interaction, selection);
            return true;
        }
        if (action === 'query' && interaction.isModalSubmit()) {
            const query = interaction.fields.getTextInputValue('query').trim();
            if (query.length > 80) throw new OrderError('Keep your search under 80 characters.');
            session.query = query; session.page = 0;
            await interaction.deferReply({ flags: 64 });
            await sendShopPayload(payload => interaction.editReply(payload), await listingPayload(session));
            return true;
        }
        if (action === 'sort' && interaction.isStringSelectMenu()) {
            const sort = interaction.values[0];
            if (!['asc', 'desc'].includes(sort)) throw new OrderError('Choose a valid price sort.');
            session.sort = sort; session.page = 0;
        } else if (action === 'range' && interaction.isStringSelectMenu()) {
            const range = interaction.values[0];
            if (!PRICE_RANGES.some(item => item.value === range)) throw new OrderError('Choose a valid price range.');
            session.range = range; session.page = 0;
        } else if (interaction.isButton() && ['prev', 'next', 'reset', 'refresh'].includes(action)) {
            if (action === 'prev') session.page--;
            if (action === 'next') session.page++;
            if (action === 'reset') { session.query = ''; session.range = 'all'; session.sort = 'asc'; session.page = 0; }
        } else throw new OrderError('Open the toycode browser again from the shop.');
        interaction._shopUpdate = true;
        await interaction.deferUpdate();
        await sendShopPayload(payload => interaction.editReply(payload), await listingPayload(session));
        return true;
    }

    return { publicCatalog, handleInteraction, restock };
}

module.exports = { createToycodeCatalog, PRICE_RANGES, PAGE_SIZE };

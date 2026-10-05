const { randomBytes } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { OrderError } = require('./orderStore');
const { TOYCODE_EMOJI, TOYCODE_COLOR, resolveToycodeImage, savedToycodeImage } = require('./toycodeImages');

const PAGE_SIZE = 5;
const SESSION_MS = 30 * 60000;
const PRICE_EMOJI = '<:price:1554267169800585227>';
const ITEM_EMOJI = { name: 'toycode', id: '1556793052469657721' };
const PRICE_RANGES = [
    { value: 'all', label: 'All prices', min: 0, max: Infinity },
    { value: 'under100', label: '$0–$99.99', min: 0, max: 10000 },
    { value: '100to500', label: '$100–$499.99', min: 10000, max: 50000 },
    { value: '500to1000', label: '$500–$999.99', min: 50000, max: 100000 },
    { value: '1000plus', label: '$1,000+', min: 100000, max: Infinity }
];
const money = cents => `$${(cents / 100).toFixed(2)} USD`;
const text = value => String(value).replace(/[`*_~|<>@]/g, '').slice(0, 100);
const row = (...components) => new ActionRowBuilder().addComponents(...components);

function createToycodeCatalog({ store, botClient, adminRoleId, downloadImage, createTicket,
    imageChannelId = process.env.TOYCODE_IMAGE_CHANNEL_ID }) {
    // Browsing never writes session state, searches or page clicks to MongoDB.
    const sessions = new Map();
    const customId = (session, action) => `toy|${session.id}|${action}`;
    const button = (session, action, label, emoji, disabled = false) => new ButtonBuilder()
        .setCustomId(customId(session, action)).setLabel(label).setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled);

    function newSession(interaction) {
        for (const [id, session] of sessions) if (Date.now() - session.touched > SESSION_MS) sessions.delete(id);
        while (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
        const session = { id: randomBytes(8).toString('hex'), owner: interaction.user.id, guildId: interaction.guildId,
            query: '', range: 'all', sort: 'asc', page: 0, selected: null, shown: [], touched: Date.now() };
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
        return { embeds: [new EmbedBuilder().setTitle(`${TOYCODE_EMOJI} ${text(title || 'Toycode Shop')}`)
            .setDescription(`${TOYCODE_EMOJI} Browse items and their pictures below.\n\n` +
                `${PRICE_EMOJI} Search by name, choose a price range, and sort prices either way.\n` +
                'Select an item to preview it and open your purchase ticket.')
            .setColor(TOYCODE_COLOR)], components: [row(
                new ButtonBuilder().setCustomId('toy_browse').setLabel('Browse Items').setEmoji(TOYCODE_EMOJI).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('toy_search_public').setLabel('Search').setEmoji('🔎').setStyle(ButtonStyle.Secondary)
            )], allowedMentions: { parse: [] } };
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
        session.shown = current.map(item => item.itemId);
        session.selected = null;
        const header = new EmbedBuilder().setTitle(`${TOYCODE_EMOJI} Toycode Shop`).setColor(TOYCODE_COLOR)
            .setDescription(`${PRICE_EMOJI} **${range.label}** • Price ${session.sort === 'asc' ? 'low → high' : 'high → low'}` +
                (session.query ? `\n🔎 Search: **${text(session.query)}**` : '') +
                (current.length ? '\nChoose an item from the dropdown to see its full picture.' : '\nNo matching items. Try another search or price range.'))
            .setFooter({ text: `Page ${session.page + 1} of ${pages}` });
        const cards = await Promise.all(current.map(async item => {
            const embed = new EmbedBuilder().setTitle(text(item.title) || 'Toycode item').setColor(TOYCODE_COLOR)
                .setDescription(`${TOYCODE_EMOJI} ${PRICE_EMOJI} **${money(item.priceCents)}**`);
            const image = await resolveToycodeImage(botClient, item);
            if (image) embed.setThumbnail(image);
            return embed;
        }));
        const components = [];
        if (current.length) components.push(row(new StringSelectMenuBuilder().setCustomId(customId(session, 'item'))
            .setPlaceholder('Choose an item to preview...').addOptions(current.map(item => ({
                label: text(item.title) || 'Toycode item', description: money(item.priceCents), value: item.itemId, emoji: ITEM_EMOJI
            })))));
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
            button(session, 'search', 'Search', '🔎'),
            button(session, 'reset', 'Reset Filters', '🧹'),
            button(session, 'refresh', 'Refresh', '🔄')
        ));
        return { content: null, embeds: [header, ...cards], components, allowedMentions: { parse: [] } };
    }

    async function previewPayload(session, itemId) {
        const item = await store.getToycode(session.guildId, itemId);
        if (!item) throw new OrderError('This item is no longer listed. Refresh the shop.');
        session.selected = { itemId: item.itemId, priceCents: item.priceCents, title: item.title };
        const embed = new EmbedBuilder().setTitle(`${TOYCODE_EMOJI} ${text(item.title)}`).setColor(TOYCODE_COLOR)
            .setDescription(`${PRICE_EMOJI} **${money(item.priceCents)}**\n\nOpen a purchase ticket for this item below.`);
        const image = await resolveToycodeImage(botClient, item);
        if (image) embed.setImage(image);
        return { content: null, embeds: [embed], components: [row(
            new ButtonBuilder().setCustomId(customId(session, 'buy')).setLabel('Buy / Open Ticket')
                .setEmoji(TOYCODE_EMOJI).setStyle(ButtonStyle.Success),
            button(session, 'back', 'Back to Items', '◀️')
        )], allowedMentions: { parse: [] } };
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
            itemId: interaction.options.getString('item_id') };
        const item = store.validateToycode(input);
        const file = await downloadImage(item.imageUrl);
        const target = imageChannelId ? await interaction.guild.channels.fetch(imageChannelId) : interaction.channel;
        if (!target?.isTextBased() || typeof target.send !== 'function' || target.guildId !== interaction.guildId) {
            throw new OrderError('Use /restock in a server text channel, or set TOYCODE_IMAGE_CHANNEL_ID to a text channel in this server.');
        }
        // Keep a durable Discord attachment source. Only metadata and message
        // references go into MongoDB; codes never appear in this image post.
        const imagePost = await target.send({ embeds: [new EmbedBuilder().setTitle(`${TOYCODE_EMOJI} ${text(item.title)}`)
            .setDescription(`${PRICE_EMOJI} **${money(item.priceCents)}**`).setColor(TOYCODE_COLOR)
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
            const codes = (interaction.options.getString('codes') || '').split(/[\r\n,]+|\s+/).map(code => code.trim()).filter(Boolean);
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
            await channel.send(publicCatalog(interaction.options.getString('title')));
            await interaction.editReply({ content: `${TOYCODE_EMOJI} Toycode shop posted in <#${channel.id}>.` });
            return true;
        }
        if (publicEntry) {
            const session = newSession(interaction);
            if (id === 'toy_search_public') await interaction.showModal(searchModal(session));
            else {
                await interaction.deferReply({ flags: 64 });
                await interaction.editReply(await listingPayload(session));
            }
            return true;
        }
        const [, sessionId, action] = id.split('|');
        const session = ownSession(interaction, sessionId);
        if (action === 'search' && interaction.isButton()) {
            await interaction.showModal(searchModal(session));
            return true;
        }
        if (action === 'buy' && interaction.isButton()) {
            if (!session.selected) throw new OrderError('Choose an item from the dropdown before opening a ticket.');
            await interaction.deferReply({ flags: 64 });
            await createTicket(interaction, session.selected);
            return true;
        }
        if (action === 'query' && interaction.isModalSubmit()) {
            const query = interaction.fields.getTextInputValue('query').trim();
            if (query.length > 80) throw new OrderError('Keep your search under 80 characters.');
            session.query = query; session.page = 0;
            await interaction.deferReply({ flags: 64 });
            await interaction.editReply(await listingPayload(session));
            return true;
        }
        let itemId;
        if (action === 'item' && interaction.isStringSelectMenu()) {
            itemId = interaction.values[0];
            if (!session.shown.includes(itemId)) throw new OrderError('Choose an item from your current page.');
        } else if (action === 'sort' && interaction.isStringSelectMenu()) {
            const sort = interaction.values[0];
            if (!['asc', 'desc'].includes(sort)) throw new OrderError('Choose a valid price sort.');
            session.sort = sort; session.page = 0;
        } else if (action === 'range' && interaction.isStringSelectMenu()) {
            const range = interaction.values[0];
            if (!PRICE_RANGES.some(item => item.value === range)) throw new OrderError('Choose a valid price range.');
            session.range = range; session.page = 0;
        } else if (interaction.isButton() && ['prev', 'next', 'reset', 'refresh', 'back'].includes(action)) {
            if (action === 'prev') session.page--;
            if (action === 'next') session.page++;
            if (action === 'reset') { session.query = ''; session.range = 'all'; session.sort = 'asc'; session.page = 0; }
        } else throw new OrderError('Open the toycode browser again from the shop.');
        interaction._shopUpdate = true;
        await interaction.deferUpdate();
        await interaction.editReply(itemId ? await previewPayload(session, itemId) : await listingPayload(session));
        return true;
    }

    return { publicCatalog, handleInteraction, restock };
}

module.exports = { createToycodeCatalog, PRICE_RANGES, PAGE_SIZE };

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { TIERS, CATEGORY_NAMES, normalizeAccountCategory, accountListings } = require('./accounts');
const { OrderError } = require('./orderStore');

const PAGE_SIZE = 25;
const TIER_COLORS = { high_tier: 0xF97316, mid_tier: 0xFACC15, low_tier: 0x22C55E };
const EMOJIS = {
    user: '<a:white_user:1554592911679553577>', price: '<:price:1554267169800585227>',
    shop: '<a:shop1:1554264889491726377>', folder: '<a:folder:1554593038003609620>',
    terms: '<a:Termss:1554267208882978896>', confirm: '<a:confirm:1554592986334105620>',
    time: '<a:time:1554592842935173240>', stock: '<a:box:1554592797733163099>'
};
const tierName = tier => tier.label.replace(/^[^A-Za-z]+/, '');
function createAccountCatalog({ Inventory, store }) {
    const tiersMenu = id => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Choose an account tier...')
        .addOptions(Object.entries(TIERS).map(([value, tier]) => ({ label: tierName(tier), value, emoji: EMOJIS.user,
            description: tier.categories.map(key => CATEGORY_NAMES[key]).join(', ').slice(0, 100) })));

    function publicCatalog(title = 'Stocked User Stock') {
        return { embeds: [new EmbedBuilder().setColor(0xF1F5F9)
            .setDescription(`# ${EMOJIS.user} ${String(title).slice(0, 256)}\n\n` +
                'Browse available usernames and USD prices. Choose a tier below, then a category.\n\n' +
                `${EMOJIS.price} Accounts are sorted from lowest to highest price.\n${EMOJIS.shop} Select a username to open its purchase ticket.\n` +
                `${EMOJIS.user} Login details are provided privately after payment and delivery.\n${EMOJIS.confirm} Accounts include a 7-day warranty from delivery.\n\n` +
                `${EMOJIS.terms} Read our shop terms in <#1555338590064746576> before ordering.`)],
            components: [new ActionRowBuilder().addComponents(tiersMenu('account_tier'))], allowedMentions: { parse: [] } };
    }

    async function listings(category) {
        const item = await Inventory.findOne({ itemId: category });
        const reserved = await store.reservedAccounts(category);
        return accountListings(item?.codes || []).filter(account => !reserved.has(account.username.toLowerCase()));
    }

    async function categoriesPayload(owner, tierKey) {
        const tier = TIERS[tierKey];
        if (!tier) throw new OrderError('Choose a valid account tier.');
        const counts = await Promise.all(tier.categories.map(async category => ({ category, count: (await listings(category)).length })));
        const menu = new StringSelectMenuBuilder().setCustomId(`account_category|${owner}|${tierKey}`).setPlaceholder('Choose a category...')
            .addOptions(counts.map(({ category, count }) => ({ label: CATEGORY_NAMES[category], value: category,
                description: count ? `${count} account${count === 1 ? '' : 's'} available` : 'Currently sold out', emoji: EMOJIS.user })));
        return { content: null, embeds: [new EmbedBuilder().setColor(TIER_COLORS[tierKey])
            .setDescription(`# ${EMOJIS.folder} ${tierName(tier)}\n\n` +
                counts.map(({ category, count }) => `${EMOJIS.user} **${CATEGORY_NAMES[category]}** — ${count} available`).join('\n') +
                '\n\nChoose a category to browse its usernames and prices.')],
            components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`account_back|${owner}`).setLabel('All Tiers').setEmoji(EMOJIS.folder).setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] } };
    }

    async function listingPayload(owner, value, requestedPage = 0) {
        const category = normalizeAccountCategory(value);
        if (!category) throw new OrderError('Choose a valid account category.');
        const accounts = await listings(category);
        const pageCount = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
        const page = Math.min(requestedPage, pageCount - 1);
        const shown = accounts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const tierKey = Object.keys(TIERS).find(key => TIERS[key].categories.includes(category));
        const embed = new EmbedBuilder().setColor(TIER_COLORS[tierKey])
            .setDescription(`# ${EMOJIS.user} ${CATEGORY_NAMES[category]}\n\n` +
                (shown.length ? shown.map(account => `${EMOJIS.user} **@${account.username}** — ${EMOJIS.price} \`$${(account.priceCents / 100).toFixed(2)}\``).join('\n') +
                `\n\n${EMOJIS.shop} Choose a username below to open its order ticket.` :
                `${EMOJIS.stock} No accounts are available in this category right now. Try another category or refresh later.`))
            .setFooter({ text: `${accounts.length} available • Page ${page + 1}/${pageCount} • Prices in USD` });
        const components = [];
        if (shown.length) components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`account_pick|${owner}|${category}`).setPlaceholder('Select an account to purchase...')
                .addOptions(shown.map(account => ({ label: `@${account.username}`, value: account.username,
                    description: `$${(account.priceCents / 100).toFixed(2)} USD`, emoji: EMOJIS.user })))
        ));
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${Math.max(0, page - 1)}|previous`)
                .setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${page + 1}|next`)
                .setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pageCount),
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${page}|refresh`)
                .setLabel('Refresh').setEmoji(EMOJIS.time).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`account_categories|${owner}|${tierKey}`)
                .setLabel('Categories').setEmoji(EMOJIS.folder).setStyle(ButtonStyle.Secondary)
        ));
        return { content: null, embeds: [embed], components, allowedMentions: { parse: [] } };
    }

    async function handleInteraction(interaction) {
        const id = interaction.customId || '';
        const select = interaction.isStringSelectMenu();
        const button = interaction.isButton();
        const legacyTier = select && (id.startsWith('tier_select') || id === 'user_tier_select');
        const legacyCategory = select && (id.startsWith('subcat_select') || id.startsWith('user_subcat_select|'));
        const legacyTicket = button && id.startsWith('create_user_ticket|');
        const supported = legacyTier || legacyCategory || legacyTicket ||
            select && (id === 'account_tier' || id.startsWith('account_tier_private|') || id.startsWith('account_category|')) ||
            button && ['account_page|', 'account_categories|', 'account_back|'].some(prefix => id.startsWith(prefix));
        if (!supported) return false;
        if (!interaction.inGuild()) throw new OrderError('Browse accounts inside the shop server.');
        const owner = interaction.user.id;
        const [action, savedOwner, value, pageValue] = id.split('|');
        const publicEntry = id === 'account_tier' || legacyTier || legacyCategory || legacyTicket;
        if (!publicEntry && savedOwner !== owner) throw new OrderError('Open your own account browser from the shop menu.');
        if (publicEntry) await interaction.deferReply({ flags: 64 });
        else { interaction._shopUpdate = true; await interaction.deferUpdate(); }
        let payload;
        if (id === 'account_tier' || action === 'account_tier_private' || legacyTier) payload = await categoriesPayload(owner, interaction.values[0]);
        else if (legacyCategory) payload = await listingPayload(owner, interaction.values[0]);
        else if (legacyTicket) payload = await listingPayload(owner, savedOwner);
        else if (action === 'account_category') {
            if (!TIERS[value]?.categories.includes(normalizeAccountCategory(interaction.values[0]))) throw new OrderError('Choose a category from this tier.');
            payload = await listingPayload(owner, interaction.values[0]);
        } else if (action === 'account_page') {
            const page = Number(pageValue);
            if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw new OrderError('Invalid catalog page.');
            payload = await listingPayload(owner, value, page);
        } else if (action === 'account_categories') payload = await categoriesPayload(owner, value);
        else payload = { content: null, embeds: [new EmbedBuilder().setColor(0xF1F5F9)
            .setDescription(`# ${EMOJIS.folder} Account Tiers\n\nChoose a tier to browse available usernames and prices.`)],
            components: [new ActionRowBuilder().addComponents(tiersMenu(`account_tier_private|${owner}`))], allowedMentions: { parse: [] } };
        await interaction.editReply(payload);
        return true;
    }

    return { publicCatalog, handleInteraction, listingPayload };
}

module.exports = { createAccountCatalog };

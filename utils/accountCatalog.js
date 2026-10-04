const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { TIERS, CATEGORY_NAMES, normalizeAccountCategory, accountListings } = require('./accounts');
const { OrderError } = require('./orderStore');

const PAGE_SIZE = 25;
function createAccountCatalog({ Inventory, store }) {
    const tiersMenu = id => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Choose an account tier...')
        .addOptions(Object.entries(TIERS).map(([value, tier]) => ({ label: tier.label, value,
            description: tier.categories.map(key => CATEGORY_NAMES[key]).join(', ').slice(0, 100) })));

    function publicCatalog(title = 'Stocked User Stock') {
        return { embeds: [new EmbedBuilder().setTitle(`👤 ${title}`.slice(0, 256)).setColor(0x2B2D31)
            .setDescription('Browse available usernames and USD prices. Choose a tier below, then a category.\n\n' +
                '💵 Accounts are sorted from lowest to highest price.\n🎫 Select a username to open its purchase ticket.\n' +
                '🔐 Login details are provided privately after payment and delivery.\n🛡️ Accounts include a 7-day warranty from delivery.\n\n' +
                'Read our shop terms in <#1555338590064746576> before ordering.')],
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
                description: count ? `${count} account${count === 1 ? '' : 's'} available` : 'Currently sold out', emoji: '👤' })));
        return { content: null, embeds: [new EmbedBuilder().setTitle(tier.label).setColor(0x5865F2)
            .setDescription(counts.map(({ category, count }) => `**${CATEGORY_NAMES[category]}** — ${count} available`).join('\n') +
                '\n\nChoose a category to browse its usernames and prices.')],
            components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`account_back|${owner}`).setLabel('All Tiers').setEmoji('↩️').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] } };
    }

    async function listingPayload(owner, value, requestedPage = 0) {
        const category = normalizeAccountCategory(value);
        if (!category) throw new OrderError('Choose a valid account category.');
        const accounts = await listings(category);
        const pageCount = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
        const page = Math.min(requestedPage, pageCount - 1);
        const shown = accounts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const embed = new EmbedBuilder().setTitle(`👤 ${CATEGORY_NAMES[category]}`).setColor(0x2B2D31)
            .setDescription(shown.length ? shown.map(account => `**@${account.username}** — \`$${(account.priceCents / 100).toFixed(2)}\``).join('\n') +
                '\n\n🎫 Choose a username below to open its order ticket.' : 'No accounts are available in this category right now. Try another category or refresh later.')
            .setFooter({ text: `${accounts.length} available • Page ${page + 1}/${pageCount} • Prices in USD` });
        const components = [];
        if (shown.length) components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`account_pick|${owner}|${category}`).setPlaceholder('Select an account to purchase...')
                .addOptions(shown.map(account => ({ label: `@${account.username}`, value: account.username,
                    description: `$${(account.priceCents / 100).toFixed(2)} USD`, emoji: '👤' })))
        ));
        const tierKey = Object.keys(TIERS).find(key => TIERS[key].categories.includes(category));
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${Math.max(0, page - 1)}|previous`)
                .setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${page + 1}|next`)
                .setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pageCount),
            new ButtonBuilder().setCustomId(`account_page|${owner}|${category}|${page}|refresh`)
                .setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`account_categories|${owner}|${tierKey}`)
                .setLabel('Categories').setEmoji('🗂️').setStyle(ButtonStyle.Secondary)
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
        else payload = { content: null, embeds: [new EmbedBuilder().setTitle('🗂️ Account Tiers').setColor(0x5865F2)
            .setDescription('Choose a tier to browse available usernames and prices.')],
            components: [new ActionRowBuilder().addComponents(tiersMenu(`account_tier_private|${owner}`))], allowedMentions: { parse: [] } };
        await interaction.editReply(payload);
        return true;
    }

    return { publicCatalog, handleInteraction, listingPayload };
}

module.exports = { createAccountCatalog };

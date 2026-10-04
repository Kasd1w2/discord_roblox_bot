require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ActivityType,
    PermissionFlagsBits
} = require('discord.js');

const DECO_PACKAGES = [
    { shopPrice: '4.99', price: '2.00' },
    { shopPrice: '5.99', price: '2.40' },
    { shopPrice: '6.99', price: '2.80' },
    { shopPrice: '7.99', price: '3.20' },
    { shopPrice: '8.99', price: '3.60' },
    { shopPrice: '9.99', price: '4.00' },
    { shopPrice: '10.99', price: '4.40' },
    { shopPrice: '11.99', price: '4.90' },
    { shopPrice: '15.99', price: '5.40' },
    { shopPrice: '20.99', price: '6.00' },
    { shopPrice: '23.96', price: '6.50' },
    { shopPrice: '32.97', price: '9.90' }
];

// Category mapping helper
const TIERS = {
    'high_tier': {
        label: '🔥 High Tier',
        subcategories: [
            { label: '2 Letters', value: '2l' },
            { label: '3 Digits', value: '3d' },
            { label: 'Real Words', value: 'real_words' }
        ]
    },
    'mid_tier': {
        label: '⚡ Mid Tier',
        subcategories: [
            { label: '3 Letters', value: '3l' },
            { label: '4 Digits', value: '4d' },
            { label: 'Clean Compounds', value: 'clean_compounds' }
        ]
    },
    'low_tier': {
        label: '🌱 Low Tier',
        subcategories: [
            { label: 'Triple Numbers', value: 'triple' },
            { label: '4 Letters', value: '4l' },
            { label: 'Edgy Compounds', value: 'edgy' },
            { label: 'Finance Compounds', value: 'finance' },
            { label: 'Leetspeak', value: 'leetspeak' },
            { label: 'Other', value: 'other' }
        ]
    }
};

const CATEGORY_NAMES = {
    '2l': '2 Letters',
    '3d': '3 Digits',
    'real_words': 'Real Words',
    '3l': '3 Letters',
    '4d': '4 Digits',
    'clean_compounds': 'Clean Compounds',
    'triple': 'Triple Numbers',
    '4l': '4 Letters',
    'edgy': 'Edgy Compounds',
    'finance': 'Finance Compounds',
    'leetspeak': 'Leetspeak',
    'other': 'Other'
};
// Account line parser (omits passwords from displays)
function parseAccountEntry(codeString) {
    let raw = codeString.trim();
    let username = raw;
    let price = '';

    if (raw.includes(':')) {
        const parts = raw.split(':');
        username = parts[0].trim().replace(/^@/, '');
        if (parts[2]) {
            let rawPrice = parts[2].trim();
            price = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
        }
    } else if (raw.includes('-')) {
        const parts = raw.split('-');
        username = parts[0].trim().replace(/^@/, '');
        price = parts[1].trim();
        if (price && !price.startsWith('$')) price = `$${price}`;
    } else {
        username = raw.replace(/^@/, '');
    }

    let displayLabel = `@${username}`;
    if (price) displayLabel += ` - ${price}`;

    return { username, displayLabel };
}

// Modular Imports
const Inventory = require('./models/Inventory');
const Ledger = require('./models/Ledger');
const appCommands = require('./commands/commandDefinitions');
const { createOrderRuntime } = require('./utils/orderRuntime');
const { OrderError } = require('./utils/orderStore');
const { publicMessage } = require('./utils/messageStyle');

const ADMIN_ROLE_ID = '1542306776622309437';

// --- DATABASE CONNECTIVITY ---
const databaseReady = mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Successfully connected to MongoDB Atlas.'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        throw err;
    });
// Login below awaits this promise; attach a handler immediately as well.
databaseReady.catch(() => {});

mongoose.connection.on('error', error => {
    console.error('MongoDB runtime error:', error);
});

const webApp = express();
const botClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ]
});

botClient.on('error', error => {
    console.error('Discord client error:', error);
});

botClient.on('shardError', error => {
    console.error('Discord gateway error:', error);
});

// --- HELPER FUNCTIONS ---
async function sendInteractionError(interaction, content = '<a:error:1554592934828179476> An error occurred while processing your request. Please contact support.') {
    try {
        if (!interaction.isRepliable()) return;

        if (interaction._shopUpdate) {
            await interaction.followUp({ content, flags: 64 });
        } else if (interaction.deferred && !interaction.replied && interaction.ephemeral !== null) {
            await interaction.editReply(interaction.ephemeral ? { content, embeds: [], components: [] } :
                publicMessage(content, { title: '❌ Something Went Wrong', color: 0xED4245, components: [] }));
        } else if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: 64 });
        } else {
            await interaction.reply({ content, flags: 64 });
        }
    } catch (replyError) {
        console.error('Failed to send interaction error response:', replyError);
    }
}

function updateBotStatus(text, temporaryMs = 15000) {
    try {
        if (!botClient.user) return;
        botClient.user.setActivity(text, { type: ActivityType.Custom });

        if (temporaryMs > 0) {
            setTimeout(() => {
                try {
                    if (!botClient.user) return;
                    botClient.user.setActivity('🛒 Stocked Store Operations', { type: ActivityType.Watching });
                } catch (error) {
                    console.error('Failed to reset bot status:', error);
                }
            }, temporaryMs);
        }
    } catch (error) {
        console.error('Failed to update bot status:', error);
    }
}

async function getCryptoAmounts(usdPrice) {
    try {
        const [eth, ltc, btc, sol] = await Promise.all([
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')
        ]);

        return {
            eth: (usdPrice / parseFloat(eth.data.price)).toFixed(6),
            ltc: (usdPrice / parseFloat(ltc.data.price)).toFixed(4),
            btc: (usdPrice / parseFloat(btc.data.price)).toFixed(8),
            sol: (usdPrice / parseFloat(sol.data.price)).toFixed(4)
        };
    } catch (error) {
        console.error('Binance crypto API failed:', error.message);
        return { eth: 'Check live rate', ltc: 'Check live rate', btc: 'Check live rate', sol: 'Check live rate' };
    }
}

function calculatePoints(usdPrice) {
    if (usdPrice <= 0) return 0;
    if (usdPrice <= 100) return 2;
    if (usdPrice <= 500) return 4;
    if (usdPrice <= 1000) return 7;
    return 10;
}

function formatProductName(productKey) {
    const decoPackage = DECO_PACKAGES.find(pkg => productKey === `deco_${pkg.shopPrice}`);
    return decoPackage
        ? `Discord Decoration ($${decoPackage.shopPrice} Shop Tier)`
        : productKey.replace(/_/g, ' ').toUpperCase();
}

function getDecorationDetails(productKey) {
    return productKey.startsWith('deco_')
        ? '\n\nPlease send the exact decoration name or shop link in this ticket. Staff delivers decorations manually via gift link after payment confirmation.'
        : '';
}

const orderRuntime = createOrderRuntime({
    mongoose, botClient, stripe, Inventory, Ledger, adminRoleId: ADMIN_ROLE_ID,
    decoPackages: DECO_PACKAGES, formatProductName, getCryptoAmounts,
    categoryNames: CATEGORY_NAMES, parseAccountEntry
});

// --- STRIPE WEBHOOK ENDPOINT ---
webApp.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }
    try {
        await databaseReady;
        if (!botClient.isReady()) return res.status(503).send('Bot is starting. Retry this event.');
        const handled = await orderRuntime.handleStripeEvent(event);
        if (handled === false && event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
            // Keep payments from pre-update links working and deduplicate them by
            // Stripe session ID. New tickets use saved orders instead.
            const checkout = event.data.object;
            const buyerId = checkout.metadata.discord_user_id;
            const itemId = checkout.metadata.item_id;
            if (!buyerId || !itemId) throw new Error('Legacy checkout is missing buyer or item metadata.');
            const paidCents = checkout.amount_total;
            let points;
            await orderRuntime.store.transaction(async session => {
                await orderRuntime.store.ensureLedger(buyerId, session);
                const user = await Ledger.collection.findOne({ discordId: buyerId }, { session });
                if ((user.purchases || []).some(purchase => purchase.stripeSessionId === checkout.id)) return;
                points = calculatePoints(paidCents / 100);
                await Ledger.collection.updateOne({ discordId: buyerId }, {
                    $inc: { points }, $push: { purchases: { item: itemId, code: 'Manual delivery required', stripeSessionId: checkout.id } }
                }, { session });
            });
            const notices = mongoose.connection.db.collection('shop_legacy_payment_notices');
            const notice = await notices.findOne({ _id: checkout.id });
            if (!notice?.sent) {
                const channel = await botClient.channels.fetch(checkout.metadata.channel_id).catch(error => {
                    if (error.code === 10003) return null;
                    throw error;
                });
                const target = channel || await botClient.channels.fetch(process.env.ORDER_LOG_CHANNEL_ID || '1542337221791711324');
                if (!target?.isTextBased()) throw new Error('Legacy payment is saved but its notification channel is unavailable.');
                await target.send(publicMessage(`**Payment confirmed (pre-update order)** — <@${buyerId}>\n` +
                    `Item: **${formatProductName(itemId)}** • $${(paidCents / 100).toFixed(2)} USD\n` +
                    `${points ?? calculatePoints(paidCents / 100)} points awarded. <@&${ADMIN_ROLE_ID}> Please arrange manual delivery.`,
                    { title: '✅ Payment Confirmed', color: 0x57F287, users: [buyerId], roles: [ADMIN_ROLE_ID],
                        nonce: checkout.id.slice(-20), enforceNonce: true }));
                await notices.updateOne({ _id: checkout.id }, { $set: { sent: true, sentAt: new Date() } }, { upsert: true });
            }
        }
        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('Stripe webhook processing failed:', error);
        return res.status(500).send('Payment processing has not completed. Retry this event.');
    }
});

// --- DISCORD CLIENT INITIALIZATION & COMMAND SYNC ---
botClient.once('clientReady', async () => {
    try {
        console.log(`Bot operational as: ${botClient.user.tag}`);
        orderRuntime.startRecovery();
        botClient.user.setActivity('🛒 Stocked Store Operations', { type: ActivityType.Watching });

        const restApi = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await restApi.put(Routes.applicationCommands(botClient.user.id), { body: [] });
        await restApi.put(
            Routes.applicationGuildCommands(botClient.user.id, '1542259049494610013'),
            { body: orderRuntime.commandDefinitions(appCommands) }
        );
        console.log('Commands synchronized cleanly.');
    } catch (syncError) {
        console.error('Discord initialization or command synchronization failed:', syncError);
    }
});

// --- EVENT ROUTING: REACTION LISTENER ---
botClient.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        if (await orderRuntime.handleReaction(reaction, user)) return;

        if (reaction.message.channel.name?.startsWith('trade-')) {
            if (reaction.emoji.id === '1554592986334105620') await reaction.message.channel.send(publicMessage(
                `**Order confirmed complete by <@${user.id}>!** Thank you for your purchase.`,
                { title: '✅ Order Complete', color: 0x57F287, users: [user.id] }));
            else if (reaction.emoji.id === '1554592934828179476') await reaction.message.channel.send(publicMessage(
                `<@${user.id}> reported a problem with this trade delivery. <@&${ADMIN_ROLE_ID}>, please assist.`,
                { title: '⚠️ Delivery Issue', color: 0xFEE75C, users: [user.id], roles: [ADMIN_ROLE_ID] }));
        }
    } catch (error) {
        console.error('Reaction handling failed:', error);
    }
});

// --- MAIN INTERACTION ROUTER ---
async function handleInteraction(interaction) {
    if (await orderRuntime.handleInteraction(interaction)) return;

    // 1. CHAT INPUT COMMANDS
    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;

        if (['setup-store', 'boost-menu', 'deco-shop', 'restock', 'remove-stock', 'deliver', 'close', 'coupon-store', 'give-coupon', 'give-points', 'view-points'].includes(commandLabel)) {
            if (!interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ content: '🛑 You do not have permission to use this command.', flags: 64 });
            }
        }   

        if (commandLabel === 'give-points') {
            const targetUser = interaction.options.getUser('user');
            const priceToCalculate = interaction.options.getNumber('pricetocalculate');
            const directPoints = interaction.options.getNumber('points');
            const hasPrice = priceToCalculate !== null;
            const hasPoints = directPoints !== null;

            if (hasPrice === hasPoints) {
                return interaction.reply({ content: '<a:error:1554592934828179476> Provide exactly one option: `pricetocalculate` or `points`.', flags: 64 });
            }
            if (hasPrice && (!Number.isFinite(priceToCalculate) || priceToCalculate <= 0)) {
                return interaction.reply({ content: '<a:error:1554592934828179476> The price must be a positive number in USD.', flags: 64 });
            }
            if (hasPoints && (!Number.isSafeInteger(directPoints) || directPoints <= 0)) {
                return interaction.reply({ content: '<a:error:1554592934828179476> Points must be a positive whole number.', flags: 64 });
            }

            const pointsToGive = hasPrice ? calculatePoints(priceToCalculate) : directPoints;
            await interaction.deferReply({ flags: 64 });

            try {
                let newBalance;
                await orderRuntime.store.transaction(async session => {
                    await orderRuntime.store.ensureLedger(targetUser.id, session);
                    const user = await Ledger.collection.findOne({ discordId: targetUser.id }, { session });
                    newBalance = (user.points || 0) + pointsToGive;
                    if (!Number.isSafeInteger(newBalance)) throw new OrderError('This amount would exceed the maximum points balance.');
                    await Ledger.collection.updateOne({ discordId: targetUser.id }, { $inc: { points: pointsToGive } }, { session });
                });

                return interaction.editReply({
                    content: `<a:MTF_Credits:1554593086544412803> Gave **${pointsToGive} points** to <@${targetUser.id}>` +
                        (hasPrice ? ` based on **$${priceToCalculate.toFixed(2)} USD**` : '') +
                        `.\nNew balance: **${newBalance} points**.`
                });
            } catch (err) {
                console.error('Database error in give-points:', err);
                return sendInteractionError(interaction, '<a:error:1554592934828179476> Failed to give points. Please try again later.');
            }
        }

        if (commandLabel === 'view-points') {
            await interaction.deferReply();
            const targetUser = interaction.options.getUser('user');

            try {
                const userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) return interaction.editReply(publicMessage(`<@${targetUser.id}> does not have any records or points on file.`,
                    { title: '👤 No Profile Found', color: 0xFEE75C }));

                const points = userLedger.points || 0;
                const coupons = userLedger.coupons && userLedger.coupons.length > 0 ? userLedger.coupons.map(c => `${c}% Off`).join(', ') : 'None';
                const purchaseCount = userLedger.purchases ? userLedger.purchases.length : 0;

                const profileEmbed = new EmbedBuilder()
                    .setTitle(`👤 User Profile: ${targetUser.username}`)
                    .setThumbnail(targetUser.displayAvatarURL())
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '<a:MTF_Credits:1554593086544412803> Points Balance', value: `\`${points}\``, inline: true },
                        { name: '<:coupon:1554581616112832513> Unused Coupons', value: `\`${coupons}\``, inline: true },
                        { name: '<a:shop1:1554264889491726377> Total Purchases', value: `\`${purchaseCount}\``, inline: true }
                    );

                await interaction.editReply({ embeds: [profileEmbed] });
            } catch (err) {
                console.error('Database error in view-points:', err);
                await sendInteractionError(interaction, '<a:error:1554592934828179476> Failed to fetch user data from the database.');
            }
        }
        if (commandLabel === 'boost-menu') {
            await interaction.deferReply({ flags: 64});
            
            const boostEmbed = new EmbedBuilder()
    .setDescription(
        '# <a:wumpus:1554265012338434078> Discord Boosting Service\n\n' +
        'Select a package below to upgrade your server. Staff will deliver your boosts after payment confirmation.\n\n' +
        '**<a:Termss:1554267208882978896> Terms & Conditions**\n' +
        '• **Duration:** Boosts remain active for 25–30 days (total boosts depend on your chosen tier).\n' +
        '• **No Warranty:** All deliveries are final. We do not provide an ongoing replacement warranty for this service.\n' +
        '• **Non-Transferable:** Once applied, boosts are locked in and cannot be moved to a different server.\n' +
        '• **Server Prep:** You must disable anti-raid bots, verification gates, and server capacity limits before ordering, otherwise the boosters will fail to join.\n' +
        '• **Invite Links:** You must provide a permanent, valid invite link. We are not liable for delivery failures caused by expired or broken links.\n' +
        '• **Support:** Open a ticket immediately if you encounter any issues with your order so we can step in.\n\n' +
        '<a:important:1554267188272308248> **Important:** By purchasing, you confirm your server is properly configured to receive members and that you agree to all terms above.\n\n' +
        '**<:price:1554267169800585227> Pricing Packages**'
    )
    .addFields(
        // Note: Replace the standard emojis below with your custom server emoji codes (e.g., <:crystal:123456789>)
        { name: '<a:boostlogo:1554263092244906005> 2x Boosts (Level 1)', value: '```bash\nPrice:\n$0.99\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 4x Boosts', value: '```bash\nPrice:\n$1.75\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 6x Boosts', value: '```bash\nPrice:\n$2.25\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 8x Boosts (Level 2)', value: '```bash\nPrice:\n$2.75\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 10x Boosts', value: '```bash\nPrice:\n$3.25\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 12x Boosts', value: '```bash\nPrice:\n$3.49\n```', inline: true },
        { name: '<a:boostlogo:1554263092244906005> 14x Boosts (Level 3)', value: '```bash\nPrice:\n$3.99\n```', inline: true }
    )
    .setColor(0xff73fa);

const boostRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
        .setCustomId('buy_boost_ticket')
        .setLabel('Purchase Boosts')
        .setEmoji('<a:shop1:1554264889491726377>')
        .setStyle(ButtonStyle.Primary)
);

// await interaction.reply({ embeds: [boostEmbed], components: [boostRow] });
            const purchaseBtn = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('buy_boost_ticket') // You can route this in your button interaction router later
                    .setLabel('Purchase Boosts')
                    .setEmoji('<a:shop1:1554264889491726377>')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.channel.send({ embeds: [boostEmbed], components: [purchaseBtn] });
            await interaction.editReply({ content: '✅ Boost menu deployed successfully!' });
        }


        if (commandLabel === 'deco-shop') {
            await interaction.deferReply({ flags: 64 });

            const decoEmbed = new EmbedBuilder()
                .setDescription(
                    '# <a:wumpus:1554265012338434078> Discord Decoration Shop\n\n' +
                    'Pick a price tier below to purchase your Discord decoration.\n\n' +
                    '**<a:Termss:1554267208882978896> Order Details**\n' +
                    '• **Delivery:** Staff delivers your decoration manually via gift link after payment confirmation.\n' +
                    '• **Selection:** Send the exact decoration name or Discord shop link in your purchase ticket.\n' +
                    '• **Pricing:** Match your decoration to its shop price. All prices below are in **USD**.\n' +
                    '• **Support:** Staff will help arrange your order and payment inside the ticket.\n\n' +
                    '<a:important:1554267188272308248> **Important:** Select the tier matching the decoration you want before paying.\n\n' +
                    '**<:price:1554267169800585227> Pricing Packages**'
                )
                .addFields(DECO_PACKAGES.map(pkg => ({
                    name: `<a:pastelbolt:1555984930843009064> $${pkg.shopPrice} Shop Tier`,
                    value: `\`\`\`bash\nOur Price:\n$${pkg.price}\n\`\`\``,
                    inline: true
                })))
                .setColor(0xff73fa);

            const purchaseBtn = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('buy_deco_ticket')
                    .setLabel('Purchase Decorations')
                    .setEmoji('<a:shop1:1554264889491726377>')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.channel.send({ embeds: [decoEmbed], components: [purchaseBtn] });
            return interaction.editReply({ content: '✅ Decoration shop deployed successfully!' });
        }

        if (commandLabel === 'give-coupon') {
            await interaction.deferReply({ flags: 64 });
            const targetUser = interaction.options.getUser('user');
            const discountPct = interaction.options.getNumber('discount');
            if (!Number.isInteger(discountPct) || discountPct <= 0 || discountPct >= 100) {
                return interaction.editReply({ content: 'Enter a whole-number discount from 1 to 99.' });
            }

            try {
                await orderRuntime.store.transaction(async session => {
                    await orderRuntime.store.ensureLedger(targetUser.id, session);
                    await Ledger.collection.updateOne({ discordId: targetUser.id }, { $push: { coupons: discountPct } }, { session });
                });

                await interaction.editReply({ content: `✅ Successfully gave a **${discountPct}% Off Coupon** to <@${targetUser.id}>.` });
            } catch (err) {
                console.error('Database error giving coupon:', err);
                await sendInteractionError(interaction, '❌ Failed to update database.');
            }
        }

        if (commandLabel === 'coupon-store') {
            const storeEmbed = new EmbedBuilder()
                .setDescription(
                    '# <:coupon:1554581616112832513> Points & Coupon Store\n\n' +
                    `Earn points automatically with every purchase you make! You can spend your saved points here on discount coupons for your next purchase.\n\n` +
                    `**Point Earnings:**\n` +
                    `• $1 - $100 = 2 Points\n` +
                    `• $101 - $500 = 4 Points\n` +
                    `• $501 - $1000 = 7 Points\n` +
                    `• $1000+ = 10 Points`)
                .setColor(0xFFD700);

            const couponMenu = new StringSelectMenuBuilder()
                .setCustomId('buy_coupon')
                .setPlaceholder('Select a coupon to purchase...')
                .addOptions([
                    { label: '10% Discount Coupon', description: 'Costs 5 points', value: '10', emoji: '<:coupon:1554581616112832513>' },
                    { label: '15% Discount Coupon', description: 'Costs 10 points', value: '15', emoji: '<:coupon:1554581616112832513>' }
                ]);

            await interaction.channel.send({ embeds: [storeEmbed], components: [new ActionRowBuilder().addComponents(couponMenu)] });
            await interaction.reply({ content: '✅ Coupon store deployed.', flags: 64 });
        }

        if (commandLabel === 'setup-store') {
            // 1. Instantly defer to prevent the 3-second timeout
            await interaction.deferReply({ flags: 64 });

            const storeType = interaction.options.getString('store_type');
            const selectedChannelOption = interaction.options.getChannel('channel');
            const customTitle = interaction.options.getString('title') || 'Stocked User Stock';

            if (storeType === 'account') {
                updateBotStatus(`🏷️ Deploying User Catalog`);

                const catalogEmbed = new EmbedBuilder()
                    .setTitle(customTitle)
                    .setDescription(
                        `We DO NOT proxy the same accs seen in the Com. A large majority of accs are directly from the original owners. Largely obtained through private methods which only we know.\n\n` +
                        `🛡️ Every acc is new to com, unverified, and sniped by us (unless stated otherwise). All accs are guaranteed to be safe.\n` +
                        `All acc details can be provided upon enquiry.\n\n` +
                        `↕️ Users are sorted by price in USD, select your budget within the dropdown to see users. All BINs are negotiable.\n\n` +
                        `Payment Methods accepted: 🪙 Crypto, ✨ Clean Limiteds\n\n` +
                        `For an extra +% we can also take: 🅿️ Paypal, 💲 CashApp, 🍎 Apple Pay, ♈ Venmo, 💤 Zelle, 🏦 Bank Transfer and 🍁 Interac.\n\n` +
                        `<a:shop1:1554264889491726377> Select an option below to purchase then make a ticket.`
                    )
                    .setColor(0x2B2D31);

                const tierMenu = new StringSelectMenuBuilder()
                    .setCustomId(`tier_select|${encodeURIComponent(customTitle)}`)
                    .setPlaceholder('Select a tier...')
                    .addOptions([
                        { label: '🔥 High Tier', value: 'high_tier', description: '2 Letters, 3 Digits, Real Words' },
                        { label: '⚡ Mid Tier', value: 'mid_tier', description: '3 Letters, 4 Digits, Clean Compounds' },
                        { label: '🌱 Low Tier', value: 'low_tier', description: 'Triples, 4L, Edgy, Finance, Leetspeak, Other' }
                    ]);

                const targetChannel = await interaction.guild.channels.fetch(selectedChannelOption.id);
                await targetChannel.send({
                    embeds: [catalogEmbed],
                    components: [new ActionRowBuilder().addComponents(tierMenu)]
                });

                // 2. Use editReply instead of reply since we deferred
                await interaction.editReply({ content: '✅ Tier catalog deployed successfully!' });

            } else {
                const productTitle = interaction.options.getString('title');
                const productPrice = interaction.options.getNumber('price');
                const productKey = interaction.options.getString('item_id');
                const robloxLink = interaction.options.getString('catalog_url');
                const thumbnailPic = interaction.options.getString('image_url');
                if (!productTitle || productPrice === null || !productKey) {
                    return interaction.editReply({ content: '❌ Missing required fields for a Single Item forum post.' });
                }

                updateBotStatus(`🏷️ Creating store listing: ${productTitle}`);
                const targetForum = await interaction.guild.channels.fetch(selectedChannelOption.id);

                const embedFields = [
                    { name: '💵 Price', value: `$${productPrice} USD`, inline: true },
                    { name: '📦 Delivery', value: 'Manual delivery after payment confirmation', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }
                ];

                if (robloxLink) embedFields.push({ name: '🔗 Rolimons Link', value: `[View item](${robloxLink})`, inline: false });

                const listingEmbed = new EmbedBuilder()
                    .setTitle(`🛍️ ${productTitle}`.slice(0, 256))
                    .setDescription(`Click on the button below to purchase!`)
                    .setColor(0x2B2D31)
                    .addFields(embedFields);

                if (thumbnailPic) {
                    listingEmbed.setImage(thumbnailPic);
                }

                const buyActionBtn = new ButtonBuilder()
                    .setCustomId(`purchase_action|${productKey}|${productPrice}`)
                    .setLabel(`Purchase ${productTitle}`.substring(0, 80))
                    .setEmoji('<a:shop1:1554264889491726377>')
                    .setStyle(ButtonStyle.Primary);

                await targetForum.threads.create({
                    name: productTitle,
                    message: { embeds: [listingEmbed], components: [new ActionRowBuilder().addComponents(buyActionBtn)] }
                });

                // 3. Use editReply instead of reply since we deferred
                await interaction.editReply({ content: `✅ Successfully created forum post for **${productTitle}**!` });
            }
        }

        if (commandLabel === 'my-codes') {
            const userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            if (!userLedger) return interaction.reply({ content: "You don't have any purchase records on file.", flags: 64 });

            const history = userLedger.purchases;
            const points = userLedger.points || 0;
            const coupons = userLedger.coupons && userLedger.coupons.length > 0 ? userLedger.coupons.map(c => `${c}% Off`).join(', ') : 'None';
            const formattedItems = history.length > 0 ? history.map(entry => `• **${entry.item}**: \`${entry.code}\``).join('\n') : 'No items yet.';

            await interaction.reply({
                content: `**Your Profile**\n⭐ Points: \`${points}\`\n🎟️ Coupons: \`${coupons}\`\n\n**Your Purchase History:**\n${formattedItems}`,
                flags: 64
            });
        }

        if (commandLabel === 'request-limited') {
            const requestEmbed = new EmbedBuilder()
                .setTitle('🔎 Need a Specific Limited or Toycode?')
                .setDescription(
                    `Can't find the item you're looking for? **We'll help track it down.**\n\n` +
                    `We can source **practically any Limited or Toycode** upon request.\n\n` +
                    `<a:time:1554592842935173240> **Sourcing Time:** 12 Hours — 7 Days\n` +
                    `<a:Cash_3D:1554592754875768902> **30% Deposit Required** (Fully refundable if missing)\n\n` +
                    `<a:heist:1554267239992131756> **Start Sourcing:** Open a ticket in <#1542544665969164308>!`
                )
                .setColor(0x3B82F6);

            await interaction.channel.send({ embeds: [requestEmbed] });
            await interaction.reply({ content: '✅ Request Limited embed posted!', flags: 64 });
        }

        if (commandLabel === 'restock') {
            const itemId = interaction.options.getString('item_id');
            updateBotStatus(`📥 Restocking items for: ${itemId.toUpperCase()}`);

            const rawInput = interaction.options.getString('codes');

            const newCodes = rawInput
                .split(/[\r\n,]+|\s+/)
                .map(c => c.trim())
                .filter(c => c.length > 0);

            if (newCodes.length === 0) {
                return interaction.reply({ content: '❌ No valid entries detected in input.', flags: 64 });
            }

            let itemRecord = await Inventory.findOne({ itemId });
            if (!itemRecord) {
                itemRecord = new Inventory({ itemId, codes: [] });
            }

            itemRecord.codes.push(...newCodes);
            await itemRecord.save();

            await interaction.reply({
                content: `✅ Successfully added **${newCodes.length}** account(s)/code(s) to \`${itemId}\`.\n📦 Total Stock: **${itemRecord.codes.length}**`,
                flags: 64
            });
        }

        if (commandLabel === 'stock') {
            updateBotStatus(`📊 Checking inventory stock`);
            const allInventory = await Inventory.find({});
            if (!allInventory || allInventory.length === 0) return interaction.reply(publicMessage('No inventory records found.',
                { title: '📦 Current Inventory Stock' }));

            const stockList = allInventory.map(item => `• **${item.itemId}**: ${item.codes.length} code(s) remaining`).join('\n');
            // Separate large catalogs so every item fits within Discord's embed limits.
            const pages = [];
            for (const line of stockList.split('\n')) {
                if (!pages.length || pages[pages.length - 1].length + line.length + 1 > 4000) pages.push(line);
                else pages[pages.length - 1] += '\n' + line;
            }
            await interaction.reply(publicMessage(pages[0], { title: '📦 Current Inventory Stock' }));
            for (const page of pages.slice(1)) await interaction.followUp(publicMessage(page, { title: '📦 Inventory Continued' }));
        }

        if (commandLabel === 'remove-stock') {
            const itemId = interaction.options.getString('item_id');
            updateBotStatus(`🗑️ Removing stock for: ${itemId.toUpperCase()}`);
            const codesToRemove = interaction.options.getString('codes').split(',').map(c => c.trim());

            let itemRecord = await Inventory.findOne({ itemId });
            if (!itemRecord) return interaction.reply({ content: `❌ Item \`${itemId}\` not found in database.`, flags: 64 });

            const originalLength = itemRecord.codes.length;
            itemRecord.codes = itemRecord.codes.filter(code => !codesToRemove.includes(code));
            await itemRecord.save();

            await interaction.reply({ content: `🗑️ Removed ${originalLength - itemRecord.codes.length} codes from \`${itemId}\`. Remaining: ${itemRecord.codes.length}`, flags: 64 });
        }

    }

    if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        if (customId === 'buy_coupon') {
            await interaction.deferReply({ flags: 64 });
            const discountPct = Number(interaction.values[0]);
            if (![10, 15].includes(discountPct)) throw new OrderError('Invalid coupon selection.');
            const cost = discountPct === 10 ? 5 : 10;

            const result = await Ledger.collection.updateOne({ discordId: interaction.user.id, points: { $gte: cost } }, {
                $inc: { points: -cost }, $push: { coupons: discountPct }
            });
            if (!result.modifiedCount) {
                return interaction.editReply({ content: `❌ Insufficient points! You need **${cost} points** for this coupon.` });
            }

            await interaction.editReply({ content: `🎉 **Redeemed!** Spent **${cost} points** for a **${discountPct}% Off Coupon**.` });
        }

        // A. Tier Selection (Resets public dropdown & sends ephemeral subcategory menu)
        if (customId.startsWith('tier_select')) {
            try {
                const [, encodedTitle] = customId.split('|');
                const selectedTierKey = interaction.values[0];
                const tierData = TIERS[selectedTierKey];

                if (!tierData) {
                    return interaction.reply({ content: '❌ Selected tier data not found.', flags: 64 });
                }

                // Reset public menu instantly
                const freshTierMenu = new StringSelectMenuBuilder()
                    .setCustomId(customId)
                    .setPlaceholder('Select a tier...')
                    .addOptions([
                        { label: '🔥 High Tier', value: 'high_tier', description: '2 Letters, 3 Digits, Real Words' },
                        { label: '⚡ Mid Tier', value: 'mid_tier', description: '3 Letters, 4 Digits, Clean Compounds' },
                        { label: '🌱 Low Tier', value: 'low_tier', description: 'Triples, 4L, Edgy, Finance, Leetspeak, Other' }
                    ]);

                await interaction.update({
                    components: [new ActionRowBuilder().addComponents(freshTierMenu)]
                });

                // Send ephemeral subcategory dropdown
                const subcatMenu = new StringSelectMenuBuilder()
                    .setCustomId(`subcat_select|${encodedTitle}`)
                    .setPlaceholder(`Select a subcategory...`)
                    .addOptions(tierData.subcategories);

                const subcatEmbed = new EmbedBuilder()
                    .setTitle(`${tierData.label}`)
                    .setDescription('Select a subcategory below to view available stock:')
                    .setColor(0x5865F2);

                await interaction.followUp({
                    embeds: [subcatEmbed],
                    components: [new ActionRowBuilder().addComponents(subcatMenu)],
                    flags: 64
                });
            } catch (err) {
                console.error('Error handling tier_select:', err);
                await sendInteractionError(interaction, '❌ An error occurred processing your selection.');
            }
        }
        // B. Subcategory Selection (Fetches stock & user purchase dropdown)
        if (customId.startsWith('subcat_select')) {
            await interaction.deferReply({ flags: 64 });

            const [, encodedTitle] = customId.split('|');
            const storeTitle = encodedTitle ? decodeURIComponent(encodedTitle) : 'Stocked User Stock';
            const selectedSubcat = interaction.values[0];
            const categoryName = CATEGORY_NAMES[selectedSubcat] || selectedSubcat.toUpperCase();

            const itemRecord = await Inventory.findOne({ itemId: selectedSubcat });
            if (!itemRecord || itemRecord.codes.length === 0) {
                return interaction.editReply({ content: `❌ No accounts are currently in stock for **${categoryName}**.` });
            }

            const parsedStock = itemRecord.codes.map(parseAccountEntry);
            const formattedStockList = parsedStock.map(i => i.displayLabel).join('\n');

            const stockEmbed = new EmbedBuilder()
                .setTitle(`${storeTitle} - ${categoryName}`)
                .setDescription(
                    `<a:Termss:1554267208882978896> Before purchase please read our Terms and Conditions in <#1555338590064746576>.\n` +
                    `<:white_user:1554592911679553577> All listed accounts are unverified with no claimed billing unless stated otherwise.\n\n` +
                    `\`\`\`\n${formattedStockList}\n\`\`\``
                )
                .setColor(0x2B2D31);

            const stockOptions = parsedStock.slice(0, 25).map(item => ({
                label: item.displayLabel.substring(0, 100),
                value: item.username.substring(0, 100)
            }));

            const stockMenu = new StringSelectMenuBuilder()
                .setCustomId(`select_stock_user|${selectedSubcat}`)
                .setPlaceholder('Select a user in stock to purchase...')
                .addOptions(stockOptions);

            await interaction.editReply({
                embeds: [stockEmbed],
                components: [new ActionRowBuilder().addComponents(stockMenu)]
            });
        }
        if (customId === 'user_tier_select') {
            const tier = interaction.values[0];
            const subCategories = tier === 'high_tier'
                ? [{ label: 'Rare Words', value: 'cat_rare_words' }]
                : tier === 'mid_tier'
                    ? [{ label: '4 Letters', value: 'cat_4_letters' }]
                    : [{ label: '5 Digits', value: 'cat_5_digits' }];

            const subMenu = new StringSelectMenuBuilder().setCustomId(`user_subcat_select|${tier}`).setPlaceholder('Select subcategory...').addOptions(subCategories);
            await interaction.reply({ embeds: [new EmbedBuilder().setTitle('📂 Select Category').setColor(0x5865F2)], components: [new ActionRowBuilder().addComponents(subMenu)], flags: 64 });
        }

        if (customId.startsWith('user_subcat_select|')) {
            const subCat = interaction.values[0];
            const ticketBtn = new ButtonBuilder().setCustomId(`create_user_ticket|${subCat}`).setLabel('Create Ticket').setStyle(ButtonStyle.Success);
            await interaction.update({ embeds: [new EmbedBuilder().setTitle(`📜 ${subCat.toUpperCase()}`).setColor(0x2B2D31)], components: [new ActionRowBuilder().addComponents(ticketBtn)] });
        }
    }

}

botClient.on('interactionCreate', async interaction => {
    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error(`Interaction failed (${interaction.commandName || interaction.customId || interaction.id}):`, error);
        const detail = error instanceof OrderError ? error.message +
            (error.existingOrder?.channelId ? ` Ticket: <#${error.existingOrder.channelId}>` : '') : undefined;
        await sendInteractionError(interaction, detail);
    }
});

// START SERVER & LOGIN
const port = process.env.PORT || 3000;
webApp.get('/', (req, res) => {
    res.status(200).send('Bot is running');
});
webApp.listen(port, () => console.log(`HTTP Listener running on port ${port}`))
    .on('error', error => {
        console.error('HTTP listener error:', error);
    });

async function loginBot() {
    try {
        await databaseReady;
        await orderRuntime.initialize();
        await botClient.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('Discord login failed:', error);
    }
}

loginBot();

const RENDER_URL = "https://discord-roblox-bot-1fqt.onrender.com/"; 

setInterval(async () => {
  try {
    const response = await fetch(RENDER_URL);
    console.log(`Self-ping status: ${response.status} - Keep-alive active.`);
  } catch (error) {
    console.error("Self-ping failed:", error.message);
  }
}, 10 * 60 * 1000); // <-- Ensure this comma exists!

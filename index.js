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

const ADMIN_ROLE_ID = '1542306776622309437';

// --- DATABASE CONNECTIVITY ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Successfully connected to MongoDB Atlas.'))
    .catch(err => console.error('MongoDB connection error:', err));

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

        if (interaction.deferred && !interaction.replied && interaction.ephemeral !== null) {
            await interaction.editReply({ content, embeds: [], components: [] });
        } else if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content, flags: 64 });
        } else {
            await interaction.reply({ content, flags: 64 });
        }
    } catch (replyError) {
        console.error('Failed to send interaction error response:', replyError);
    }
}

async function deleteOrderChannel(channel) {
    try {
        await channel.delete();
    } catch (error) {
        console.error('Order channel deletion failed:', error);
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

function generatePaymentMenu(productKey, productPrice, channelId) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`payment_select|${productKey}|${productPrice}|${channelId}`)
        .setPlaceholder('Choose your payment method...')
        .addOptions([
            { label: 'Pay with Card (Stripe)', description: 'Pay by Credit/Debit card; staff delivers manually', value: 'select_stripe', emoji: '<:stripe:1554263177829687398>' },
            { label: 'Pay with Cryptocurrency', description: 'Pay using ETH, LTC, BTC, or SOL', value: 'select_crypto', emoji: '<:crypto:1554263320997920799>' },
            { label: 'Other', description: 'PayPal, Limiteds, or another payment method', value: 'select_other', emoji: '<:dots:1555973916944637952>' }
        ]);
    return new ActionRowBuilder().addComponents(selectMenu);
}

function getCancelButtonRow() {
    const cancelBtn = new ButtonBuilder()
        .setCustomId('close_order')
        .setLabel('Cancel Order')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('<:trashcan:1554593006596657262>');
    return new ActionRowBuilder().addComponents(cancelBtn);
}

// --- STRIPE WEBHOOK ENDPOINT ---
webApp.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(req.body, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (parseError) {
        return res.status(400).send(`Webhook Error: ${parseError.message}`);
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        try {
            const session = stripeEvent.data.object;
            if (session.payment_status !== 'paid') {
                return res.status(200).json({ received: true });
            }

            const buyerDiscordId = session.metadata.discord_user_id;
            const targetItemId = session.metadata.item_id;
            const channelId = session.metadata.channel_id;
            const usdPricePaid = session.amount_total / 100;

            updateBotStatus(`💳 Payment received! Awaiting manual delivery of ${targetItemId.toUpperCase()}...`);

            let userLedger = await Ledger.findOne({ discordId: buyerDiscordId });
            if (!userLedger) {
                userLedger = new Ledger({ discordId: buyerDiscordId, purchases: [], points: 0, coupons: [] });
            }
            
            const pointsEarned = calculatePoints(usdPricePaid);
            userLedger.points += pointsEarned;
            userLedger.purchases.push({ item: targetItemId, code: 'Manual delivery required' });
            await userLedger.save();

            const orderChannel = await botClient.channels.fetch(channelId);
            if (orderChannel) {
                await orderChannel.send(
                    `<a:confirm:1554592986334105620> **Payment Confirmed!** Thank you for your purchase, <@${buyerDiscordId}>.\n` +
                    `<a:MTF_Credits:1554593086544412803> You earned **${pointsEarned} points** for this transaction!\n\n` +
                    `Your order for **${targetItemId.replace(/_/g, ' ').toUpperCase()}** will be delivered manually by staff. Please wait here for assistance.\n` +
                    `<a:be:1554263397842026507> <@&${ADMIN_ROLE_ID}> **This order has been paid for and requires manual delivery!**`
                );
            }
        } catch (dbErr) {
            console.error('Error handling checkout completion webhook:', dbErr);
        }
    }

    res.status(200).json({ received: true });
});

// --- DISCORD CLIENT INITIALIZATION & COMMAND SYNC ---
botClient.once('clientReady', async () => {
    try {
        console.log(`Bot operational as: ${botClient.user.tag}`);
        botClient.user.setActivity('🛒 Stocked Store Operations', { type: ActivityType.Watching });

        const restApi = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await restApi.put(Routes.applicationCommands(botClient.user.id), { body: [] });
        await restApi.put(
            Routes.applicationGuildCommands(botClient.user.id, '1542259049494610013'),
            { body: appCommands }
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

        if (reaction.message.channel.name?.startsWith('trade-')) {
            if (reaction.emoji.id === '1554592986334105620') await reaction.message.channel.send(`<a:confirm:1554592986334105620> **Order confirmed complete by <@${user.id}>!** Thank you for your purchase.`);
            else if (reaction.emoji.id === '1554592934828179476') await reaction.message.channel.send(`<a:error:1554592934828179476> **ISSUE REPORTED:** <@&${ADMIN_ROLE_ID}>, <@${user.id}> reported a problem with this trade delivery! Please assist.`);
        }
    } catch (error) {
        console.error('Reaction handling failed:', error);
    }
});

// --- MAIN INTERACTION ROUTER ---
async function handleInteraction(interaction) {

    // 1. CHAT INPUT COMMANDS
    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;

        if (['setup-store', 'boost-menu','restock', 'remove-stock', 'deliver', 'close', 'coupon-store', 'give-coupon', 'view-points'].includes(commandLabel)) {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ content: '🛑 You do not have permission to use this command.', flags: 64 });
            }
        }   

        if (commandLabel === 'view-points') {
            await interaction.deferReply();
            const targetUser = interaction.options.getUser('user');

            try {
                const userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) return interaction.editReply({ content: `<a:error:1554592934828179476> <@${targetUser.id}> does not have any records or points on file.` });

                const points = userLedger.points || 0;
                const coupons = userLedger.coupons && userLedger.coupons.length > 0 ? userLedger.coupons.map(c => `${c}% Off`).join(', ') : 'None';
                const purchaseCount = userLedger.purchases ? userLedger.purchases.length : 0;

                const profileEmbed = new EmbedBuilder()
                    .setTitle(`<:white_user:1554592911679553577> User Profile: ${targetUser.username}`)
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


        if (commandLabel === 'give-coupon') {
            await interaction.deferReply({ flags: 64 });
            const targetUser = interaction.options.getUser('user');
            const discountPct = interaction.options.getNumber('discount');

            try {
                let userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) userLedger = new Ledger({ discordId: targetUser.id, purchases: [], points: 0, coupons: [] });

                userLedger.coupons.push(discountPct);
                await userLedger.save();

                await interaction.editReply({ content: `✅ Successfully gave a **${discountPct}% Off Coupon** to <@${targetUser.id}>.` });
            } catch (err) {
                console.error('Database error giving coupon:', err);
                await sendInteractionError(interaction, '❌ Failed to update database.');
            }
        }

        if (commandLabel === 'coupon-store') {
            const storeEmbed = new EmbedBuilder()
                .setTitle('<:coupon:1554581616112832513> Points & Coupon Store')
                .setDescription(`Earn points automatically with every purchase you make! You can spend your saved points here on discount coupons for your next purchase.\n\n` +
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
                    { name: 'Price', value: `$${productPrice} USD`, inline: true },
                    { name: 'Delivery', value: 'Manual delivery after payment confirmation', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }
                ];

                if (robloxLink) embedFields.push({ name: 'Rolimons Link', value: `[View item](${robloxLink})`, inline: false });

                const listingEmbed = new EmbedBuilder()
                    .setTitle(`${productTitle}`)
                    .setDescription(`Click on the button below to purchase!`)
                    .setColor(0x2B2D31)
                    .addFields(embedFields);

                if (thumbnailPic) {
                    listingEmbed.setImage(thumbnailPic);
                }

                const buyActionBtn = new ButtonBuilder()
                    .setCustomId(`purchase_action|${productKey}|${productPrice}`)
                    .setLabel(`Purchase ${productTitle}`.substring(0, 80))
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
                .setTitle('<a:aPES_Magnifying:1554592881707319448> Need a Specific Limited or Toycode?')
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
            if (!allInventory || allInventory.length === 0) return interaction.reply({ content: 'No inventory records found.' });

            const stockList = allInventory.map(item => `• **${item.itemId}**: ${item.codes.length} code(s) remaining`).join('\n');
            await interaction.reply({ content: `<a:box:1554592797733163099> **Current Inventory Stock:**\n${stockList}` });
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

        if (commandLabel === 'deliver') {
            const targetUser = interaction.options.getUser('buyer');
            const itemId = interaction.options.getString('item_id');
            const itemPrice = interaction.options.getNumber('price') || 0;
            const specificAccount = interaction.options.getString('specific_account');

            if (!interaction.channel.name.startsWith('trade-')) return interaction.reply({ content: '🛑 Must be inside a trade channel.', flags: 64 });

            try {
                const itemRecord = await Inventory.findOne({ itemId });
                if (!itemRecord || itemRecord.codes.length === 0) return interaction.reply({ content: `❌ Stock empty for \`${itemId}\`!`, flags: 64 });

                let deliveredCode;

                // If the admin provided a specific account name, search the array for it
                if (specificAccount) {
                    const codeIndex = itemRecord.codes.findIndex(c => c.toLowerCase().includes(specificAccount.toLowerCase()));
                    if (codeIndex === -1) {
                        return interaction.reply({ content: `❌ Could not find account matching \`${specificAccount}\` in category \`${itemId}\`.`, flags: 64 });
                    }
                    // Remove that exact account from the database list
                    deliveredCode = itemRecord.codes.splice(codeIndex, 1)[0];
                } else {
                    // If no specific account was provided, pull the first entry for this staff-requested delivery.
                    deliveredCode = itemRecord.codes.shift();
                }

                await itemRecord.save();

                let userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) userLedger = new Ledger({ discordId: targetUser.id, purchases: [], points: 0, coupons: [] });

                const pointsEarned = calculatePoints(itemPrice);
                userLedger.purchases.push({ item: itemId, code: deliveredCode });
                if (pointsEarned > 0) userLedger.points += pointsEarned;
                await userLedger.save();

                deliveredCode = deliveredCode.replace(/:.*$/, ''); // Remove any price info from the code for privacy
                
                const deliveryEmbed = new EmbedBuilder()
                    .setTitle('<a:Delivery:1554592662013739109> Order Delivery')
                    .setDescription(`Code for **${itemId.toUpperCase()}**:\n\`\`\`${deliveredCode}\`\`\``)
                    .setColor(0x00FF00);

                await interaction.reply({ content: `✅ Code pulled and sent to channel.`, flags: 64 });
                await interaction.channel.send({ content: `Hey <@${targetUser.id}>! Here is your delivery:`, embeds: [deliveryEmbed] });
            } catch (err) {
                console.error('Error delivering code:', err);
                await sendInteractionError(interaction, 'Error delivering code.');
            }
        }

        if (commandLabel === 'close') {
            const status = interaction.options.getString('status');
            const method = interaction.options.getString('method') || 'Unknown Method';
            const price = interaction.options.getNumber('price');
            const buyer = interaction.options.getUser('buyer');
            const channel = interaction.channel;

            if (!channel.name.startsWith('trade-')) return interaction.reply({ content: '🛑 Must be inside a trade channel.', flags: 64 });

            await interaction.reply({ content: '🔒 Closing channel...', flags: 64 });

            if (status === 'success') {
                if (buyer && price) {
                    let userLedger = await Ledger.findOne({ discordId: buyer.id });
                    if (!userLedger) userLedger = new Ledger({ discordId: buyer.id, purchases: [], points: 0, coupons: [] });
                    userLedger.points += calculatePoints(price);
                    await userLedger.save();
                }

                const logChannel = await interaction.guild.channels.fetch('1542337221791711324').catch(() => null);
                if (logChannel) {
                    const itemsold = channel.name.split('-')[1] || 'Unknown Item';
                    const receiptEmbed = new EmbedBuilder()
                        .setTitle('<:Receipt:1554592625066254356> New Successful Sale')
                        .setColor(0x00FF00)
                        .addFields(
                            { name: '<a:box:1554592797733163099> Item Sold', value: `\`${itemsold}\``, inline: true },
                            { name: '<:stripe:1554263177829687398> Payment Method', value: `\`${method}\``, inline: true }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [receiptEmbed] });
                }
            }

            setTimeout(() => deleteOrderChannel(channel), 4000);
        }
    }

    // 2. BUTTON INTERACTION ROUTER
    if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith('purchase_action|')) {
            await interaction.deferReply({ flags: 64 });

            const [, productKey, productPrice] = customId.split('|');
            const sanitizedUser = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';

            try {
                const tradeChannel = await interaction.guild.channels.create({
                    name: `trade-${productKey.toLowerCase()}-${sanitizedUser}`.substring(0, 100),
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });

                let userLedger = await Ledger.findOne({ discordId: interaction.user.id });

                if (userLedger && userLedger.coupons && userLedger.coupons.length > 0) {
                    const couponEmbed = new EmbedBuilder()
                        .setTitle('<:coupon:1554581616112832513> Discount Coupon Available!')
                        .setDescription(`You have available coupons! Would you like to apply a coupon to this purchase?`)
                        .setColor(0xFFD700);

                    const couponRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`use_coupon_yes|${productKey}|${productPrice}`).setLabel('Use Coupon').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`use_coupon_no|${productKey}|${productPrice}`).setLabel('Skip Coupon').setStyle(ButtonStyle.Secondary)
);

                    await tradeChannel.send({ content: `<@${interaction.user.id}>`, embeds: [couponEmbed], components: [couponRow] });
                } else {
                    const checkoutEmbed = new EmbedBuilder()
                        .setTitle('<a:folder:1554593038003609620> Secure Checkout Portal')
                        .setDescription(`Order for **${productKey.toUpperCase()}**.\nTotal Price: \`$${productPrice} USD\``)
                        .setColor(0x5865F2);

                    await tradeChannel.send({
                        content: `<@${interaction.user.id}>`,
                        embeds: [checkoutEmbed],
                        components: [generatePaymentMenu(productKey, productPrice, tradeChannel.id), getCancelButtonRow()]
                    });
                }

                await interaction.editReply({ content: `✅ Order channel created: <#${tradeChannel.id}>` });
            } catch (err) {
                console.error('Channel creation error:', err);
                await sendInteractionError(interaction, '❌ Failed to create trade channel. Ensure the bot has "Manage Channels" permissions.');
            }
        }

        if (customId.startsWith('use_coupon_yes|')) {
            const [, productKey, productPrice] = customId.split('|');
            let userLedger = await Ledger.findOne({ discordId: interaction.user.id });

            const uniqueCoupons = [...new Set(userLedger.coupons)];
            const options = uniqueCoupons.map(pct => ({
                label: `Apply ${pct}% Off Coupon`,
                value: pct.toString(),
                emoji: '<:coupon:1554581616112832513>'
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`apply_coupon|${productKey}|${productPrice}`)
                .setPlaceholder('Select which coupon to apply...')
                .addOptions(options);

            await interaction.update({
                embeds: [new EmbedBuilder().setTitle('<:coupon:1554581616112832513> Select Coupon').setDescription('Choose your coupon below:')],
                components: [new ActionRowBuilder().addComponents(selectMenu), getCancelButtonRow()]
            });
        }

        if (customId.startsWith('use_coupon_no|')) {
    const [, productKey, productPrice] = customId.split('|');
    
    // Removes underscores and capitalizes (e.g., "6_boosts" -> "6 BOOSTS")
    const formattedName = productKey.replace(/_/g, ' ').toUpperCase(); 

    const polishedEmbed = new EmbedBuilder()
        .setTitle('<a:folder:1554593038003609620> Secure Checkout Portal')
        .setDescription(`Order for **${formattedName}**.\nTotal Price: \`$${productPrice} USD\``)
        .setColor(0x5865F2);

    await interaction.update({
        embeds: [polishedEmbed],
        components: [generatePaymentMenu(productKey, productPrice, interaction.channelId), getCancelButtonRow()]
    });
}

        if (customId.startsWith('open_tx_modal|')) {
            const [, productKey] = customId.split('|');
            const txModal = new ModalBuilder().setCustomId(`submit_tx_form|${productKey}`).setTitle('Transaction Proof');
            const txInput = new TextInputBuilder().setCustomId('tx_hash_input').setLabel('Transaction Hash').setStyle(TextInputStyle.Short).setRequired(true);
            txModal.addComponents(new ActionRowBuilder().addComponents(txInput));
            await interaction.showModal(txModal);
        }

        if (customId === 'close_order') {
            await interaction.reply({ content: '<:trashcan:1554593006596657262> Order cancelled. Channel closing...' });
            setTimeout(() => deleteOrderChannel(interaction.channel), 2000);
        }

        if (customId === 'buy_boost_ticket') {
    await interaction.deferReply({ flags: 64 });
    
    const sanitizedUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    try {
        const ticketChannel = await interaction.guild.channels.create({
            name: `trade-${sanitizedUsername}-boosts`.substring(0, 100),
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });

        // Add the dropdown menu inside the ticket
        const packageMenu = new StringSelectMenuBuilder()
    .setCustomId('select_boost_package')
    .setPlaceholder('Select your boost package...')
    .addOptions([
        { label: '2x Boosts (Level 1)', value: '2_boosts|0.99', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '4x Boosts', value: '4_boosts|1.75', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '6x Boosts', value: '6_boosts|2.25', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '8x Boosts (Level 2)', value: '8_boosts|2.75', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '10x Boosts', value: '10_boosts|3.25', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '12x Boosts', value: '12_boosts|3.49', emoji: '<a:boostlogo:1554263092244906005>' },
        { label: '14x Boosts (Level 3)', value: '14_boosts|3.99', emoji: '<a:boostlogo:1554263092244906005>' }
    ]);

        const welcomeEmbed = new EmbedBuilder()
            .setTitle('<a:wumpus:1554265012338434078> Server Boost Purchase')
            .setDescription(`Welcome <@${interaction.user.id}>!\n\nPlease select the exact package you want from the menu below to calculate pricing and apply any coupons.`)
            .setColor(0xff73fa);

        await ticketChannel.send({
            content: `<@${interaction.user.id}>`,
            embeds: [welcomeEmbed],
            components: [new ActionRowBuilder().addComponents(packageMenu), getCancelButtonRow()]
        });

        await interaction.editReply({ content: `✅ Boost ticket created: <#${ticketChannel.id}>` });
    } catch (err) {
        console.error('Boost ticket error:', err);
        await sendInteractionError(interaction, '❌ Failed to create boost ticket.');
    }
}


        if (customId.startsWith('create_user_ticket|')) {
            await interaction.deferReply({ flags: 64 });
            const [, categoryName] = customId.split('|');
            const sanitizedUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');

            try {
                const ticketChannel = await interaction.guild.channels.create({
                    name: `trade-${categoryName.toLowerCase().replace(/\s/g, '-')}-${sanitizedUsername}`.substring(0, 100),
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });

                const welcomeEmbed = new EmbedBuilder()
                    .setTitle('🎫 Account Purchase Ticket')
                    .setDescription(`Welcome <@${interaction.user.id}>!\n\nRequested Category: **${categoryName}**`)
                    .setColor(0x5865F2);

                await ticketChannel.send({
                    content: `<@${interaction.user.id}> | <@&${ADMIN_ROLE_ID}>`,
                    embeds: [welcomeEmbed],
                    components: [getCancelButtonRow()]
                });

                await interaction.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
            } catch (err) {
                console.error('Ticket error:', err);
                await sendInteractionError(interaction, '❌ Failed to create ticket.');
            }
        }
    }

    // 3. SELECT MENU INTERACTION ROUTER
    if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;

        if (customId === 'select_boost_package') {
            await interaction.deferUpdate();
            
            const [productKey, productPrice] = interaction.values[0].split('|');
            let userLedger = await Ledger.findOne({ discordId: interaction.user.id });

            if (userLedger && userLedger.coupons && userLedger.coupons.length > 0) {
                const couponEmbed = new EmbedBuilder()
                    .setTitle('<:coupon:1554581616112832513> Discount Coupon Available!')
                    .setDescription(`You have available coupons! Would you like to apply a coupon to this purchase?`)
                    .setColor(0xFFD700);

                const couponRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`use_coupon_yes|${productKey}|${productPrice}`).setLabel('Use Coupon').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`use_coupon_no|${productKey}|${productPrice}`).setLabel('Skip Coupon').setStyle(ButtonStyle.Secondary)
                );
                
                await interaction.editReply({ embeds: [couponEmbed], components: [couponRow] });
            } else {
                const formattedName = productKey.replace(/_/g, ' ').toUpperCase();
                const checkoutEmbed = new EmbedBuilder()
                    .setTitle('<a:folder:1554593038003609620> Secure Checkout Portal')
                    .setDescription(`Order for **${formattedName}**.\nTotal Price: \`$${productPrice} USD\``)
                    .setColor(0x5865F2);

                await interaction.editReply({
                    embeds: [checkoutEmbed],
                    components: [generatePaymentMenu(productKey, productPrice, interaction.channel.id), getCancelButtonRow()]
                });
            }
}
        if (customId === 'buy_coupon') {
            await interaction.deferReply({ flags: 64 });
            const discountPct = parseInt(interaction.values[0]);
            const cost = discountPct === 10 ? 5 : 10;

            let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            if (!userLedger || (userLedger.points || 0) < cost) {
                return interaction.editReply({ content: `❌ Insufficient points! You need **${cost} points** for this coupon.` });
            }

            userLedger.points -= cost;
            userLedger.coupons.push(discountPct);
            await userLedger.save();

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
        if (customId.startsWith('select_stock_user|')) {
            await interaction.deferReply({ flags: 64 });
            const [, categoryId] = customId.split('|');
            const selectedUsername = interaction.values[0];
            const sanitizedBuyer = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');

            try {
                const ticketChannel = await interaction.guild.channels.create({
                    name: `trade-${selectedUsername.toLowerCase()}-${sanitizedBuyer}`.substring(0, 100),
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });

                const welcomeEmbed = new EmbedBuilder()
                    .setTitle('🎫 Account Purchase Ticket')
                    .setDescription(`Welcome <@${interaction.user.id}>!\n\nRequested Account: **@${selectedUsername}**\nCategory: **${(CATEGORY_NAMES[categoryId] || categoryId).toUpperCase()}**\n\nSupport staff will assist you shortly.`)
                    .setColor(0x5865F2);

                await ticketChannel.send({
                    content: `<@${interaction.user.id}> | <@&${ADMIN_ROLE_ID}>`,
                    embeds: [welcomeEmbed],
                    components: [getCancelButtonRow()]
                });

                await interaction.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
            } catch (err) {
                console.error('Ticket error:', err);
                await sendInteractionError(interaction, '❌ Failed to create ticket channel.');
            }
        }

        if (customId.startsWith('apply_coupon|')) {
            await interaction.deferUpdate();
            const [, productKey, originalPrice] = customId.split('|');
            const discountPct = parseInt(interaction.values[0]);

            let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            const couponIndex = userLedger.coupons.indexOf(discountPct);

            if (couponIndex > -1) {
    userLedger.coupons.splice(couponIndex, 1);
    await userLedger.save();

    // Removes underscores and capitalizes (e.g., "6_boosts" -> "6 BOOSTS")
    const formattedName = productKey.replace(/_/g, ' ').toUpperCase();
    const newPrice = (parseFloat(originalPrice) * (1 - (discountPct / 100))).toFixed(2);
    
    const discountedEmbed = new EmbedBuilder()
        .setTitle('<a:folder:1554593038003609620> Secure Checkout Portal (Discount Applied)')
        .setDescription(`Order for **${formattedName}**\nNew Price: \`$${newPrice} USD\` <:price:1554267169800585227>`)
        .setColor(0x00FF00);

    await interaction.editReply({ 
        embeds: [discountedEmbed], 
        components: [generatePaymentMenu(productKey, newPrice, interaction.channel.id), getCancelButtonRow()] 
    });
}
        }

        if (customId.startsWith('payment_select|')) {
            const [, productKey, productPrice, channelId] = customId.split('|');
            const selectedValue = interaction.values[0];
            await interaction.deferUpdate();
            const orderChannel = await interaction.guild.channels.fetch(channelId);

            if (selectedValue === 'select_stripe') {

                // Calculate the 5% processing fee
                const feeAmount = (parseFloat(productPrice) * 0.05);
                const finalPrice = (parseFloat(productPrice) + feeAmount).toFixed(2);

                let stripeSession;
                try {
                    stripeSession = await stripe.checkout.sessions.create({
                        payment_method_types: ['card'],
                        line_items: [{
                            price_data: {
                                currency: 'usd',
                                product_data: { name: productKey.toUpperCase() + ' (+5% Processing Fee)' },
                                // Update the unit amount to charge the final price with the fee included
                                unit_amount: Math.round(parseFloat(finalPrice) * 100),
                            },
                            quantity: 1,
                        }],
                        mode: 'payment',
                        success_url: 'https://discord.com',
                        cancel_url: 'https://discord.com',
                        metadata: {
                            discord_user_id: interaction.user.id,
                            item_id: productKey,
                            channel_id: orderChannel.id
                        }
                    });
                } catch (stripeError) {
                    console.error('Stripe checkout creation failed:', stripeError);
                    await sendInteractionError(interaction, '<a:error:1554592934828179476> Unable to create a Stripe checkout link. Please try again later or contact support.');
                    return;
                }

                const checkoutEmbed = new EmbedBuilder()
                    .setTitle('<:stripe:1554263177829687398> Stripe Card Checkout')
                    .setDescription(`Click below to pay safely. Once payment is confirmed, staff will deliver your order manually.\n\n<a:important:1554267188272308248> *A 5% processing fee ($${feeAmount.toFixed(2)}) has been added to your total.*`)
                    .setColor(0x635BFF);

                // Update the button label to show the final price with the fee included
                const payBtn = new ButtonBuilder()
                    .setLabel(`Pay $${finalPrice} via Stripe`)
                    .setURL(stripeSession.url)
                    .setStyle(ButtonStyle.Link);
                
                await orderChannel.send({ embeds: [checkoutEmbed], components: [new ActionRowBuilder().addComponents(payBtn, getCancelButtonRow().components[0])] });
                await interaction.message.delete().catch(() => { });
            }

            if (selectedValue === 'select_crypto') {
                const amounts = await getCryptoAmounts(parseFloat(productPrice));

                const cryptoEmbed = new EmbedBuilder()
                    .setTitle('<:crypto:1554263320997920799> Crypto Payment Gateway')
                    .setDescription(`Send exact live amount for **$${productPrice} USD**. Once staff verifies your payment, your order will be delivered manually.`)
                    .setColor(0xF7931A)
                    .addFields(
                        { name: '<:eth:1554263242937860127> ETH', value: `\`\`\`${amounts.eth} ETH\`\`\`\n\`\`\`0x42d01fE1f89C6cDE28ef7a34Ef5A7B452eD6B271\`\`\`` },
                        { name: '<:LTC:1554263223325171793> LTC', value: `\`\`\`${amounts.ltc} LTC\`\`\`\n\`\`\`MWSeYJ3qgm3j5yYGGFimu5ebSzHA9oUvBy\`\`\`` },
                        { name: '<:BTC:1554263205331738634> BTC', value: `\`\`\`${amounts.btc} BTC\`\`\`\n\`\`\`34hRphphvMtvqiWPawAESR1bxkfvUoFNhh\`\`\`` },
                        { name: '<:sol:1554263160041640036> SOL', value: `\`\`\`${amounts.sol} SOL\`\`\`\n\`\`\`222P8wKAC2s2UcfNyANYre8yVKjU1c3C3MA7mYqK92ZB\`\`\`` }
                    );

                const submitTxBtn = new ButtonBuilder().setCustomId(`open_tx_modal|${productKey}`).setLabel('Submit Transaction Hash').setStyle(ButtonStyle.Success);
                await orderChannel.send({ embeds: [cryptoEmbed], components: [new ActionRowBuilder().addComponents(submitTxBtn, getCancelButtonRow().components[0])] });
                await interaction.message.delete().catch(() => { });
            }

            if (selectedValue === 'select_other') {
                const otherEmbed = new EmbedBuilder()
                    .setTitle('<:dots:1555973916944637952> Other Payment Methods')
                    .setDescription(
                        `Order for **${productKey.replace(/_/g, ' ').toUpperCase()}**.\nTotal Price: \`$${productPrice} USD\`\n\n` +
                        `Please list what you would like to pay with in this ticket (for example: PayPal, Limiteds, or another payment method).\n\n` +
                        `Staff will discuss the payment details with you and deliver your order manually once payment is confirmed.`
                    )
                    .setColor(0x5865F2);

                await orderChannel.send({
                    content: `<@${interaction.user.id}> | <@&${ADMIN_ROLE_ID}>`,
                    embeds: [otherEmbed],
                    components: [getCancelButtonRow()]
                });
                await interaction.message.delete().catch(() => { });
            }
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

    // 4. MODAL SUBMIT ROUTER
    if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_tx_form|')) {
        const [, productKey] = interaction.customId.split('|');
        const userTxProof = interaction.fields.getTextInputValue('tx_hash_input');

        const confirmationEmbed = new EmbedBuilder()
            .setTitle('<a:heist:1554267239992131756> Transaction Submitted')
            .setDescription(`Item: \`${productKey}\`\nHash:\n\`\`\`${userTxProof}\`\`\``)
            .setColor(0x00FF00);

        await interaction.reply({ embeds: [confirmationEmbed] });
        await interaction.channel.send(`<a:be:1554263397842026507> <@&${ADMIN_ROLE_ID}>, <@${interaction.user.id}> submitted transaction proof for **${productKey}**!`);
    }
}

botClient.on('interactionCreate', async interaction => {
    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error(`Interaction failed (${interaction.commandName || interaction.customId || interaction.id}):`, error);
        await sendInteractionError(interaction);
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

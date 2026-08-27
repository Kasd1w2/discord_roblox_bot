require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
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
    PermissionFlagsBits
} = require('discord.js');

// --- DATABASE CONNECTIVITY ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Successfully connected to MongoDB Atlas.'))
    .catch(err => console.error('MongoDB connection error:', err));

const InventorySchema = new mongoose.Schema({
    itemId: { type: String, required: true, unique: true },
    codes: [String]
});
const Inventory = mongoose.model('Inventory', InventorySchema);

const LedgerSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    purchases: [{ item: String, code: String }],
    points: { type: Number, default: 0 },
    coupons: [{ type: Number }] // Stores array of discounts, e.g. [10, 15]
});
const Ledger = mongoose.model('Ledger', LedgerSchema);

const webApp = express();
const botClient = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ] 
});

// --- HELPER FUNCTIONS ---
async function getCryptoAmounts(usdPrice) {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,litecoin,bitcoin,solana&vs_currencies=usd', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const prices = response.data;

        return {
            eth: (usdPrice / prices.ethereum.usd).toFixed(6),
            ltc: (usdPrice / prices.litecoin.usd).toFixed(4),
            btc: (usdPrice / prices.bitcoin.usd).toFixed(8),
            sol: (usdPrice / prices.solana.usd).toFixed(4)
        };
    } catch (error) {
        console.error('CoinGecko API failed, attempting backup API (CryptoCompare)...', error.message);
        
        try {
            const backupRes = await axios.get('https://min-api.cryptocompare.com/data/pricemulti?fsyms=ETH,LTC,BTC,SOL&tsyms=USD');
            const data = backupRes.data;

            return {
                eth: (usdPrice / data.ETH.USD).toFixed(6),
                ltc: (usdPrice / data.LTC.USD).toFixed(4),
                btc: (usdPrice / data.BTC.USD).toFixed(8),
                sol: (usdPrice / data.SOL.USD).toFixed(4)
            };
        } catch (backupError) {
            console.error('Backup crypto API also failed:', backupError.message);
            return { eth: 'Check live rate', ltc: 'Check live rate', btc: 'Check live rate', sol: 'Check live rate' };
        }
    }
}

function calculatePoints(usdPrice) {
    if (usdPrice <= 0) return 0;
    if (usdPrice <= 100) return 2;
    if (usdPrice <= 500) return 4;
    if (usdPrice <= 1000) return 7;
    return 10; // $1000+
}

function generatePaymentMenu(productKey, productPrice, channelId) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`payment_select|${productKey}|${productPrice}|${channelId}`)
        .setPlaceholder('📂 Choose your payment method...')
        .addOptions([
            { label: 'Pay with Card (Stripe)', description: 'Instant automated delivery via Credit/Debit card', value: 'select_stripe', emoji: '💳' },
            { label: 'Pay with Cryptocurrency', description: 'Pay using ETH, LTC, BTC, or SOL', value: 'select_crypto', emoji: '🪙' },
            { label: 'Cancel Order', description: 'Discard transaction and close channel', value: 'select_cancel', emoji: '🗑️' }
        ]);
    return new ActionRowBuilder().addComponents(selectMenu);
}

// --- STRIPE WEBHOOK ENDPOINT (AUTOMATED CODE DELIVERY & POINTS) ---
webApp.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(req.body, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (parseError) {
        return res.status(400).send(`Webhook Error: ${parseError.message}`);
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object;
        const buyerDiscordId = session.metadata.discord_user_id;
        const targetItemId = session.metadata.item_id;
        const channelId = session.metadata.channel_id;
        const usdPricePaid = session.amount_total / 100; // Convert cents to dollars

        try {
            const itemRecord = await Inventory.findOne({ itemId: targetItemId });
            
            if (!itemRecord || itemRecord.codes.length === 0) {
                console.error(`CRITICAL: User ${buyerDiscordId} paid for ${targetItemId} but stock is empty!`);
                return res.status(200).json({ received: true }); 
            }

            const purchasedCode = itemRecord.codes.shift();
            await itemRecord.save();

            let userLedger = await Ledger.findOne({ discordId: buyerDiscordId });
            if (!userLedger) {
                userLedger = new Ledger({ discordId: buyerDiscordId, purchases: [], points: 0, coupons: [] });
            }
            
            const pointsEarned = calculatePoints(usdPricePaid);
            userLedger.purchases.push({ item: targetItemId, code: purchasedCode });
            userLedger.points += pointsEarned;
            await userLedger.save();

            const orderChannel = await botClient.channels.fetch(channelId);
            if (orderChannel) {
                const deliveryMessage = await orderChannel.send(
                    `✅ **Payment Confirmed!** Thank you for your purchase, <@${buyerDiscordId}>.\n` +
                    `⭐ You earned **${pointsEarned} points** for this transaction!\n\n` +
                    `Here is your code for **${targetItemId}**:\n` +
                    `\`\`\`${purchasedCode}\`\`\`\n` +
                    `Please use the reactions below to confirm delivery or report an issue.`
                );
                await deliveryMessage.react('✅');
                await deliveryMessage.react('❌');
                await orderChannel.send(`🙏 Thank you again for your business, <@${buyerDiscordId}>! If you have a moment, please drop a vouch in <#1542340439166820434>.`);
            }

        } catch (dbErr) {
            console.error('Error handling checkout completion webhook:', dbErr);
        }
    }

    return res.status(200).json({ received: true });
});

// --- DISCORD COMMAND DEFINITIONS ---
const appCommands = [
    // Existing commands...
    new SlashCommandBuilder()
        .setName('setup-store')
        .setDescription('Create a new product post inside a Forum Channel (Admin)')
        .addChannelOption(opt => opt.setName('forum_channel').setDescription('Select the Forum channel to post in').addChannelTypes(ChannelType.GuildForum).setRequired(true))
        .addStringOption(opt => opt.setName('title').setDescription('Display Title / Post Name').setRequired(true))
        .addNumberOption(opt => opt.setName('price').setDescription('Cost in USD').setRequired(true))
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID matching inventory key').setRequired(true))
        .addStringOption(opt => opt.setName('catalog_url').setDescription('Roblox Catalog link').setRequired(true))
        .addStringOption(opt => opt.setName('image_url').setDescription('Thumbnail Image URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('my-codes')
        .setDescription('Inspect your previously purchased items and points'),
    new SlashCommandBuilder()
        .setName('restock')
        .setDescription('Add stock codes to an item (Admin)')
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key').setRequired(true))
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes (e.g. CODE1,CODE2)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Check available inventory stock levels (Admin)'),
    new SlashCommandBuilder()
        .setName('remove-stock')
        .setDescription('Remove specific codes from an item (Admin)')
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key').setRequired(true))
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes to remove').setRequired(true)),
    new SlashCommandBuilder()
        .setName('deliver')
        .setDescription('Pull code from database and send code embed with user ping (Admin)')
        .addUserOption(opt => opt.setName('buyer').setDescription('Select the user to ping').setRequired(true))
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key to pull code from').setRequired(true)),
    new SlashCommandBuilder()
        .setName('give-coupon')
        .setDescription('Give a discount coupon to a user manually (Admin)')
        .addUserOption(opt => opt.setName('user').setDescription('The user to receive the coupon').setRequired(true))
        .addNumberOption(opt => opt.setName('discount').setDescription('Discount percentage (e.g., 10, 15, 50)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close order channel and log successful/failed sale (Admin)')
        .addStringOption(opt => opt.setName('status').setDescription('Was the payment successful?').setRequired(true).addChoices({ name: 'Successful', value: 'success' }, { name: 'Failed / Cancelled', value: 'failed' }))
        .addStringOption(opt => opt.setName('method').setDescription('Payment method used').setRequired(false).addChoices({ name: 'Stripe (Card)', value: 'Stripe (Card)' }, { name: 'Cryptocurrency', value: 'Cryptocurrency' }))
        .addUserOption(opt => opt.setName('buyer').setDescription('Buyer (needed to award points if successful)').setRequired(false))
        .addNumberOption(opt => opt.setName('price').setDescription('Final order price (needed to award points)').setRequired(false)),
    // New command: Coupon Store
    new SlashCommandBuilder()
        .setName('coupon-store')
        .setDescription('Drop the interactive Coupon Store embed in this channel (Admin)')
];

botClient.once('clientReady', async () => {
    console.log(`Bot operational as: ${botClient.user.tag}`);
    const restApi = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await restApi.put(
            Routes.applicationGuildCommands(botClient.user.id, '1542259049494610013'), 
            { body: appCommands }
        );
        console.log('Guild-level slash commands synchronized.');
    } catch (syncError) {
        console.error('Command synchronization failed:', syncError);
    }
});

// --- EVENT ROUTING & REACTION LISTENER ---
botClient.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) try { await reaction.fetch(); } catch (err) { return; }

    if (reaction.message.channel.name.startsWith('trade-')) {
        const ADMIN_ROLE_ID = '1542306776622309437';
        if (reaction.emoji.name === '✅') await reaction.message.channel.send(`✅ **Order confirmed complete by <@${user.id}>!** Thank you for your purchase.`);
        else if (reaction.emoji.name === '❌') await reaction.message.channel.send(`❌ **ISSUE REPORTED:** <@&${ADMIN_ROLE_ID}>, <@${user.id}> reported a problem with this trade delivery! Please assist.`);
    }
});

botClient.on('interactionCreate', async interaction => {
    const ADMIN_ROLE_ID = '1542306776622309437';

    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;

        if (['setup-store', 'restock', 'stock', 'remove-stock', 'deliver', 'close', 'coupon-store', 'give-coupon'].includes(commandLabel)) {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ content: '🛑 You do not have permission to use this command.', flags: 64 });
            }
        }

        if (commandLabel === 'coupon-store') {
            const storeEmbed = new EmbedBuilder()
                .setTitle('🎟️ Points & Coupon Store')
                .setDescription(`Earn points automatically with every purchase you make! You can spend your saved points here on discount coupons for your next purchase (valid on items < $100).\n\n` +
                                `**Point Earnings:**\n` +
                                `• $1 - $100 = 2 Points\n` +
                                `• $101 - $500 = 4 Points\n` +
                                `• $501 - $1000 = 7 Points\n` +
                                `• $1000+ = 10 Points`)
                .setColor(0xFFD700)
                .setImage('https://i.imgur.com/EXAMPLE_BANNER.png'); // Feel free to add a nice banner URL here

            const couponMenu = new StringSelectMenuBuilder()
                .setCustomId('buy_coupon')
                .setPlaceholder('🛒 Select a coupon to purchase...')
                .addOptions([
                    { label: '10% Discount Coupon', description: 'Costs 5 points', value: '10' },
                    { label: '15% Discount Coupon', description: 'Costs 10 points', value: '15' }
                ]);

            const menuRow = new ActionRowBuilder().addComponents(couponMenu);
            await interaction.channel.send({ embeds: [storeEmbed], components: [menuRow] });
            await interaction.reply({ content: '✅ Coupon store deployed.', flags: 64 });
        }

        if (commandLabel === 'my-codes') {
            const userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            if (!userLedger) return interaction.reply({ content: "You don't have any purchase records on file.", flags: 64 });

            const history = userLedger.purchases;
            const points = userLedger.points || 0;
            const coupons = userLedger.coupons && userLedger.coupons.length > 0 ? userLedger.coupons.map(c => `${c}% Off`).join(', ') : 'None';

            const formattedItems = history.length > 0 ? history.map(entry => `• **${entry.item}**: \`${entry.code}\``).join('\n') : 'No items yet.';
            await interaction.reply({ 
                content: `**Your Profile**\n⭐ Points: \`${points}\`\n🎟️ Coupons: \`${coupons}\`\n\n**Your Active Codes:**\n${formattedItems}`, 
                flags: 64 
            });
        }

        // [Other standard admin commands remain identical to your current structure here: setup-store, restock, stock, remove-stock, deliver]

        if (commandLabel === 'close') {
            const status = interaction.options.getString('status');
            const method = interaction.options.getString('method') || 'Unknown Method';
            const price = interaction.options.getNumber('price');
            const buyer = interaction.options.getUser('buyer');
            const channel = interaction.channel;

            if (!channel.name.startsWith('trade-')) return interaction.reply({ content: '🛑 This command can only be used inside a trade channel.', flags: 64 });

            await interaction.reply({ content: '🔒 Processing order closure and cleaning up channel...', flags: 64 });

            if (status === 'success') {
                // Award points manually if buyer and price provided
                if (buyer && price) {
                    let userLedger = await Ledger.findOne({ discordId: buyer.id });
                    if (!userLedger) userLedger = new Ledger({ discordId: buyer.id, purchases: [], points: 0, coupons: [] });
                    
                    const earned = calculatePoints(price);
                    userLedger.points += earned;
                    await userLedger.save();
                }

                const PUBLIC_LOG_CHANNEL_ID = '1542337221791711324';
                const logChannel = await interaction.guild.channels.fetch(PUBLIC_LOG_CHANNEL_ID).catch(() => null);

                if (logChannel) {
                    const channelNameParts = channel.name.split('-');
                    let parsedItem = channelNameParts.length > 1 ? channelNameParts[1].toUpperCase() : 'STORE ITEM';

                    const receiptEmbed = new EmbedBuilder()
                        .setTitle('🧾 New Successful Sale')
                        .setDescription(`An item has been successfully purchased and delivered securely.`)
                        .setColor(0x00FF00)
                        .addFields(
                            { name: '📦 Item Sold', value: `\`${parsedItem}\``, inline: true },
                            { name: '💳 Payment Method', value: `\`${method}\``, inline: true }
                        )
                        .setTimestamp();

                    await logChannel.send({ embeds: [receiptEmbed] });
                }
            }

            setTimeout(async () => {
                await channel.delete().catch(() => {});
            }, 4000);
        }
    }

    // --- BUTTON & SELECT MENU INTERACTION HANDLERS ---
    
    // 1. Coupon Purchase Logic
    if (interaction.isStringSelectMenu() && interaction.customId === 'buy_coupon') {
        await interaction.deferReply({ flags: 64 });
        const discountPct = parseInt(interaction.values[0]);
        const cost = discountPct === 10 ? 5 : 10;
        
        let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
        if (!userLedger || userLedger.points < cost) {
            return interaction.editReply({ content: `❌ You do not have enough points. This coupon costs **${cost} points**.` });
        }

        userLedger.points -= cost;
        userLedger.coupons.push(discountPct);
        await userLedger.save();

        return interaction.editReply({ content: `✅ Success! You bought a **${discountPct}% Off Coupon** for ${cost} points. You now have ${userLedger.points} points remaining.` });
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'close_order') {
            await interaction.reply({ content: '🗑️ Canceling order... closing channel in 5 seconds.' });
            setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
            return;
        }

        // 2. Initial Purchase Action (Check for Coupons)
        if (interaction.customId.startsWith('purchase_action|')) {
            await interaction.deferReply({ flags: 64 });
            const [, productKey, productPrice] = interaction.customId.split('|');
            const priceNum = parseFloat(productPrice);

            try {
                const itemRecord = await Inventory.findOne({ itemId: productKey });
                if (!itemRecord || itemRecord.codes.length === 0) {
                    await interaction.editReply({ content: `❌ Sorry, **${productKey}** is currently **out of stock**.` });
                    setTimeout(async () => { await interaction.deleteReply().catch(() => {}); }, 4000);
                    return;
                }

                const guild = interaction.guild;
                const sanitizedUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
                const orderChannel = await guild.channels.create({
                    name: `trade-${productKey}-${sanitizedUsername}`.substring(0, 100),
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] },
                        { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] }
                    ],
                });

                await interaction.editReply({ content: `🛒 Your private order channel has been created: <#${orderChannel.id}>` });
                setTimeout(async () => { await interaction.deleteReply().catch(() => {}); }, 6000);

                // Fetch ledger to see if user has coupons
                let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
                
                // If price < 100 AND user has at least 1 coupon, offer it
                if (priceNum < 100 && userLedger && userLedger.coupons && userLedger.coupons.length > 0) {
                    const couponEmbed = new EmbedBuilder()
                        .setTitle('🎟️ Apply Coupon?')
                        .setDescription(`You are purchasing **${productKey}** for **$${productPrice}**.\nYou have discount coupons available! Would you like to use one on this order?`)
                        .setColor(0xFFD700);

                    const btnYes = new ButtonBuilder().setCustomId(`use_coupon_yes|${productKey}|${productPrice}`).setLabel('Yes, apply coupon').setStyle(ButtonStyle.Success);
                    const btnNo = new ButtonBuilder().setCustomId(`use_coupon_no|${productKey}|${productPrice}`).setLabel('No, save for later').setStyle(ButtonStyle.Secondary);
                    
                    await orderChannel.send({
                        content: `<@${interaction.user.id}>`,
                        embeds: [couponEmbed],
                        components: [new ActionRowBuilder().addComponents(btnYes, btnNo)]
                    });
                } else {
                    // Standard checkout flow (no coupons or price >= 100)
                    const polishedEmbed = new EmbedBuilder()
                        .setTitle('🛍️ Secure Checkout Portal')
                        .setDescription(`Welcome <@${interaction.user.id}>! You are initializing an order for **${productKey.toUpperCase()}**.\n\n` +
                                        `• **Total Price:** \`$${productPrice} USD\`\n` +
                                        `• **Status:** \`Awaiting Payment Selection\`\n\n` +
                                        `Please make your selection from the dropdown menu below.`)
                        .setColor(0x5865F2);

                    await orderChannel.send({ embeds: [polishedEmbed], components: [generatePaymentMenu(productKey, productPrice, orderChannel.id)] });
                }

            } catch (err) {
                console.error('Error creating order channel:', err);
                await interaction.editReply({ content: 'Encountered an error opening your order channel.' });
            }
        }

        // 3. User clicked Yes to use a coupon
        if (interaction.customId.startsWith('use_coupon_yes|')) {
            const [, productKey, productPrice] = interaction.customId.split('|');
            let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            
            // Generate unique options for the select menu based on what they own
            const uniqueCoupons = [...new Set(userLedger.coupons)];
            const options = uniqueCoupons.map(pct => ({
                label: `Apply ${pct}% Off Coupon`,
                description: `Reduces price to $${(productPrice * (1 - (pct/100))).toFixed(2)}`,
                value: pct.toString()
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`apply_coupon|${productKey}|${productPrice}`)
                .setPlaceholder('Select which coupon to apply...')
                .addOptions(options);

            await interaction.update({
                embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setDescription('Please select the coupon you wish to apply from the dropdown below:')],
                components: [new ActionRowBuilder().addComponents(selectMenu)]
            });
        }

        // 4. User clicked No to coupon, load standard payment menu
        if (interaction.customId.startsWith('use_coupon_no|')) {
            const [, productKey, productPrice] = interaction.customId.split('|');
            
            const polishedEmbed = new EmbedBuilder()
                .setTitle('🛍️ Secure Checkout Portal')
                .setDescription(`Welcome <@${interaction.user.id}>! You are initializing an order for **${productKey.toUpperCase()}**.\n\n` +
                                `• **Total Price:** \`$${productPrice} USD\`\n` +
                                `• **Status:** \`Awaiting Payment Selection\`\n\n` +
                                `Please make your selection from the dropdown menu below.`)
                .setColor(0x5865F2);

            await interaction.update({ embeds: [polishedEmbed], components: [generatePaymentMenu(productKey, productPrice, interaction.channel.id)] });
        }
    }

    // 5. User selected a coupon from the dropdown to apply
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('apply_coupon|')) {
        await interaction.deferUpdate();
        const [, productKey, originalPrice] = interaction.customId.split('|');
        const discountPct = parseInt(interaction.values[0]);
        
        let userLedger = await Ledger.findOne({ discordId: interaction.user.id });
        const couponIndex = userLedger.coupons.indexOf(discountPct);
        
        if (couponIndex > -1) {
            // Remove the coupon from the user's inventory
            userLedger.coupons.splice(couponIndex, 1);
            await userLedger.save();
            
            const newPrice = (parseFloat(originalPrice) * (1 - (discountPct / 100))).toFixed(2);

            const discountedEmbed = new EmbedBuilder()
                .setTitle('🛍️ Secure Checkout Portal (Discount Applied)')
                .setDescription(`Welcome <@${interaction.user.id}>! You are initializing an order for **${productKey.toUpperCase()}**.\n\n` +
                                `• **Original Price:** ~~\`$${originalPrice} USD\`~~\n` +
                                `• **Discounted Price:** \`$${newPrice} USD\` 🎉\n` +
                                `• **Status:** \`Awaiting Payment Selection\`\n\n` +
                                `Please make your selection from the dropdown menu below.`)
                .setColor(0x00FF00);

            await interaction.editReply({ embeds: [discountedEmbed], components: [generatePaymentMenu(productKey, newPrice, interaction.channel.id)] });
        }
    }

    // 6. Payment Method Selection (Stripe / Crypto / Cancel)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('payment_select|')) {
        const [, productKey, productPrice, channelId] = interaction.customId.split('|');
        const selectedValue = interaction.values[0];
        const orderChannel = await interaction.guild.channels.fetch(channelId);

        if (selectedValue === 'select_cancel') {
            await interaction.reply({ content: '🗑️ Order canceled. Closing channel in 5 seconds...', flags: 64 });
            setTimeout(async () => { await orderChannel.delete().catch(() => {}); }, 5000);
            return;
        }

        if (selectedValue === 'select_stripe') {
            await interaction.deferUpdate();

            const stripeSession = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: { name: productKey.toUpperCase().replace('_', ' ') },
                        unit_amount: Math.round(parseFloat(productPrice) * 100),
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: 'https://roblox.com',
                cancel_url: 'https://roblox.com',
                metadata: {
                    discord_user_id: interaction.user.id,
                    item_id: productKey,
                    guild_id: interaction.guild.id,
                    channel_id: orderChannel.id
                }
            });

            const checkoutEmbed = new EmbedBuilder()
                .setTitle('💳 Stripe Card Checkout')
                .setDescription(`Click the secure link below to open your Stripe invoice.\n\n*Your code will post here automatically once paid.*`)
                .setColor(0x635BFF);

            const payButton = new ButtonBuilder().setLabel(`Pay $${productPrice} via Stripe`).setURL(stripeSession.url).setStyle(ButtonStyle.Link);
            await orderChannel.send({ embeds: [checkoutEmbed], components: [new ActionRowBuilder().addComponents(payButton)] });
            await interaction.message.delete().catch(() => {});
        }

        if (selectedValue === 'select_crypto') {
            await interaction.deferUpdate();
            const amounts = await getCryptoAmounts(parseFloat(productPrice));

            const cryptoEmbed = new EmbedBuilder()
                .setTitle('🪙 Cryptocurrency Payment Gateway')
                .setDescription(`Target item: **${productKey.toUpperCase()}**\nEquivalent Value: **$${productPrice} USD**\n\nSend the exact live amount below to one of our official addresses:`)
                .setColor(0xF7931A)
                .addFields(
                    { name: '🔹 Ethereum (ETH)', value: `\`\`\`${amounts.eth} ETH\`\`\`\n\`\`\`0x42d01fE1f89C6cDE28ef7a34Ef5A7B452eD6B271\`\`\``, inline: false },
                    { name: '🟣 Litecoin (LTC)', value: `\`\`\`${amounts.ltc} LTC\`\`\`\n\`\`\`MWSeYJ3qgm3j5yYGGFimu5ebSzHA9oUvBy\`\`\``, inline: false },
                    { name: '🟠 Bitcoin (BTC)', value: `\`\`\`${amounts.btc} BTC\`\`\`\n\`\`\`34hRphphvMtvqiWPawAESR1bxkfvUoFNhh\`\`\``, inline: false },
                    { name: '🟢 Solana (SOL)', value: `\`\`\`${amounts.sol} SOL\`\`\`\n\`\`\`222P8wKAC2s2UcfNyANYre8yVKjU1c3C3MA7mYqK92ZB\`\`\``, inline: false }
                )
                .setFooter({ text: 'After completing payment, click the button below to submit your transaction hash.' });

            const submitTxBtn = new ButtonBuilder().setCustomId(`open_tx_modal|${productKey}`).setLabel('Submit Transaction Hash').setStyle(ButtonStyle.Success).setEmoji('📝');
            await orderChannel.send({ embeds: [cryptoEmbed], components: [new ActionRowBuilder().addComponents(submitTxBtn)] });
            await interaction.message.delete().catch(() => {});
        }
    }

    // --- TX SUBMISSION MODAL HANDLERS ---
    if (interaction.isButton() && interaction.customId.startsWith('open_tx_modal|')) {
        const [, productKey] = interaction.customId.split('|');
        const txModal = new ModalBuilder().setCustomId(`submit_tx_form|${productKey}`).setTitle('Submit Crypto Payment Details');
        const txInput = new TextInputBuilder().setCustomId('tx_hash_input').setLabel('Transaction Hash / ID / Proof').setStyle(TextInputStyle.Paragraph).setRequired(true);
        txModal.addComponents(new ActionRowBuilder().addComponents(txInput));
        await interaction.showModal(txModal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_tx_form|')) {
        const [, productKey] = interaction.customId.split('|');
        const userTxProof = interaction.fields.getTextInputValue('tx_hash_input');
        const ADMIN_ROLE_ID = '1542306776622309437';

        const confirmationEmbed = new EmbedBuilder()
            .setTitle('📥 Transaction Submitted')
            .setDescription(`Thank you! Your transaction proof has been logged for review.\n\n**Item:** \`${productKey}\`\n**Submitted Hash:**\n\`\`\`${userTxProof}\`\`\``)
            .setColor(0x00FF00).setTimestamp();

        await interaction.reply({ embeds: [confirmationEmbed] });
        await interaction.channel.send(`🔔 <@&${ADMIN_ROLE_ID}>, <@${interaction.user.id}> has submitted a crypto transaction proof for **${productKey}**! Please verify and deliver the code manually.`);
    }
});

// Initialize Services
const port = process.env.PORT || 3000;
webApp.listen(port, () => console.log(`HTTP Webhook Listener running on port ${port}`));
botClient.login(process.env.DISCORD_TOKEN);
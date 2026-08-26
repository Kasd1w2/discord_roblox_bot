require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    purchases: [{ item: String, code: String }]
});
const Ledger = mongoose.model('Ledger', LedgerSchema);

const webApp = express();
const botClient = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- STRIPE WEBHOOK ENDPOINT ---
webApp.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(
            req.body, 
            signatureHeader, 
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (parseError) {
        console.error(`Webhook Signature Verification Failed: ${parseError.message}`);
        return res.status(400).send(`Webhook Error: ${parseError.message}`);
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const checkoutSession = stripeEvent.data.object;
        const buyerDiscordId = checkoutSession.metadata.discord_user_id;
        const targetItemId = checkoutSession.metadata.item_id;
        const guildId = checkoutSession.metadata.guild_id;

        try {
            const itemRecord = await Inventory.findOne({ itemId: targetItemId });

            if (itemRecord && itemRecord.codes.length > 0) {
                const assignedCode = itemRecord.codes.shift();
                await itemRecord.save();

                let userLedger = await Ledger.findOne({ discordId: buyerDiscordId });
                if (!userLedger) {
                    userLedger = new Ledger({ discordId: buyerDiscordId, purchases: [] });
                }
                userLedger.purchases.push({ item: targetItemId, code: assignedCode });
                await userLedger.save();

                const guild = await botClient.guilds.fetch(guildId);
                const orderChannel = await guild.channels.create({
                    name: `order-${targetItemId}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone.id,
                            deny: [PermissionFlagsBits.ViewChannel],
                        },
                        {
                            id: buyerDiscordId,
                            allow: [
                                PermissionFlagsBits.ViewChannel, 
                                PermissionFlagsBits.SendMessages, 
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        },
                        {
                            id: botClient.user.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel, 
                                PermissionFlagsBits.SendMessages, 
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        }
                    ],
                });

                await orderChannel.send(`Hey <@${buyerDiscordId}>, 🛍️ **Order Fulfilled!**\nProduct: \`${targetItemId}\`\nYour Code: **\`${assignedCode}\`**\n\n*Please copy and save this code!*`);
                console.log(`Fulfilled order for ${targetItemId} to user ${buyerDiscordId}`);
            } else {
                console.error(`CRITICAL STOCK ERROR: Out of stock for ${targetItemId}!`);
            }
        } catch (dbErr) {
            console.error('Database query error during fulfillment:', dbErr);
        }
    }

    return res.status(200).json({ received: true });
});

// --- DISCORD COMMAND DEFINITIONS ---
const appCommands = [
    new SlashCommandBuilder()
        .setName('setup-store')
        .setDescription('Deploy a dynamic product listing embed')
        .addStringOption(opt => opt.setName('title').setDescription('Display Title').setRequired(true))
        .addNumberOption(opt => opt.setName('price').setDescription('Cost in USD').setRequired(true))
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID matching inventory key').setRequired(true))
        .addStringOption(opt => opt.setName('catalog_url').setDescription('Roblox Catalog link').setRequired(true))
        .addStringOption(opt => opt.setName('image_url').setDescription('Thumbnail Image URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('my-codes')
        .setDescription('Inspect your previously purchased items'),
    new SlashCommandBuilder()
        .setName('restock')
        .setDescription('Add stock codes to an item')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key').setRequired(true))
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes (e.g. CODE1,CODE2)').setRequired(true))
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

// --- EVENT ROUTING ---
botClient.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;

        if (commandLabel === 'setup-store') {
            const productTitle = interaction.options.getString('title');
            const productPrice = interaction.options.getNumber('price');
            const productKey = interaction.options.getString('item_id');
            const robloxLink = interaction.options.getString('catalog_url');
            const thumbnailPic = interaction.options.getString('image_url');

            const listingEmbed = new EmbedBuilder()
                .setTitle(`${productTitle}`)
                .setColor(0x2B2D31)
                .addFields(
                    { name: 'Price', value: `$${productPrice} USD`, inline: true },
                    { name: 'Delivery', value: 'Automated (Private Channel)', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: 'Rolimons Link', value: `[View item](${robloxLink})`, inline: false }
                )
                .setThumbnail(thumbnailPic);

            const buyActionBtn = new ButtonBuilder()
                .setCustomId(`purchase_action|${productKey}|${productPrice}`)
                .setLabel(`Purchase ${productTitle}`)
                .setStyle(ButtonStyle.Primary);

            const buttonRow = new ActionRowBuilder().addComponents(buyActionBtn);

            await interaction.channel.send({ embeds: [listingEmbed], components: [buttonRow] });
            await interaction.reply({ content: 'Storefront panel deployed successfully.', flags: 64 });
        }

        if (commandLabel === 'my-codes') {
            const userLedger = await Ledger.findOne({ discordId: interaction.user.id });
            const history = userLedger ? userLedger.purchases : [];

            if (history.length === 0) {
                return interaction.reply({ content: "You don't have any purchase records on file.", flags: 64 });
            }

            const formattedItems = history.map(entry => `• **${entry.item}**: \`${entry.code}\``).join('\n');
            await interaction.reply({ content: `**Your Active Codes:**\n${formattedItems}`, flags: 64 });
        }

        if (commandLabel === 'restock') {
            const itemId = interaction.options.getString('item_id');
            const newCodes = interaction.options.getString('codes').split(',').map(c => c.trim());

            let itemRecord = await Inventory.findOne({ itemId });
            if (!itemRecord) {
                itemRecord = new Inventory({ itemId, codes: [] });
            }

            itemRecord.codes.push(...newCodes);
            await itemRecord.save();

            await interaction.reply({ content: `Added ${newCodes.length} codes to \`${itemId}\`. Total stock: ${itemRecord.codes.length}`, flags: 64 });
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('purchase_action|')) {
        await interaction.deferReply({ flags: 64 });
        const [, productKey, productPrice] = interaction.customId.split('|');

        try {
            const checkoutSession = await stripe.checkout.sessions.create({
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
                    guild_id: interaction.guild.id
                }
            });

            await interaction.editReply({
                content: `Checkout session generated successfully! Click the link below to finalize your payment:\n\n🔗 **[Click Here to Open Checkout](${checkoutSession.url})**`,
                components: []
            });
        } catch (stripeError) {
            console.error('Stripe session creation error:', stripeError);
            await interaction.editReply({ content: 'Encountered an error generating the checkout link. Please try again later.' });
        }
    }
});

// Initialize Services
const port = process.env.PORT || 3000;
webApp.listen(port, () => console.log(`HTTP Webhook Listener running on port ${port}`));
botClient.login(process.env.DISCORD_TOKEN);
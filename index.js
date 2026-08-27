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
const botClient = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ] 
});

// --- STRIPE WEBHOOK ENDPOINT (LIMITED / TRADE MODE) ---
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
            const guild = await botClient.guilds.fetch(guildId);
            // Note: If the channel was already created on button click, you can handle fulfillment tracking here.
            console.log(`Payment confirmed for item ${targetItemId} by user ${buyerDiscordId}`);
        } catch (dbErr) {
            console.error('Error handling checkout completion webhook:', dbErr);
        }
    }

    return res.status(200).json({ received: true });
});

// --- DISCORD COMMAND DEFINITIONS ---
const appCommands = [
    new SlashCommandBuilder()
        .setName('setup-store')
        .setDescription('Create a new product post inside a Forum Channel (Admin)')
        .addChannelOption(opt => 
            opt.setName('forum_channel')
               .setDescription('Select the Forum channel to post in')
               .addChannelTypes(ChannelType.GuildForum)
               .setRequired(true))
        .addStringOption(opt => opt.setName('title').setDescription('Display Title / Post Name').setRequired(true))
        .addNumberOption(opt => opt.setName('price').setDescription('Cost in USD').setRequired(true))
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID matching inventory key').setRequired(true))
        .addStringOption(opt => opt.setName('catalog_url').setDescription('Roblox Catalog link').setRequired(true))
        .addStringOption(opt => opt.setName('image_url').setDescription('Thumbnail Image URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('my-codes')
        .setDescription('Inspect your previously purchased items'),
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
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes to remove').setRequired(true))
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

    if (reaction.partial) {
        try { await reaction.fetch(); } catch (err) { return; }
    }

    if (reaction.message.channel.name.startsWith('trade-')) {
        const ADMIN_ROLE_ID = '1542306776622309437';

        if (reaction.emoji.name === '✅') {
            await reaction.message.channel.send(`✅ **Order confirmed complete by <@${user.id}>!** Thank you for your purchase.`);
        } 
        else if (reaction.emoji.name === '❌') {
            await reaction.message.channel.send(`❌ **ISSUE REPORTED:** <@&${ADMIN_ROLE_ID}>, <@${user.id}> reported a problem with this trade delivery! Please assist.`);
        }
    }
});

botClient.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;
        const ADMIN_ROLE_ID = '1542306776622309437';

        if (['setup-store', 'restock', 'stock', 'remove-stock'].includes(commandLabel)) {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ 
                    content: '🛑 You do not have permission to use this command.', 
                    flags: 64 
                });
            }
        }

        if (commandLabel === 'setup-store') {
            const selectedChannelOption = interaction.options.getChannel('forum_channel');
            const targetForum = await interaction.guild.channels.fetch(selectedChannelOption.id);
            
            const productTitle = interaction.options.getString('title');
            const productPrice = interaction.options.getNumber('price');
            const productKey = interaction.options.getString('item_id');
            const robloxLink = interaction.options.getString('catalog_url');
            const thumbnailPic = interaction.options.getString('image_url');

            const listingEmbed = new EmbedBuilder()
                .setTitle(`${productTitle}`)
                .setDescription(`Click on the button below to purchase!`)
                .setColor(0x2B2D31)
                .addFields(
                    { name: 'Price', value: `$${productPrice} USD`, inline: true },
                    { name: 'Delivery', value: 'Manual Trade (Private Channel)', inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: 'Rolimons Link', value: `[View item](${robloxLink})`, inline: false }
                )
                .setImage(thumbnailPic);

            const buyActionBtn = new ButtonBuilder()
                .setCustomId(`purchase_action|${productKey}|${productPrice}`)
                .setLabel(`Purchase ${productTitle}`)
                .setStyle(ButtonStyle.Primary);

            const buttonRow = new ActionRowBuilder().addComponents(buyActionBtn);

            await targetForum.threads.create({
                name: productTitle,
                message: {
                    embeds: [listingEmbed],
                    components: [buttonRow]
                }
            });

            await interaction.reply({ content: `✅ Successfully created forum post for **${productTitle}**!`, flags: 64 });
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

            await interaction.reply({ content: `✅ Added ${newCodes.length} codes to \`${itemId}\`. Total stock: ${itemRecord.codes.length}`, flags: 64 });
        }

        if (commandLabel === 'stock') {
            const allInventory = await Inventory.find({});
            
            if (!allInventory || allInventory.length === 0) {
                return interaction.reply({ content: 'No inventory records found in the database.', flags: 64 });
            }

            const stockList = allInventory
                .map(item => `• **${item.itemId}**: ${item.codes.length} code(s) remaining`)
                .join('\n');

            await interaction.reply({ content: `📦 **Current Inventory Stock:**\n${stockList}`, flags: 64 });
        }

        if (commandLabel === 'remove-stock') {
            const itemId = interaction.options.getString('item_id');
            const codesToRemove = interaction.options.getString('codes').split(',').map(c => c.trim());

            let itemRecord = await Inventory.findOne({ itemId });
            if (!itemRecord) {
                return interaction.reply({ content: `❌ Item \`${itemId}\` not found in database.`, flags: 64 });
            }

            const originalLength = itemRecord.codes.length;
            
            itemRecord.codes = itemRecord.codes.filter(code => !codesToRemove.includes(code));
            await itemRecord.save();

            const removedCount = originalLength - itemRecord.codes.length;

            await interaction.reply({ content: `🗑️ Removed ${removedCount} codes from \`${itemId}\`. Remaining stock: ${itemRecord.codes.length}`, flags: 64 });
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('purchase_action|')) {
        await interaction.deferReply({ flags: 64 });
        const [, productKey, productPrice] = interaction.customId.split('|');

        try {
            // Check inventory stock in MongoDB
            const itemRecord = await Inventory.findOne({ itemId: productKey });
            
            if (itemRecord && itemRecord.codes.length === 0) {
<<<<<<< Updated upstream
                // Send temporary notice tagging the user, then delete it after 5 seconds
=======
>>>>>>> Stashed changes
                const outOfStockMsg = await interaction.channel.send(`❌ <@${interaction.user.id}>, sorry! **${productKey}** is currently **out of stock**.`);
                setTimeout(() => {
                    outOfStockMsg.delete().catch(() => {});
                }, 5000);

                return interaction.editReply({ content: '❌ This item is out of stock.' });
            }

<<<<<<< Updated upstream
=======
            // Create Stripe Checkout Session
>>>>>>> Stashed changes
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

            // Immediately create the private order channel with the user's name included
            const guild = interaction.guild;
            const sanitizedUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
            const orderChannel = await guild.channels.create({
                name: `trade-${productKey}-${sanitizedUsername}`.substring(0, 100),
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: interaction.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel, 
                            PermissionFlagsBits.SendMessages, 
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AddReactions
                        ],
                    },
                    {
                        id: botClient.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel, 
                            PermissionFlagsBits.SendMessages, 
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AddReactions
                        ],
                    }
                ],
            });

            // Send instructions and the payment link inside their new private channel
            const deliveryMessage = await orderChannel.send(
                `Hey <@${interaction.user.id}>, 🛍️ **Complete your payment below!**\n` +
                `Item: \`${productKey}\`\n\n` +
                `🔗 **[Click Here to Open Checkout](${checkoutSession.url})**\n\n` +
                `Once paid, please send your **Roblox Username** here. Afterward, use these reactions:\n` +
                `✅ **Click Check** if you received your item.\n` +
                `❌ **Click X** if there is a problem.`
            );

            await deliveryMessage.react('✅');
            await deliveryMessage.react('❌');

            // Send a clean public notice in the forum post tagging the user, then auto-delete it after 6 seconds
            const publicNotice = await interaction.channel.send(`🛒 <@${interaction.user.id}>, your private order channel has been created: <#${orderChannel.id}>`);
            setTimeout(() => {
                publicNotice.delete().catch(() => {});
            }, 6000);

            // Clear out the ephemeral thinking state silently
            await interaction.deleteReply().catch(() => {});

        } catch (stripeError) {
            console.error('Checkout creation error:', stripeError);
            await interaction.editReply({ content: 'Encountered an error generating your checkout. Please try again later.' });
        }
    }
});

// Initialize Services
const port = process.env.PORT || 3000;
webApp.listen(port, () => console.log(`HTTP Webhook Listener running on port ${port}`));
botClient.login(process.env.DISCORD_TOKEN);

require('dotenv').config();
const express = require('express');
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

const webApp = express();
const botClient = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- MOCK INVENTORY & DATABASE STORAGE ---
// ⚠️ WARNING: On Render's free tier, this in-memory storage resets when the server restarts or sleeps.
const storeDatabase = {
    stockpile: {
        'white_cane': ['RBX-CANE-1111', 'RBX-CANE-2222'],
        'red_valk': ['RBX-VALK-3333', 'RBX-VALK-4444']
    },
    ledger: {} // Maps Discord ID to array of fulfilled purchases
};

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

        const availableCodes = storeDatabase.stockpile[targetItemId];
        const assignedCode = (availableCodes && availableCodes.length > 0) ? availableCodes.shift() : null;

        if (assignedCode) {
            if (!storeDatabase.ledger[buyerDiscordId]) {
                storeDatabase.ledger[buyerDiscordId] = [];
            }
            storeDatabase.ledger[buyerDiscordId].push({ item: targetItemId, code: assignedCode });

            try {
                // Fetch the Discord Server (Guild) where the button was clicked
                const guild = await botClient.guilds.fetch(guildId);

                // Create a private channel visible only to the buyer and the bot
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

                // Send the code to the newly created private channel
                await orderChannel.send(`Hey <@${buyerDiscordId}>, 🛍️ **Order Fulfilled!**\nProduct: \`${targetItemId}\`\nYour Code: **\`${assignedCode}\`**\n\n*Please copy and save this code!*`);
                console.log(`Successfully created private channel for item ${targetItemId} and delivered code to user ID ${buyerDiscordId}`);
            } catch (channelError) {
                console.error(`Failed to create private channel for user ${buyerDiscordId}. Code safely preserved in ledger. Error:`, channelError);
            }
        } else {
            console.error(`CRITICAL STOCK ERROR: User ${buyerDiscordId} completed checkout for ${targetItemId}, but inventory is empty!`);
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
        .setDescription('Inspect your previously purchased items')
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
            const history = storeDatabase.ledger[interaction.user.id] || [];
            if (history.length === 0) {
                return interaction.reply({ content: "You don't have any purchase records on file.", flags: 64 });
            }

            const formattedItems = history.map(entry => `• **${entry.item}**: \`${entry.code}\``).join('\n');
            await interaction.reply({ content: `**Your Active Codes:**\n${formattedItems}`, flags: 64 });
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
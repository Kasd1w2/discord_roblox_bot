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

// --- HELPER FUNCTION: FETCH LIVE CRYPTO RATES ---
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

// --- STRIPE WEBHOOK ENDPOINT (AUTOMATED CODE DELIVERY) ---
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
        const session = stripeEvent.data.object;
        const buyerDiscordId = session.metadata.discord_user_id;
        const targetItemId = session.metadata.item_id;
        const channelId = session.metadata.channel_id;

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
                userLedger = new Ledger({ discordId: buyerDiscordId, purchases: [] });
            }
            userLedger.purchases.push({ item: targetItemId, code: purchasedCode });
            await userLedger.save();

            const orderChannel = await botClient.channels.fetch(channelId);
            if (orderChannel) {
                const deliveryMessage = await orderChannel.send(
                    `✅ **Payment Confirmed!** Thank you for your purchase, <@${buyerDiscordId}>.\n\n` +
                    `Here is your code for **${targetItemId}**:\n` +
                    `\`\`\`${purchasedCode}\`\`\`\n` +
                    `Please use the reactions below to confirm delivery or report an issue.`
                );
                
                await deliveryMessage.react('✅');
                await deliveryMessage.react('❌');
            }

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
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes to remove').setRequired(true)),
    new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close order channel and log successful/failed sale (Admin)')
        .addStringOption(opt => 
            opt.setName('status')
               .setDescription('Was the payment successful?')
               .setRequired(true)
               .addChoices(
                   { name: 'Successful', value: 'success' },
                   { name: 'Failed / Cancelled', value: 'failed' }
               ))
        .addStringOption(opt => 
            opt.setName('method')
               .setDescription('Payment method used (required if successful)')
               .setRequired(false)
               .addChoices(
                   { name: 'Stripe (Card)', value: 'Stripe (Card)' },
                   { name: 'Cryptocurrency', value: 'Cryptocurrency' }
               ))
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

        if (['setup-store', 'restock', 'stock', 'remove-stock', 'close'].includes(commandLabel)) {
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
                    { name: 'Delivery', value: 'Automated Code Delivery', inline: true },
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

        // --- NEW /CLOSE COMMAND HANDLER ---
        if (commandLabel === 'close') {
            const status = interaction.options.getString('status');
            const method = interaction.options.getString('method') || 'Unknown Method';
            const channel = interaction.channel;

            if (!channel.name.startsWith('trade-')) {
                return interaction.reply({ content: '🛑 This command can only be used inside a trade/order channel.', flags: 64 });
            }

            await interaction.reply({ content: '🔒 Processing order closure and cleaning up channel...', flags: 64 });

            if (status === 'success') {
                const PUBLIC_LOG_CHANNEL_ID = '1542337221791711324';
                const logChannel = await interaction.guild.channels.fetch(PUBLIC_LOG_CHANNEL_ID).catch(() => null);

                if (logChannel) {
                    // Extract item name from channel name format: trade-[item_id]-[username]
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

    // --- BUTTON INTERACTION HANDLERS ---
    if (interaction.isButton()) {
        if (interaction.customId === 'close_order') {
            await interaction.reply({ content: '🗑️ Canceling order... closing channel in 5 seconds.' });
            
            setTimeout(async () => {
                await interaction.channel.delete().catch(() => {});
            }, 5000);
            return;
        }

        if (interaction.customId.startsWith('purchase_action|')) {
            await interaction.deferReply({ flags: 64 });
            const [, productKey, productPrice] = interaction.customId.split('|');

            try {
                const itemRecord = await Inventory.findOne({ itemId: productKey });
                
                if (!itemRecord || itemRecord.codes.length === 0) {
                    await interaction.editReply({ 
                        content: `❌ Sorry, **${productKey}** is currently **out of stock**.` 
                    });

                    setTimeout(async () => {
                        await interaction.deleteReply().catch(() => {});
                    }, 4000);

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

                const polishedEmbed = new EmbedBuilder()
                    .setTitle('🛍️ Secure Checkout Portal')
                    .setDescription(`Welcome <@${interaction.user.id}>! You are initializing an order for **${productKey.toUpperCase()}**.\n\n` +
                                  `• **Total Price:** \`$${productPrice} USD\`\n` +
                                  `• **Status:** \`Awaiting Payment Selection\`\n\n` +
                                  `Please make your selection from the dropdown menu below to proceed with your preferred checkout method.`)
                    .setColor(0x5865F2)
                    .setFooter({ text: 'Powered by Automated Escrow System' });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`payment_select|${productKey}|${productPrice}|${orderChannel.id}`)
                    .setPlaceholder('📂 Choose your payment method...')
                    .addOptions([
                        {
                            label: 'Pay with Card (Stripe)',
                            description: 'Instant automated delivery via Credit/Debit card',
                            value: 'select_stripe',
                            emoji: '💳'
                        },
                        {
                            label: 'Pay with Cryptocurrency',
                            description: 'Pay using ETH, LTC, BTC, or SOL',
                            value: 'select_crypto',
                            emoji: '🪙'
                        },
                        {
                            label: 'Cancel Order',
                            description: 'Discard transaction and close channel',
                            value: 'select_cancel',
                            emoji: '🗑️'
                        }
                    ]);

                const menuRow = new ActionRowBuilder().addComponents(selectMenu);

                await orderChannel.send({
                    embeds: [polishedEmbed],
                    components: [menuRow]
                });

                await interaction.editReply({ 
                    content: `🛒 Your private order channel has been created: <#${orderChannel.id}>` 
                });

                setTimeout(async () => {
                    await interaction.deleteReply().catch(() => {});
                }, 6000);

            } catch (err) {
                console.error('Error creating order channel:', err);
                await interaction.editReply({ content: 'Encountered an error opening your order channel.' });
            }
        }
    }

    // --- SELECT MENU HANDLER ---
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('payment_select|')) {
            const [, productKey, productPrice, channelId] = interaction.customId.split('|');
            const selectedValue = interaction.values[0];
            const orderChannel = await interaction.guild.channels.fetch(channelId);

            if (selectedValue === 'select_cancel') {
                await interaction.reply({ content: '🗑️ Order canceled. Closing channel in 5 seconds...', flags: 64 });
                setTimeout(async () => {
                    await orderChannel.delete().catch(() => {});
                }, 5000);
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

                const payButton = new ButtonBuilder().setLabel('Open Stripe Checkout').setURL(stripeSession.url).setStyle(ButtonStyle.Link);
                const backRow = new ActionRowBuilder().addComponents(payButton);

                await orderChannel.send({ embeds: [checkoutEmbed], components: [backRow] });
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

                const submitTxBtn = new ButtonBuilder()
                    .setCustomId(`open_tx_modal|${productKey}`)
                    .setLabel('Submit Transaction Hash')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('📝');

                const cryptoRow = new ActionRowBuilder().addComponents(submitTxBtn);

                await orderChannel.send({ embeds: [cryptoEmbed], components: [cryptoRow] });
                await interaction.message.delete().catch(() => {});
            }
        }
    }

    // --- OPEN TRANSACTION SUBMISSION MODAL ---
    if (interaction.isButton() && interaction.customId.startsWith('open_tx_modal|')) {
        const [, productKey] = interaction.customId.split('|');

        const txModal = new ModalBuilder()
            .setCustomId(`submit_tx_form|${productKey}`)
            .setTitle('Submit Crypto Payment Details');

        const txInput = new TextInputBuilder()
            .setCustomId('tx_hash_input')
            .setLabel('Transaction Hash / ID / Proof')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Paste your blockchain transaction hash or link here...')
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(txInput);
        txModal.addComponents(row);

        await interaction.showModal(txModal);
    }

    // --- HANDLE MODAL SUBMISSION ---
    if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_tx_form|')) {
        const [, productKey] = interaction.customId.split('|');
        const userTxProof = interaction.fields.getTextInputValue('tx_hash_input');
        const ADMIN_ROLE_ID = '1542306776622309437';

        const confirmationEmbed = new EmbedBuilder()
            .setTitle('📥 Transaction Submitted')
            .setDescription(`Thank you! Your transaction proof has been logged for review.\n\n**Item:** \`${productKey}\`\n**Submitted Hash:**\n\`\`\`${userTxProof}\`\`\``)
            .setColor(0x00FF00)
            .setTimestamp();

        await interaction.reply({ embeds: [confirmationEmbed] });

        await interaction.channel.send(
            `🔔 <@&${ADMIN_ROLE_ID}>, <@${interaction.user.id}> has submitted a crypto transaction proof for **${productKey}**! Please verify and deliver the code manually.`
        );
    }
});

// Initialize Services
const port = process.env.PORT || 3000;
webApp.listen(port, () => console.log(`HTTP Webhook Listener running on port ${port}`));
botClient.login(process.env.DISCORD_TOKEN);
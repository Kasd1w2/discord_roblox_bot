const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const Inventory = require('../models/Inventory');
const Ledger = require('../models/Ledger');
const { getCryptoAmounts, calculatePoints } = require('../utils/helpers');
const { updateBotStatus } = require('../utils/botStatus');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function handleInteraction(interaction, botClient) {
    if (interaction.isChatInputCommand()) {
        const commandLabel = interaction.commandName;

        if (commandLabel === 'view-points') {
            await interaction.deferReply();
            const targetUser = interaction.options.getUser('user');

            try {
                const userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) {
                    return interaction.editReply({ content: `❌ <@${targetUser.id}> does not have any records or points on file.` });
                }

                const points = userLedger.points || 0;
                const coupons = userLedger.coupons && userLedger.coupons.length > 0 
                    ? userLedger.coupons.map(c => `${c}% Off`).join(', ') 
                    : 'None';
                const purchaseCount = userLedger.purchases ? userLedger.purchases.length : 0;

                const profileEmbed = new EmbedBuilder()
                    .setTitle(`📊 User Profile: ${targetUser.username}`)
                    .setThumbnail(targetUser.displayAvatarURL())
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '⭐ Points Balance', value: `\`${points}\``, inline: true },
                        { name: '🎟️ Unused Coupons', value: `\`${coupons}\``, inline: true },
                        { name: '🛒 Total Purchases', value: `\`${purchaseCount}\``, inline: true }
                    );

                await interaction.editReply({ embeds: [profileEmbed] });
            } catch (err) {
                console.error('Database error in view-points:', err);
                await interaction.editReply({ content: '❌ Failed to fetch user data from the database.' });
            }
        }

        if (commandLabel === 'give-coupon') {
            await interaction.deferReply({ flags: 64 });
            const targetUser = interaction.options.getUser('user');
            const discountPct = interaction.options.getNumber('discount');

            try {
                let userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) {
                    userLedger = new Ledger({ discordId: targetUser.id, purchases: [], points: 0, coupons: [] });
                }
                
                userLedger.coupons.push(discountPct);
                await userLedger.save();

                await interaction.editReply({ 
                    content: `✅ Successfully gave a **${discountPct}% Off Coupon** to <@${targetUser.id}> for testing.` 
                });
            } catch (err) {
                console.error('Database error giving coupon:', err);
                await interaction.editReply({ 
                    content: '❌ Failed to update database. Please check the bot console for details.' 
                });
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
                .setColor(0xFFD700);

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

        if (commandLabel === 'setup-store') {
            const storeType = interaction.options.getString('store_type');
            const selectedChannelOption = interaction.options.getChannel('channel');

            if (storeType === 'account' || storeType === 'catalog') {
    updateBotStatus(botClient, `🏷️ Deploying User Catalog`);
    
    const catalogEmbed = new EmbedBuilder()
        .setTitle('💎 R0BLOX - Username Stock')
        .setDescription(
            `👑 We DO NOT proxy the same accs seen in the Com. A large majority of accs are directly from the original owners. Largely obtained through private methods which only we know.\n\n` +
            `🛡️ Every acc is new to com, unverified, and sniped by us (unless stated otherwise). All accs are guaranteed to be safe.\n` +
            `All acc details can be provided upon enquiry.\n\n` +
            `💲 Users are sorted by price in USD, select your budget within the dropdown to see users. All BINs are negotiable.\n\n` +
            `Payment Methods accepted: 🪙 Crypto, ✨ Clean Limiteds\n\n` +
            `For an extra +% we can also take: 🅿️ Paypal, 💲 CashApp,  Apple Pay, ♈ Venmo, ℤ Zelle, 🏦 Bank Transfer and 🟧 Interac.\n\n` +
            `Select an option below to purchase then make a ticket.`
        )
        .setColor(0x2B2D31);

    const tierMenu = new StringSelectMenuBuilder()
        .setCustomId('user_tier_select')
        .setPlaceholder('Select a subcategory')
        .addOptions([
            { label: 'Triple Numbers', description: 'View Triple Numbers accounts', value: 'cat_triple_numbers' },
            { label: '4 Letters', description: 'View 4 Letters accounts', value: 'cat_4_letters' },
            { label: 'Edgy Compounds', description: 'View Edgy Compounds accounts', value: 'cat_edgy_compounds' },
            { label: 'Finance Compounds', description: 'View Finance Compounds accounts', value: 'cat_finance_compounds' },
            { label: 'Leetspeak', description: 'View Leetspeak accounts', value: 'cat_leetspeak' },
            { label: 'Other', description: 'View Other accounts', value: 'cat_other' }
        ]);

    const targetChannel = await interaction.guild.channels.fetch(selectedChannelOption.id);
    await targetChannel.send({ embeds: [catalogEmbed], components: [new ActionRowBuilder().addComponents(tierMenu)] });
    return interaction.reply({ content: '✅ Username catalog deployed successfully!', flags: 64 });
}

            // Single item forum post logic
            const productTitle = interaction.options.getString('title');
            const productPrice = interaction.options.getNumber('price');
            const productKey = interaction.options.getString('item_id');
            const robloxLink = interaction.options.getString('catalog_url');
            const thumbnailPic = interaction.options.getString('image_url');
            const deliveryMethod = interaction.options.getString('delivery_method');

            if (!productTitle || !productPrice || !productKey || !thumbnailPic || !deliveryMethod) {
                return interaction.reply({ content: '❌ Missing required fields for a Single Item forum post.', flags: 64 });
            }

            updateBotStatus(botClient, `🏷️ Creating store listing: ${productTitle}`);
            const targetForum = await interaction.guild.channels.fetch(selectedChannelOption.id);
            
            const embedFields = [
                { name: 'Price', value: `$${productPrice} USD`, inline: true },
                { name: 'Delivery', value: deliveryMethod, inline: true }, 
                { name: '\u200B', value: '\u200B', inline: true }
            ];

            if (robloxLink) {
                embedFields.push({ name: 'Rolimons Link', value: `[View item](${robloxLink})`, inline: false });
            }

            const listingEmbed = new EmbedBuilder()
                .setTitle(`${productTitle}`)
                .setDescription(`Click on the button below to purchase!`)
                .setColor(0x2B2D31)
                .addFields(embedFields)
                .setImage(thumbnailPic);

            const fullLabel = `Purchase ${productTitle}`;
            const safeLabel = fullLabel.length > 80 ? `${fullLabel.slice(0, 77)}...` : fullLabel;

            const buyActionBtn = new ButtonBuilder()
                .setCustomId(`purchase_action|${productKey}|${productPrice}`)
                .setLabel(safeLabel)
                .setStyle(ButtonStyle.Primary);

            await targetForum.threads.create({
                name: productTitle,
                message: { embeds: [listingEmbed], components: [new ActionRowBuilder().addComponents(buyActionBtn)] }
            });

            await interaction.reply({ content: `✅ Successfully created forum post for **${productTitle}**!`, flags: 64 });
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

        if (commandLabel === 'request-limited') {
            const requestEmbed = new EmbedBuilder()
                .setTitle('🔎 Need a Specific Limited?')
                .setDescription(
                    `Can't find the item you're looking for? **We'll help track it down.**\n\n` +
                    `We can source **practically any Limited** upon request, including rare or hard-to-find items.\n\n` +
                    `⏱️ **Sourcing Time:** 12 Hours — 7 Days\n` +
                    `*Times may vary depending on availability and copies on the market.*\n\n` +
                    `💰 **30% Deposit Required**\n` +
                    `A 30% deposit of the agreed price is required to begin sourcing. **Fully refundable if the item cannot be located.**\n\n` +
                    `⭐ **Why Choose Us?**\n` +
                    `⚡ **Fast & Responsive** — Quick communication & updates.\n` +
                    `🔍 **Dedicated Sourcing** — We actively search for your item.\n` +
                    `🛡️ **Reliable Service** — Simple, straightforward process.\n` +
                    `📈 **Strong Track Record** — We've successfully sourced the vast majority of requested items.\n\n` +
                    `🎟️ **Start Sourcing**\n` +
                    `Open a ticket in <#1542544665969164308> and tell us what you're looking for!`
                )
                .setColor(0x3B82F6);

            await interaction.channel.send({ embeds: [requestEmbed] });
            await interaction.reply({ content: '✅ Request Limited embed posted!', flags: 64 });
        }

        if (commandLabel === 'restock') {
            const itemId = interaction.options.getString('item_id');
            updateBotStatus(botClient, `📥 Restocking items for: ${itemId.toUpperCase()}`);
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
            updateBotStatus(botClient, `📊 Checking inventory stock`);
            const allInventory = await Inventory.find({});
            if (!allInventory || allInventory.length === 0) {
                return interaction.reply({ content: 'No inventory records found in the database.' });
            }

            const stockList = allInventory.map(item => `• **${item.itemId}**: ${item.codes.length} code(s) remaining`).join('\n');
            await interaction.reply({ content: `📦 **Current Inventory Stock:**\n${stockList}` });
        }

        if (commandLabel === 'remove-stock') {
            const itemId = interaction.options.getString('item_id');
            updateBotStatus(botClient, `🗑️ Removing stock for: ${itemId.toUpperCase()}`);
            
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

        if (commandLabel === 'deliver') {
            const targetUser = interaction.options.getUser('buyer');
            const itemId = interaction.options.getString('item_id');
            const itemPrice = interaction.options.getNumber('price') || 0;

            updateBotStatus(botClient, `📦 Delivering item: ${itemId.toUpperCase()}`);

            if (!interaction.channel.name.startsWith('trade-')) {
                return interaction.reply({ content: '🛑 This command can only be used inside a trade/order channel.', flags: 64 });
            }

            try {
                const itemRecord = await Inventory.findOne({ itemId });
                if (!itemRecord || itemRecord.codes.length === 0) {
                    return interaction.reply({ content: `❌ Stock error: Item \`${itemId}\` is completely out of stock!`, flags: 64 });
                }

                const deliveredCode = itemRecord.codes.shift();
                await itemRecord.save();

                let userLedger = await Ledger.findOne({ discordId: targetUser.id });
                if (!userLedger) {
                    userLedger = new Ledger({ discordId: targetUser.id, purchases: [], points: 0, coupons: [] });
                }

                const pointsEarned = calculatePoints(itemPrice);
                userLedger.purchases.push({ item: itemId, code: deliveredCode });
                if (pointsEarned > 0) {
                    userLedger.points += pointsEarned;
                }
                await userLedger.save();

                const deliveryEmbed = new EmbedBuilder()
                    .setTitle('🎁 Order Delivery')
                    .setDescription(`Here is your requested code for **${itemId.toUpperCase()}**:\n\`\`\`${deliveredCode}\`\`\``)
                    .setColor(0x00FF00)
                    .setFooter({ text: 'Thank you for your business!' })
                    .setTimestamp();

                let pointNotice = pointsEarned > 0 ? `\n⭐ You earned **${pointsEarned} points** for this order!` : '';

                await interaction.reply({ content: `✅ Successfully pulled code for ${targetUser.tag} and sent it to the channel.`, flags: 64 });
                
                await interaction.channel.send({
                    content: `Hey <@${targetUser.id}>! Here is your delivery:${pointNotice}`,
                    embeds: [deliveryEmbed]
                });
                await interaction.channel.send(`🙏 Thank you again for your business, <@${targetUser.id}>! If you have a moment, please drop a vouch in <#1542340439166820434>. We'd really appreciate it!`);
            } catch (err) {
                console.error('Error in /deliver command:', err);
                await interaction.reply({ content: 'An error occurred while attempting to deliver the code.', flags: 64 });
            }
        }

        if (commandLabel === 'close') {
            updateBotStatus(botClient, `CloseOperation: ${interaction.options.getString('item_id')?.toUpperCase() || 'Unknown Item'}`);
            const status = interaction.options.getString('status');
            const method = interaction.options.getString('method') || 'Unknown Method';
            const price = interaction.options.getNumber('price');
            const buyer = interaction.options.getUser('buyer');
            const channel = interaction.channel;

            if (!channel.name.startsWith('trade-')) return interaction.reply({ content: '🛑 This command can only be used inside a trade channel.', flags: 64 });

            await interaction.reply({ content: '🔒 Processing order closure and cleaning up channel...', flags: 64 });

            if (status === 'success') {
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

    if (interaction.isButton()) {
        const customId = interaction.customId;
        // Handle custom button actions (e.g. purchase_action)
    }

    if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        // Handle select menu choices (e.g. user_tier_select, buy_coupon)
    }
}

module.exports = { handleInteraction };
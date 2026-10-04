const { createHash } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { createOrderStore, OrderError, toCents, requireOpen } = require('./orderStore');
const { publicMessage } = require('./messageStyle');
const { accountListings, parseAccountEntry, normalizeAccountCategory } = require('./accounts');
const { shopTerms } = require('./shopTerms');

const money = cents => cents == null ? 'Awaiting quote' : `$${(cents / 100).toFixed(2)} USD`;
const safeText = value => String(value ?? '').replace(/[`*_~|<>]/g, '').slice(0, 180);
const orderColor = order => order.kind === 'boost' ? 0xFF73FA : order.kind === 'decoration' ? 0xA855F7 :
    order.kind === 'account' ? 0xF1F5F9 : 0x14B8A6;
const COMMANDS = [
    { name: 'terms', description: 'Staff: post the shop terms and warranty policy in this channel', type: 1 },
    { name: 'my-orders', description: 'View your saved orders and their progress', type: 1 },
    { name: 'order', description: 'Staff: privately view an order summary', type: 1,
        options: [{ name: 'order_id', description: 'Order ID (defaults to the current ticket)', type: 3, required: false }] },
    { name: 'confirm-payment', description: 'Staff: confirm a manual payment for an order', type: 1,
        options: [
            { name: 'method', description: 'Payment method, for example Crypto or PayPal', type: 3, required: true },
            { name: 'price', description: 'USD amount received (defaults to the saved order total)', type: 10, required: false, min_value: 0.01 },
            { name: 'order_id', description: 'Order ID (defaults to the current ticket)', type: 3, required: false }
        ] },
    { name: 'transcript', description: 'Download a saved order transcript', type: 1,
        options: [{ name: 'order_id', description: 'The order ID shown in /my-orders', type: 3, required: true }] },
    { name: 'rate-order', description: 'Rate your delivered order from 1 to 5 stars', type: 1,
        options: [
            { name: 'stars', description: 'Your rating from 1 to 5', type: 4, required: true, min_value: 1, max_value: 5 },
            { name: 'order_id', description: 'Order ID (required after the ticket closes)', type: 3, required: false }
        ] }
];

function completedReceipt(order) {
    const rating = Number.isInteger(order.starRating) && order.starRating >= 1 && order.starRating <= 5 ?
        `${'★'.repeat(order.starRating)}${'☆'.repeat(5 - order.starRating)} (${order.starRating}/5)` : 'Not rated';
    const rawProduct = order.productName || order.productKey;
    const product = /^(?:toy[_ -]?codes?)$/i.test(rawProduct) ? 'Toy Code' : safeText(rawProduct);
    const method = safeText(order.paymentMethod || 'Unknown');
    const paymentEmoji = /crypto|eth|ltc|btc|sol/i.test(method) ? '<:crypto:1554263320997920799>' :
        /stripe|card/i.test(method) ? '<:stripe:1554263177829687398>' : '<:dots:1555973916944637952>';
    return new EmbedBuilder().setTitle(process.env.LIVE_DELIVERIES_TITLE || 'Stocked | New Completed Order!').setColor(0x57F287)
        .addFields(
            { name: 'Star Rating', value: `\`${rating}\`` },
            { name: 'Product Purchased', value: `${product === 'Toy Code' ? '🍂' : '🎁'} \`${product}\`` },
            { name: 'USD Spent', value: `\`$${((order.paidCents || 0) / 100).toFixed(2)}\`` },
            { name: 'Payment Method', value: `${paymentEmoji} \`${method}\`` },
            { name: 'Order Id', value: `\`${order.orderId}\`` }
        );
}

function isStaff(interaction, roleId) {
    const roles = interaction.member?.roles;
    return Boolean(roles?.cache?.has(roleId) || Array.isArray(roles) && roles.includes(roleId));
}

function assertAuthorized(interaction, order, roleId, staffOnly = false, buyerOnly = false) {
    if (!order || order.guildId !== interaction.guildId) throw new OrderError('Order not found in this server.');
    const staff = isStaff(interaction, roleId);
    if (staffOnly && !staff) throw new OrderError('Only shop staff can use this control.');
    if (buyerOnly && order.buyerId !== interaction.user.id) throw new OrderError('Only this order’s buyer can use checkout controls.');
    if (!staffOnly && !buyerOnly && !staff && order.buyerId !== interaction.user.id) throw new OrderError('This is not your order.');
}

function createOrderRuntime({ mongoose, botClient, stripe, Inventory, Ledger, adminRoleId,
    decoPackages, formatProductName, getCryptoAmounts, categoryNames }) {
    const positiveSetting = (name, fallback) => {
        const value = Number(process.env[name]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const store = createOrderStore({ connection: mongoose.connection, Inventory, Ledger,
        cooldownSeconds: positiveSetting('ORDER_TICKET_COOLDOWN_SECONDS', 30), ticketHours: positiveSetting('ORDER_TICKET_TTL_HOURS', 24) });
    const boostPackages = [
        ['2_boosts', '2x Boosts (Level 1)', 99], ['4_boosts', '4x Boosts', 175],
        ['6_boosts', '6x Boosts', 225], ['8_boosts', '8x Boosts (Level 2)', 275],
        ['10_boosts', '10x Boosts', 325], ['12_boosts', '12x Boosts', 349], ['14_boosts', '14x Boosts (Level 3)', 399]
    ];
    let recoveryRunning = false;
    let recoveryTimer;
    const archiveJobs = new Map();
    const transcriptFileBytes = 6000000;
    const transcriptBatchSize = 3;

    function commandDefinitions(existing) {
        const definitions = existing.map(command => command.toJSON ? command.toJSON() : command);
        return [...definitions.filter(command => !COMMANDS.some(item => item.name === command.name)), ...COMMANDS];
    }

    async function orderFor(interaction, orderId = null, options = {}) {
        const order = orderId ? await store.get(orderId) : await store.byChannel(interaction.channelId);
        if (!order) throw new OrderError('This ticket predates saved order tracking. Open a new ticket to use these controls.');
        assertAuthorized(interaction, order, adminRoleId, options.staffOnly, options.buyerOnly);
        if (!options.anyChannel && order.channelId !== interaction.channelId) throw new OrderError('Use these controls inside the matching order ticket.');
        return order;
    }

    function orderSummary(order) {
        const color = order.status === 'issue' ? 0xFEE75C : order.status === 'cancelled' ? 0xED4245 :
            order.status === 'expired' ? 0xF59E0B : order.paymentStatus === 'paid' ? 0x57F287 : orderColor(order);
        return new EmbedBuilder().setTitle(`Order ${order.orderId}`).setColor(color)
            .setDescription(`**${safeText(order.productName || formatProductName(order.productKey))}**` +
                (order.selectedAccount ? `\nRequested account: @${safeText(order.selectedAccount)}` : ''))
            .addFields(
                { name: 'Buyer', value: `<@${order.buyerId}>`, inline: true },
                { name: 'Status', value: order.closing ? 'Archiving transcript' : safeText(order.status.replace(/_/g, ' ')), inline: true },
                { name: 'Total', value: money(order.paidCents ?? order.totalCents), inline: true },
                { name: 'Payment', value: order.paymentStatus === 'paid' ? `Confirmed • ${safeText(order.paymentMethod)}` : 'Awaiting payment', inline: true },
                { name: 'Coupon', value: order.coupon ? `${order.coupon.discountPct}% reserved until <t:${Math.floor(order.coupon.expiresAt / 1000)}:t>` : order.couponConsumed ? 'Applied to payment' : 'None', inline: true }
            ).setTimestamp(order.createdAt);
    }

    function buyerRow(order) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`buyer_order|cancel|${order.orderId}`).setLabel('Cancel Order').setStyle(ButtonStyle.Danger)
                .setEmoji('<:trashcan:1554593006596657262>').setDisabled(!order.active || order.closing || order.paymentStatus === 'paid')
        );
    }

    async function fetchChannel(order) {
        if (!order.channelId) return null;
        try { return await botClient.channels.fetch(order.channelId); }
        catch (error) { if (error.code === 10003) return null; throw error; }
    }

    async function retireStaffPanel(order) {
        if (!order.panelMessageId) return;
        const channel = await fetchChannel(order);
        if (channel) {
            try {
                const panel = await channel.messages.fetch(order.panelMessageId);
                await panel.edit(publicMessage(`Order **${order.orderId}** — ${safeText(order.productName)}.\nFor help, send a message in this ticket.`,
                    { title: '🎫 Order Ticket', color: orderColor(order), components: [] }));
            } catch (error) { if (error.code !== 10008) throw error; }
        }
        await store.patch(order.orderId, { panelMessageId: null, claimedBy: null });
    }

    function checkoutPayload(order, coupons = []) {
        const name = safeText(order.productName || formatProductName(order.productKey));
        const details = order.kind === 'decoration' ? '\n\nSend the exact decoration name or shop link in this ticket. Staff delivers your gift link after payment confirmation.' : '';
        const embed = new EmbedBuilder().setTitle('🛒 Secure Checkout Portal')
            .setDescription(`Order **${order.orderId}**\n**${name}**\nTotal: **${money(order.totalCents)}**${details}` +
                (order.coupon ? `\n\n${order.coupon.discountPct}% coupon reserved. It is consumed only after payment.` : ''))
            .setColor(order.coupon ? 0xFFD700 : orderColor(order));
        const payment = new StringSelectMenuBuilder().setCustomId(`payment_select|${order.orderId}`).setPlaceholder('Choose your payment method...')
            .addOptions([
                { label: 'Pay with Card (Stripe)', value: 'select_stripe', emoji: '<:stripe:1554263177829687398>' },
                { label: 'Pay with Cryptocurrency', value: 'select_crypto', emoji: '<:crypto:1554263320997920799>' },
                { label: 'Other Payment Method', value: 'select_other', emoji: '<:dots:1555973916944637952>' }
            ]);
        const components = [new ActionRowBuilder().addComponents(payment)];
        if (order.coupon || coupons.length) components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`use_coupon_yes|${order.orderId}`).setLabel(order.coupon ? 'Change Coupon' : 'Use Coupon').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`use_coupon_no|${order.orderId}`).setLabel(order.coupon ? 'Remove Coupon' : 'Skip Coupon').setStyle(ButtonStyle.Secondary)
        ));
        components.push(buyerRow(order));
        return { content: null, embeds: [embed], components, allowedMentions: { parse: [] } };
    }

    async function renderCheckout(order, interaction = null) {
        const coupons = await store.couponsFor(order.buyerId, order.orderId);
        const payload = checkoutPayload(order, coupons);
        if (interaction) await interaction.editReply(payload);
        else {
            const channel = await fetchChannel(order);
            if (!channel) return;
            let message;
            if (order.checkoutMessageId) {
                try { message = await channel.messages.fetch(order.checkoutMessageId); }
                catch (error) { if (error.code !== 10008) throw error; }
            }
            if (message) await message.edit(payload);
            else {
                message = await channel.send(payload);
                await store.patch(order.orderId, { checkoutMessageId: message.id });
            }
        }
    }

    async function createTicket(interaction, input) {
        const order = await store.openOrder({ ...input, buyerId: interaction.user.id, guildId: interaction.guildId });
        let channel;
        try {
            const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
            channel = await interaction.guild.channels.create({
                name: `trade-${input.kind}-${username}-${order.orderId.slice(-4).toLowerCase()}`.substring(0, 100),
                type: ChannelType.GuildText, topic: `Order ${order.orderId} | Buyer ${order.buyerId}`,
                permissionOverwrites: [
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: order.buyerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: botClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });
            const saved = await store.patch(order.orderId, { channelId: channel.id });
            await channel.send(publicMessage(`Welcome, <@${order.buyerId}>!\nYour order ID is **${order.orderId}**.\nOur staff will help you here.`,
                { title: '🎫 Your Order Ticket', color: orderColor(order), users: [order.buyerId], roles: [adminRoleId] }));
            if (input.kind === 'boost' || input.kind === 'decoration') {
                const choices = input.kind === 'boost' ? boostPackages.map(([key, label]) => ({ label, value: key, emoji: '<a:boostlogo:1554263092244906005>' })) :
                    decoPackages.map(pkg => ({ label: `$${pkg.shopPrice} Shop Tier → $${pkg.price}`, value: `deco_${pkg.shopPrice}`, emoji: '<:price:1554267169800585227>' }));
                const menu = new StringSelectMenuBuilder().setCustomId(`${input.kind === 'boost' ? 'select_boost_package' : 'select_deco_package'}|${order.orderId}`)
                    .setPlaceholder('Select your package...').addOptions(choices);
                const welcome = new EmbedBuilder().setTitle(input.kind === 'boost' ? '🚀 Server Boost Purchase' : '✨ Decoration Purchase')
                    .setDescription(input.kind === 'boost' ? 'Select the package you want below. Staff will help with payment and delivery.' :
                        'Select the shop price matching your decoration, then send its name or shop link in this ticket.')
                    .setColor(orderColor(order)).setFooter({ text: `Order ${order.orderId}` });
                const message = await channel.send({ embeds: [welcome],
                    components: [new ActionRowBuilder().addComponents(menu), buyerRow(saved)], allowedMentions: { parse: [] } });
                await store.patch(order.orderId, { checkoutMessageId: message.id });
            } else if (input.baseCents) await renderCheckout(saved);
            else await channel.send(publicMessage('Staff will confirm your item and quote a price before payment.',
                { title: '💬 Waiting for a Quote', color: 0xF59E0B, components: [buyerRow(saved)] }));
            await interaction.editReply({ content: `✅ Order **${order.orderId}** created: <#${channel.id}>` });
        } catch (error) {
            // Preserve a partly created ticket and its saved order for staff support.
            if (!channel) await store.abandonCreation(order.orderId);
            else console.error(`Order ${order.orderId} needs staff assistance in channel ${channel.id}:`, error);
            throw error;
        }
    }

    async function notifyPaid(result) {
        const order = result.order;
        if (order.paymentNoticeSent) { await retireStaffPanel(order); return; }
        const text = `Order **${order.orderId}**\n` +
            `<@${order.buyerId}> paid **${money(order.paidCents)}** using **${safeText(order.paymentMethod)}**.\n` +
            `<a:MTF_Credits:1554593086544412803> Earned **${order.pointsEarned} points**.\n` +
            `<@&${adminRoleId}> Manual delivery is required${order.kind === 'decoration' ? ' via gift link' : ''}.`;
        const channel = await fetchChannel(order);
        if (channel) {
            // A stable Discord nonce also reduces duplicate notices when the process
            // restarts after Discord accepted the message but before MongoDB saved it.
            await channel.send(publicMessage(text, { title: '✅ Payment Confirmed', color: 0x57F287,
                users: [order.buyerId], roles: [adminRoleId], nonce: order.orderId.replace('ORD-', ''), enforceNonce: true }));
            await retireStaffPanel(order);
            if (order.checkoutMessageId) {
                try { await (await channel.messages.fetch(order.checkoutMessageId)).edit(publicMessage(
                    `Order **${order.orderId}** has been paid.\nStaff will deliver your order.`,
                    { title: '✅ Payment Confirmed', color: 0x57F287, components: [] })); }
                catch (error) { if (error.code !== 10008) throw error; }
            }
        } else {
            const logId = process.env.ORDER_LOG_CHANNEL_ID || '1542337221791711324';
            const log = await botClient.channels.fetch(logId);
            if (!log?.isTextBased()) throw new Error(`Payment for ${order.orderId} is saved, but no notification channel is available.`);
            await log.send(publicMessage(text + '\n⚠️ The ticket is unavailable. Staff must arrange delivery.',
                { title: '⚠️ Paid Order Needs Delivery', color: 0xFEE75C, roles: [adminRoleId] }));
        }
        await store.patch(order.orderId, { paymentNoticeSent: true });
    }

    async function reconcileCheckout(order, expire = false) {
        if (order.checkoutCreating?.until > new Date()) throw new OrderError('Checkout is being created. Wait a moment and try again.');
        if (!order.stripeSessionId || order.paymentStatus === 'paid') return order;
        let checkout = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        if (expire && checkout.status === 'open') {
            try { checkout = await stripe.checkout.sessions.expire(checkout.id); }
            catch (error) {
                checkout = await stripe.checkout.sessions.retrieve(checkout.id);
                if (checkout.status === 'open') throw error;
            }
        }
        if (checkout.payment_status === 'paid') {
            const result = await store.markPaid(order.orderId, { amountCents: checkout.amount_total, method: 'Stripe',
                actorId: 'stripe', stripeSessionId: checkout.id });
            await notifyPaid(result);
            return result.order;
        }
        if (checkout.status === 'complete') throw new OrderError('Card payment is still processing. The ticket has been kept open.');
        if (checkout.status === 'expired') {
            order = await store.clearCheckout(order.orderId, checkout.id);
            if (order.coupon) order = await store.releaseCoupon(order.orderId);
        }
        return order;
    }

    async function stripeCheckout(order, interaction) {
        requireOpen(order);
        order = await reconcileCheckout(order);
        if (order.paymentStatus === 'paid') { await interaction.editReply(publicMessage('This order is already paid. Staff will handle delivery.',
            { title: '✅ Payment Confirmed', color: 0x57F287, components: [] })); return; }
        if (!order.totalCents) throw new OrderError('Staff must confirm a price before checkout.');
        let checkout;
        if (order.stripeSessionId) checkout = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        else {
            if (order.coupon?.expiresAt <= new Date()) order = await store.releaseCoupon(order.orderId);
            const { token, order: lockedOrder } = await store.beginCheckout(order.orderId);
            try {
                const finalCents = Math.round(lockedOrder.totalCents * 1.05);
                checkout = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'], mode: 'payment',
                    expires_at: lockedOrder.checkoutCreateExpiresAt,
                    line_items: [{ price_data: { currency: 'usd', unit_amount: finalCents,
                        product_data: { name: formatProductName(lockedOrder.productKey) + ' (+5% Processing Fee)' } }, quantity: 1 }],
                    success_url: 'https://discord.com', cancel_url: 'https://discord.com',
                    metadata: { order_id: lockedOrder.orderId, discord_user_id: lockedOrder.buyerId,
                        item_id: lockedOrder.productKey, channel_id: lockedOrder.channelId }
                }, { idempotencyKey: `${lockedOrder.orderId}-quote-${lockedOrder.quoteVersion}` });
                order = await store.attachCheckout(order.orderId, token, checkout);
            } catch (error) {
                // A timed-out create may have succeeded at Stripe. Keep the lease and
                // retry with the same idempotency key, rather than issuing a new quote.
                if (checkout?.id) {
                    try { await stripe.checkout.sessions.expire(checkout.id); } catch (expireError) { console.error('Could not expire unattached checkout:', expireError); }
                    await store.checkoutFailed(order.orderId, token);
                }
                throw error;
            }
        }
        const embed = new EmbedBuilder().setTitle('💳 Stripe Card Checkout').setColor(0x635BFF)
            .setDescription(`Order **${order.orderId}**\nTotal: **${money(checkout.amount_total)}**, including the 5% processing fee.\n` +
                'Staff will deliver manually after payment confirmation.\nCheckout expires in about 30 minutes; an unused coupon is released on expiry.');
        const pay = new ButtonBuilder().setLabel(`Pay ${money(checkout.amount_total)}`).setURL(checkout.url).setStyle(ButtonStyle.Link);
        const expire = new ButtonBuilder().setCustomId(`expire_checkout|${order.orderId}`).setLabel('Change Payment Method').setStyle(ButtonStyle.Secondary);
        await interaction.editReply({ content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(pay, expire), buyerRow(order)] });
        await retireStaffPanel(order);
    }

    function input(id, label, value = '', style = TextInputStyle.Short) {
        const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 100);
        if (value) field.setValue(value);
        return new ActionRowBuilder().addComponents(field);
    }

    async function transcriptChannel(order, channelId) {
        const channel = await botClient.channels.fetch(channelId || process.env.TRANSCRIPT_CHANNEL_ID || '1542545115564998678');
        if (!channel?.isTextBased() || typeof channel.send !== 'function' || channel.guildId !== order.guildId || channel.id === order.channelId) {
            throw new Error('The transcript destination must be a separate text channel in the order server.');
        }
        return channel;
    }

    function transcriptInfo(order, channelMissing, savedAt = new Date()) {
        return { savedAt, channelMissing, receipt: {
            paidCents: order.paidCents || 0, paymentMethod: order.paymentMethod || 'Unpaid', points: order.pointsEarned || 0,
            status: order.closeFinalStatus || order.status, reason: order.closeReason || '',
        } };
    }

    async function transcriptFiles(order, info, messages) {
        const receipt = info.receipt;
        let lines = [`ORDER TRANSCRIPT\nOrder: ${order.orderId}\nProduct: ${order.productName}\nBuyer: ${order.buyerId}\n` +
            `Payment: ${money(receipt.paidCents)} (${receipt.paymentMethod})\nPoints: ${receipt.points}\nStatus: ${receipt.status}\n` +
            `Reason: ${receipt.reason}\nSaved: ${new Date(info.savedAt).toISOString()}\n` +
            (info.channelMissing ? 'Note: the channel was already unavailable when archival ran.\n' : '') + '\n'];
        let bytes = Buffer.byteLength(lines[0]), messageCount = 0;
        const buffers = [];
        for await (const message of messages) {
            const line = `[${new Date(message.createdAt).toISOString()}] ${message.author} (${message.authorId})\n${message.content || ''}\n` +
                (message.reference ? `Reply to: ${message.reference}\n` : '') +
                (message.embeds || []).map(embed => `Embed: ${JSON.stringify(embed)}\n`).join('') +
                (message.attachments || []).map(file => `Attachment: ${file.name} (${file.size} bytes) ${file.url}\n`).join('') + '\n';
            const size = Buffer.byteLength(line);
            if (size > transcriptFileBytes) throw new Error('A transcript message is too large to archive. The ticket has been kept.');
            if (bytes + size > transcriptFileBytes) { buffers.push(Buffer.from(lines.join(''))); lines = []; bytes = 0; }
            lines.push(line); bytes += size; messageCount++;
        }
        buffers.push(Buffer.from(lines.join('')));
        return { messageCount, files: buffers.map((buffer, index) => new AttachmentBuilder(buffer, {
            name: `${order.orderId}-transcript${buffers.length > 1 ? `-${index + 1}` : ''}.txt`
        })) };
    }

    async function uploadTranscript(order, info, files, messageCount) {
        // Persist only upload progress and message IDs. A retry reuses or edits
        // the already-uploaded batches instead of reposting their contents.
        let progress = order.transcriptUpload || { savedAt: info.savedAt, batches: [] };
        const destination = await transcriptChannel(order, progress.channelId);
        progress = { ...progress, channelId: destination.id, batches: [...progress.batches] };
        await store.patch(order.orderId, { transcriptUpload: progress });
        const messageIds = [];
        for (let offset = 0, index = 0; offset < files.length; offset += transcriptBatchSize, index++) {
            const batch = files.slice(offset, offset + transcriptBatchSize);
            const hash = createHash('sha256');
            for (const file of batch) hash.update(file.name).update(file.attachment);
            const digest = hash.digest('hex');
            const previous = progress.batches[index];
            const hasFiles = message => message.attachments.size === batch.length && batch.every(file =>
                [...message.attachments.values()].some(attachment => attachment.name === file.name && attachment.size === file.attachment.length));
            let message;
            if (previous?.messageId) {
                try { message = await destination.messages.fetch({ message: previous.messageId, force: true }); }
                catch (error) { if (error.code !== 10008) throw error; }
                if (message && message.author?.id !== botClient.user.id) throw new Error('Saved transcript message is not owned by this bot.');
            }
            const payload = { embeds: [new EmbedBuilder().setTitle('Ticket Transcript').setColor(orderColor(order))
                .setDescription(`<a:folder:1554593038003609620> **Order:** ${order.orderId}\n` +
                    `<a:box:1554592797733163099> **Product:** ${safeText(order.productName)}\n` +
                    `<a:white_user:1554592911679553577> **Buyer:** <@${order.buyerId}>\n` +
                    `<a:confirm:1554592986334105620> **Status:** ${safeText(info.receipt.status)}\n**Messages:** ${messageCount}\n` +
                    `**Files:** ${offset + 1}–${offset + batch.length} of ${files.length}`)],
                files: batch, allowedMentions: { parse: [] } };
            if (!message) {
                const nonce = createHash('sha256').update(`${order.orderId}:${new Date(progress.savedAt).toISOString()}:${index}:${digest}`).digest('hex').slice(0, 24);
                message = await destination.send({ ...payload, nonce, enforceNonce: true });
            } else if (previous.digest !== digest || !hasFiles(message)) {
                message = await message.edit({ ...payload, attachments: [] });
            }
            if (!hasFiles(message)) throw new Error('Discord did not return every transcript attachment. The ticket has been kept.');
            progress.batches[index] = { digest, messageId: message.id };
            await store.patch(order.orderId, { transcriptUpload: progress });
            messageIds.push(message.id);
        }
        return { storage: 'discord', channelId: destination.id, messageIds, fileCount: files.length,
            messageCount, savedAt: info.savedAt, channelMissing: Boolean(info.channelMissing), cleanupPending: true };
    }

    async function saveTranscript(order, channel) {
        const pages = [];
        let before;
        if (channel) {
            while (true) {
                const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                if (!page.size) break;
                const sorted = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
                pages.push(sorted.map(message => ({ id: message.id, createdAt: message.createdAt,
                    authorId: message.author?.id, author: message.author?.tag || message.author?.username || 'Unknown',
                    content: message.content, embeds: message.embeds.map(embed => embed.toJSON()),
                    attachments: [...message.attachments.values()].map(file => ({ name: file.name, url: file.url, size: file.size })),
                    reference: message.reference?.messageId || null })));
                before = sorted[0].id;
                if (page.size < 100) break;
            }
        }
        const info = transcriptInfo(order, !channel, order.transcriptUpload?.savedAt || new Date());
        const { files, messageCount } = await transcriptFiles(order, info, pages.reverse().flat());
        return uploadTranscript(order, info, files, messageCount);
    }

    async function clearTranscriptParts(order) {
        if (!order.transcript?.cleanupPending) return order;
        // The Discord references are durable before any old Mongo content is removed.
        await store.parts().deleteMany({ orderId: order.orderId });
        return store.patch(order.orderId, { 'transcript.cleanupPending': false, transcriptUpload: null });
    }

    async function migrateTranscriptUnlocked(order) {
        if (order.transcript?.storage === 'discord') return clearTranscriptParts(order);
        const info = order.transcript;
        if (!info?.snapshotId) throw new Error('No saved Mongo transcript is available to migrate.');
        let partCount = 0;
        async function* messages() {
            for await (const part of store.parts().find({ orderId: order.orderId, snapshotId: info.snapshotId }).sort({ part: -1 })) {
                if (part.part !== info.partCount - 1 - partCount) throw new Error('Saved transcript parts are incomplete; Mongo content has been kept.');
                partCount++;
                yield* part.messages;
            }
        }
        const { files, messageCount } = await transcriptFiles(order, info, messages());
        if (partCount !== info.partCount || messageCount !== info.messageCount) throw new Error('Saved transcript parts are incomplete; Mongo content has been kept.');
        const transcript = await uploadTranscript(order, info, files, messageCount);
        order = await store.patch(order.orderId, { transcript, transcriptUpload: null });
        return clearTranscriptParts(order);
    }

    async function archiveJob(orderId, work) {
        if (archiveJobs.has(orderId)) {
            await archiveJobs.get(orderId);
            return archiveJob(orderId, work);
        }
        const job = Promise.resolve().then(async () => work(await store.get(orderId)));
        archiveJobs.set(orderId, job);
        try { return await job; } finally { archiveJobs.delete(orderId); }
    }

    async function migrateTranscript(order) {
        return archiveJob(order.orderId, migrateTranscriptUnlocked);
    }

    async function archiveAndDelete(order) {
        return archiveJob(order.orderId, archiveAndDeleteUnlocked);
    }

    async function archiveAndDeleteUnlocked(order) {
        const channel = await fetchChannel(order);
        if (order.active) {
            if (!order.closing) throw new OrderError('Closure has not been requested.');
            if (channel) {
                await channel.permissionOverwrites.edit(order.buyerId, { SendMessages: false });
                await retireStaffPanel(order);
            }
            const transcript = await saveTranscript(order, channel);
            order = await store.finalizeClose(order.orderId, transcript);
        }
        if (order.transcript?.storage !== 'discord') order = await migrateTranscriptUnlocked(order);
        if (!order.transcript?.messageIds?.length) throw new Error(`Refusing to delete ${order.orderId} without a Discord transcript.`);
        order = await clearTranscriptParts(order);
        if (channel) {
            try { await channel.delete(`Order ${order.orderId}: transcript saved`); }
            catch (error) { if (error.code !== 10003) throw error; }
        }
        order = await store.patch(order.orderId, { channelDeleted: true });
        await publishCompletedReceipt(order);
        return store.get(order.orderId);
    }

    async function liveDeliveriesChannel(order) {
        const channelId = process.env.LIVE_DELIVERIES_CHANNEL_ID || process.env.ORDER_LOG_CHANNEL_ID;
        if (channelId) {
            const channel = await botClient.channels.fetch(channelId);
            if (!channel?.isTextBased() || channel.guildId !== order.guildId) throw new Error('The live-deliveries channel must be a text channel in the order server.');
            await store.saveDeliveryChannelId(order.guildId, channel.id);
            return channel;
        }
        const savedId = await store.getDeliveryChannelId(order.guildId);
        if (savedId) {
            let savedChannel;
            try { savedChannel = await botClient.channels.fetch(savedId); }
            catch (error) { if (error.code !== 10003) throw error; }
            if (savedChannel?.isTextBased() && savedChannel.guildId === order.guildId) return savedChannel;
            await store.saveDeliveryChannelId(order.guildId, null);
        }
        const guild = await botClient.guilds.fetch(order.guildId);
        const channels = await guild.channels.fetch();
        const matches = [...channels.values()].filter(channel => channel?.name === 'live-deliveries' && channel.isTextBased());
        if (matches.length !== 1) throw new Error('Set LIVE_DELIVERIES_CHANNEL_ID to select the #live-deliveries channel.');
        await store.saveDeliveryChannelId(order.guildId, matches[0].id);
        return matches[0];
    }

    async function publishCompletedReceipt(order) {
        if (order.receiptNoticeSent) return;
        if (order.status !== 'closed' || order.paymentStatus !== 'paid' || order.fulfillmentStatus !== 'delivered') {
            await store.patch(order.orderId, { receiptNoticeSent: true, receiptSkipped: true });
            return;
        }
        const log = await liveDeliveriesChannel(order);
        const sent = await log.send({ embeds: [completedReceipt(order)], allowedMentions: { parse: [] },
            nonce: `${order.orderId}-receipt`, enforceNonce: true });
        await store.patch(order.orderId, { receiptNoticeSent: true, receiptMessageId: sent.id, receiptChannelId: log.id });
    }

    async function refreshRatingReceipt(order) {
        if (!order.receiptMessageId || !order.receiptChannelId) return;
        const channel = await botClient.channels.fetch(order.receiptChannelId);
        if (!channel || channel.guildId !== order.guildId) throw new Error('Saved receipt channel does not match this order server.');
        const message = await channel.messages.fetch(order.receiptMessageId);
        await message.edit({ embeds: [completedReceipt(order)], allowedMentions: { parse: [] } });
    }

    async function closeTicket(order, actorId, buyerCancel = false, reason = 'Closed by staff', expired = false) {
        requireOpen(order);
        if ((buyerCancel || expired) && order.paymentStatus === 'paid') throw new OrderError('This order is paid. Contact staff instead of cancelling it.');
        order = await reconcileCheckout(order, true);
        if ((buyerCancel || expired) && order.paymentStatus === 'paid') throw new OrderError('Payment was confirmed. Staff will handle this order.');
        const finalStatus = expired ? 'expired' : buyerCancel || order.paymentStatus !== 'paid' ? 'cancelled' : 'closed';
        order = await store.beginClose(order.orderId, actorId, reason, finalStatus);
        await archiveAndDelete(order);
    }

    async function history(interaction, page = 0) {
        const list = await store.listOrders(interaction.guildId, interaction.user.id, page);
        const shown = list.slice(0, 5);
        const embed = new EmbedBuilder().setTitle('Your Orders').setColor(0x5865F2)
            .setDescription(shown.length ? shown.map(order => `**${order.orderId}** • ${safeText(order.productName)}\n` +
                `${safeText(order.status.replace(/_/g, ' '))} • ${money(order.paidCents ?? order.totalCents)}` +
                (order.active && order.channelId ? ` • <#${order.channelId}>` : '') +
                (order.transcript ? '\nTranscript available through `/transcript`.' : '')).join('\n\n') : 'No saved orders yet.')
            .setFooter({ text: `Page ${page + 1}` });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`orders_page|${interaction.user.id}|${Math.max(0, page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`orders_page|${interaction.user.id}|${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(list.length <= 5)
        );
        await interaction.editReply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    }

    async function downloadTranscript(interaction, order) {
        if (!order.transcript) throw new OrderError('This order has not been archived yet. Its transcript is saved when staff closes it.');
        if (order.transcript.storage !== 'discord') order = await migrateTranscript(order);
        const destination = await transcriptChannel(order, order.transcript.channelId);
        const files = [];
        for (const messageId of order.transcript.messageIds) {
            // Fetch fresh messages so downloads use current Discord attachment URLs.
            const message = await destination.messages.fetch({ message: messageId, force: true });
            if (message.author?.id !== botClient.user.id) throw new OrderError('This archived transcript is unavailable. Contact staff.');
            for (const file of message.attachments.values()) {
                if (!file.name.startsWith(`${order.orderId}-transcript`) || !file.name.endsWith('.txt')) throw new OrderError('The archived transcript files do not match this order.');
                files.push(new AttachmentBuilder(file.url, { name: file.name }));
            }
        }
        if (files.length !== order.transcript.fileCount) throw new OrderError('Some archived transcript files are missing. Contact staff.');
        await interaction.editReply({ content: `Saved transcript for **${order.orderId}** (${order.transcript.messageCount} messages).`, files: files.slice(0, transcriptBatchSize) });
        for (let offset = transcriptBatchSize; offset < files.length; offset += transcriptBatchSize) {
            await interaction.followUp({ files: files.slice(offset, offset + transcriptBatchSize), flags: 64 });
        }
    }

    async function handleInteraction(interaction) {
        const cmd = interaction.isChatInputCommand() ? interaction.commandName : null;
        const id = interaction.customId || '';
        const supportedCommands = ['terms', 'my-orders', 'order', 'transcript', 'rate-order', 'confirm-payment', 'deliver', 'close'];
        const prefixes = ['purchase_action|', 'use_coupon_yes|', 'use_coupon_no|', 'open_tx_modal|',
            'account_pick|', 'select_stock_user|', 'apply_coupon|', 'payment_select|', 'submit_tx_form|', 'staff_order|', 'buyer_order|',
            'staff_pay|', 'order_issue|', 'orders_page|', 'expire_checkout|', 'select_boost_package|', 'select_deco_package|'];
        if (!supportedCommands.includes(cmd) && !prefixes.some(prefix => id.startsWith(prefix)) &&
            !['close_order', 'buy_boost_ticket', 'buy_deco_ticket', 'select_boost_package', 'select_deco_package'].includes(id)) return false;
        if (!interaction.inGuild()) throw new OrderError('Shop orders can only be used inside the server.');

        if (cmd) {
            await interaction.deferReply({ flags: 64 });
            if (cmd === 'terms') {
                if (!isStaff(interaction, adminRoleId)) throw new OrderError('Only shop staff can post the terms.');
                await interaction.channel.send({ embeds: [shopTerms()], allowedMentions: { parse: [] } });
                await interaction.editReply({ content: '✅ Shop terms posted. All products have a 7-day warranty except boosts.' });
            }
            else if (cmd === 'my-orders') await history(interaction);
            else if (cmd === 'rate-order') {
                const value = interaction.options.getString('order_id');
                const order = await orderFor(interaction, value?.toUpperCase(), { buyerOnly: true, anyChannel: Boolean(value) });
                const saved = await store.setRating(order.orderId, interaction.user.id, interaction.options.getInteger('stars'));
                await refreshRatingReceipt(saved);
                await interaction.editReply({ content: `⭐ Your **${saved.starRating}/5** rating for **${order.orderId}** was saved.` });
            }
            else if (cmd === 'transcript') {
                const order = await orderFor(interaction, interaction.options.getString('order_id').toUpperCase(), { anyChannel: true });
                await downloadTranscript(interaction, order);
            } else if (cmd === 'order') {
                const value = interaction.options.getString('order_id');
                const order = await orderFor(interaction, value?.toUpperCase(), { staffOnly: true, anyChannel: Boolean(value) });
                await retireStaffPanel(order);
                await interaction.editReply({ embeds: [orderSummary(order)], content: order.channelId ? `Ticket: <#${order.channelId}>` : 'Ticket is unavailable.' });
            } else if (cmd === 'confirm-payment') {
                const value = interaction.options.getString('order_id');
                let order = await orderFor(interaction, value?.toUpperCase(), { staffOnly: true, anyChannel: Boolean(value) });
                requireOpen(order);
                const price = interaction.options.getNumber('price');
                const amountCents = price == null ? order.totalCents : toCents(price);
                if (!amountCents) throw new OrderError('Provide the USD amount received using the price option.');
                const method = interaction.options.getString('method')?.trim().slice(0, 100);
                if (!method) throw new OrderError('Provide the payment method.');
                order = await reconcileCheckout(order, true);
                const result = await store.markPaid(order.orderId, { amountCents, method, actorId: interaction.user.id });
                await notifyPaid(result);
                await interaction.editReply({ content: result.newlyPaid ? '✅ Payment recorded and points awarded once.' : 'This order was already paid; no extra points were awarded.' });
            } else if (cmd === 'deliver') {
                let order = await orderFor(interaction, null, { staffOnly: true });
                if (interaction.options.getUser('buyer')?.id !== order.buyerId) throw new OrderError('The delivery buyer must match the saved order.');
                const itemId = interaction.options.getString('item_id');
                if (itemId !== order.productKey) throw new OrderError('The delivery item must match the saved order.');
                if (order.paymentStatus !== 'paid') {
                    const price = interaction.options.getNumber('price');
                    if (!price) throw new OrderError('Use /confirm-payment first, or provide the paid price.');
                    order = await reconcileCheckout(order, true);
                    const result = await store.markPaid(order.orderId, { amountCents: toCents(price), method: 'Manual', actorId: interaction.user.id });
                    await notifyPaid(result);
                }
                const delivery = await store.deliverStock(order.orderId, interaction.user.id, itemId, interaction.options.getString('specific_account'));
                const account = order.kind === 'account' ? parseAccountEntry(delivery.code) : null;
                const displayed = delivery.code.replace(/:.*$/, '');
                const details = account ? `<a:white_user:1554592911679553577> **Username:** \`@${account.username}\`\n` +
                    `<:price:1554267169800585227> **Price:** \`$${(account.priceCents / 100).toFixed(2)}\`\n\n` +
                    '<a:folder:1554593038003609620> Your login details are available privately with `/my-codes`.' :
                    `Code for **${safeText(itemId)}**:\n\`\`\`${displayed.replace(/`/g, '')}\`\`\``;
                await interaction.channel.send(publicMessage(`Hey <@${order.buyerId}>!\nOrder **${order.orderId}**\n\n${details}`,
                    { title: '📦 Order Delivery', color: 0x57F287, users: [order.buyerId] }));
                await retireStaffPanel(delivery.order);
                await interaction.editReply({ content: '✅ Delivery recorded. Points were awarded once at payment confirmation.' });
            } else if (cmd === 'close') {
                let order = await orderFor(interaction, null, { staffOnly: true });
                if (interaction.options.getString('status') === 'success') {
                    const buyer = interaction.options.getUser('buyer');
                    if (buyer && buyer.id !== order.buyerId) throw new OrderError('The buyer must match the saved order.');
                    if (order.paymentStatus !== 'paid') {
                        const price = interaction.options.getNumber('price');
                        if (!price) throw new OrderError('Confirm payment before closing a successful sale.');
                        order = await reconcileCheckout(order, true);
                        const result = await store.markPaid(order.orderId, { amountCents: toCents(price),
                            method: interaction.options.getString('method') || 'Manual', actorId: interaction.user.id });
                        order = result.order;
                        await notifyPaid(result);
                    }
                    if (order.fulfillmentStatus !== 'delivered') order = await store.delivered(order.orderId, interaction.user.id);
                }
                await interaction.editReply({ content: `Archiving **${order.orderId}** before closing the ticket…` });
                await closeTicket(order, interaction.user.id);
            }
            return true;
        }

        if (interaction.isButton() && ['buy_boost_ticket', 'buy_deco_ticket'].includes(id)) {
            await interaction.deferReply({ flags: 64 });
            const decoration = id === 'buy_deco_ticket';
            await createTicket(interaction, { kind: decoration ? 'decoration' : 'boost',
                productKey: decoration ? 'decoration_selection' : 'boost_selection',
                productName: decoration ? 'Discord Decoration' : 'Discord Boosts', baseCents: null });
            return true;
        }
        if (interaction.isButton() && id.startsWith('purchase_action|')) {
            await interaction.deferReply({ flags: 64 });
            const [, productKey, price] = id.split('|');
            if (!productKey || productKey.length > 80) throw new OrderError('Invalid listing. Ask staff to repost this product.');
            // This listing button is posted by the bot. Its price is copied once into
            // MongoDB; all subsequent checkout controls use the saved server quote.
            if (interaction.message.author?.id !== botClient.user.id) throw new OrderError('This listing was not posted by the shop bot.');
            await createTicket(interaction, { kind: 'item', productKey, productName: formatProductName(productKey), baseCents: toCents(price) });
            return true;
        }
        if (interaction.isStringSelectMenu() && (id.startsWith('account_pick|') || id.startsWith('select_stock_user|'))) {
            await interaction.deferReply({ flags: 64 });
            const current = id.startsWith('account_pick|');
            const segments = id.split('|');
            if (current && segments[1] !== interaction.user.id) throw new OrderError('Open your own account browser from the shop menu.');
            const category = normalizeAccountCategory(segments[current ? 2 : 1]);
            if (!category) throw new OrderError('Choose a valid account category.');
            const username = interaction.values[0];
            const item = await Inventory.findOne({ itemId: category });
            const entry = accountListings(item?.codes || []).find(account => account.username.toLowerCase() === username?.toLowerCase());
            if (!entry) throw new OrderError('That account is no longer in stock. Refresh the catalog.');
            await createTicket(interaction, { kind: 'account', productKey: category, selectedAccount: entry.username,
                productName: `${categoryNames[category] || category}: @${entry.username}`, baseCents: entry.priceCents });
            return true;
        }
        if (interaction.isButton() && id.startsWith('orders_page|')) {
            const [, buyer, value] = id.split('|');
            const page = Number(value);
            if (buyer !== interaction.user.id || !Number.isSafeInteger(page) || page < 0 || page > 10000) throw new OrderError('Invalid order history page.');
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            await history(interaction, page);
            return true;
        }

        if (interaction.isButton() && id.startsWith('staff_order|')) {
            await interaction.deferReply({ flags: 64 });
            const order = await orderFor(interaction, id.split('|')[2], { staffOnly: true });
            await retireStaffPanel(order);
            await interaction.editReply({ content: 'The staff panel has been removed. Use /confirm-payment, /deliver, or /close.' });
            return true;
        }
        if (interaction.isButton() && (id.startsWith('buyer_order|') || id === 'close_order')) {
            const [, action, orderId] = id.split('|');
            const order = await orderFor(interaction, orderId, { buyerOnly: true });
            requireOpen(order);
            if (action === 'issue') await issueModal(interaction, order);
            else {
                await interaction.deferReply({ flags: 64 });
                await interaction.editReply({ content: `Saving **${order.orderId}** before cancelling…` });
                await closeTicket(order, interaction.user.id, true, 'Cancelled by buyer');
            }
            return true;
        }
        if (interaction.isModalSubmit() && id.startsWith('staff_pay|')) {
            await interaction.deferReply({ flags: 64 });
            const order = await orderFor(interaction, id.split('|')[1], { staffOnly: true });
            await retireStaffPanel(order);
            await interaction.editReply({ content: 'The staff panel has been removed. Confirm manual payments with /confirm-payment.' });
            return true;
        }
        if (interaction.isModalSubmit() && id.startsWith('order_issue|')) {
            await interaction.deferReply({ flags: 64 });
            const order = await orderFor(interaction, id.split('|')[1]);
            const reason = interaction.fields.getTextInputValue('issue_reason').trim();
            if (!reason) throw new OrderError('Describe the issue first.');
            const saved = await store.reportIssue(order.orderId, interaction.user.id, reason);
            await retireStaffPanel(saved);
            await interaction.channel.send(publicMessage(`Order **${order.orderId}**\n\n${reason}`,
                { title: '⚠️ Order Issue Reported', color: 0xFEE75C, roles: [adminRoleId] }));
            await interaction.editReply({ content: 'Your issue was saved and staff notified.' });
            return true;
        }

        if (interaction.isStringSelectMenu() && (id.startsWith('select_boost_package') || id.startsWith('select_deco_package'))) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            const key = interaction.values[0].split('|')[0];
            let productName, baseCents;
            if (order.kind === 'boost') {
                const pkg = boostPackages.find(item => item[0] === key);
                if (!pkg) throw new OrderError('Invalid boost package.');
                [, productName, baseCents] = pkg;
            } else if (order.kind === 'decoration') {
                const pkg = decoPackages.find(item => `deco_${item.shopPrice}` === key);
                if (!pkg) throw new OrderError('Invalid decoration package.');
                productName = formatProductName(key); baseCents = toCents(pkg.price);
            } else throw new OrderError('This ticket does not accept package selection.');
            const saved = await store.setProduct(order.orderId, key, productName, baseCents);
            await renderCheckout(saved, interaction);
            await retireStaffPanel(saved);
            return true;
        }
        if (interaction.isButton() && id.startsWith('use_coupon_yes|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            requireOpen(order);
            const coupons = await store.couponsFor(order.buyerId, order.orderId);
            if (!coupons.length) throw new OrderError('No available coupons. A coupon may be reserved in another ticket.');
            const menu = new StringSelectMenuBuilder().setCustomId(`apply_coupon|${order.orderId}`).setPlaceholder('Choose a coupon...')
                .addOptions(coupons.slice(0, 25).map(pct => ({ label: `${pct}% Off Coupon`, value: String(pct), emoji: '<:coupon:1554581616112832513>' })));
            const back = new ButtonBuilder().setCustomId(`use_coupon_no|${order.orderId}`).setLabel('Continue Without Coupon').setStyle(ButtonStyle.Secondary);
            await interaction.editReply({ content: null, embeds: [new EmbedBuilder().setTitle('🎟️ Select Coupon').setDescription('Coupons are reserved until payment, cancellation, or expiry.').setColor(0xFFD700)],
                components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(back), buyerRow(order)] });
            return true;
        }
        if (interaction.isButton() && id.startsWith('use_coupon_no|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            const saved = await store.releaseCoupon(order.orderId);
            await renderCheckout(saved, interaction); await retireStaffPanel(saved);
            return true;
        }
        if (interaction.isStringSelectMenu() && id.startsWith('apply_coupon|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            const saved = await store.reserveCoupon(order.orderId, Number(interaction.values[0]));
            await renderCheckout(saved, interaction); await retireStaffPanel(saved);
            return true;
        }
        if (interaction.isButton() && id.startsWith('expire_checkout|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            let order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            order = await reconcileCheckout(order, true);
            if (order.paymentStatus === 'paid') throw new OrderError('Payment has already been confirmed.');
            await renderCheckout(order, interaction); await retireStaffPanel(order);
            return true;
        }
        if (interaction.isStringSelectMenu() && id.startsWith('payment_select|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            let order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            requireOpen(order);
            if (order.paymentStatus === 'paid') throw new OrderError('This order is already paid.');
            if (!order.totalCents) throw new OrderError('Select a priced package first.');
            const method = interaction.values[0];
            if (method === 'select_stripe') await stripeCheckout(order, interaction);
            else if (method === 'select_crypto' || method === 'select_other') {
                order = await reconcileCheckout(order, true);
                if (order.paymentStatus === 'paid') throw new OrderError('This order is already paid.');
                if (order.coupon?.expiresAt <= new Date()) order = await store.releaseCoupon(order.orderId);
                order = await store.patch(order.orderId, { paymentMethod: method === 'select_crypto' ? 'Crypto' : 'Other' });
                if (method === 'select_crypto') {
                    const amounts = await getCryptoAmounts(order.totalCents / 100);
                    const embed = new EmbedBuilder().setTitle('🪙 Crypto Payment Gateway').setColor(0xF7931A)
                        .setDescription(`Order **${order.orderId}** • **${money(order.totalCents)}**\nStaff verifies payments and delivers manually.\n` +
                            'Confirm the live amount and network with staff before sending. These amounts are a snapshot.');
                    const wallets = [['ETH', amounts.eth, '0x42d01fE1f89C6cDE28ef7a34Ef5A7B452eD6B271'], ['LTC', amounts.ltc, 'MWSeYJ3qgm3j5yYGGFimu5ebSzHA9oUvBy'],
                        ['BTC', amounts.btc, '34hRphphvMtvqiWPawAESR1bxkfvUoFNhh'], ['SOL', amounts.sol, '222P8wKAC2s2UcfNyANYre8yVKjU1c3C3MA7mYqK92ZB']];
                    embed.addFields(wallets.map(([name, amount, wallet]) => ({ name, value: `\`\`\`${amount} ${name}\`\`\`\n\`\`\`${wallet}\`\`\`` })));
                    const tx = new ButtonBuilder().setCustomId(`open_tx_modal|${order.orderId}`).setLabel('Submit Transaction Hash').setStyle(ButtonStyle.Success);
                    await interaction.editReply({ content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(tx), buyerRow(order)] });
                } else {
                    await interaction.editReply({ content: null, embeds: [new EmbedBuilder().setTitle('💳 Other Payment Methods').setColor(0x5865F2)
                        .setDescription(`Order **${order.orderId}** • **${money(order.totalCents)}**\nTell staff what you would like to pay with (PayPal, Limiteds, or another method).\nStaff confirms payment before delivery.`)],
                        components: [buyerRow(order)] });
                }
                await retireStaffPanel(order);
            } else throw new OrderError('Invalid payment method.');
            return true;
        }
        if (interaction.isButton() && id.startsWith('open_tx_modal|')) {
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            requireOpen(order);
            const modal = new ModalBuilder().setCustomId(`submit_tx_form|${order.orderId}`).setTitle('Transaction Proof');
            modal.addComponents(input('tx_hash_input', 'Transaction hash'));
            await interaction.showModal(modal); return true;
        }
        if (interaction.isModalSubmit() && id.startsWith('submit_tx_form|')) {
            await interaction.deferReply({ flags: 64 });
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            requireOpen(order);
            const hash = interaction.fields.getTextInputValue('tx_hash_input').trim();
            await store.patch(order.orderId, { transactionHash: hash });
            await interaction.channel.send(publicMessage(`<@${order.buyerId}> submitted payment proof for **${order.orderId}**.\n` +
                `\`\`\`${hash.replace(/`/g, '')}\`\`\`\nStaff will verify the transaction.`,
                { title: '🧾 Payment Proof Submitted', color: 0xF7931A, users: [order.buyerId], roles: [adminRoleId] }));
            await interaction.editReply({ content: 'Transaction hash saved. Staff will verify it; submission does not confirm payment.' });
            return true;
        }
        throw new OrderError('Unknown order control.');
    }

    async function issueModal(interaction, order) {
        const modal = new ModalBuilder().setCustomId(`order_issue|${order.orderId}`).setTitle('Report Order Issue');
        modal.addComponents(input('issue_reason', 'Describe the issue', '', TextInputStyle.Paragraph));
        await interaction.showModal(modal);
    }

    async function handleStripeEvent(event) {
        if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) return;
        const checkout = event.data.object;
        // Sessions created before this update use the compatibility handler in index.js.
        if (!checkout.metadata?.order_id) return false;
        const order = await store.get(checkout.metadata.order_id);
        if (!order || order.buyerId !== checkout.metadata.discord_user_id || order.channelId !== checkout.metadata.channel_id || checkout.currency !== 'usd') {
            throw new Error('Stripe metadata or currency does not match a saved order.');
        }
        if (checkout.payment_status === 'paid') {
            const result = await store.markPaid(order.orderId, { amountCents: checkout.amount_total, method: 'Stripe', actorId: 'stripe', stripeSessionId: checkout.id, eventId: event.id });
            await notifyPaid(result);
        } else if (event.type === 'checkout.session.expired' && order.stripeSessionId === checkout.id && order.paymentStatus !== 'paid' && order.active && !order.closing) {
            const saved = await reconcileCheckout(order);
            if (!saved.stripeSessionId) { await renderCheckout(saved); await retireStaffPanel(saved); }
        }
        return true;
    }

    async function recover() {
        if (recoveryRunning || mongoose.connection.readyState !== 1 || !botClient.isReady()) return;
        recoveryRunning = true;
        try {
            for (let order of await store.recoveryOrders()) {
                try {
                    if (order.panelMessageId) {
                        await retireStaffPanel(order);
                        order = await store.get(order.orderId);
                    }
                    if (!order.active && order.transcript &&
                        (order.transcript.storage !== 'discord' || order.transcript.cleanupPending)) order = await migrateTranscript(order);
                    if (!order.channelId && order.createdAt < new Date(Date.now() - 600000)) { await store.abandonCreation(order.orderId); continue; }
                    if (order.closing || !order.active && (!order.channelDeleted || order.transcript && !order.receiptNoticeSent)) { await archiveAndDelete(order); continue; }
                    const oldSessionId = order.stripeSessionId;
                    if (order.stripeSessionId) order = await reconcileCheckout(order);
                    if (oldSessionId && !order.stripeSessionId && order.paymentStatus !== 'paid') {
                        await renderCheckout(order); await retireStaffPanel(order);
                    }
                    if (order.paymentStatus === 'paid') { if (!order.paymentNoticeSent) await notifyPaid({ order }); continue; }
                    if (!order.active) continue;
                    if (order.expiresAt <= new Date()) {
                        await closeTicket(order, 'system', false, 'Unpaid ticket expired', true);
                    } else if (order.coupon?.expiresAt <= new Date()) {
                        order = await reconcileCheckout(order, true);
                        if (order.paymentStatus !== 'paid') {
                            if (order.coupon) order = await store.releaseCoupon(order.orderId);
                            await renderCheckout(order); await retireStaffPanel(order);
                        }
                    }
                } catch (error) { console.error(`Order recovery failed (${order.orderId}):`, error); }
            }
        } finally { recoveryRunning = false; }
    }

    async function handleReaction(reaction, user) {
        if (user.bot || !['1554592986334105620', '1554592934828179476'].includes(reaction.emoji.id)) return false;
        const order = await store.byChannel(reaction.message.channelId);
        if (!order) return false;
        if (user.id !== order.buyerId || !order.active || order.closing) return true;
        // Buyer reactions are feedback; only staff can change delivery/payment status.
        const content = reaction.emoji.id === '1554592986334105620' ? `✅ <@${user.id}> confirmed receipt for **${order.orderId}**.` :
            `⚠️ <@&${adminRoleId}> <@${user.id}> reported a delivery issue for **${order.orderId}**. Send a message in this ticket so staff can assist.`;
        const issue = reaction.emoji.id === '1554592934828179476';
        await reaction.message.channel.send(publicMessage(content,
            { title: issue ? '⚠️ Delivery Issue' : '✅ Delivery Received', color: issue ? 0xFEE75C : 0x57F287,
                users: [user.id], roles: issue ? [adminRoleId] : [] }));
        return true;
    }

    function startRecovery() {
        if (recoveryTimer) return;
        (async () => {
            // Pin receipt destinations on startup so later channel renames work,
            // including before the first completed sale and across restarts.
            for (const guild of botClient.guilds.cache?.values() || []) {
                try { await liveDeliveriesChannel({ guildId: guild.id }); }
                catch (error) { console.error(`Receipt channel setup failed (${guild.id}):`, error.message); }
            }
            await recover();
        })().catch(error => console.error('Initial order recovery failed:', error));
        recoveryTimer = setInterval(() => recover().catch(error => console.error('Order recovery failed:', error)), 60000);
        recoveryTimer.unref?.();
    }

    return { initialize: store.initialize, commandDefinitions, handleInteraction, handleStripeEvent, handleReaction, startRecovery,
        store, saveTranscript, archiveAndDelete, migrateTranscript, recover, reconcileCheckout, closeTicket };
}

module.exports = { createOrderRuntime, isStaff, assertAuthorized, money, completedReceipt, COMMANDS };

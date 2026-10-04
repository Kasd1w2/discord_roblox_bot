const { randomBytes } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { createOrderStore, OrderError, toCents, requireOpen } = require('./orderStore');

const money = cents => cents == null ? 'Awaiting quote' : `$${(cents / 100).toFixed(2)} USD`;
const safeText = value => String(value ?? '').replace(/[`*_~|<>]/g, '').slice(0, 180);
const COMMANDS = [
    { name: 'my-orders', description: 'View your saved orders and their progress', type: 1 },
    { name: 'order', description: 'Staff: view or recover an order panel', type: 1,
        options: [{ name: 'order_id', description: 'Order ID (defaults to the current ticket)', type: 3, required: false }] },
    { name: 'transcript', description: 'Download a saved order transcript', type: 1,
        options: [{ name: 'order_id', description: 'The order ID shown in /my-orders', type: 3, required: true }] }
];

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
    decoPackages, formatProductName, getCryptoAmounts, categoryNames, parseAccountEntry }) {
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

    function panelEmbed(order) {
        return new EmbedBuilder().setTitle(`Order ${order.orderId}`).setColor(order.paymentStatus === 'paid' ? 0x57F287 : 0x5865F2)
            .setDescription(`**${safeText(order.productName || formatProductName(order.productKey))}**` +
                (order.selectedAccount ? `\nRequested account: @${safeText(order.selectedAccount)}` : ''))
            .addFields(
                { name: 'Buyer', value: `<@${order.buyerId}>`, inline: true },
                { name: 'Status', value: order.closing ? 'Archiving transcript' : safeText(order.status.replace(/_/g, ' ')), inline: true },
                { name: 'Total', value: money(order.paidCents ?? order.totalCents), inline: true },
                { name: 'Payment', value: order.paymentStatus === 'paid' ? `Confirmed • ${safeText(order.paymentMethod)}` : 'Awaiting payment', inline: true },
                { name: 'Staff', value: order.claimedBy ? `<@${order.claimedBy}>` : 'Unclaimed', inline: true },
                { name: 'Coupon', value: order.coupon ? `${order.coupon.discountPct}% reserved until <t:${Math.floor(order.coupon.expiresAt / 1000)}:t>` : order.couponConsumed ? 'Applied to payment' : 'None', inline: true }
            ).setFooter({ text: 'Staff controls • Your order remains saved after this ticket closes.' }).setTimestamp(order.createdAt);
    }

    function panelRows(order) {
        const disabled = !order.active || order.closing;
        const make = (action, label, style, off = false) => new ButtonBuilder().setCustomId(`staff_order|${action}|${order.orderId}`)
            .setLabel(label).setStyle(style).setDisabled(disabled || off);
        return [new ActionRowBuilder().addComponents(
            make('claim', order.claimedBy ? 'Claimed' : 'Claim Order', ButtonStyle.Secondary, Boolean(order.claimedBy)),
            make('paid', 'Confirm Payment', ButtonStyle.Success, order.paymentStatus === 'paid'),
            make('delivered', 'Mark Delivered', ButtonStyle.Primary, order.paymentStatus !== 'paid' || order.fulfillmentStatus === 'delivered'),
            make('issue', 'Report Issue', ButtonStyle.Secondary), make('close', 'Close Ticket', ButtonStyle.Danger)
        )];
    }

    function buyerRow(order) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`buyer_order|issue|${order.orderId}`).setLabel('Report Issue').setStyle(ButtonStyle.Secondary)
                .setDisabled(!order.active || order.closing),
            new ButtonBuilder().setCustomId(`buyer_order|cancel|${order.orderId}`).setLabel('Cancel Order').setStyle(ButtonStyle.Danger)
                .setEmoji('<:trashcan:1554593006596657262>').setDisabled(!order.active || order.closing || order.paymentStatus === 'paid')
        );
    }

    async function fetchChannel(order) {
        if (!order.channelId) return null;
        try { return await botClient.channels.fetch(order.channelId); }
        catch (error) { if (error.code === 10003) return null; throw error; }
    }

    async function refreshPanel(order) {
        const channel = await fetchChannel(order);
        if (!channel) return;
        let panel;
        if (order.panelMessageId) {
            try { panel = await channel.messages.fetch(order.panelMessageId); }
            catch (error) { if (error.code !== 10008) throw error; }
        }
        const payload = { embeds: [panelEmbed(order)], components: [...panelRows(order), buyerRow(order)], allowedMentions: { parse: [] } };
        if (panel) await panel.edit(payload);
        else {
            panel = await channel.send(payload);
            await store.patch(order.orderId, { panelMessageId: panel.id });
        }
    }

    function checkoutPayload(order, coupons = []) {
        const name = safeText(order.productName || formatProductName(order.productKey));
        const details = order.kind === 'decoration' ? '\n\nSend the exact decoration name or shop link in this ticket. Staff delivers your gift link after payment confirmation.' : '';
        const embed = new EmbedBuilder().setTitle('<a:folder:1554593038003609620> Secure Checkout Portal')
            .setDescription(`Order **${order.orderId}**\n**${name}**\nTotal: **${money(order.totalCents)}**${details}` +
                (order.coupon ? `\n\n${order.coupon.discountPct}% coupon reserved. It is consumed only after payment.` : ''))
            .setColor(order.coupon ? 0x57F287 : 0x5865F2);
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
        return { embeds: [embed], components, allowedMentions: { parse: [] } };
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
            await channel.send({ content: `<@${order.buyerId}> | <@&${adminRoleId}>\nYour order ID is **${order.orderId}**.`,
                allowedMentions: { users: [order.buyerId], roles: [adminRoleId] } });
            await refreshPanel(saved);
            if (input.kind === 'boost' || input.kind === 'decoration') {
                const choices = input.kind === 'boost' ? boostPackages.map(([key, label]) => ({ label, value: key, emoji: '<a:boostlogo:1554263092244906005>' })) :
                    decoPackages.map(pkg => ({ label: `$${pkg.shopPrice} Shop Tier → $${pkg.price}`, value: `deco_${pkg.shopPrice}`, emoji: '<:price:1554267169800585227>' }));
                const menu = new StringSelectMenuBuilder().setCustomId(`${input.kind === 'boost' ? 'select_boost_package' : 'select_deco_package'}|${order.orderId}`)
                    .setPlaceholder('Select your package...').addOptions(choices);
                const message = await channel.send({ content: 'Select the package you want below.',
                    components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } });
                await store.patch(order.orderId, { checkoutMessageId: message.id });
            } else if (input.baseCents) await renderCheckout(saved);
            else await channel.send('Staff will confirm your item and quote a price before payment.');
            await interaction.editReply({ content: `✅ Order **${order.orderId}** created: <#${channel.id}>` });
        } catch (error) {
            // Preserve a partly created ticket so staff can recover it with /order.
            if (!channel) await store.abandonCreation(order.orderId);
            else console.error(`Order ${order.orderId} needs panel recovery in channel ${channel.id}:`, error);
            throw error;
        }
    }

    async function notifyPaid(result) {
        const order = result.order;
        if (order.paymentNoticeSent) { await refreshPanel(order); return; }
        const text = `<a:confirm:1554592986334105620> **Payment confirmed — ${order.orderId}**\n` +
            `<@${order.buyerId}> paid **${money(order.paidCents)}** using **${safeText(order.paymentMethod)}**.\n` +
            `<a:MTF_Credits:1554593086544412803> Earned **${order.pointsEarned} points**.\n` +
            `<@&${adminRoleId}> Manual delivery is required${order.kind === 'decoration' ? ' via gift link' : ''}.`;
        const channel = await fetchChannel(order);
        if (channel) {
            // A stable Discord nonce also reduces duplicate notices when the process
            // restarts after Discord accepted the message but before MongoDB saved it.
            await channel.send({ content: text, allowedMentions: { users: [order.buyerId], roles: [adminRoleId] },
                nonce: order.orderId.replace('ORD-', ''), enforceNonce: true });
            await refreshPanel(order);
            if (order.checkoutMessageId) {
                try { await (await channel.messages.fetch(order.checkoutMessageId)).edit({ components: [], content: 'Payment confirmed. Staff will deliver your order.' }); }
                catch (error) { if (error.code !== 10008) throw error; }
            }
        } else {
            const logId = process.env.ORDER_LOG_CHANNEL_ID || '1542337221791711324';
            const log = await botClient.channels.fetch(logId);
            if (!log?.isTextBased()) throw new Error(`Payment for ${order.orderId} is saved, but no notification channel is available.`);
            await log.send({ content: text + '\n⚠️ The ticket is unavailable. Staff must arrange delivery.', allowedMentions: { roles: [adminRoleId], users: [] } });
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
        if (order.paymentStatus === 'paid') { await interaction.editReply({ content: 'This order is already paid.', embeds: [], components: [] }); return; }
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
        const embed = new EmbedBuilder().setTitle('<:stripe:1554263177829687398> Stripe Card Checkout').setColor(0x635BFF)
            .setDescription(`Order **${order.orderId}**\nTotal: **${money(checkout.amount_total)}**, including the 5% processing fee.\n` +
                'Staff will deliver manually after payment confirmation.\nCheckout expires in about 30 minutes; an unused coupon is released on expiry.');
        const pay = new ButtonBuilder().setLabel(`Pay ${money(checkout.amount_total)}`).setURL(checkout.url).setStyle(ButtonStyle.Link);
        const expire = new ButtonBuilder().setCustomId(`expire_checkout|${order.orderId}`).setLabel('Change Payment Method').setStyle(ButtonStyle.Secondary);
        await interaction.editReply({ content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(pay, expire), buyerRow(order)] });
        await refreshPanel(order);
    }

    function input(id, label, value = '', style = TextInputStyle.Short) {
        const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 100);
        if (value) field.setValue(value);
        return new ActionRowBuilder().addComponents(field);
    }

    async function saveTranscript(order, channel) {
        const snapshotId = randomBytes(10).toString('hex');
        let before, part = 0, messageCount = 0;
        try {
            if (channel) {
                while (true) {
                    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                    if (!page.size) break;
                    const sorted = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
                    const messages = sorted.map(message => ({ id: message.id, createdAt: message.createdAt,
                        authorId: message.author?.id, author: message.author?.tag || message.author?.username || 'Unknown',
                        content: message.content, embeds: message.embeds.map(embed => embed.toJSON()),
                        attachments: [...message.attachments.values()].map(file => ({ name: file.name, url: file.url, size: file.size })),
                        reference: message.reference?.messageId || null }));
                    await store.parts().insertOne({ orderId: order.orderId, snapshotId, part: part++, messages });
                    messageCount += messages.length;
                    before = sorted[0].id;
                    if (page.size < 100) break;
                }
            }
            return { snapshotId, savedAt: new Date(), messageCount, partCount: part,
                channelMissing: !channel, receipt: { orderId: order.orderId, product: order.productName, buyerId: order.buyerId,
                    paidCents: order.paidCents || 0, paymentMethod: order.paymentMethod || 'Unpaid', points: order.pointsEarned || 0,
                    claimedBy: order.claimedBy, status: order.closeFinalStatus, reason: order.closeReason } };
        } catch (error) {
            await store.parts().deleteMany({ orderId: order.orderId, snapshotId });
            throw error;
        }
    }

    async function archiveAndDelete(order) {
        const channel = await fetchChannel(order);
        if (order.active) {
            if (!order.closing) throw new OrderError('Closure has not been requested.');
            if (channel) {
                await channel.permissionOverwrites.edit(order.buyerId, { SendMessages: false });
                await refreshPanel(order);
            }
            const transcript = await saveTranscript(order, channel);
            order = await store.finalizeClose(order.orderId, transcript);
        }
        if (!order.transcript) throw new Error(`Refusing to delete ${order.orderId} without a saved transcript.`);
        if (channel) {
            try { await channel.delete(`Order ${order.orderId}: transcript saved`); }
            catch (error) { if (error.code !== 10003) throw error; }
        }
        order = await store.patch(order.orderId, { channelDeleted: true });
        if (!order.receiptNoticeSent) {
            const logId = process.env.ORDER_LOG_CHANNEL_ID || '1542337221791711324';
            const log = await botClient.channels.fetch(logId).catch(() => null);
            if (log?.isTextBased()) {
                await log.send({ embeds: [new EmbedBuilder().setTitle(`Order archived • ${order.orderId}`).setColor(0x5865F2)
                    .setDescription(`Product: **${safeText(order.productName)}**\nStatus: **${order.status}**\nPayment: **${money(order.paidCents || 0)}**\n` +
                        `Method: **${safeText(order.paymentMethod || 'Unpaid')}**\nTranscript: **${order.transcript.messageCount} messages**\n` +
                        'Buyer and staff can retrieve the transcript with `/transcript`.')], allowedMentions: { parse: [] } });
                await store.patch(order.orderId, { receiptNoticeSent: true });
            }
        }
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
        const receipt = order.transcript.receipt;
        let text = `ORDER TRANSCRIPT\nOrder: ${order.orderId}\nProduct: ${order.productName}\nBuyer: ${order.buyerId}\n` +
            `Payment: ${money(receipt.paidCents)} (${receipt.paymentMethod})\nPoints: ${receipt.points}\nStatus: ${receipt.status}\n` +
            `Reason: ${receipt.reason}\nSaved: ${order.transcript.savedAt.toISOString()}\n` +
            (order.transcript.channelMissing ? 'Note: the channel was already unavailable when archival ran.\n' : '') + '\n';
        const buffers = [];
        for await (const part of store.parts().find({ orderId: order.orderId, snapshotId: order.transcript.snapshotId }).sort({ part: -1 })) {
            for (const message of part.messages) {
                const line = `[${new Date(message.createdAt).toISOString()}] ${message.author} (${message.authorId})\n${message.content || ''}\n` +
                    (message.reference ? `Reply to: ${message.reference}\n` : '') +
                    message.embeds.map(embed => `Embed: ${JSON.stringify(embed)}\n`).join('') +
                    message.attachments.map(file => `Attachment: ${file.name} (${file.size} bytes) ${file.url}\n`).join('') + '\n';
                if (Buffer.byteLength(text + line) > 6000000) { buffers.push(Buffer.from(text)); text = ''; }
                text += line;
            }
        }
        buffers.push(Buffer.from(text));
        const files = buffers.map((buffer, index) => new AttachmentBuilder(buffer, {
            name: `${order.orderId}-transcript${buffers.length > 1 ? `-${index + 1}` : ''}.txt`
        }));
        await interaction.editReply({ content: `Saved transcript for **${order.orderId}** (${order.transcript.messageCount} messages).`, files: files.slice(0, 10) });
        for (let offset = 10; offset < files.length; offset += 10) await interaction.followUp({ files: files.slice(offset, offset + 10), flags: 64 });
    }

    async function handleInteraction(interaction) {
        const cmd = interaction.isChatInputCommand() ? interaction.commandName : null;
        const id = interaction.customId || '';
        const supportedCommands = ['my-orders', 'order', 'transcript', 'deliver', 'close'];
        const prefixes = ['purchase_action|', 'use_coupon_yes|', 'use_coupon_no|', 'open_tx_modal|', 'create_user_ticket|',
            'select_stock_user|', 'apply_coupon|', 'payment_select|', 'submit_tx_form|', 'staff_order|', 'buyer_order|',
            'staff_pay|', 'order_issue|', 'orders_page|', 'expire_checkout|', 'select_boost_package|', 'select_deco_package|'];
        if (!supportedCommands.includes(cmd) && !prefixes.some(prefix => id.startsWith(prefix)) &&
            !['close_order', 'buy_boost_ticket', 'buy_deco_ticket', 'select_boost_package', 'select_deco_package'].includes(id)) return false;
        if (!interaction.inGuild()) throw new OrderError('Shop orders can only be used inside the server.');

        if (cmd) {
            await interaction.deferReply({ flags: 64 });
            if (cmd === 'my-orders') await history(interaction);
            else if (cmd === 'transcript') {
                const order = await orderFor(interaction, interaction.options.getString('order_id').toUpperCase(), { anyChannel: true });
                await downloadTranscript(interaction, order);
            } else if (cmd === 'order') {
                const value = interaction.options.getString('order_id');
                const order = await orderFor(interaction, value?.toUpperCase(), { staffOnly: true, anyChannel: Boolean(value) });
                await refreshPanel(order);
                await interaction.editReply({ embeds: [panelEmbed(order)], content: order.channelId ? `Ticket: <#${order.channelId}>` : 'Ticket is unavailable.' });
            } else if (cmd === 'deliver') {
                let order = await orderFor(interaction, null, { staffOnly: true });
                if (interaction.options.getUser('buyer')?.id !== order.buyerId) throw new OrderError('The delivery buyer must match the saved order.');
                const itemId = interaction.options.getString('item_id');
                if (itemId !== order.productKey) throw new OrderError('The delivery item must match the saved order.');
                if (order.paymentStatus !== 'paid') {
                    const price = interaction.options.getNumber('price');
                    if (!price) throw new OrderError('Confirm payment with the staff panel first, or provide the paid price.');
                    order = await reconcileCheckout(order, true);
                    const result = await store.markPaid(order.orderId, { amountCents: toCents(price), method: 'Manual', actorId: interaction.user.id });
                    await notifyPaid(result);
                }
                const delivery = await store.deliverStock(order.orderId, interaction.user.id, itemId, interaction.options.getString('specific_account'));
                // Keep the existing channel delivery format. The complete original
                // entry remains available privately through /my-codes.
                const displayed = delivery.code.replace(/:.*$/, '');
                await interaction.channel.send({ content: `Hey <@${order.buyerId}>! Delivery for **${order.orderId}**:`,
                    embeds: [new EmbedBuilder().setTitle('<a:Delivery:1554592662013739109> Order Delivery')
                        .setDescription(`Code for **${safeText(itemId)}**:\n\`\`\`${displayed.replace(/`/g, '')}\`\`\``).setColor(0x57F287)],
                    allowedMentions: { users: [order.buyerId], roles: [] } });
                await refreshPanel(delivery.order);
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
        if (interaction.isStringSelectMenu() && id.startsWith('select_stock_user|')) {
            await interaction.deferReply({ flags: 64 });
            const category = id.split('|')[1];
            const username = interaction.values[0];
            const item = await Inventory.findOne({ itemId: category });
            const entry = item?.codes.find(code => parseAccountEntry(code).username === username);
            if (!entry) throw new OrderError('That account is no longer in stock. Refresh the catalog.');
            const displayedPrice = parseAccountEntry(entry).displayLabel.match(/\$([0-9]+(?:\.[0-9]{1,2})?)$/);
            await createTicket(interaction, { kind: 'account', productKey: category, selectedAccount: username,
                productName: `${categoryNames[category] || category}: @${username}`, baseCents: displayedPrice ? toCents(displayedPrice[1]) : null });
            return true;
        }
        if (interaction.isButton() && id.startsWith('create_user_ticket|')) {
            await interaction.deferReply({ flags: 64 });
            const category = id.split('|')[1];
            await createTicket(interaction, { kind: 'account', productKey: category, productName: categoryNames[category] || category, baseCents: null });
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
            const [, action, orderId] = id.split('|');
            const order = await orderFor(interaction, orderId, { staffOnly: true });
            requireOpen(order);
            if (action === 'paid') {
                if (order.paymentStatus === 'paid') throw new OrderError('This order is already paid.');
                const modal = new ModalBuilder().setCustomId(`staff_pay|${orderId}`).setTitle('Confirm Payment');
                modal.addComponents(input('paid_amount', 'Amount received (USD)', order.totalCents ? (order.totalCents / 100).toFixed(2) : ''),
                    input('paid_method', 'Payment method', order.paymentMethod || 'Other'));
                await interaction.showModal(modal);
            } else if (action === 'issue') await issueModal(interaction, order);
            else {
                await interaction.deferReply({ flags: 64 });
                if (action === 'claim') {
                    const saved = await store.claim(orderId, interaction.user.id);
                    await refreshPanel(saved);
                    await interaction.editReply({ content: `✅ You claimed **${orderId}**.` });
                } else if (action === 'delivered') {
                    const saved = await store.delivered(orderId, interaction.user.id);
                    await refreshPanel(saved);
                    await interaction.channel.send({ content: `✅ **${orderId}** marked delivered by <@${interaction.user.id}>.`, allowedMentions: { parse: [] } });
                    await interaction.editReply({ content: 'Delivery recorded.' });
                } else if (action === 'close') {
                    if (order.paymentStatus === 'paid' && order.fulfillmentStatus !== 'delivered') throw new OrderError('Mark this paid order delivered before closing it.');
                    await interaction.editReply({ content: `Saving the transcript for **${orderId}**, then closing…` });
                    await closeTicket(order, interaction.user.id);
                } else throw new OrderError('Unknown staff control.');
            }
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
            let order = await orderFor(interaction, id.split('|')[1], { staffOnly: true });
            requireOpen(order);
            order = await reconcileCheckout(order, true);
            const result = await store.markPaid(order.orderId, { amountCents: toCents(interaction.fields.getTextInputValue('paid_amount')),
                method: interaction.fields.getTextInputValue('paid_method').trim().slice(0, 100), actorId: interaction.user.id });
            await notifyPaid(result);
            await interaction.editReply({ content: result.newlyPaid ? '✅ Payment recorded and points awarded once.' : 'This order was already paid; no extra points were awarded.' });
            return true;
        }
        if (interaction.isModalSubmit() && id.startsWith('order_issue|')) {
            await interaction.deferReply({ flags: 64 });
            const order = await orderFor(interaction, id.split('|')[1]);
            const reason = interaction.fields.getTextInputValue('issue_reason').trim();
            if (!reason) throw new OrderError('Describe the issue first.');
            const saved = await store.reportIssue(order.orderId, interaction.user.id, reason);
            await refreshPanel(saved);
            await interaction.channel.send({ content: `⚠️ **Issue reported — ${order.orderId}**\n<@&${adminRoleId}>\n${reason}`,
                allowedMentions: { roles: [adminRoleId], users: [] } });
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
            await refreshPanel(saved);
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
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Select Coupon').setDescription('Coupons are reserved until payment, cancellation, or expiry.').setColor(0xFFD700)],
                components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(back), buyerRow(order)] });
            return true;
        }
        if (interaction.isButton() && id.startsWith('use_coupon_no|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            const saved = await store.releaseCoupon(order.orderId);
            await renderCheckout(saved, interaction); await refreshPanel(saved);
            return true;
        }
        if (interaction.isStringSelectMenu() && id.startsWith('apply_coupon|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            const order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            const saved = await store.reserveCoupon(order.orderId, Number(interaction.values[0]));
            await renderCheckout(saved, interaction); await refreshPanel(saved);
            return true;
        }
        if (interaction.isButton() && id.startsWith('expire_checkout|')) {
            interaction._shopUpdate = true;
            await interaction.deferUpdate();
            let order = await orderFor(interaction, id.split('|')[1], { buyerOnly: true });
            order = await reconcileCheckout(order, true);
            if (order.paymentStatus === 'paid') throw new OrderError('Payment has already been confirmed.');
            await renderCheckout(order, interaction); await refreshPanel(order);
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
                    const embed = new EmbedBuilder().setTitle('<:crypto:1554263320997920799> Crypto Payment Gateway').setColor(0xF7931A)
                        .setDescription(`Order **${order.orderId}** • **${money(order.totalCents)}**\nStaff verifies payments and delivers manually.\n` +
                            'Confirm the live amount and network with staff before sending. These amounts are a snapshot.');
                    const wallets = [['ETH', amounts.eth, '0x42d01fE1f89C6cDE28ef7a34Ef5A7B452eD6B271'], ['LTC', amounts.ltc, 'MWSeYJ3qgm3j5yYGGFimu5ebSzHA9oUvBy'],
                        ['BTC', amounts.btc, '34hRphphvMtvqiWPawAESR1bxkfvUoFNhh'], ['SOL', amounts.sol, '222P8wKAC2s2UcfNyANYre8yVKjU1c3C3MA7mYqK92ZB']];
                    embed.addFields(wallets.map(([name, amount, wallet]) => ({ name, value: `\`\`\`${amount} ${name}\`\`\`\n\`\`\`${wallet}\`\`\`` })));
                    const tx = new ButtonBuilder().setCustomId(`open_tx_modal|${order.orderId}`).setLabel('Submit Transaction Hash').setStyle(ButtonStyle.Success);
                    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(tx), buyerRow(order)] });
                } else {
                    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Other Payment Methods').setColor(0x5865F2)
                        .setDescription(`Order **${order.orderId}** • **${money(order.totalCents)}**\nTell staff what you would like to pay with (PayPal, Limiteds, or another method).\nStaff confirms payment before delivery.`)],
                        components: [buyerRow(order)] });
                }
                await refreshPanel(order);
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
            await interaction.channel.send({ content: `<@&${adminRoleId}> <@${order.buyerId}> submitted payment proof for **${order.orderId}**.\n\`\`\`${hash.replace(/`/g, '')}\`\`\``,
                allowedMentions: { roles: [adminRoleId], users: [order.buyerId] } });
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
            if (!saved.stripeSessionId) { await renderCheckout(saved); await refreshPanel(saved); }
        }
        return true;
    }

    async function recover() {
        if (recoveryRunning || mongoose.connection.readyState !== 1 || !botClient.isReady()) return;
        recoveryRunning = true;
        try {
            for (let order of await store.recoveryOrders()) {
                try {
                    if (!order.channelId && order.createdAt < new Date(Date.now() - 600000)) { await store.abandonCreation(order.orderId); continue; }
                    if (order.closing || !order.active && (!order.channelDeleted || order.transcript && !order.receiptNoticeSent)) { await archiveAndDelete(order); continue; }
                    const oldSessionId = order.stripeSessionId;
                    if (order.stripeSessionId) order = await reconcileCheckout(order);
                    if (oldSessionId && !order.stripeSessionId && order.paymentStatus !== 'paid') {
                        await renderCheckout(order); await refreshPanel(order);
                    }
                    if (order.paymentStatus === 'paid') { if (!order.paymentNoticeSent) await notifyPaid({ order }); continue; }
                    if (order.expiresAt <= new Date()) {
                        await closeTicket(order, 'system', false, 'Unpaid ticket expired', true);
                    } else if (order.coupon?.expiresAt <= new Date()) {
                        order = await reconcileCheckout(order, true);
                        if (order.paymentStatus !== 'paid') {
                            if (order.coupon) order = await store.releaseCoupon(order.orderId);
                            await renderCheckout(order); await refreshPanel(order);
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
            `⚠️ <@&${adminRoleId}> <@${user.id}> reported a delivery issue for **${order.orderId}**. Use Report Issue to save details.`;
        await reaction.message.channel.send({ content, allowedMentions: { users: [user.id], roles: [adminRoleId] } });
        return true;
    }

    function startRecovery() {
        if (recoveryTimer) return;
        recover().catch(error => console.error('Initial order recovery failed:', error));
        recoveryTimer = setInterval(() => recover().catch(error => console.error('Order recovery failed:', error)), 60000);
        recoveryTimer.unref?.();
    }

    return { initialize: store.initialize, commandDefinitions, handleInteraction, handleStripeEvent, handleReaction, startRecovery,
        store, saveTranscript, archiveAndDelete, reconcileCheckout, closeTicket };
}

module.exports = { createOrderRuntime, isStaff, assertAuthorized, money, COMMANDS };

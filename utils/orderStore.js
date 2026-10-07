const { randomBytes, createHash } = require('node:crypto');
const { normalizeAccountCategory, parseAccountEntry, parseAccountRestock } = require('./accounts');
const { robloxCatalogUrl } = require('./catalogLinks');

class OrderError extends Error {
    constructor(message, existingOrder = null) {
        super(message);
        this.name = 'OrderError';
        this.existingOrder = existingOrder;
    }
}

function validateRobloxUrl(value) {
    const url = robloxCatalogUrl(value);
    if (!url) throw new OrderError('Use a Roblox catalog item link such as https://www.roblox.com/catalog/123456789.');
    return url;
}

function toCents(value) {
    const amount = Number(value);
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents) || cents < 1) {
        throw new OrderError('Enter a positive USD amount with a valid cent value.');
    }
    return cents;
}

function quoteCents(baseCents, discountPct = 0) {
    return Math.max(1, Math.round(baseCents * (100 - discountPct) / 100));
}

function pointsFor(cents) {
    if (cents <= 0) return 0;
    if (cents <= 10000) return 2;
    if (cents <= 50000) return 4;
    if (cents <= 100000) return 7;
    return 10;
}

function requireOpen(order) {
    if (!order || !order.active || order.closing) throw new OrderError('This order is closed or is being archived.');
}

function requireEditable(order) {
    requireOpen(order);
    if (order.paymentStatus === 'paid') throw new OrderError('This order has already been paid.');
    if (order.stripeSessionId || order.checkoutCreating?.until > new Date()) {
        throw new OrderError('A card checkout is active. Finish or expire that checkout before changing this order.');
    }
}

function availableCoupons(coupons, reservedDiscounts) {
    const remaining = [...coupons];
    for (const discount of reservedDiscounts) {
        const index = remaining.indexOf(discount);
        if (index !== -1) remaining.splice(index, 1);
    }
    return [...new Set(remaining.filter(pct => Number.isInteger(pct) && pct > 0 && pct < 100))];
}

function createOrderStore({ connection, Ledger, Inventory, cooldownSeconds = 30, ticketHours = 24 }) {
    const db = () => connection.db;
    const orders = () => db().collection('shop_orders');
    const gates = () => db().collection('shop_ticket_cooldowns');
    const parts = () => db().collection('shop_transcript_parts');
    const buyerLocks = () => db().collection('shop_buyer_locks');
    const settings = () => db().collection('shop_settings');
    const toycodeItems = () => db().collection('shop_toycode_items');
    const ledger = () => Ledger.collection;
    const inventory = () => Inventory.collection;

    async function transaction(work) {
        const session = await connection.startSession();
        try {
            let result;
            await session.withTransaction(async () => { result = await work(session); });
            return result;
        } finally {
            await session.endSession();
        }
    }

    async function ensureLedger(buyerId, session) {
        // Serialize first-time ledger creation as well as coupon/payment updates,
        // even if the user's existing Ledger schema has no unique discordId index.
        await buyerLocks().updateOne({ _id: buyerId }, { $inc: { version: 1 } }, { upsert: true, session });
        await ledger().updateOne({ discordId: buyerId }, {
            $setOnInsert: { discordId: buyerId, points: 0, purchases: [], coupons: [] }
        }, { upsert: true, session });
    }

    async function initialize() {
        await orders().createIndex({ orderId: 1 }, { unique: true });
        await orders().createIndex({ guildId: 1, buyerId: 1, productSlot: 1 }, {
            unique: true, partialFilterExpression: { active: true }, name: 'one_open_order_per_product'
        });
        await orders().createIndex({ channelId: 1 }, {
            unique: true, partialFilterExpression: { channelId: { $type: 'string' } }
        });
        await orders().createIndex({ buyerId: 1, guildId: 1, createdAt: -1 });
        await orders().createIndex({ stripeSessionId: 1 }, {
            unique: true, partialFilterExpression: { stripeSessionId: { $type: 'string' } }
        });
        await orders().createIndex({ active: 1, expiresAt: 1 });
        await parts().createIndex({ orderId: 1, snapshotId: 1, part: 1 }, { unique: true });
        await toycodeItems().createIndex({ guildId: 1, itemId: 1 }, { unique: true });
        await toycodeItems().createIndex({ guildId: 1, active: 1, priceCents: 1 });
        // Cooldown rows can be discarded once their lock has elapsed.
        await gates().createIndex({ nextAllowedAt: 1 }, { expireAfterSeconds: 3600 });
    }

    async function openOrder(input) {
        const productSlot = input.selectedAccount ? `${input.productKey}:@${input.selectedAccount.toLowerCase()}` : input.productKey;
        const filter = { guildId: input.guildId, buyerId: input.buyerId, productSlot, active: true };
        const existing = await orders().findOne(filter);
        if (existing) throw new OrderError('You already have an open ticket for this product.', existing);
        try {
            return await transaction(async session => {
                const now = new Date();
                if (input.kind === 'toycode') {
                    await settings().updateOne({ _id: `toycode:${input.guildId}:${input.productKey}` },
                        { $inc: { version: 1 } }, { upsert: true, session });
                    const item = await toycodeItems().findOne({ guildId: input.guildId, itemId: input.productKey, active: true }, { session });
                    if (!item || item.priceCents !== input.baseCents || item.title !== input.productName) {
                        throw new OrderError('This item is no longer listed at that price. Go back and select it again.');
                    }
                    // Price, title and image come from the saved listing, never
                    // from component IDs or a buyer-supplied quote.
                    input = { ...input, productName: item.title, imageChannelId: item.imageChannelId,
                        imageMessageId: item.imageMessageId, imageAttachmentId: item.imageAttachmentId };
                }
                if (input.kind === 'account' && input.selectedAccount) {
                    await settings().updateOne({ _id: `account-stock:${input.productKey}` }, { $inc: { version: 1 } }, { upsert: true, session });
                    const reserved = await orders().findOne({ productSlot, active: true }, { session });
                    if (reserved) throw new OrderError('This account already has an open order. Choose another account or ask staff for help.',
                        reserved.buyerId === input.buyerId && reserved.guildId === input.guildId ? reserved : null);
                    const item = await inventory().findOne({ itemId: input.productKey }, { session });
                    const account = (item?.codes || []).map(parseAccountEntry).find(entry => entry?.username.toLowerCase() === input.selectedAccount.toLowerCase());
                    if (!account || account.priceCents !== input.baseCents) throw new OrderError('This account is no longer available at that price. Refresh the catalog.');
                }
                const gateId = `${input.guildId}:${input.buyerId}`;
                const gate = await gates().findOne({ _id: gateId }, { session });
                if (gate && gate.nextAllowedAt > now) {
                    const seconds = Math.ceil((gate.nextAllowedAt - now) / 1000);
                    throw new OrderError(`Please wait ${seconds} seconds before opening another ticket.`);
                }
                await gates().updateOne({ _id: gateId }, {
                    $set: { nextAllowedAt: new Date(now.getTime() + cooldownSeconds * 1000) }
                }, { upsert: true, session });
                const order = {
                    orderId: `ORD-${randomBytes(6).toString('hex').toUpperCase()}`,
                    ...input, productSlot, active: true, channelId: null,
                    status: input.baseCents ? 'awaiting_payment' : 'awaiting_selection',
                    paymentStatus: 'unpaid', fulfillmentStatus: 'pending',
                    totalCents: input.baseCents || null, coupon: null, quoteVersion: 0,
                    claimedBy: null, closing: false, createdAt: now, updatedAt: now,
                    expiresAt: new Date(now.getTime() + ticketHours * 3600000),
                    issues: [], audit: [{ action: 'opened', actorId: input.buyerId, at: now }]
                };
                await orders().insertOne(order, { session });
                return order;
            });
        } catch (error) {
            if (error.code === 11000) {
                const duplicate = await orders().findOne(filter);
                throw new OrderError(duplicate ? 'You already have an open ticket for this product.' : 'Another ticket is being opened. Please wait a moment.', duplicate);
            }
            throw error;
        }
    }

    async function get(orderId) { return orders().findOne({ orderId }); }
    async function getToycode(guildId, itemId) { return toycodeItems().findOne({ guildId, itemId, active: true }); }
    async function listToycodes(guildId) { return toycodeItems().find({ guildId, active: true }).toArray(); }

    function validateToycode(input) {
        const title = String(input.title || '').trim().replace(/\s+/g, ' ');
        if (!input.guildId || !title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) {
            throw new OrderError('Enter a toycode title between 1 and 100 characters.');
        }
        const priceCents = toCents(input.price);
        if (Math.abs(Number(input.price) * 100 - priceCents) > 0.00001) {
            throw new OrderError('Use a positive USD price with no more than two decimal places.');
        }
        let image;
        try { image = new URL(input.imageUrl); } catch { throw new OrderError('Use a direct, public image link for image_url.'); }
        if (!['http:', 'https:'].includes(image.protocol) || image.username || image.password || image.href.length > 2000) {
            throw new OrderError('Use a direct, public HTTP or HTTPS image link under 2000 characters.');
        }
        const itemId = input.itemId?.trim() || `toy_${createHash('sha256').update(`${input.guildId}\0${title.toLowerCase()}`).digest('hex').slice(0, 16)}`;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(itemId) || normalizeAccountCategory(itemId)) {
            throw new OrderError('Use a stock ID with up to 64 letters, digits, underscores or hyphens, separate from account categories.');
        }
        return { guildId: input.guildId, itemId, title, priceCents, imageUrl: image.href,
            ...(input.catalogUrl != null ? { catalogUrl: validateRobloxUrl(input.catalogUrl) } : {}) };
    }

    async function saveToycode(input, codes = []) {
        const item = validateToycode(input);
        if (!input.imageChannelId || !input.imageMessageId || !input.imageAttachmentId) {
            throw new OrderError('The toycode image must be uploaded before saving this listing.');
        }
        return transaction(async session => {
            await settings().updateOne({ _id: `toycode:${item.guildId}:${item.itemId}` },
                { $inc: { version: 1 } }, { upsert: true, session });
            await toycodeItems().updateOne({ guildId: item.guildId, itemId: item.itemId }, {
                $set: { ...item, active: true, imageChannelId: input.imageChannelId,
                    imageMessageId: input.imageMessageId, imageAttachmentId: input.imageAttachmentId, updatedAt: new Date() },
                $setOnInsert: { createdAt: new Date() }
            }, { upsert: true, session });
            if (codes.length) {
                const stock = await inventory().findOne({ itemId: item.itemId }, { session });
                await inventory().updateOne({ itemId: item.itemId },
                    { $set: { codes: [...(stock?.codes || []), ...codes] } }, { upsert: true, session });
            }
            return { item: await toycodeItems().findOne({ guildId: item.guildId, itemId: item.itemId }, { session }), added: codes.length };
        });
    }

    async function updateToycodeCatalogUrl(input, codes = []) {
        const itemId = input.itemId?.trim();
        if (!input.guildId || !itemId) throw new OrderError('Provide item_id to update an existing toycode’s Roblox link.');
        const catalogUrl = validateRobloxUrl(input.catalogUrl);
        return transaction(async session => {
            const filter = { guildId: input.guildId, itemId, active: true };
            if (!await toycodeItems().findOne(filter, { session })) {
                throw new OrderError('No toycode listing found with that stock ID in this server. Check item_id, or create it with title, price and image_url.');
            }
            await settings().updateOne({ _id: `toycode:${input.guildId}:${itemId}` },
                { $inc: { version: 1 } }, { upsert: true, session });
            // Patch only the link: existing title, price, image references and stock stay intact.
            await toycodeItems().updateOne(filter, { $set: { catalogUrl, updatedAt: new Date() } }, { session });
            if (codes.length) {
                const stock = await inventory().findOne({ itemId }, { session });
                await inventory().updateOne({ itemId },
                    { $set: { codes: [...(stock?.codes || []), ...codes] } }, { upsert: true, session });
            }
            return { item: await toycodeItems().findOne(filter, { session }), added: codes.length };
        });
    }
    async function byChannel(channelId) { return orders().findOne({ channelId }); }
    async function getDeliveryChannelId(guildId) {
        return (await settings().findOne({ _id: `live-deliveries:${guildId}` }))?.channelId || null;
    }
    async function saveDeliveryChannelId(guildId, channelId) {
        await settings().updateOne({ _id: `live-deliveries:${guildId}` }, { $set: { channelId, updatedAt: new Date() } }, { upsert: true });
    }
    async function patch(orderId, fields) {
        await orders().updateOne({ orderId }, { $set: { ...fields, updatedAt: new Date() } });
        return get(orderId);
    }

    async function setProduct(orderId, productKey, productName, baseCents) {
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            requireEditable(order);
            if (order.coupon) throw new OrderError('Remove the reserved coupon before changing packages.');
            await orders().updateOne({ orderId }, {
                $set: { productKey, productSlot: productKey, productName, baseCents, totalCents: baseCents, checkoutCreating: null, checkoutCreateExpiresAt: null, status: 'awaiting_payment', updatedAt: new Date() },
                $inc: { quoteVersion: 1 }
            }, { session });
            return orders().findOne({ orderId }, { session });
        }).catch(error => {
            if (error.code === 11000) throw new OrderError('You already have another open order for this package.');
            throw error;
        });
    }

    async function couponsFor(buyerId, exceptOrderId = null, session = undefined) {
        const user = await ledger().findOne({ discordId: buyerId }, { session });
        const reserved = await orders().find({ buyerId, paymentStatus: 'unpaid', 'coupon.discountPct': { $exists: true },
            ...(exceptOrderId ? { orderId: { $ne: exceptOrderId } } : {}) }, { session }).toArray();
        return availableCoupons(user?.coupons || [], reserved.map(order => order.coupon.discountPct));
    }

    async function reserveCoupon(orderId, discountPct) {
        if (!Number.isInteger(discountPct) || discountPct <= 0 || discountPct >= 100) throw new OrderError('Invalid coupon.');
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            requireEditable(order);
            if (!order.baseCents) throw new OrderError('Select a priced package first.');
            await ensureLedger(order.buyerId, session);
            // Write the same ledger in every reservation transaction, so simultaneous
            // tickets cannot reserve the last coupon from different snapshots.
            await ledger().updateOne({ discordId: order.buyerId }, { $inc: { couponReservationVersion: 1 } }, { session });
            const available = await couponsFor(order.buyerId, orderId, session);
            if (!available.includes(discountPct)) throw new OrderError('That coupon is already reserved or is no longer available.');
            const now = new Date();
            await orders().updateOne({ orderId }, {
                $set: { coupon: { discountPct, reservedAt: now, expiresAt: new Date(now.getTime() + 30 * 60000) },
                    totalCents: quoteCents(order.baseCents, discountPct), checkoutCreating: null, checkoutCreateExpiresAt: null, updatedAt: now },
                $inc: { quoteVersion: 1 }, $push: { audit: { action: 'coupon_reserved', actorId: order.buyerId, at: now } }
            }, { session });
            return orders().findOne({ orderId }, { session });
        });
    }

    async function releaseCoupon(orderId) {
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            requireEditable(order);
            if (order.coupon) {
                await ledger().updateOne({ discordId: order.buyerId }, { $inc: { couponReservationVersion: 1 } }, { session });
                await orders().updateOne({ orderId }, {
                    $set: { coupon: null, totalCents: order.baseCents, checkoutCreating: null, checkoutCreateExpiresAt: null, updatedAt: new Date() }, $inc: { quoteVersion: 1 }
                }, { session });
            }
            return orders().findOne({ orderId }, { session });
        });
    }

    async function beginCheckout(orderId) {
        const token = randomBytes(12).toString('hex');
        const now = new Date();
        const saved = await get(orderId);
        requireOpen(saved);
        const expiresAt = saved.checkoutCreateExpiresAt || Math.floor(now / 1000) + 1860;
        const result = await orders().updateOne({ orderId, active: true, closing: false, paymentStatus: 'unpaid',
            stripeSessionId: null, quoteVersion: saved.quoteVersion,
            $or: [{ checkoutCreating: null }, { 'checkoutCreating.until': { $lte: now } }] }, {
            $set: { checkoutCreating: { token, quoteVersion: saved.quoteVersion, until: new Date(now.getTime() + 120000) }, checkoutCreateExpiresAt: expiresAt, updatedAt: now }
        });
        if (!result.modifiedCount) throw new OrderError('Checkout is already being prepared, or this order cannot be paid.');
        return { token, order: await get(orderId) };
    }

    async function attachCheckout(orderId, token, checkout) {
        const order = await get(orderId);
        const result = await orders().updateOne({ orderId, active: true, closing: false, paymentStatus: 'unpaid',
            quoteVersion: order.checkoutCreating?.quoteVersion, 'checkoutCreating.token': token }, {
            $set: { stripeSessionId: checkout.id, stripeExpectedCents: checkout.amount_total, stripeUrl: checkout.url,
                stripeExpiresAt: new Date(checkout.expires_at * 1000), checkoutCreating: null, paymentMethod: 'Stripe',
                ...(order.coupon ? { 'coupon.expiresAt': new Date(checkout.expires_at * 1000) } : {}), updatedAt: new Date() }
        });
        if (!result.modifiedCount) throw new OrderError('The order changed while checkout was being created. Please try again.');
        return get(orderId);
    }

    async function checkoutFailed(orderId, token) {
        await orders().updateOne({ orderId, 'checkoutCreating.token': token }, { $set: { checkoutCreating: null } });
    }

    async function clearCheckout(orderId, stripeSessionId) {
        await orders().updateOne({ orderId, stripeSessionId, paymentStatus: 'unpaid' }, {
            $set: { stripeSessionId: null, stripeUrl: null, stripeExpiresAt: null, checkoutCreating: null, checkoutCreateExpiresAt: null },
            $inc: { quoteVersion: 1 }
        });
        return get(orderId);
    }

    async function markPaid(orderId, { amountCents, method, actorId, stripeSessionId = null, eventId = null }) {
        if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new OrderError('A valid paid amount is required.');
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            if (!order) throw new OrderError('Order not found.');
            if (order.paymentStatus === 'paid') return { order, newlyPaid: false };
            if (stripeSessionId && order.stripeSessionId !== stripeSessionId) throw new OrderError('This Stripe checkout does not match the saved order.');
            if (stripeSessionId && order.stripeExpectedCents !== amountCents) throw new OrderError('Stripe payment amount does not match the saved checkout.');
            if (!stripeSessionId) requireOpen(order);
            await ensureLedger(order.buyerId, session);
            const user = await ledger().findOne({ discordId: order.buyerId }, { session });
            const coupons = [...(user.coupons || [])];
            if (order.coupon) {
                const index = coupons.indexOf(order.coupon.discountPct);
                if (index === -1) throw new OrderError('The reserved coupon is missing. Staff must reconcile this payment.');
                coupons.splice(index, 1);
            }
            const pointsEarned = pointsFor(amountCents);
            const late = !order.active || order.closing;
            await ledger().updateOne({ discordId: order.buyerId }, {
                $inc: { points: pointsEarned, couponReservationVersion: 1 }, $set: { coupons },
                $push: { purchases: { orderId, item: order.productKey, code: 'Manual delivery required',
                    price: amountCents / 100, paidAt: new Date() } }
            }, { session });
            await orders().updateOne({ orderId }, {
                $set: { paymentStatus: 'paid', status: late ? 'issue' : 'paid', paymentMethod: method,
                    paidCents: amountCents, paidAt: new Date(), pointsEarned, couponConsumed: Boolean(order.coupon),
                    coupon: null, paidStripeSessionId: stripeSessionId, stripeEventId: eventId,
                    latePayment: late, closing: false, checkoutCreating: null, updatedAt: new Date() },
                $push: { audit: { action: 'payment_confirmed', actorId, at: new Date(), method } }
            }, { session });
            return { order: await orders().findOne({ orderId }, { session }), newlyPaid: true };
        });
    }

    async function claim(orderId, actorId) {
        const result = await orders().updateOne({ orderId, active: true, closing: false,
            $or: [{ claimedBy: null }, { claimedBy: actorId }] }, {
            $set: { claimedBy: actorId, updatedAt: new Date() },
            $push: { audit: { action: 'claimed', actorId, at: new Date() } }
        });
        if (!result.matchedCount) throw new OrderError('Another staff member has claimed this order, or it is closed.');
        return get(orderId);
    }

    async function delivered(orderId, actorId) {
        const result = await orders().updateOne({ orderId, active: true, closing: false, paymentStatus: 'paid', fulfillmentStatus: { $ne: 'delivered' } }, {
            $set: { status: 'delivered', fulfillmentStatus: 'delivered', deliveredAt: new Date(), deliveredBy: actorId, updatedAt: new Date() },
            $push: { audit: { action: 'delivered', actorId, at: new Date() } }
        });
        if (!result.matchedCount) throw new OrderError('Confirm payment first. This order may already be delivered or closed.');
        return get(orderId);
    }

    async function reportIssue(orderId, actorId, reason) {
        const result = await orders().updateOne({ orderId, active: true, closing: false }, {
            $set: { status: 'issue', fulfillmentStatus: 'issue', updatedAt: new Date() },
            $push: { issues: { actorId, reason, at: new Date() }, audit: { action: 'issue_reported', actorId, at: new Date() } }
        });
        if (!result.matchedCount) throw new OrderError('This order is closed.');
        return get(orderId);
    }

    async function setRating(orderId, buyerId, stars) {
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new OrderError('Choose a rating from 1 to 5 stars.');
        const result = await orders().updateOne({ orderId, buyerId, paymentStatus: 'paid', fulfillmentStatus: 'delivered' }, {
            $set: { starRating: stars, ratedAt: new Date(), updatedAt: new Date() },
            $push: { audit: { action: 'rated', actorId: buyerId, at: new Date(), stars } }
        });
        if (!result.matchedCount) throw new OrderError('Only the buyer can rate an order after delivery.');
        return get(orderId);
    }

    async function restockAccounts(category, rawInput) {
        const itemId = normalizeAccountCategory(category);
        if (!itemId) throw new OrderError('Choose a valid account category.');
        let accounts;
        try { accounts = parseAccountRestock(rawInput); }
        catch (error) { throw new OrderError(error.message); }
        return transaction(async session => {
            await settings().updateOne({ _id: `account-stock:${itemId}` }, { $inc: { version: 1 } }, { upsert: true, session });
            const item = await inventory().findOne({ itemId }, { session });
            const existing = new Set((item?.codes || []).map(parseAccountEntry).filter(Boolean).map(entry => entry.username.toLowerCase()));
            for (const account of accounts) if (existing.has(account.username.toLowerCase())) {
                throw new OrderError(`@${account.username} is already stocked in ${itemId}. Remove its old entry before replacing it.`);
            }
            const codes = [...(item?.codes || []), ...accounts.map(account => account.code)];
            await inventory().updateOne({ itemId }, { $set: { codes } }, { upsert: true, session });
            return { added: accounts.length, total: codes.length };
        });
    }

    async function reservedAccounts(category) {
        const ordersInStock = await orders().find({ productKey: category, kind: 'account', active: true, fulfillmentStatus: 'pending' }).toArray();
        return new Set(ordersInStock.map(order => order.selectedAccount?.toLowerCase()).filter(Boolean));
    }

    async function removeAccounts(category, input) {
        const itemId = normalizeAccountCategory(category);
        if (!itemId) throw new OrderError('Choose a valid account category.');
        const names = [];
        for (const line of String(input || '').split(/\r?\n/).filter(line => line.trim())) {
            if (line.includes(':')) {
                const account = parseAccountEntry(line);
                if (!account) throw new OrderError('Remove accounts by username, or provide one complete username:password:price entry per line.');
                names.push(account.username);
            } else names.push(...line.split(',').map(name => name.trim().replace(/^@/, '')));
        }
        if (!names.length || names.some(name => !/^[A-Za-z0-9_]{1,32}$/.test(name))) throw new OrderError('Provide the usernames to remove, separated by commas or new lines.');
        const wanted = new Set(names.map(name => name.toLowerCase()));
        return transaction(async session => {
            await settings().updateOne({ _id: `account-stock:${itemId}` }, { $inc: { version: 1 } }, { upsert: true, session });
            const pending = await orders().find({ productKey: itemId, kind: 'account', active: true, fulfillmentStatus: 'pending' }, { session }).toArray();
            if (pending.some(order => wanted.has(order.selectedAccount?.toLowerCase()))) throw new OrderError('An account you selected has an open order. Resolve that ticket before removing its stock.');
            const item = await inventory().findOne({ itemId }, { session });
            if (!item) throw new OrderError('This account category has no stock record.');
            const codes = item.codes.filter(code => !wanted.has(code.split(':')[0].trim().replace(/^@/, '').toLowerCase()));
            await inventory().updateOne({ _id: item._id }, { $set: { codes } }, { session });
            return { removed: item.codes.length - codes.length, total: codes.length };
        });
    }

    async function deliverStock(orderId, actorId, itemId, specificAccount = null) {
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            requireOpen(order);
            if (order.paymentStatus !== 'paid') throw new OrderError('Confirm payment before delivering stock.');
            if (order.fulfillmentStatus === 'delivered') {
                if (order.stockDeliveryCode) return { code: order.stockDeliveryCode, order, repeated: true };
                throw new OrderError('This order has already been delivered manually.');
            }
            if (order.productKey !== itemId) throw new OrderError('The delivery item must match this order.');
            const item = await inventory().findOne({ itemId }, { session });
            if (!item?.codes?.length) throw new OrderError(`Stock is empty for ${itemId}.`);
            const wanted = order.selectedAccount || specificAccount;
            const index = wanted ? item.codes.findIndex(code => {
                const username = order.kind === 'account' ? parseAccountEntry(code)?.username : code.split(':')[0].trim().replace(/^@/, '');
                return username?.toLowerCase() === wanted.toLowerCase();
            }) : 0;
            if (index === -1) throw new OrderError('The requested account is no longer in stock.');
            const codes = [...item.codes];
            const code = codes.splice(index, 1)[0];
            await inventory().updateOne({ _id: item._id }, { $set: { codes } }, { session });
            const user = await ledger().findOne({ discordId: order.buyerId }, { session });
            const purchases = (user?.purchases || []).map(entry => entry.orderId === orderId ? { ...entry, code } : entry);
            await ledger().updateOne({ discordId: order.buyerId }, { $set: { purchases } }, { session });
            await orders().updateOne({ orderId }, {
                $set: { status: 'delivered', fulfillmentStatus: 'delivered', stockDeliveryCode: code, deliveredAt: new Date(), deliveredBy: actorId, updatedAt: new Date() },
                $push: { audit: { action: 'stock_delivered', actorId, at: new Date() } }
            }, { session });
            return { code, order: await orders().findOne({ orderId }, { session }) };
        });
    }

    async function beginClose(orderId, actorId, reason, finalStatus) {
        return transaction(async session => {
            const order = await orders().findOne({ orderId }, { session });
            requireOpen(order);
            if (['cancelled', 'expired'].includes(finalStatus) && order.paymentStatus === 'paid') throw new OrderError('A paid order cannot be cancelled by the buyer or expiry timer.');
            if (order.checkoutCreating?.until > new Date() || order.stripeSessionId && order.paymentStatus !== 'paid') {
                throw new OrderError('Expire or reconcile the card checkout before closing this order.');
            }
            if (order.coupon) await ledger().updateOne({ discordId: order.buyerId }, { $inc: { couponReservationVersion: 1 } }, { session });
            await orders().updateOne({ orderId }, {
                $set: { closing: true, closeActorId: actorId, closeReason: reason, closeFinalStatus: finalStatus,
                    coupon: null, totalCents: order.paymentStatus === 'paid' ? order.totalCents : order.baseCents, updatedAt: new Date() },
                $push: { audit: { action: 'closure_requested', actorId, at: new Date(), reason } }
            }, { session });
            return orders().findOne({ orderId }, { session });
        });
    }

    async function finalizeClose(orderId, transcript) {
        const order = await get(orderId);
        const result = await orders().updateOne({ orderId, closing: true,
            ...(['cancelled', 'expired'].includes(order.closeFinalStatus) ? { paymentStatus: 'unpaid' } : {}) }, {
            $set: { status: order.closeFinalStatus, active: false, closing: false, closedAt: new Date(), transcript,
                transcriptUpload: null, channelDeleted: false, updatedAt: new Date() }
        });
        if (!result.modifiedCount) throw new OrderError('The order changed during archival; the channel has been kept.');
        return get(orderId);
    }

    async function abandonCreation(orderId) {
        await orders().updateOne({ orderId, paymentStatus: 'unpaid' }, {
            $set: { active: false, closing: false, status: 'cancelled', closedAt: new Date(), channelDeleted: true }
        });
    }

    async function listOrders(guildId, buyerId, page = 0) {
        return orders().find({ guildId, buyerId }).sort({ createdAt: -1 }).skip(page * 5).limit(6).toArray();
    }
    async function recoveryOrders() {
        const now = new Date();
        return orders().find({ $or: [
            { closing: true }, { active: false, channelDeleted: false },
            { active: true, paymentStatus: 'unpaid', expiresAt: { $lte: now } },
            { active: true, paymentStatus: 'unpaid', 'coupon.expiresAt': { $lte: now } },
            { active: true, paymentStatus: 'unpaid', stripeSessionId: { $type: 'string' } },
            { paymentStatus: 'paid', paymentNoticeSent: { $ne: true } },
            { active: false, 'transcript.savedAt': { $exists: true }, receiptNoticeSent: { $ne: true } },
            { active: false, 'transcript.snapshotId': { $type: 'string' } },
            { active: false, 'transcript.cleanupPending': true },
            { panelMessageId: { $type: 'string' } },
            { active: true, channelId: null, createdAt: { $lte: new Date(now.getTime() - 600000) } }
        ] }).sort({ updatedAt: 1 }).limit(100).toArray();
    }

    return { initialize, ensureLedger, openOrder, get, getToycode, listToycodes, validateToycode, saveToycode, updateToycodeCatalogUrl, byChannel, getDeliveryChannelId, saveDeliveryChannelId, patch, setProduct, couponsFor, reserveCoupon, releaseCoupon,
        beginCheckout, attachCheckout, checkoutFailed, clearCheckout, markPaid, claim, delivered, reportIssue, setRating, restockAccounts, removeAccounts, reservedAccounts, deliverStock,
        beginClose, finalizeClose, abandonCreation, listOrders, recoveryOrders, parts, transaction };
}

module.exports = { createOrderStore, OrderError, toCents, quoteCents, pointsFor, availableCoupons, requireOpen, requireEditable };

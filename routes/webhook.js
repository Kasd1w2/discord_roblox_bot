const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Inventory = require('../models/Inventory');
const Ledger = require('../models/Ledger');
const { calculatePoints } = require('../utils/helpers');
const { updateBotStatus } = require('../utils/botStatus');

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
        const usdPricePaid = session.amount_total / 100;
        const botClient = req.app.get('botClient');

        try {
            updateBotStatus(botClient, `💳 Payment received! Auto-delivering ${targetItemId.toUpperCase()}...`);

            const itemRecord = await Inventory.findOne({ itemId: targetItemId });
            
            if (!itemRecord || itemRecord.codes.length === 0) {
                console.error(`CRITICAL: User ${buyerDiscordId} paid for ${targetItemId} but stock is empty!`);
                updateBotStatus(botClient, `⚠️ ERROR: Stock empty for ${targetItemId.toUpperCase()}!`);
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
                await orderChannel.send(`🙏 Thank you again for your business, <@${buyerDiscordId}>!`);
            }

        } catch (dbErr) {
            console.error('Error handling checkout completion webhook:', dbErr);
        }
    }
    
    res.status(200).json({ received: true });
});

module.exports = router;
const { EmbedBuilder } = require('discord.js');

function shopTerms() {
    return new EmbedBuilder().setTitle('📜 Stocked | Shop Terms').setColor(0x2B2D31)
        .setDescription('Please read these terms before placing an order. Ask staff if anything is unclear.')
        .addFields(
            { name: '🛍️ Orders & Prices', value: 'Check the product, username, quantity, and price before paying. Prices are in USD. Any payment fees are shown before checkout.' },
            { name: '💳 Payments', value: 'Pay only through the checkout or payment details provided in your order ticket. Staff must verify manual payments before delivery. A transaction hash or screenshot alone does not confirm payment.' },
            { name: '📦 Delivery', value: 'Products are delivered manually after payment confirmation. Keep your ticket open and provide any information staff needs. Login details and codes are available privately through `/my-codes` after delivery.' },
            { name: '🛡️ 7-Day Warranty', value: '**All products except server boosts include a 7-day warranty starting from delivery.** Report a product issue within that period with your order ID and a description. Staff will verify the issue and arrange a correction or replacement.' },
            { name: '🚀 Server Boosts', value: '**Boosts have no warranty.** Supply a valid permanent invite and prepare your server for delivery. Applied boosts cannot be transferred to another server.' },
            { name: '🔐 Account & Code Security', value: 'Keep login details and codes private. Secure delivered accounts promptly and store your order ID. Do not post passwords or unused codes in public channels.' },
            { name: '↩️ Cancellations & Refund Requests', value: 'Contact staff in your ticket about cancellation or refund requests, preferably before delivery. Staff will review the payment and delivery records with you.' },
            { name: '💬 Support & Conduct', value: 'Use your order ticket for support and send clear details about any issue. Fake payment proof, scams, spam, and harassment are not allowed.' }
        );
}

module.exports = { shopTerms };

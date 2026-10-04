const { EmbedBuilder } = require('discord.js');

function shopTerms() {
    return new EmbedBuilder().setColor(0xF59E0B)
        .setDescription('# <a:Termss:1554267208882978896> Stocked | Shop Terms\n\n' +
            '<a:important:1554267188272308248> Please read these terms before placing an order. Ask staff if anything is unclear.')
        .addFields(
            { name: '<:price:1554267169800585227> Orders & Prices', value: 'Check the product, username, quantity, and price before paying. Prices are in USD. Any payment fees are shown before checkout.' },
            { name: '<:stripe:1554263177829687398> <:crypto:1554263320997920799> Payments', value: 'Pay only through the checkout or payment details provided in your order ticket. Staff must verify manual payments before delivery. A transaction hash or screenshot alone does not confirm payment.' },
            { name: '<a:Delivery:1554592662013739109> Delivery', value: 'Products are delivered manually after payment confirmation. Keep your ticket open and provide any information staff needs. Login details and codes are available privately through `/my-codes` after delivery.' },
            { name: '<a:confirm:1554592986334105620> 7-Day Warranty', value: '**All products except server boosts include a 7-day warranty starting from delivery.** Report a product issue within that period with your order ID and a description. Staff will verify the issue and arrange a correction or replacement.' },
            { name: '<a:boostlogo:1554263092244906005> Server Boosts', value: '**Boosts have no warranty.** Supply a valid permanent invite and prepare your server for delivery. Applied boosts cannot be transferred to another server.' },
            { name: '<a:white_user:1554592911679553577> Account & Code Security', value: 'Keep login details and codes private. Secure delivered accounts promptly and store your order ID. Do not post passwords or unused codes in public channels.' },
            { name: '<:trashcan:1554593006596657262> Cancellations & Refund Requests', value: 'Contact staff in your ticket about cancellation or refund requests, preferably before delivery. Staff will review the payment and delivery records with you.' },
            { name: '<a:folder:1554593038003609620> Support & Conduct', value: 'Use your order ticket for support and send clear details about any issue. Fake payment proof, scams, spam, and harassment are not allowed.' }
        );
}

module.exports = { shopTerms };

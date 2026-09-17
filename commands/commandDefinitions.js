const { SlashCommandBuilder } = require('discord.js');

module.exports = [
new SlashCommandBuilder()
    .setName('setup-store')
    .setDescription('Create a new product post or account stock display (Admin)')
    .addChannelOption(opt => opt.setName('channel').setDescription('Select the channel').setRequired(true))
    .addStringOption(opt => opt.setName('store_type').setDescription('What are you setting up?').setRequired(true).addChoices(
        { name: 'Item Store (Automated Codes)', value: 'item' },
        { name: 'Account Stock Display (Users)', value: 'account' }
    ))
    .addStringOption(opt => opt.setName('title').setDescription('Display Title / Post Name').setRequired(false))
    .addNumberOption(opt => opt.setName('price').setDescription('Cost in USD').setRequired(false))
    .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID matching inventory').setRequired(false))
    .addStringOption(opt => opt.setName('delivery_method')
        .setDescription('Delivery Method')
        .setRequired(false)
        .addChoices(
            { name: 'Automated Code', value: 'Automated Code Delivery' },
            { name: 'Automated Link', value: 'Automated Activation Link' },
            { name: 'Manual Delivery', value: 'Manual Delivery' },
            { name: 'User:Password', value: 'User:Password Delivery' },
        ))
    .addStringOption(opt => opt.setName('image_url').setDescription('Thumbnail / Image URL (Optional)').setRequired(false))
    .addStringOption(opt => opt.setName('catalog_url').setDescription('Rolimons link (Optional)').setRequired(false)),
    new SlashCommandBuilder()
        .setName('my-codes')
        .setDescription('Inspect your previously purchased items and points'),
    new SlashCommandBuilder()
    .setName('request-limited')
    .setDescription('Post the Request Limited informational embed (Admin)'),
    new SlashCommandBuilder()
        .setName('restock')
        .setDescription('Add stock codes or accounts to an item (Admin)')
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key').setRequired(true))
        .addStringOption(opt => opt.setName('codes').setDescription('Paste user:password lines or comma-separated codes').setRequired(true)),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Check available inventory stock levels'),
    new SlashCommandBuilder()
        .setName('remove-stock')
        .setDescription('Remove specific codes from an item (Admin)')
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key').setRequired(true))
        .addStringOption(opt => opt.setName('codes').setDescription('Comma-separated codes to remove').setRequired(true)),
    new SlashCommandBuilder()
        .setName('deliver')
        .setDescription('Pull code from database and send code embed with user ping (Admin)')
        .addUserOption(opt => opt.setName('buyer').setDescription('Select the user to ping').setRequired(true))
        .addStringOption(opt => opt.setName('item_id').setDescription('Stock ID key to pull code from').setRequired(true))
        .addNumberOption(opt => opt.setName('price').setDescription('Order price in USD to award points (Optional)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close order channel and log successful/failed sale (Admin)')
        .addStringOption(opt => opt.setName('status').setDescription('Was the payment successful?').setRequired(true).addChoices({ name: 'Successful', value: 'success' }, { name: 'Failed / Cancelled', value: 'failed' }))
        .addStringOption(opt => opt.setName('method').setDescription('Payment method used').setRequired(false).addChoices({ name: 'Stripe (Card)', value: 'Stripe (Card)' }, { name: 'Cryptocurrency', value: 'Cryptocurrency' }))
        .addUserOption(opt => opt.setName('buyer').setDescription('Buyer (needed to award points if successful)').setRequired(false))
        .addNumberOption(opt => opt.setName('price').setDescription('Final order price (needed to award points)').setRequired(false)),
    new SlashCommandBuilder()
        .setName('coupon-store')
        .setDescription('Drop the interactive Coupon Store embed in this channel (Admin)'),
    new SlashCommandBuilder()
        .setName('give-coupon')
        .setDescription('Give a discount coupon to a user manually (Admin)')
        .addUserOption(opt => opt.setName('user').setDescription('The user to receive the coupon').setRequired(true))
        .addNumberOption(opt => opt.setName('discount').setDescription('Discount percentage (e.g., 10, 15, 50)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('view-points')
        .setDescription('View the points and coupons of a specific user (Admin)')
        .addUserOption(opt => opt.setName('user').setDescription('The user to inspect').setRequired(true)),

];

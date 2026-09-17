const mongoose = require('mongoose');

const LedgerSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    purchases: [{ item: String, code: String }],
    points: { type: Number, default: 0 },
    coupons: [{ type: Number }]
});

module.exports = mongoose.model('Ledger', LedgerSchema);
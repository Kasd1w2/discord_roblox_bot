const mongoose = require('mongoose');

const InventorySchema = new mongoose.Schema({
    itemId: { type: String, required: true, unique: true },
    codes: [String]
});

module.exports = mongoose.model('Inventory', InventorySchema);
import mongoose from 'mongoose'

// Item remains the master catalog. Item.stockKg is legacy, unallocated stock.
// Regional balances use integer grams and are never mirrored to Item.stockKg.
const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, immutable: true },
  region: { type: mongoose.Schema.Types.ObjectId, ref: 'Region', required: true, immutable: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true, immutable: true },
  quantityGrams: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  assignmentRevision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  sellingPriceOverride: { type: Number, min: 1, validate: { validator: value => value == null || Number.isSafeInteger(value) } },
  lowStockThresholdOverride: { type: Number, min: 0, validate: { validator: value => value == null || (Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 1000)) && Math.abs(value - Math.round(value * 1000) / 1000) < 1e-9) } },
  configurationHistory: [{
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, required: true },
    beforePrice: Number, afterPrice: Number, beforeThreshold: Number, afterThreshold: Number,
    _id: false,
  }],
}, { timestamps: true })
schema.index({ shop: 1, region: 1, item: 1 }, { unique: true })
export const RegionalStock = mongoose.model('RegionalStock', schema)

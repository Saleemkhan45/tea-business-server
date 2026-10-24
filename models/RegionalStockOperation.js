import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  idempotencyKey: { type: String, required: true, maxlength: 128 },
  fingerprint: { type: String, required: true },
  type: { type: String, enum: ['opening_stock', 'receipt', 'correction', 'transfer', 'purchase_receipt', 'purchase_reversal'], required: true },
  purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
  businessDate: { type: String },
  reference: { type: String, trim: true, maxlength: 160 },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  region: { type: mongoose.Schema.Types.ObjectId, ref: 'Region', required: true },
  destination: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
  quantityGrams: { type: Number, required: true, validate: Number.isSafeInteger },
  reason: { type: String, required: true, maxlength: 240 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  balances: [{ region: mongoose.Schema.Types.ObjectId, beforeGrams: Number, afterGrams: Number, _id: false }],
}, { timestamps: { createdAt: true, updatedAt: false } })
schema.index({ shop: 1, idempotencyKey: 1 }, { unique: true })
schema.index({ shop: 1, region: 1, createdAt: -1 })
schema.index({ shop: 1, destination: 1, createdAt: -1 })
export const RegionalStockOperation = mongoose.model('RegionalStockOperation', schema)

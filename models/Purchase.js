import mongoose from 'mongoose'

const purchaseSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
  businessDate: { type: String, required: true, index: true },
  quantityKg: { type: Number, required: true, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['received', 'in_transit', 'pending', 'voided'], default: 'received', index: true },
  receivingRegion: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
  regionName: { type: String, trim: true },
  supplierName: { type: String, trim: true },
  productName: { type: String, trim: true },
  unitCost: { type: Number, min: 0, validate: Number.isSafeInteger },
  taxAmount: { type: Number, min: 0, validate: Number.isSafeInteger },
  shippingAmount: { type: Number, min: 0, validate: Number.isSafeInteger },
  discountAmount: { type: Number, min: 0, validate: Number.isSafeInteger },
  reference: { type: String, trim: true, maxlength: 160 },
  notes: { type: String, trim: true, maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedAt: { type: Date },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidedAt: { type: Date },
  voidReason: { type: String, maxlength: 240 },
  revision: { type: Number, default: 0 },
  idempotencyKey: { type: String, maxlength: 128, immutable: true, select: false },
  fingerprint: { type: String, immutable: true, select: false },
  payments: [{
    idempotencyKey: { type: String, required: true, maxlength: 128 },
    amountPkr: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    method: { type: String, enum: ['cash', 'bank_transfer', 'cheque', 'card', 'other'], required: true },
    businessDate: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
    reference: { type: String, maxlength: 160 },
  }],
}, { timestamps: true })

purchaseSchema.index({ shop: 1, businessDate: -1 })
purchaseSchema.index({ shop: 1, receivingRegion: 1, businessDate: -1 })
purchaseSchema.index({ shop: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } })

export const Purchase = mongoose.model('Purchase', purchaseSchema)

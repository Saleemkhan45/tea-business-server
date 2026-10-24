import mongoose from 'mongoose'

export const SALE_IDEMPOTENCY_KEY_MAX_LENGTH = 128
export const SALE_IDEMPOTENCY_INDEX_NAME = 'sale_shop_idempotency_key_unique'

const inventoryMovementSchema = new mongoose.Schema({
  regionalStock: { type: mongoose.Schema.Types.ObjectId, ref: 'RegionalStock' },
  region: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  type: {
    type: String,
    enum: ['sale_decrease', 'sale_restore', 'sale_update_adjustment'],
    required: true,
  },
  quantityKg: { type: Number, required: true, min: 0 },
  stockBeforeKg: { type: Number, required: true, min: 0 },
  stockAfterKg: { type: Number, required: true, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, trim: true, maxlength: 240 },
}, {
  _id: false,
  timestamps: { createdAt: true, updatedAt: false },
})

const saleEditSchema = new mongoose.Schema({
  salespersonName: { type: String, trim: true, maxlength: 160 },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: { type: String },
  businessDate: { type: String },
  teaType: { type: String },
  sellingRegionName: { type: String, trim: true, maxlength: 120 },
  sellingRegion: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
  stockLocationId: { type: String },
  quantityKg: { type: Number },
  unitPrice: { type: Number },
  totalAmount: { type: Number },
  amountPaid: { type: Number },
  receivedPaymentMethod: { type: String },
  status: { type: String },
  paymentMethod: { type: String },
  notes: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, {
  _id: false,
  timestamps: { createdAt: true, updatedAt: false },
})

const saleSchema = new mongoose.Schema({
  // Business attribution only; createdBy remains the authenticated audit actor.
  salespersonName: { type: String, trim: true, maxlength: 160 },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  customerName: { type: String, trim: true, maxlength: 160 },
  businessDate: { type: String, required: true, index: true },
  teaType: { type: String, enum: ['green', 'black', 'jasmine', 'herbal', 'other'], index: true },
  sellingRegionName: { type: String, trim: true, maxlength: 120 },
  sellingRegion: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
  stockLocationId: { type: String, trim: true, maxlength: 120 },
  quantityKg: { type: Number, min: 0 },
  unitPrice: { type: Number, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  amountPaid: { type: Number, min: 0, validate: Number.isSafeInteger },
  receivedPaymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'card', 'cheque', 'other'] },
  ledgerRecorded: { type: Boolean, default: false },
  productName: { type: String, trim: true },
  customerRegion: { type: String, trim: true },
  status: { type: String, enum: ['completed', 'pending', 'voided'], default: 'completed', index: true },
  paymentMethod: { type: String, enum: ['cash', 'credit', 'bank_transfer', 'card', 'cheque', 'other'], index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  notes: { type: String, trim: true, maxlength: 500 },
  idempotencyKey: {
    type: String, trim: true, minlength: 1, maxlength: SALE_IDEMPOTENCY_KEY_MAX_LENGTH,
    immutable: true, select: false,
  },
  idempotencyFingerprint: {
    type: String, match: /^[a-f0-9]{64}$/, immutable: true, select: false,
  },
  ledgerRevision: { type: Number, default: 0, select: false },
  inventoryMovements: { type: [inventoryMovementSchema], default: [] },
  editHistory: { type: [saleEditSchema], default: [] },
  voidedAt: { type: Date },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidReason: { type: String, trim: true, maxlength: 240 },
}, { timestamps: true })

saleSchema.index({ shop: 1, customer: 1, businessDate: -1 })
saleSchema.index({ shop: 1, businessDate: -1 })
saleSchema.index({ shop: 1, sellingRegion: 1, businessDate: -1 })
saleSchema.index({ shop: 1, 'inventoryMovements.region': 1 })
saleSchema.index({ shop: 1, idempotencyKey: 1 }, {
  name: SALE_IDEMPOTENCY_INDEX_NAME,
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
})

export const Sale = mongoose.model('Sale', saleSchema)

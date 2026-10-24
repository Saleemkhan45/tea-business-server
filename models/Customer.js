import mongoose from 'mongoose'

export const CUSTOMER_STATUSES = ['active', 'inactive']
export const CUSTOMER_CREATION_IDEMPOTENCY_KEY_MAX_LENGTH = 128
export const CUSTOMER_CREATION_IDEMPOTENCY_INDEX_NAME = 'customer_shop_creation_key_unique'

const customerSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  phone: { type: String, trim: true, maxlength: 40 },
  address: { type: String, trim: true, maxlength: 300 },
  region: { type: String, trim: true, maxlength: 120 },
  city: { type: String, trim: true, maxlength: 120 },
  notes: { type: String, trim: true, maxlength: 1000 },
  creationIdempotencyKey: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: CUSTOMER_CREATION_IDEMPOTENCY_KEY_MAX_LENGTH,
    immutable: true,
    select: false,
  },
  creationFingerprint: {
    type: String,
    match: /^[a-f0-9]{64}$/,
    immutable: true,
    select: false,
  },
  // Legacy notification cache only. Customer Ledger will be authoritative.
  balanceDue: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'Customer balance due must be an integer PKR value.',
    },
  },
  // Coordination metadata only; ledger transactions remain the financial source of truth.
  ledgerRevision: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'Customer ledger revision must be an integer value.',
    },
  },
  status: { type: String, enum: CUSTOMER_STATUSES, default: 'active', index: true },
}, { timestamps: true })

customerSchema.index({ shop: 1, name: 1 })
customerSchema.index({ shop: 1, status: 1, name: 1 })
customerSchema.index({ shop: 1, phone: 1 })
customerSchema.index({ shop: 1, creationIdempotencyKey: 1 }, {
  name: CUSTOMER_CREATION_IDEMPOTENCY_INDEX_NAME,
  unique: true,
  partialFilterExpression: { creationIdempotencyKey: { $type: 'string' } },
})

export const Customer = mongoose.model('Customer', customerSchema)

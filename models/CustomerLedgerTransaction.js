import mongoose from 'mongoose'

export const CUSTOMER_LEDGER_TRANSACTION_TYPES = ['purchase', 'payment', 'opening_balance', 'adjustment', 'return']
export const CUSTOMER_LEDGER_TRANSACTION_STATUSES = ['active', 'voided']
export const CUSTOMER_LEDGER_PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'cheque', 'other']
export const CUSTOMER_LEDGER_TEA_TYPES = ['green', 'black', 'jasmine', 'herbal', 'other']
export const ACTIVE_SALE_PURCHASE_INDEX_NAME = 'active_sale_purchase_unique'

function isValidBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function isSafeIntegerPkr(value) {
  return value === undefined || value === null || Number.isSafeInteger(value)
}

function hasSupportedQuantityPrecision(quantityKg) {
  if (quantityKg === undefined || quantityKg === null) return true
  if (!Number.isFinite(quantityKg)) return false
  const quantityGrams = Math.round(quantityKg * 1000)
  return Number.isSafeInteger(quantityGrams)
    && Math.abs(quantityKg - (quantityGrams / 1000)) < 1e-9
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function requireField(document, field, message) {
  if (isBlank(document[field])) document.invalidate(field, message)
}

function invalidateWhenPresent(document, field, message) {
  if (!isBlank(document[field])) document.invalidate(field, message)
}

function validateAmountByType(document) {
  if (!CUSTOMER_LEDGER_TRANSACTION_TYPES.includes(document.type)) return
  requireField(document, 'amountPkr', 'Ledger amount is required.')
  if (!Number.isSafeInteger(document.amountPkr)) return

  if (document.type === 'purchase' && document.amountPkr < 0) {
    document.invalidate('amountPkr', 'Purchase amount must be zero or greater.')
  }
  if ((document.type === 'payment' || document.type === 'opening_balance') && document.amountPkr <= 0) {
    document.invalidate('amountPkr', 'Ledger amount must be greater than zero.')
  }
  if (document.type === 'adjustment' && document.amountPkr === 0) {
    document.invalidate('amountPkr', 'Adjustment amount must not be zero.')
  }
}

function validatePurchaseFields(document) {
  if (document.type !== 'purchase') return
  requireField(document, 'saleId', 'Sale ID is required for purchase ledger transactions.')
  requireField(document, 'teaType', 'Tea type is required for purchase ledger transactions.')
  requireField(document, 'stockLocationId', 'Stock location ID is required for purchase ledger transactions.')
  requireField(document, 'quantityKg', 'Quantity is required for purchase ledger transactions.')
  requireField(document, 'ratePerKgPkr', 'Rate per kilogram is required for purchase ledger transactions.')

  if (document.quantityKg !== undefined && document.quantityKg <= 0) {
    document.invalidate('quantityKg', 'Quantity must be greater than zero.')
  }
  if (document.ratePerKgPkr !== undefined && document.ratePerKgPkr < 0) {
    document.invalidate('ratePerKgPkr', 'Rate per kilogram must be zero or greater.')
  }
}

function validatePaymentFields(document) {
  if (document.type !== 'payment') return
  requireField(document, 'paymentMethod', 'Payment method is required for payment ledger transactions.')
}

function validateAdjustmentFields(document) {
  if (document.type !== 'adjustment') return
  requireField(document, 'reason', 'Adjustment reason is required.')
}

function validateVoidFields(document) {
  if (document.status === 'voided') {
    requireField(document, 'voidedAt', 'Void timestamp is required for voided ledger transactions.')
    requireField(document, 'voidedBy', 'Void operator is required for voided ledger transactions.')
    requireField(document, 'voidReason', 'Void reason is required for voided ledger transactions.')
    return
  }

  if (document.status === 'active') {
    invalidateWhenPresent(document, 'voidedAt', 'Active ledger transactions cannot include voidedAt.')
    invalidateWhenPresent(document, 'voidedBy', 'Active ledger transactions cannot include voidedBy.')
    invalidateWhenPresent(document, 'voidReason', 'Active ledger transactions cannot include voidReason.')
  }
}

const customerLedgerTransactionSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  idempotencyKey: { type: String, trim: true, maxlength: 120 },
  type: { type: String, enum: CUSTOMER_LEDGER_TRANSACTION_TYPES, required: true },
  businessDate: {
    type: String,
    required: true,
    validate: {
      validator: isValidBusinessDate,
      message: 'Business date must be a valid YYYY-MM-DD date.',
    },
  },
  status: { type: String, enum: CUSTOMER_LEDGER_TRANSACTION_STATUSES, default: 'active', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reference: { type: String, trim: true, maxlength: 120 },
  collectionOccurrence: { type: mongoose.Schema.Types.ObjectId, ref: 'CollectionOccurrence' },
  productName: { type: String, trim: true },
  salePaymentMethod: { type: String, enum: ['cash', 'credit', 'bank_transfer', 'card', 'cheque', 'other'] },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerLedgerTransaction' },
  notes: { type: String, trim: true, maxlength: 500, default: null },

  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
  teaType: { type: String, enum: CUSTOMER_LEDGER_TEA_TYPES },
  stockLocationId: { type: String, trim: true, maxlength: 120 },
  quantityKg: {
    type: Number,
    validate: {
      validator: hasSupportedQuantityPrecision,
      message: 'Quantity must use no more than three decimal places.',
    },
  },
  ratePerKgPkr: {
    type: Number,
    validate: {
      validator: isSafeIntegerPkr,
      message: 'Rate per kilogram must be an integer PKR value.',
    },
  },
  amountPkr: {
    type: Number,
    validate: {
      validator: isSafeIntegerPkr,
      message: 'Ledger amount must be an integer PKR value.',
    },
  },
  paymentMethod: { type: String, enum: CUSTOMER_LEDGER_PAYMENT_METHODS },
  reason: { type: String, trim: true, maxlength: 240 },

  voidedAt: { type: Date },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidReason: { type: String, trim: true, maxlength: 240 },
}, { timestamps: true })

customerLedgerTransactionSchema.pre('validate', function validateLedgerTransaction() {
  validateAmountByType(this)
  validatePurchaseFields(this)
  validatePaymentFields(this)
  validateAdjustmentFields(this)
  validateVoidFields(this)
})

customerLedgerTransactionSchema.index({ shop: 1, customer: 1, businessDate: 1, createdAt: 1, _id: 1 })
customerLedgerTransactionSchema.index({ shop: 1, customer: 1, type: 1, businessDate: 1 })
customerLedgerTransactionSchema.index({ shop: 1, businessDate: 1 })
customerLedgerTransactionSchema.index({ saleId: 1 }, {
  name: ACTIVE_SALE_PURCHASE_INDEX_NAME,
  unique: true,
  partialFilterExpression: { type: 'purchase', status: 'active', saleId: { $type: 'objectId' } },
})

export const CustomerLedgerTransaction = mongoose.model('CustomerLedgerTransaction', customerLedgerTransactionSchema)

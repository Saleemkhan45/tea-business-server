import mongoose from 'mongoose'

const id = mongoose.Schema.Types.ObjectId
const options = { timestamps: true, autoIndex: false, autoCreate: false }
const safe = { type: Number, required: true, validate: Number.isSafeInteger }
const state = new mongoose.Schema({
  shop: { type: id, required: true, ref: 'Shop' }, shopBalance: { ...safe, min: 0 }, homeBalance: { ...safe, min: 0 },
  sequence: { ...safe, min: 0, default: 0 }, openingDate: { type: String, required: true },
  initializedBy: { type: id, required: true, ref: 'User' }, closedThrough: { type: String, default: '' }, latestClose: { type: id, default: null },
  homeEnabled: { type: Boolean, default: true, immutable: true },
}, options)
state.index({ shop: 1 }, { unique: true })
const entry = new mongoose.Schema({
  shop: { type: id, required: true, ref: 'Shop', immutable: true }, sequence: { ...safe, immutable: true },
  key: { type: String, required: true, immutable: true }, fingerprint: { type: String, required: true, immutable: true, select: false },
  businessDate: { type: String, required: true, immutable: true }, type: { type: String, required: true, immutable: true, enum: ['opening', 'boss_to_shop', 'shop_to_home', 'boss_external', 'owner_withdrawal', 'expense', 'contribution', 'adjustment_in', 'adjustment_out', 'reversal', 'sale_receipt', 'customer_receipt', 'supplier_payment', 'source_correction'] },
  shopDelta: { ...safe, immutable: true }, homeDelta: { ...safe, immutable: true },
  shopBalance: { ...safe, min: 0, immutable: true }, homeBalance: { ...safe, min: 0, immutable: true },
  description: { type: String, required: true, maxlength: 500, immutable: true }, reference: { type: String, maxlength: 120, immutable: true },
  classification: { type: String, enum: ['owner_equity', 'owner_loan', 'owner_drawings'], immutable: true }, createdBy: { type: id, ref: 'User', required: true, immutable: true },
  expenseCategory: { type: String, enum: ['transport', 'shop_supplies', 'utilities', 'other'], immutable: true },
  source: { type: String, immutable: true }, sourceBusinessDate: { type: String, immutable: true }, reversalOf: { type: id, immutable: true },
}, options)
entry.index({ shop: 1, key: 1 }, { unique: true })
entry.index({ shop: 1, sequence: 1 }, { unique: true })
entry.index({ shop: 1, businessDate: 1, sequence: 1 })
const source = new mongoose.Schema({
  shop: { type: id, required: true }, source: { type: String, required: true }, value: safe, revision: { ...safe, default: 0 },
}, options)
source.index({ shop: 1, source: 1 }, { unique: true })
const closing = new mongoose.Schema({
  shop: { type: id, required: true, immutable: true }, key: { type: String, required: true, immutable: true },
  fingerprint: { type: String, required: true, immutable: true, select: false },
  action: { type: String, enum: ['close', 'reopen'], required: true, immutable: true },
  businessDate: { type: String, required: true, immutable: true }, createdBy: { type: id, ref: 'User', required: true, immutable: true },
  notes: { type: String, required: true, immutable: true, maxlength: 500 },
  expectedShop: { type: Number, immutable: true }, expectedHome: { type: Number, immutable: true }, countedShop: { type: Number, immutable: true }, difference: { type: Number, immutable: true },
  sequence: { type: Number, immutable: true }, takenHome: { type: Number, immutable: true },
  previousClosedThrough: { type: String, immutable: true }, previousClose: { type: id, immutable: true }, reopens: { type: id, immutable: true },
}, options)
closing.index({ shop: 1, key: 1 }, { unique: true })
closing.index({ shop: 1, businessDate: 1, createdAt: 1 })
for (const schema of [entry, closing]) {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
    throw new Error('Posted Cash Book records are append-only. Use an audited counter-entry.')
  })
  schema.pre('save', function () {
    if (!this.isNew) throw new Error('Posted Cash Book records cannot be saved again.')
  })
}
export const CashState = mongoose.model('CashState', state)
export const CashEntry = mongoose.model('CashEntry', entry)
export const CashSource = mongoose.model('CashSource', source)
export const CashClosing = mongoose.model('CashClosing', closing)

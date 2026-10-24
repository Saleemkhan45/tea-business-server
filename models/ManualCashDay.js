import mongoose from 'mongoose'

const id = mongoose.Schema.Types.ObjectId
const amount = { type: Number, required: true, min: 0, validate: Number.isSafeInteger }
const options = { timestamps: true, autoCreate: false, autoIndex: false }
const lifecycle = {
  status: { type: String, enum: ['active', 'voided'], default: 'active' },
  voidedBy: { type: id, ref: 'User', default: null },
  voidedAt: { type: Date, default: null },
  voidReason: { type: String, maxlength: 500, default: '' },
}
const values = {
  shopCashAmount: amount, bossAddedAmount: amount, totalCollected: amount,
  // Retained only for historical records and audit snapshots; never recalculated.
  takenHomeAmount: { ...amount, required: false }, remainingCash: { ...amount, required: false }, notes: { type: String, maxlength: 500, default: '' },
}
const daySchema = new mongoose.Schema({
  shop: { type: id, ref: 'Shop', required: true, immutable: true },
  businessDate: { type: String, required: true, immutable: true }, ...values, ...lifecycle,
  enteredBy: { type: id, ref: 'User', required: true, immutable: true },
  lastUpdatedBy: { type: id, ref: 'User', required: true },
  revision: { ...amount, default: 0 },
}, options)
daySchema.index({ shop: 1, businessDate: 1 }, { unique: true })
daySchema.pre('validate', function () {
  const total = this.shopCashAmount + this.bossAddedAmount
  if (!Number.isSafeInteger(total) || this.totalCollected !== total) this.invalidate('totalCollected', 'Manual cash totals must match entered amounts.')
})
const snapshot = new mongoose.Schema({ ...values, ...lifecycle }, { _id: false })
const revisionSchema = new mongoose.Schema({
  shop: { type: id, required: true, immutable: true },
  record: { type: id, ref: 'ManualCashDay', required: true, immutable: true },
  businessDate: { type: String, required: true, immutable: true },
  revision: { ...amount, immutable: true },
  action: { type: String, enum: ['create', 'correct', 'void', 'replace'], required: true, immutable: true },
  key: { type: String, required: true, immutable: true, select: false },
  fingerprint: { type: String, required: true, immutable: true, select: false },
  previous: { type: snapshot, default: null, immutable: true },
  next: { type: snapshot, required: true, immutable: true },
  reason: { type: String, maxlength: 500, required: true, immutable: true },
  modifiedBy: { type: id, ref: 'User', required: true, immutable: true },
}, options)
revisionSchema.index({ shop: 1, key: 1 }, { unique: true })
revisionSchema.index({ shop: 1, record: 1, revision: 1 }, { unique: true })
revisionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () { throw new Error('Manual cash audit entries are append-only.') })
revisionSchema.pre('save', function () { if (!this.isNew) throw new Error('Manual cash audit entries are append-only.') })
daySchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'], function () { throw new Error('Finalized manual cash days cannot be deleted or replaced.') })
export const ManualCashDay = mongoose.model('ManualCashDay', daySchema)
export const ManualCashRevision = mongoose.model('ManualCashRevision', revisionSchema)

import mongoose from 'mongoose'

// Embedded so the revision claim, profile and audit append are one atomic write.
// No new collection/index or fabricated legacy backfill is required.
const profileChange = new mongoose.Schema({
  revision: { type: Number, required: true },
  key: { type: String, required: true },
  fingerprint: { type: String, required: true },
  action: { type: String, enum: ['create', 'edit'], required: true },
  changes: [{ field: String, previous: mongoose.Schema.Types.Mixed, next: mongoose.Schema.Types.Mixed, _id: false }],
  modifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, required: true },
}, { _id: true })

const supplierSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  alternatePhone: { type: String, trim: true, maxlength: 40 },
  contactPerson: { type: String, trim: true, maxlength: 160 },
  email: { type: String, trim: true, maxlength: 254 },
  city: { type: String, trim: true, maxlength: 120 },
  address: { type: String, trim: true, maxlength: 500 },
  notes: { type: String, trim: true, maxlength: 2000 },
  regions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Region' }],
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
  productOfferings: [{ type: String, trim: true, maxlength: 160 }],
  creationIdempotencyKey: { type: String, maxlength: 128, immutable: true, select: false },
  creationFingerprint: { type: String, immutable: true, select: false },
  revision: { type: Number, default: 0 },
  profileHistory: { type: [profileChange], default: undefined, select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
}, { timestamps: true })

supplierSchema.index({ shop: 1, name: 1 }, { unique: true })

export const Supplier = mongoose.model('Supplier', supplierSchema)

import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameKey: { type: String, required: true },
  idempotencyKey: { type: String, maxlength: 128, select: false },
  fingerprint: { type: String, select: false },
  city: { type: String, trim: true, maxlength: 120 },
  manager: { type: String, trim: true, maxlength: 160 },
  description: { type: String, trim: true, maxlength: 1000 },
  phone: { type: String, trim: true, maxlength: 40 },
  address: { type: String, trim: true, maxlength: 300 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })
schema.index({ shop: 1, nameKey: 1 }, { unique: true })
schema.index({ shop: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } })
export const Region = mongoose.model('Region', schema)

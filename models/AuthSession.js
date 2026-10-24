import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true, select: false },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  csrfToken: { type: String, required: true, select: false },
  authVersion: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  expiresAt: { type: Date, required: true },
  persistent: { type: Boolean, default: false },
  absoluteExpiresAt: Date,
  lastRenewedAt: Date,
  revokedAt: { type: Date, default: null },
  accessMode: { type: String, enum: ['individual', 'trusted-view'], default: 'individual' },
  approvals: [{ tokenHash: String, actionHash: String, operator: mongoose.Schema.Types.ObjectId, authVersion: Number, expiresAt: Date, usedAt: { type: Date, default: null } }],
}, { timestamps: true })
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
export const AuthSession = mongoose.model('AuthSession', schema)

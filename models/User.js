import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  passwordHash: { type: String, select: false },
  passwordChangedAt: Date,
  emailVerifiedAt: Date,
  pendingEmailChange: { type: new mongoose.Schema({ email: String, tokenHash: String, expiresAt: Date, authVersion: Number }, { _id: false }), select: false, default: undefined },
  authVersion: { type: Number, default: 0, min: 0, select: false, validate: Number.isSafeInteger },
  role: { type: String, enum: ['owner', 'admin', 'staff'], default: 'staff' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  securityEvents: [{ action: String, actor: mongoose.Schema.Types.ObjectId, at: Date, previousEmail: String, nextEmail: String }],
}, { timestamps: true })

userSchema.index({ email: 1 }, { unique: true })

export const User = mongoose.model('User', userSchema)

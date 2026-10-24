import mongoose from 'mongoose'

const shopSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  cashBookRevision: { type: Number, default: 0, select: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
}, { timestamps: true })

export const Shop = mongoose.model('Shop', shopSchema)

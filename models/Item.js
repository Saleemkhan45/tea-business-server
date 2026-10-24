import mongoose from 'mongoose'
import { ITEM_TEA_TYPES } from '../constants/teaCategories.js'

const itemSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true },
  teaType: { type: String, enum: ITEM_TEA_TYPES, required: true },
  catalogCreationKey: { type: String, maxlength: 128, select: false },
  catalogFingerprint: { type: String, select: false },
  stockKg: { type: Number, required: true, min: 0, default: 0 },
  sellingPrice: { type: Number, min: 0, validate: Number.isSafeInteger },
  lowStockThreshold: { type: Number, required: true, min: 0, default: 100 },
  lowStockAlertActive: { type: Boolean, default: false },
  lowStockAlertCycle: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
}, { timestamps: true })

itemSchema.index({ shop: 1, name: 1 }, { unique: true })
itemSchema.index({ shop: 1, catalogCreationKey: 1 }, { unique: true, partialFilterExpression: { catalogCreationKey: { $type: 'string' } } })

export const Item = mongoose.model('Item', itemSchema)

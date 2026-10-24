import mongoose from 'mongoose'

export const NOTIFICATION_TYPES = ['LOW_STOCK', 'PURCHASE_ADDED', 'SALES_UP', 'NO_PAYMENT_TODAY', 'KHATA_COLLECTION', 'WHATSAPP_MESSAGE']
export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'danger']

const notificationSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  type: { type: String, enum: NOTIFICATION_TYPES, required: true, index: true },
  severity: { type: String, enum: NOTIFICATION_SEVERITIES, required: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  entityType: { type: String, required: true, trim: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupeKey: { type: String, required: true, trim: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: function () { return this.type === 'KHATA_COLLECTION' ? undefined : new Date(Date.now() + 60 * 86400000) } },
}, { versionKey: false, autoIndex: false })

notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

notificationSchema.index({ shop: 1, createdAt: -1 })
notificationSchema.index({ shop: 1, type: 1, createdAt: -1 })

export const Notification = mongoose.model('Notification', notificationSchema)

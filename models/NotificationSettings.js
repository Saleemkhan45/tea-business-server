import mongoose from 'mongoose'
import { NOTIFICATION_TYPES } from './Notification.js'

const enabledDefaults = NOTIFICATION_TYPES.reduce((flags, type) => ({ ...flags, [type]: true }), {})

const lowStockThresholdSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  threshold: { type: Number, required: true, min: 0 },
}, { _id: false })

const notificationSettingsSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  enabled: { type: Map, of: Boolean, default: enabledDefaults },
  lowStockThresholds: { type: [lowStockThresholdSchema], default: [] },
  noPaymentCutoffTime: { type: String, default: '18:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  muteUntil: { type: Date, default: null },
  soundEnabled: { type: Boolean, default: false },
}, { timestamps: true })

export const NotificationSettings = mongoose.model('NotificationSettings', notificationSettingsSchema)
export const DEFAULT_NOTIFICATION_ENABLED = enabledDefaults

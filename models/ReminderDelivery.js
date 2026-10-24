import mongoose from 'mongoose'
const id = { type: mongoose.Schema.Types.ObjectId, required: true }
const settings = new mongoose.Schema({
  shop: id, push: { type: Boolean, default: false }, whatsapp: { type: Boolean, default: false },
  operator: mongoose.Schema.Types.ObjectId, protectedPhone: String, phoneHash: String,
  consentAt: Date, consentBy: mongoose.Schema.Types.ObjectId, consentSource: String,
  quietStart: { type: String, default: '21:00' }, quietEnd: { type: String, default: '08:00' },
  revision: { type: Number, default: 0 }, history: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true, autoIndex: false, autoCreate: false })
settings.index({ shop: 1 }, { unique: true, name: 'reminder_settings_shop_unique' })
export const ReminderSettings = mongoose.model('ReminderSettings', settings)

const device = new mongoose.Schema({
  shop: id, user: id, session: id, endpointHash: { type: String, required: true },
  protectedSubscription: { type: String, required: true }, active: { type: Boolean, default: true },
  lastSeenAt: Date,
}, { timestamps: true, autoIndex: false, autoCreate: false })
// One browser endpoint cannot be owned simultaneously by two shops or users.
device.index({ endpointHash: 1 }, { unique: true, name: 'push_endpoint_unique' })
device.index({ shop: 1, user: 1, active: 1 })
export const PushDevice = mongoose.model('PushDevice', device)

const delivery = new mongoose.Schema({
  shop: id, occurrence: id, channel: { type: String, enum: ['push', 'whatsapp'], required: true },
  recipient: { type: String, required: true }, user: id,
  status: { type: String, enum: ['queued', 'leased', 'sending', 'retry', 'accepted', 'delivered', 'read', 'failed', 'uncertain', 'cancelled', 'simulated'], default: 'queued' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  leaseToken: String, leaseUntil: Date, providerMessageId: String, safeErrorCode: String,
  acceptedAt: Date, deliveredAt: Date, events: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true, autoIndex: false, autoCreate: false })
delivery.index({ shop: 1, occurrence: 1, channel: 1, recipient: 1 }, { unique: true, name: 'reminder_delivery_unique' })
delivery.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 })
delivery.index({ shop: 1, createdAt: -1 })
delivery.index({ providerMessageId: 1 }, { sparse: true })
export const ReminderDelivery = mongoose.model('ReminderDelivery', delivery)

// Minimal signed receipt inbox: callbacks can arrive before send acknowledgment is saved.
const receipt = new mongoose.Schema({
  providerMessageId: { type: String, required: true }, status: { type: String, required: true },
  businessId: { type: String, required: true }, phoneId: { type: String, required: true },
  processed: { type: Boolean, default: false },
  lastCheckedAt: { type: Date, default: null },
}, { timestamps: true, autoIndex: false, autoCreate: false })
receipt.index({ providerMessageId: 1, status: 1 }, { unique: true, name: 'reminder_receipt_unique' })
receipt.index({ processed: 1, lastCheckedAt: 1, createdAt: 1 })
export const ReminderReceipt = mongoose.model('ReminderReceipt', receipt)

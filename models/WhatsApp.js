import mongoose from 'mongoose'
const id = { type: mongoose.Schema.Types.ObjectId, required: true }
const options = { timestamps: true, autoIndex: false, autoCreate: false }
const contact = new mongoose.Schema({
  shop: id, customer: id, phoneHash: { type: String, required: true }, protectedPhone: { type: String, required: true },
  optedIn: { type: Boolean, default: false }, consentAt: Date, consentBy: mongoose.Schema.Types.ObjectId,
  consentSource: String, optedOutAt: Date, revision: { type: Number, default: 0 }, history: [mongoose.Schema.Types.Mixed],
}, options)
contact.index({ shop: 1, customer: 1 }, { unique: true, name: 'wa_contact_customer_unique' })
contact.index({ shop: 1, phoneHash: 1 }, { unique: true, name: 'wa_contact_phone_unique' })
export const WhatsAppContact = mongoose.model('WhatsAppContact', contact)

const conversation = new mongoose.Schema({
  shop: id, phoneHash: { type: String, required: true }, protectedPhone: { type: String, required: true },
  customer: mongoose.Schema.Types.ObjectId, lastInboundAt: Date, lastActivityAt: Date,
  optedOut: { type: Boolean, default: false }, linkHistory: [mongoose.Schema.Types.Mixed],
}, options)
conversation.index({ shop: 1, phoneHash: 1 }, { unique: true, name: 'wa_conversation_phone_unique' })
conversation.index({ shop: 1, lastActivityAt: -1, _id: -1 })
export const WhatsAppConversation = mongoose.model('WhatsAppConversation', conversation)

const message = new mongoose.Schema({
  shop: id, conversation: id, direction: { type: String, enum: ['in', 'out'], required: true },
  kind: { type: String, enum: ['text', 'template', 'unsupported'], required: true }, protectedBody: String,
  bodyExpiresAt: { type: Date, required: true }, providerMessageId: String, clientKey: String, intentHash: String,
  occurrence: mongoose.Schema.Types.ObjectId, customer: mongoose.Schema.Types.ObjectId, contactRevision: Number,
  createdBy: mongoose.Schema.Types.ObjectId, sentAt: Date,
  status: { type: String, enum: ['received', 'queued', 'leased', 'sending', 'retry', 'accepted', 'delivered', 'read', 'failed', 'uncertain', 'simulated', 'cancelled'], required: true },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  leaseToken: String, leaseUntil: Date, safeErrorCode: String, events: [mongoose.Schema.Types.Mixed],
}, options)
message.index({ providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } }, name: 'wa_message_provider_unique' })
message.index({ shop: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } }, name: 'wa_message_intent_unique' })
message.index({ shop: 1, conversation: 1, createdAt: -1, _id: -1 })
message.index({ direction: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 })
message.index({ bodyExpiresAt: 1 }) // Cleanup removes content only, retaining idempotency/audit metadata.
export const WhatsAppMessage = mongoose.model('WhatsAppMessage', message)

const read = new mongoose.Schema({ shop: id, conversation: id, message: id, user: id }, options)
read.index({ shop: 1, message: 1, user: 1 }, { unique: true, name: 'wa_read_user_unique' })
export const WhatsAppRead = mongoose.model('WhatsAppRead', read)

const integration = new mongoose.Schema({ shop: id, lastVerifiedWebhookAt: Date, lastInboundAt: Date, lastDeliveryAt: Date }, options)
integration.index({ shop: 1 }, { unique: true, name: 'wa_integration_shop_unique' })
export const WhatsAppIntegration = mongoose.model('WhatsAppIntegration', integration)

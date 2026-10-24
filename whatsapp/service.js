import mongoose from 'mongoose'
import { Customer } from '../models/Customer.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { Notification } from '../models/Notification.js'
import { WhatsAppContact, WhatsAppConversation, WhatsAppMessage, WhatsAppRead, WhatsAppIntegration } from '../models/WhatsApp.js'
import { fingerprint, protect, unprotect } from '../reminders/privacy.js'
import { balancePkr } from '../services/customerLedgerCalculations.js'
import { normalizePhone, whatsappConfig, serviceWindowOpen, isOptOut, inboundText } from './policy.js'
import { requireWhatsAppIndexes } from './readiness.js'

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const expires = (config, now) => new Date(now.getTime() + config.retentionDays * 86400000)
export function requireCustomerChannel(shop, config) {
  if (!config.customerEnabled || String(shop) !== config.customerShop) throw fail('Customer messaging is disabled or this sender is not assigned to your shop.', 503)
}
async function transaction(operation) {
  const session = await mongoose.startSession()
  try { return await session.withTransaction(() => operation(session)) } finally { await session.endSession() }
}
export async function getContact(shop, customer, config = whatsappConfig()) {
  const owner = await Customer.findOne({ _id: customer, shop }).select('name phone').lean()
  if (!owner) throw fail('Customer not found.', 404)
  const row = await WhatsAppContact.findOne({ shop, customer }).lean()
  return { customerName: owner.name, existingPhone: owner.phone ?? '', phone: row ? unprotect(row.protectedPhone, config.encryptionKey, `${shop}:${customer}:contact`) : '',
    optedIn: row?.optedIn ?? false, consentAt: row?.consentAt ?? null, consentSource: row?.consentSource ?? '', optedOutAt: row?.optedOutAt ?? null, revision: row?.revision ?? 0 }
}
export async function saveContact(shop, customer, actor, input, config = whatsappConfig()) {
  await requireWhatsAppIndexes()
  const phone = normalizePhone(input.phone), phoneHash = fingerprint(phone)
  if (input.optedIn && !input.consentSource?.trim()) throw fail('Record the source of the customer’s explicit consent.')
  try {
    return await transaction(async session => {
      const owner = await Customer.findOneAndUpdate({ _id: customer, shop, status: 'active' }, { $inc: { ledgerRevision: 1 } }, { session, new: true }).lean()
      if (!owner) throw fail('Active customer not found.', 404)
      const previous = await WhatsAppContact.findOne({ shop, customer }).session(session).lean()
      if ((previous?.revision ?? 0) !== input.revision) throw fail('WhatsApp contact changed. Reload before saving.', 409)
      const now = new Date()
      const settings = { phoneHash, protectedPhone: protect(phone, config.encryptionKey, `${shop}:${customer}:contact`), optedIn: input.optedIn,
        consentBy: actor, consentSource: input.optedIn ? input.consentSource.trim() : 'operator_disabled',
        ...(input.optedIn ? { consentAt: now } : { optedOutAt: now }) }
      await WhatsAppContact.findOneAndUpdate({ shop, customer }, { $set: settings, $inc: { revision: 1 }, $setOnInsert: { shop, customer },
        $push: { history: { phoneHash, optedIn: input.optedIn, actor, at: now, source: settings.consentSource } } }, { session, upsert: true, runValidators: true })
      if (input.optedIn) await WhatsAppConversation.updateOne({ shop, phoneHash }, { $set: { optedOut: false } }, { session })
    })
  } catch (error) {
    if (error.code === 11000) throw fail('This WhatsApp number is already assigned to a customer in your shop. Reload and review the contact.', 409)
    throw error
  }
}
export async function ensureConversation(shop, phone, customer, config, session) {
  const phoneHash = fingerprint(phone)
  return WhatsAppConversation.findOneAndUpdate({ shop, phoneHash }, { $setOnInsert: {
    shop, phoneHash, protectedPhone: protect(phone, config.encryptionKey, `${shop}:${phoneHash}:conversation`), ...(customer ? { customer } : {}),
  } }, { upsert: true, new: true, session }).lean()
}
export async function receiveInbound(shop, message, config = whatsappConfig(), now = new Date()) {
  requireCustomerChannel(shop, config)
  await requireWhatsAppIndexes()
  if (typeof message.id !== 'string' || message.id.length > 1024 || !/^\d+$/.test(message.from ?? '')) throw fail('Invalid inbound message.')
  const sentAt = new Date(Number(message.timestamp) * 1000)
  if (!Number.isFinite(sentAt.getTime()) || sentAt > now || sentAt.getTime() <= 0) throw fail('Invalid inbound timestamp.')
  const phone = normalizePhone(`+${message.from}`), phoneHash = fingerprint(phone)
  const receivedText = inboundText(message)
  const text = receivedText ?? '[Unsupported message: review in WhatsApp Business tooling]'
  try {
    await transaction(async session => {
      const contact = await WhatsAppContact.findOne({ shop, phoneHash }).session(session).lean()
      const conversation = await ensureConversation(shop, phone, contact?.customer, config, session)
      const id = new mongoose.Types.ObjectId()
      await WhatsAppMessage.create([{ _id: id, shop, conversation: conversation._id, direction: 'in',
        kind: receivedText === null ? 'unsupported' : 'text', protectedBody: protect({ text }, config.encryptionKey, `${shop}:${id}:message`),
        bodyExpiresAt: expires(config, now), providerMessageId: message.id, sentAt, status: 'received' }], { session })
      await WhatsAppConversation.updateOne({ _id: conversation._id, shop }, { $max: { lastInboundAt: sentAt, lastActivityAt: now },
        ...(isOptOut(text) ? { $set: { optedOut: true } } : {}) }, { session })
      if (isOptOut(text) && contact) await WhatsAppContact.updateOne({ _id: contact._id, shop }, {
        $set: { optedIn: false, optedOutAt: now, consentSource: 'customer_opt_out' }, $inc: { revision: 1 },
        $push: { history: { at: now, optedIn: false, source: 'customer_opt_out', message: id } },
      }, { session })
      await Notification.updateOne({ shop, dedupeKey: `WHATSAPP_INBOUND:${shop}:${fingerprint(message.id)}` }, { $setOnInsert: {
        shop, dedupeKey: `WHATSAPP_INBOUND:${shop}:${fingerprint(message.id)}`, type: 'WHATSAPP_MESSAGE', severity: 'info',
        title: 'New WhatsApp message', message: 'A customer or unlinked sender replied. Open the protected inbox to review.',
        entityType: 'WhatsAppConversation', entityId: conversation._id, createdAt: now, expiresAt: expires(config, now),
      } }, { session, upsert: true, setDefaultsOnInsert: false })
      await WhatsAppIntegration.updateOne({ shop }, { $max: { lastVerifiedWebhookAt: now, lastInboundAt: now }, $setOnInsert: { shop } }, { session, upsert: true })
    })
  } catch (error) {
    if (error.code === 11000 && await WhatsAppMessage.exists({ shop, providerMessageId: message.id })) return
    throw error // A conversation-creation race must be retried by the provider, never acknowledged as a stored message.
  }
}
async function currentCustomer(conversation) {
  if (!conversation.customer) return null
  const contact = await WhatsAppContact.findOne({ shop: conversation.shop, customer: conversation.customer, phoneHash: conversation.phoneHash }).lean()
  return contact ? Customer.findOne({ _id: contact.customer, shop: conversation.shop }).select('name status').lean() : null
}
export async function serializeConversation(row, user, config) {
  const customer = await currentCustomer(row)
  const reads = await WhatsAppRead.find({ shop: row.shop, conversation: row._id, user }).select('message').lean()
  const unread = await WhatsAppMessage.countDocuments({ shop: row.shop, conversation: row._id, direction: 'in', _id: { $nin: reads.map(value => value.message) } })
  const ledger = customer ? await CustomerLedgerTransaction.find({ shop: row.shop, customer: customer._id }).lean() : []
  return { id: String(row._id), customerId: customer ? String(customer._id) : null, customerName: customer?.name ?? 'Unlinked sender — review required',
    phone: unprotect(row.protectedPhone, config.encryptionKey, `${row.shop}:${row.phoneHash}:conversation`), unread,
    lastInboundAt: row.lastInboundAt ?? null, windowOpen: serviceWindowOpen(row.lastInboundAt), optedOut: row.optedOut,
    outstandingPkr: customer ? balancePkr(ledger) : null, lastActivityAt: row.lastActivityAt ?? row.createdAt }
}
export async function listConversations(shop, user, page, config = whatsappConfig()) {
  const [rows, total] = await Promise.all([WhatsAppConversation.find({ shop }).sort({ lastActivityAt: -1, _id: -1 }).skip((page - 1) * 25).limit(25).lean(), WhatsAppConversation.countDocuments({ shop })])
  return { rows: await Promise.all(rows.map(row => serializeConversation(row, user, config))), total }
}
export async function getMessages(shop, conversationId, user, before, config = whatsappConfig()) {
  const conversation = await WhatsAppConversation.findOne({ _id: conversationId, shop }).lean()
  if (!conversation) throw fail('Conversation not found.', 404)
  const rows = await WhatsAppMessage.find({ shop, conversation: conversationId, ...(before ? { _id: { $lt: before } } : {}) }).sort({ _id: -1 }).limit(50).lean()
  const reads = await WhatsAppRead.find({ shop, user, message: { $in: rows.map(row => row._id) } }).lean()
  return { conversation: await serializeConversation(conversation, user, config), rows: rows.reverse().map(row => ({
    id: String(row._id), direction: row.direction, kind: row.kind, status: row.status, sentAt: row.sentAt ?? row.createdAt,
    text: row.protectedBody && row.bodyExpiresAt > new Date() ? unprotect(row.protectedBody, config.encryptionKey, `${shop}:${row._id}:message`).text : '[Content expired]',
    read: row.direction === 'out' || reads.some(read => String(read.message) === String(row._id)), safeErrorCode: row.safeErrorCode,
  })), olderCursor: rows.length === 50 ? String(rows[0]._id) : null }
}
export async function markRead(shop, conversation, user, ids) {
  const messages = await WhatsAppMessage.find({ shop, conversation, direction: 'in', _id: { $in: ids } }).select('_id').lean()
  for (const message of messages) {
    try { await WhatsAppRead.updateOne({ shop, user, message: message._id }, { $setOnInsert: { shop, user, conversation, message: message._id } }, { upsert: true }) }
    catch (error) { if (error.code !== 11000) throw error }
  }
}
export async function linkConversation(shop, conversationId, customer, actor) {
  return transaction(async session => {
    const conversation = await WhatsAppConversation.findOne({ _id: conversationId, shop }).session(session).lean()
    if (!conversation) throw fail('Conversation not found.', 404)
    const contact = await WhatsAppContact.findOne({ shop, customer, phoneHash: conversation.phoneHash }).session(session).lean()
    if (!contact || !await Customer.exists({ _id: customer, shop, status: 'active' }).session(session)) throw fail('Save this exact WhatsApp number on the intended active customer before linking.', 409)
    await WhatsAppConversation.updateOne({ _id: conversationId, shop }, { $set: { customer }, $push: { linkHistory: { customer, previousCustomer: conversation.customer, actor, at: new Date() } } }, { session })
  })
}
export async function queueMessage(shop, conversation, actor, body, config = whatsappConfig(), now = new Date()) {
  requireCustomerChannel(shop, config)
  await requireWhatsAppIndexes()
  const intentHash = fingerprint(JSON.stringify({ conversation: String(conversation._id), kind: body.kind, text: body.text, occurrence: body.occurrence ? String(body.occurrence) : null }))
  const existing = await WhatsAppMessage.findOne({ shop, clientKey: body.clientKey }).lean()
  if (existing) {
    if (existing.intentHash !== intentHash || String(existing.createdBy ?? '') !== String(actor ?? '')) throw fail('Message key already belongs to a different request.', 409)
    return { id: String(existing._id), status: existing.status }
  }
  const customer = await currentCustomer(conversation)
  if (!customer || customer.status !== 'active' || conversation.optedOut) throw fail('Link an eligible customer; opted-out conversations cannot receive messages.', 409)
  const contact = await WhatsAppContact.findOne({ shop, customer: customer._id, phoneHash: conversation.phoneHash }).lean()
  if (body.kind === 'text' && !serviceWindowOpen(conversation.lastInboundAt, now)) throw fail('The 24-hour reply window is closed. Use an approved scheduled template.', 409)
  if (body.kind === 'template' && !contact?.optedIn) throw fail('Explicit customer reminder consent is required.', 409)
  const id = new mongoose.Types.ObjectId()
  const content = body.kind === 'text' ? { kind: 'text', text: body.text } : { kind: 'template', name: customer.name, amount: body.amount, text: `Collection reminder template: ${customer.name} — PKR ${body.amount}` }
  try {
    await WhatsAppMessage.create({ _id: id, shop, conversation: conversation._id, direction: 'out', kind: body.kind,
      protectedBody: protect(content, config.encryptionKey, `${shop}:${id}:message`), bodyExpiresAt: expires(config, now),
      clientKey: body.clientKey, intentHash, createdBy: actor, customer: customer._id, contactRevision: contact.revision,
      occurrence: body.occurrence, status: 'queued', nextAttemptAt: now })
  } catch (error) {
    if (error.code !== 11000) throw error
    const replay = await WhatsAppMessage.findOne({ shop, clientKey: body.clientKey }).lean()
    if (!replay || replay.intentHash !== intentHash || String(replay.createdBy ?? '') !== String(actor ?? '')) throw fail('Message request conflicted. Reload before retrying.', 409)
    return { id: String(replay._id), status: replay.status }
  }
  await WhatsAppConversation.updateOne({ _id: conversation._id, shop }, { $max: { lastActivityAt: now } })
  return { id: String(id), status: 'queued' }
}

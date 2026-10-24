import { randomUUID } from 'node:crypto'
import { WhatsAppContact, WhatsAppConversation, WhatsAppMessage } from '../models/WhatsApp.js'
import { CollectionOccurrence, CollectionSchedule } from '../models/CollectionSchedule.js'
import { Customer } from '../models/Customer.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { ReminderSettings } from '../models/ReminderDelivery.js'
import { collectionState, addDays } from '../services/collectionCalculations.js'
import { balancePkr } from '../services/customerLedgerCalculations.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { eligibleOccurrence, failurePolicy, nextAllowedTime } from '../reminders/policy.js'
import { unprotect } from '../reminders/privacy.js'
import { whatsappConfig, serviceWindowOpen } from './policy.js'
import { requireWhatsAppIndexes } from './readiness.js'
import { ensureConversation, queueMessage } from './service.js'
import { sendCustomerMessage } from './provider.js'

async function eligible(occurrence, now) {
  if (!await CollectionSchedule.exists({ _id: occurrence.schedule, shop: occurrence.shop, customer: occurrence.customer, status: 'active' })) return false
  const ledger = await CustomerLedgerTransaction.find({ shop: occurrence.shop, customer: occurrence.customer }).lean()
  return eligibleOccurrence(occurrence, collectionState(occurrence, ledger, balancePkr(ledger), getBusinessDate(now)), now)
}
export async function enqueueCustomerReminders(config, now) {
  const shop = config.customerShop
  const occurrences = await CollectionOccurrence.find({ shop, channels: 'customer_whatsapp', scheduledDate: { $gte: addDays(getBusinessDate(now), -1), $lte: getBusinessDate(now) } }).lean()
  for (const occurrence of occurrences) {
    const contact = await WhatsAppContact.findOne({ shop, customer: occurrence.customer, optedIn: true }).lean()
    if (!contact || !await Customer.exists({ _id: occurrence.customer, shop, status: 'active' }) || !await eligible(occurrence, now)) continue
    const phone = unprotect(contact.protectedPhone, config.encryptionKey, `${shop}:${occurrence.customer}:contact`)
    const conversation = await ensureConversation(shop, phone, occurrence.customer, config)
    if (conversation.optedOut) continue
    try {
      await queueMessage(shop, conversation, undefined, { kind: 'template', occurrence: occurrence._id,
        amount: occurrence.expectedAmount, clientKey: `collection:${occurrence._id}:customer:${occurrence.customer}` }, config, now)
    } catch (error) { if (error.statusCode !== 409) throw error }
  }
}
export async function processCustomerMessage(row, config, now = new Date(), send = sendCustomerMessage) {
  const claim = { _id: row._id, shop: row.shop, status: 'leased', leaseToken: row.leaseToken }
  const cancel = code => WhatsAppMessage.updateOne(claim, { $set: { status: 'cancelled', safeErrorCode: code } })
  if (String(row.shop) !== config.customerShop || !config.customerEnabled || !await Shop.exists({ _id: row.shop, status: 'active' })) return cancel('shop_ineligible')
  const conversation = await WhatsAppConversation.findOne({ _id: row.conversation, shop: row.shop }).lean()
  if (!conversation || conversation.optedOut || String(conversation.customer) !== String(row.customer)) return cancel('conversation_ineligible')
  const contact = await WhatsAppContact.findOne({ shop: row.shop, customer: row.customer, phoneHash: conversation.phoneHash }).lean()
  if (!contact || contact.revision !== row.contactRevision || !await Customer.exists({ _id: row.customer, shop: row.shop, status: 'active' })) return cancel('contact_changed')
  if (row.createdBy && !await User.exists({ _id: row.createdBy, shop: row.shop, status: 'active' })) return cancel('operator_ineligible')
  if (row.kind === 'text' && !serviceWindowOpen(conversation.lastInboundAt, now)) return cancel('reply_window_closed')
  if (row.kind === 'template') {
    if (!contact.optedIn) return cancel('customer_opted_out')
    const occurrence = await CollectionOccurrence.findOne({ _id: row.occurrence, shop: row.shop, customer: row.customer, channels: 'customer_whatsapp' }).lean()
    if (!occurrence || !await eligible(occurrence, now)) return cancel('collection_resolved_or_paused')
    const settings = await ReminderSettings.findOne({ shop: row.shop }).lean()
    const allowedAt = nextAllowedTime(now, settings ?? { quietStart: '21:00', quietEnd: '08:00' })
    if (allowedAt > now) return WhatsAppMessage.updateOne(claim, { $set: { status: 'retry', nextAttemptAt: allowedAt } })
  }
  if (!row.protectedBody || row.bodyExpiresAt <= now) return cancel('message_content_expired')
  if (!config.live) return WhatsAppMessage.updateOne(claim, { $set: { status: 'simulated' }, $push: { events: { status: 'simulated', at: now } } })
  const body = unprotect(row.protectedBody, config.encryptionKey, `${row.shop}:${row._id}:message`)
  const phone = unprotect(contact.protectedPhone, config.encryptionKey, `${row.shop}:${row.customer}:contact`)
  const started = await WhatsAppMessage.updateOne(claim, { $set: { status: 'sending' }, $inc: { attempts: 1 }, $push: { events: { status: 'sending', at: now } } })
  if (started.modifiedCount !== 1) return
  let result
  try { result = await send(phone, body, config) }
  catch (error) { result = failurePolicy(error, row.attempts + 1, now) }
  await WhatsAppMessage.updateOne({ _id: row._id, shop: row.shop, status: 'sending', leaseToken: row.leaseToken }, {
    $set: { ...result, ...(result.status === 'accepted' ? { sentAt: now } : {}) }, $push: { events: { status: result.status, code: result.safeErrorCode, at: now } },
  })
}
export async function runCustomerMessaging({ config = whatsappConfig(), now = new Date(), limit = 100 } = {}) {
  if (!config.customerEnabled && !config.retentionEnabled) return { failedClaims: 0 }
  if (!/^[a-fA-F0-9]{24}$/.test(config.customerShop)) throw new Error('Customer WhatsApp requires an explicit sender-to-shop assignment.')
  await requireWhatsAppIndexes()
  await WhatsAppMessage.updateMany({ shop: config.customerShop, bodyExpiresAt: { $lte: now }, protectedBody: { $exists: true } }, { $unset: { protectedBody: 1 } })
  if (!config.customerEnabled || !await Shop.exists({ _id: config.customerShop, status: 'active' })) return { failedClaims: 0 }
  await enqueueCustomerReminders(config, now)
  await WhatsAppMessage.updateMany({ shop: config.customerShop, status: 'sending', leaseUntil: { $lte: now } }, { $set: { status: 'uncertain', safeErrorCode: 'send_outcome_unknown' } })
  await WhatsAppMessage.updateMany({ shop: config.customerShop, status: 'leased', leaseUntil: { $lte: now } }, { $set: { status: 'retry', nextAttemptAt: now } })
  let failedClaims = 0
  for (let index = 0; index < limit; index++) {
    const at = new Date()
    const row = await WhatsAppMessage.findOneAndUpdate({ shop: config.customerShop, direction: 'out', status: { $in: ['queued', 'retry'] }, nextAttemptAt: { $lte: at } },
      { $set: { status: 'leased', leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + 120000) } }, { new: true, sort: { nextAttemptAt: 1, _id: 1 } }).lean()
    if (!row) break
    try { await processCustomerMessage(row, config) } catch { failedClaims++ }
  }
  return { failedClaims }
}

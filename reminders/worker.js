import { randomUUID } from 'node:crypto'
import { ReminderDelivery, ReminderSettings, PushDevice } from '../models/ReminderDelivery.js'
import { CollectionOccurrence, CollectionSchedule } from '../models/CollectionSchedule.js'
import { Customer } from '../models/Customer.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { AuthSession } from '../models/AuthSession.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { NotificationSettings } from '../models/NotificationSettings.js'
import { balancePkr } from '../services/customerLedgerCalculations.js'
import { collectionState, addDays } from '../services/collectionCalculations.js'
import { runCollectionReminderJob } from '../services/collectionNotifications.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { reminderConfig, operatorApproved, providerReady } from './config.js'
import { unprotect } from './privacy.js'
import { requireReminderIndexes } from './readiness.js'
import { eligibleOccurrence, failurePolicy, nextAllowedTime } from './policy.js'
import { sendPush, sendWhatsApp } from './providers.js'
import { reconcileReceipts } from './receipts.js'

async function pending(occurrence, now) {
  if (!await Shop.exists({ _id: occurrence.shop, status: 'active' })) return false
  if (!await Customer.exists({ _id: occurrence.customer, shop: occurrence.shop, status: 'active' })) return false
  if (!await CollectionSchedule.exists({ _id: occurrence.schedule, shop: occurrence.shop, customer: occurrence.customer, status: 'active' })) return false
  const ledger = await CustomerLedgerTransaction.find({ shop: occurrence.shop, customer: occurrence.customer }).lean()
  return eligibleOccurrence(occurrence, collectionState(occurrence, ledger, balancePkr(ledger), getBusinessDate(now)), now)
}
async function userEnabled(shop, user, now) {
  if (!await User.exists({ _id: user, shop, status: 'active' })) return false
  const preferences = await NotificationSettings.findOne({ user }).lean()
  return preferences?.enabled?.KHATA_COLLECTION !== false && !(preferences?.muteUntil > now)
}
async function queue(occurrence, channel, recipient, user, nextAttemptAt) {
  const scope = { shop: occurrence.shop, occurrence: occurrence._id, channel, recipient }
  try {
    await ReminderDelivery.updateOne(scope, { $setOnInsert: { ...scope, user, status: 'queued', attempts: 0, nextAttemptAt } }, { upsert: true })
  } catch (error) { if (error.code !== 11000) throw error }
}
export async function enqueueReminders(now = new Date()) {
  const occurrences = await CollectionOccurrence.find({ scheduledDate: { $gte: addDays(getBusinessDate(now), -1), $lte: getBusinessDate(now) } }).lean()
  for (const occurrence of occurrences) {
    if (!await pending(occurrence, now)) continue
    const settings = await ReminderSettings.findOne({ shop: occurrence.shop }).lean()
    if (!settings) continue
    const channels = occurrence.channels ?? ['in_app'], next = nextAllowedTime(now, settings)
    if (settings.whatsapp && settings.operator && channels.includes('whatsapp')) {
      await queue(occurrence, 'whatsapp', settings.phoneHash, settings.operator, next)
    }
    if (settings.push && channels.includes('push')) {
      const devices = await PushDevice.find({ shop: occurrence.shop, active: true }).lean()
      for (const device of devices) await queue(occurrence, 'push', String(device._id), device.user, next)
    }
  }
}
async function destination(delivery, config, now) {
  const settings = await ReminderSettings.findOne({ shop: delivery.shop }).lean()
  const occurrence = await CollectionOccurrence.findOne({ _id: delivery.occurrence, shop: delivery.shop }).lean()
  if (!settings || !settings[delivery.channel] || !occurrence || !await pending(occurrence, now)
    || !(occurrence.channels ?? []).includes(delivery.channel) || !await userEnabled(delivery.shop, delivery.user, now)) return null
  const allowedAt = nextAllowedTime(now, settings)
  if (allowedAt > now) return { defer: allowedAt }
  if (delivery.channel === 'whatsapp') {
    if (!settings.consentAt || String(settings.operator) !== String(delivery.user) || settings.phoneHash !== delivery.recipient) return null
    const phone = unprotect(settings.protectedPhone, config.encryptionKey, `${delivery.shop}:operator`)
    if (!operatorApproved(config, delivery.shop, phone)) return null
    return { phone }
  }
  const device = await PushDevice.findOne({ _id: delivery.recipient, shop: delivery.shop, user: delivery.user, active: true }).lean()
  if (!device || !await AuthSession.exists({ _id: device.session, shop: delivery.shop, user: delivery.user, revokedAt: null, expiresAt: { $gt: now } })) return null
  return { subscription: unprotect(device.protectedSubscription, config.encryptionKey, `${device.shop}:${device.user}:${device.endpointHash}`) }
}
export async function processDelivery(delivery, config, now = new Date(), providers = { sendPush, sendWhatsApp }) {
  const claim = { _id: delivery._id, status: 'leased', leaseToken: delivery.leaseToken }
  const target = await destination(delivery, config, now)
  if (!target) return ReminderDelivery.updateOne(claim, { $set: { status: 'cancelled', safeErrorCode: 'recipient_or_collection_ineligible' } })
  if (target.defer) return ReminderDelivery.updateOne(claim, { $set: { status: 'retry', nextAttemptAt: target.defer } })
  if (!config.live) return ReminderDelivery.updateOne(claim, { $set: { status: 'simulated' }, $push: { events: { at: now, status: 'simulated' } } })
  if (!providerReady(delivery.channel, config)) return ReminderDelivery.updateOne(claim, { $set: { status: 'failed', safeErrorCode: 'provider_not_configured' } })
  // Persist the uncertainty boundary before touching the external provider.
  const started = await ReminderDelivery.updateOne(claim, { $set: { status: 'sending' }, $inc: { attempts: 1 }, $push: { events: { at: now, status: 'sending' } } })
  if (started.modifiedCount !== 1) return
  const sending = { _id: delivery._id, status: 'sending', leaseToken: delivery.leaseToken }
  let result
  try {
    result = delivery.channel === 'push' ? await providers.sendPush(target.subscription, config) : await providers.sendWhatsApp(target.phone, config)
  } catch (error) {
    result = failurePolicy(error, delivery.attempts + 1, now)
    if (delivery.channel === 'push' && result.safeErrorCode === 'recipient_expired') {
      await PushDevice.updateOne({ _id: delivery.recipient, shop: delivery.shop, user: delivery.user }, { $set: { active: false } })
    }
  }
  // Failed acknowledgment persistence leaves 'sending', later quarantined as uncertain.
  await ReminderDelivery.updateOne(sending, { $set: { ...result, ...(result.status === 'accepted' ? { acceptedAt: now } : {}) },
    $push: { events: { at: now, status: result.status, code: result.safeErrorCode } } })
}
export async function runDeliveryWorker({ now = new Date(), limit = 100, config = reminderConfig() } = {}) {
  await requireReminderIndexes()
  await reconcileReceipts(config)
  await runCollectionReminderJob()
  await enqueueReminders(now)
  await ReminderDelivery.updateMany({ status: 'sending', leaseUntil: { $lte: now } }, { $set: { status: 'uncertain', safeErrorCode: 'worker_interrupted_after_send_boundary' } })
  await ReminderDelivery.updateMany({ status: 'leased', leaseUntil: { $lte: now } }, { $set: { status: 'retry', nextAttemptAt: now } })
  let failedClaims = 0
  for (let count = 0; count < limit; count++) {
    const claimAt = new Date()
    const row = await ReminderDelivery.findOneAndUpdate({ status: { $in: ['queued', 'retry'] }, nextAttemptAt: { $lte: claimAt } },
      { $set: { status: 'leased', leaseToken: randomUUID(), leaseUntil: new Date(claimAt.getTime() + 120000) } }, { new: true, sort: { nextAttemptAt: 1, _id: 1 } }).lean()
    if (!row) break
    try { await processDelivery(row, config, new Date()) }
    catch { failedClaims++ } // Persisted leases recover; never log provider objects or recipients.
  }
  await reconcileReceipts(config)
  return { failedClaims }
}

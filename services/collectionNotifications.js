import { CollectionOccurrence, CollectionSchedule } from '../models/CollectionSchedule.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { Customer } from '../models/Customer.js'
import { Notification } from '../models/Notification.js'
import { Shop } from '../models/Shop.js'
import { balancePkr } from './customerLedgerCalculations.js'
import { collectionState, reminderInstant } from './collectionCalculations.js'
import { syncShop } from './collectionService.js'
import { getBusinessDate } from '../utils/businessDay.js'

// Uses the existing persistent bell and read-state system. Never creates ledger entries.
export async function refreshCollectionNotifications(shop) {
  await syncShop(shop)
  const occurrences = await CollectionOccurrence.find({ shop, scheduledDate: { $lte: getBusinessDate() } }).lean()
  for (const occurrence of occurrences) {
    const customer = await Customer.findOne({ _id: occurrence.customer, shop }).lean()
    if (!customer) continue
    const ledger = await CustomerLedgerTransaction.find({ shop, customer: occurrence.customer }).lean()
    const state = collectionState(occurrence, ledger, balancePkr(ledger))
    const resolved = ['collected', 'cleared', 'acknowledged'].includes(state.status) || customer.status !== 'active'
    const dedupeKey = `KHATA_COLLECTION:${shop}:${occurrence._id}`
    if (resolved) {
      await Notification.updateOne({ shop, dedupeKey }, { $set: { 'meta.resolved': true } })
      continue
    }
    if (reminderInstant(occurrence) > new Date() || !(occurrence.channels ?? ['in_app']).includes('in_app')) continue
    try {
      await Notification.updateOne({ shop, dedupeKey }, {
        // Query upserts do not provide a document to type-dependent defaults.
        // Explicitly remove expiry so pending collection reminders persist.
        $unset: { expiresAt: 1 },
        $set: { 'meta.resolved': false, 'meta.status': state.status },
        $setOnInsert: { shop, dedupeKey, type: 'KHATA_COLLECTION', severity: 'warning',
          title: `Khata collection due: ${customer.name}`,
          message: `PKR ${occurrence.expectedAmount.toLocaleString('en-PK')} expected on ${occurrence.scheduledDate}.`,
          entityType: 'Customer', entityId: customer._id,
          'meta.occurrenceId': String(occurrence._id), 'meta.businessDate': occurrence.scheduledDate,
          createdAt: new Date() },
      }, { upsert: true, runValidators: true, setDefaultsOnInsert: false })
    } catch (error) { if (error.code !== 11000) throw error }
  }
}

export async function runCollectionReminderJob() {
  const shops = await Shop.find({ status: 'active' }).select('_id').lean()
  for (const shop of shops) {
    if (await CollectionSchedule.exists({ shop: shop._id })) await refreshCollectionNotifications(shop._id)
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ settings: vi.fn(), devices: vi.fn(), device: vi.fn(), disable: vi.fn(),
  occurrences: vi.fn(), occurrence: vi.fn(), ledger: vi.fn(), user: vi.fn(), customer: vi.fn(), shop: vi.fn(), schedule: vi.fn(),
  session: vi.fn(), preferences: vi.fn(), update: vi.fn(), updateMany: vi.fn(), claim: vi.fn(), indexes: vi.fn(), inApp: vi.fn() }))
vi.mock('../models/ReminderDelivery.js', () => ({
  ReminderSettings: { findOne: db.settings }, PushDevice: { find: db.devices, findOne: db.device, updateOne: db.disable },
  ReminderDelivery: { updateOne: db.update, updateMany: db.updateMany, findOneAndUpdate: db.claim },
}))
vi.mock('../models/CollectionSchedule.js', () => ({ CollectionOccurrence: { find: db.occurrences, findOne: db.occurrence }, CollectionSchedule: { exists: db.schedule } }))
vi.mock('../models/Customer.js', () => ({ Customer: { exists: db.customer } }))
vi.mock('../models/Shop.js', () => ({ Shop: { exists: db.shop } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.user } }))
vi.mock('../models/AuthSession.js', () => ({ AuthSession: { exists: db.session } }))
vi.mock('../models/NotificationSettings.js', () => ({ NotificationSettings: { findOne: db.preferences } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { find: db.ledger } }))
vi.mock('../services/collectionNotifications.js', () => ({ runCollectionReminderJob: db.inApp }))
vi.mock('./readiness.js', () => ({ requireReminderIndexes: db.indexes }))
vi.mock('./receipts.js', () => ({ reconcileReceipts: async () => {} }))
import { enqueueReminders, processDelivery, runDeliveryWorker } from './worker.js'
import { protect } from './privacy.js'

const now = new Date('2026-10-21T05:00:00Z'), key = 'a'.repeat(64)
const occurrence = { _id: 'occurrence', customer: 'customer', shop: 'shop', schedule: 'schedule', scheduledDate: '2026-10-21', time: '09:00', expectedAmount: 2000, channels: ['push'] }
const device = { _id: 'device', shop: 'shop', user: 'user', session: 'session', endpointHash: 'hash', active: true,
  protectedSubscription: protect({ endpoint: 'https://fcm.googleapis.com/offline' }, key, 'shop:user:hash') }
const row = { _id: 'delivery', occurrence: 'occurrence', shop: 'shop', user: 'user', channel: 'push', recipient: 'device', attempts: 0, leaseToken: 'lease' }
const config = { live: true, encryptionKey: key, vapidPublic: 'offline-public', vapidPrivate: 'offline-private', vapidSubject: 'mailto:offline@example.invalid' }
const query = value => ({ lean: async () => value })
beforeEach(() => {
  vi.resetAllMocks()
  for (const fn of [db.shop, db.user, db.customer, db.schedule, db.session]) fn.mockResolvedValue(true)
  db.preferences.mockReturnValue(query(null))
  db.settings.mockReturnValue(query({ push: true, quietStart: '21:00', quietEnd: '08:00' }))
  db.device.mockReturnValue(query(device)); db.devices.mockReturnValue(query([device]))
  db.occurrence.mockReturnValue(query(occurrence)); db.occurrences.mockReturnValue(query([occurrence]))
  db.ledger.mockReturnValue(query([{ type: 'opening_balance', amountPkr: 20000, businessDate: '2026-10-01', status: 'active', _id: 'opening' }]))
  db.update.mockResolvedValue({ modifiedCount: 1 }); db.claim.mockReturnValue(query(null))
  db.updateMany.mockResolvedValue({}); db.indexes.mockResolvedValue(); db.inApp.mockResolvedValue()
})
describe('durable external reminder orchestration offline', () => {
  it('deduplicates queue identity across worker restarts without touching a ledger', async () => {
    await enqueueReminders(now); await enqueueReminders(now)
    expect(db.update.mock.calls[0][0]).toEqual({ shop: 'shop', occurrence: 'occurrence', channel: 'push', recipient: 'device' })
    expect(db.update.mock.calls[1][0]).toEqual(db.update.mock.calls[0][0])
    expect(db.update.mock.calls[0][2]).toEqual({ upsert: true })
    expect(db.ledger).toHaveBeenCalledWith({ shop: 'shop', customer: 'customer' })
  })
  it('simulates without contacting either provider', async () => {
    const providers = { sendPush: vi.fn(), sendWhatsApp: vi.fn() }
    await processDelivery(row, { ...config, live: false }, now, providers)
    expect(providers.sendPush).not.toHaveBeenCalled(); expect(providers.sendWhatsApp).not.toHaveBeenCalled()
    expect(db.update.mock.calls[0][1].$set.status).toBe('simulated')
  })
  it('cancels a logged-out device before any send', async () => {
    db.session.mockResolvedValue(false)
    const providers = { sendPush: vi.fn() }
    await processDelivery(row, config, now, providers)
    expect(providers.sendPush).not.toHaveBeenCalled()
    expect(db.update.mock.calls[0][1].$set.status).toBe('cancelled')
    expect(db.session).toHaveBeenCalledWith(expect.objectContaining({ shop: 'shop', user: 'user', revokedAt: null }))
  })
  it.each(['shop', 'customer', 'schedule', 'user'])('cancels inactive %s ownership before delivery', async name => {
    db[name].mockResolvedValue(false)
    const providers = { sendPush: vi.fn() }
    await processDelivery(row, config, now, providers)
    expect(providers.sendPush).not.toHaveBeenCalled()
  })
  it('rechecks authoritative clearance and never sends a now-unnecessary reminder', async () => {
    db.ledger.mockReturnValue(query([]))
    const providers = { sendPush: vi.fn() }
    await processDelivery(row, config, now, providers)
    expect(providers.sendPush).not.toHaveBeenCalled()
    expect(db.update.mock.calls[0][1].$set.status).toBe('cancelled')
  })
  it('uses the send-boundary compare-and-set to prevent simultaneous claims from sending twice', async () => {
    let status = 'leased'
    db.update.mockImplementation(async (filter, update) => {
      if (filter.status !== status) return { modifiedCount: 0 }
      status = update.$set.status; return { modifiedCount: 1 }
    })
    const providers = { sendPush: vi.fn().mockResolvedValue({ status: 'accepted' }) }
    await Promise.all([processDelivery(row, config, now, providers), processDelivery(row, config, now, providers)])
    expect(providers.sendPush).toHaveBeenCalledOnce()
    expect(status).toBe('accepted')
  })
  it('deactivates an expired push subscription and records a safe failure code', async () => {
    await processDelivery(row, config, now, { sendPush: vi.fn().mockRejectedValue({ statusCode: 410, body: 'private data' }) })
    expect(db.disable).toHaveBeenCalledWith({ _id: 'device', shop: 'shop', user: 'user' }, { $set: { active: false } })
    expect(db.update.mock.calls.at(-1)[1].$set).toMatchObject({ status: 'failed', safeErrorCode: 'recipient_expired' })
    expect(JSON.stringify(db.update.mock.calls)).not.toContain('private data')
  })
  it('quarantines interrupted sends and recovers only claims that never reached sending', async () => {
    db.occurrences.mockReturnValue(query([]))
    await runDeliveryWorker({ config, now })
    expect(db.updateMany.mock.calls[0]).toEqual([{ status: 'sending', leaseUntil: { $lte: now } }, { $set: { status: 'uncertain', safeErrorCode: 'worker_interrupted_after_send_boundary' } }])
    expect(db.updateMany.mock.calls[1][0].status).toBe('leased')
    expect(db.claim.mock.calls[0][0].status).toEqual({ $in: ['queued', 'retry'] })
  })
})

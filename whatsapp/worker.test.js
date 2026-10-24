import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ shop: vi.fn(), user: vi.fn(), customer: vi.fn(), contact: vi.fn(), conversation: vi.fn(), update: vi.fn(), prune: vi.fn(), occurrence: vi.fn(), schedule: vi.fn(), ledger: vi.fn(), settings: vi.fn() }))
vi.mock('../models/WhatsApp.js', () => ({ WhatsAppContact: { findOne: db.contact }, WhatsAppConversation: { findOne: db.conversation }, WhatsAppMessage: { updateOne: db.update, updateMany: db.prune } }))
vi.mock('../models/Shop.js', () => ({ Shop: { exists: db.shop } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.user } }))
vi.mock('../models/Customer.js', () => ({ Customer: { exists: db.customer } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { find: db.ledger } }))
vi.mock('../models/CollectionSchedule.js', () => ({ CollectionOccurrence: { findOne: db.occurrence }, CollectionSchedule: { exists: db.schedule } }))
vi.mock('../models/ReminderDelivery.js', () => ({ ReminderSettings: { findOne: db.settings } }))
vi.mock('./service.js', () => ({ ensureConversation: vi.fn(), queueMessage: vi.fn() }))
vi.mock('./readiness.js', () => ({ requireWhatsAppIndexes: async () => {} }))
import { processCustomerMessage, runCustomerMessaging } from './worker.js'
import { protect } from '../reminders/privacy.js'
const now = new Date('2026-10-21T05:00:00Z'), shop = '507f1f77bcf86cd799439011'
const config = { customerEnabled: true, customerShop: shop, encryptionKey: 'a'.repeat(64), live: true }
const row = { _id: 'message', shop, conversation: 'conversation', customer: 'customer', createdBy: 'operator', contactRevision: 1, kind: 'text', leaseToken: 'lease', attempts: 0,
  bodyExpiresAt: new Date('2026-12-01'), protectedBody: protect({ kind: 'text', text: 'Confirmed arrangement, awaiting actual payment.' }, config.encryptionKey, `${shop}:message:message`) }
const query = value => ({ lean: async () => value })
beforeEach(() => {
  vi.resetAllMocks()
  for (const method of [db.shop, db.user, db.customer, db.schedule]) method.mockResolvedValue(true)
  db.contact.mockReturnValue(query({ customer: 'customer', revision: 1, optedIn: true, protectedPhone: protect('+923001234567', config.encryptionKey, `${shop}:customer:contact`) }))
  db.conversation.mockReturnValue(query({ customer: 'customer', phoneHash: 'hash', lastInboundAt: now }))
  db.update.mockResolvedValue({ modifiedCount: 1 })
  db.occurrence.mockReturnValue(query({ _id: 'occurrence', shop, schedule: 'schedule', customer: 'customer', expectedAmount: 2000, scheduledDate: '2026-10-21', time: '09:00' }))
  db.ledger.mockReturnValue(query([{ _id: 'opening', type: 'opening_balance', status: 'active', businessDate: '2026-10-01', amountPkr: 20000 }]))
  db.settings.mockReturnValue(query(null))
})
describe('customer message dispatch safety offline', () => {
  it('does nothing while customer activation is disabled', async () => {
    expect(await runCustomerMessaging({ config: { ...config, customerEnabled: false } })).toEqual({ failedClaims: 0 })
    expect(db.shop).not.toHaveBeenCalled()
  })
  it('can remove expired encrypted content while sending remains disabled, preserving message metadata', async () => {
    await runCustomerMessaging({ config: { ...config, customerEnabled: false, retentionEnabled: true }, now })
    expect(db.prune).toHaveBeenCalledWith({ shop, bodyExpiresAt: { $lte: now }, protectedBody: { $exists: true } }, { $unset: { protectedBody: 1 } })
    expect(db.shop).not.toHaveBeenCalled()
  })
  it('rechecks the service window at dispatch and cancels late queued text', async () => {
    db.conversation.mockReturnValue(query({ customer: 'customer', phoneHash: 'hash', lastInboundAt: new Date(now.getTime() - 86400000) }))
    const send = vi.fn()
    await processCustomerMessage(row, config, now, send)
    expect(send).not.toHaveBeenCalled()
    expect(db.update.mock.calls[0][1].$set.safeErrorCode).toBe('reply_window_closed')
  })
  it.each(['opted_out', 'contact_changed', 'foreign_shop'])('cancels %s before contacting Meta', async reason => {
    if (reason === 'opted_out') db.conversation.mockReturnValue(query({ customer: 'customer', optedOut: true }))
    if (reason === 'contact_changed') db.contact.mockReturnValue(query({ revision: 2 }))
    const send = vi.fn()
    await processCustomerMessage(reason === 'foreign_shop' ? { ...row, shop: 'foreign' } : row, config, now, send)
    expect(send).not.toHaveBeenCalled()
  })
  it('uses an atomic send boundary to avoid two concurrent provider calls', async () => {
    let status = 'leased'
    db.update.mockImplementation(async (filter, update) => {
      if (filter.status !== status) return { modifiedCount: 0 }
      status = update.$set.status; return { modifiedCount: 1 }
    })
    const send = vi.fn().mockResolvedValue({ status: 'accepted', providerMessageId: 'wamid.offline' })
    await Promise.all([processCustomerMessage(row, config, now, send), processCustomerMessage(row, config, now, send)])
    expect(send).toHaveBeenCalledOnce(); expect(status).toBe('accepted')
  })
  it('simulates without external delivery and quarantines unknown send outcomes', async () => {
    const send = vi.fn()
    await processCustomerMessage(row, { ...config, live: false }, now, send)
    expect(send).not.toHaveBeenCalled(); expect(db.update.mock.calls[0][1].$set.status).toBe('simulated')
    db.update.mockClear()
    await processCustomerMessage(row, config, now, vi.fn().mockRejectedValue(new Error('timeout')))
    expect(db.update.mock.calls.at(-1)[1].$set.status).toBe('uncertain')
  })
  it('does not remind cleared debt even with an opted-in recipient', async () => {
    db.ledger.mockReturnValue(query([]))
    const send = vi.fn()
    await processCustomerMessage({ ...row, kind: 'template', occurrence: 'occurrence', createdBy: undefined }, config, now, send)
    expect(send).not.toHaveBeenCalled()
    expect(db.update.mock.calls[0][1].$set.safeErrorCode).toBe('collection_resolved_or_paused')
  })
})

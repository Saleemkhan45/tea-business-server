import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ sync: vi.fn(), occurrences: vi.fn(), customer: vi.fn(), ledger: vi.fn(), notification: vi.fn() }))
vi.mock('./collectionService.js', () => ({ syncShop: db.sync }))
vi.mock('../models/CollectionSchedule.js', () => ({ CollectionOccurrence: { find: db.occurrences }, CollectionSchedule: {} }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOne: db.customer } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { find: db.ledger } }))
vi.mock('../models/Notification.js', () => ({ Notification: { updateOne: db.notification } }))
vi.mock('../models/Shop.js', () => ({ Shop: {} }))
import { refreshCollectionNotifications } from './collectionNotifications.js'

const occurrence = { _id: 'occurrence', shop: 'shop', customer: 'customer', scheduledDate: '2026-10-01', expectedAmount: 2000 }
const opening = { _id: 'opening', businessDate: '2026-10-01', createdAt: '2026-10-01', type: 'opening_balance', amountPkr: 20000, status: 'active' }
const payment = { _id: 'payment', businessDate: '2026-10-02', createdAt: '2026-10-02', type: 'payment', amountPkr: 2000, status: 'active', collectionOccurrence: 'occurrence' }
beforeEach(() => {
  vi.resetAllMocks()
  db.sync.mockResolvedValue(undefined)
  db.occurrences.mockReturnValue({ lean: async () => [occurrence] })
  db.customer.mockReturnValue({ lean: async () => ({ _id: 'customer', name: 'Offline fixture', status: 'active' }) })
  db.ledger.mockReturnValue({ lean: async () => [opening] })
  db.notification.mockResolvedValue({})
})
describe('persistent collection bell notifications offline', () => {
  it('uses shop-scoped deterministic deduplication on every refresh', async () => {
    await refreshCollectionNotifications('shop')
    await refreshCollectionNotifications('shop')
    expect(db.notification.mock.calls[0][0]).toEqual({ shop: 'shop', dedupeKey: 'KHATA_COLLECTION:shop:occurrence' })
    expect(db.notification.mock.calls[1][0]).toEqual(db.notification.mock.calls[0][0])
    expect(db.notification.mock.calls[0][1].$setOnInsert.entityId).toBe('customer')
    expect(db.notification.mock.calls[0][2]).toMatchObject({ upsert: true })
    expect(db.notification.mock.calls[0][2].setDefaultsOnInsert).toBe(false)
    expect(db.notification.mock.calls[0][1].$unset).toEqual({ expiresAt: 1 })
    expect(db.ledger).toHaveBeenCalledWith({ shop: 'shop', customer: 'customer' })
  })
  it('resolves a fully collected reminder and restores it following a void', async () => {
    db.ledger.mockReturnValue({ lean: async () => [opening, payment] })
    await refreshCollectionNotifications('shop')
    expect(db.notification.mock.calls[0][1].$set['meta.resolved']).toBe(true)
    db.ledger.mockReturnValue({ lean: async () => [opening, { ...payment, status: 'voided' }] })
    await refreshCollectionNotifications('shop')
    expect(db.notification.mock.calls[1][1].$set['meta.resolved']).toBe(false)
    expect(db.notification.mock.calls[1][0]).toEqual(db.notification.mock.calls[0][0])
  })
  it('keeps partial reminders pending and does not overwrite persisted read state', async () => {
    db.ledger.mockReturnValue({ lean: async () => [opening, { ...payment, amountPkr: 1000 }] })
    await refreshCollectionNotifications('shop')
    expect(db.notification.mock.calls[0][1].$set).toEqual({ 'meta.resolved': false, 'meta.status': 'partial' })
    expect(JSON.stringify(db.notification.mock.calls[0][1])).not.toContain('readAt')
  })
})

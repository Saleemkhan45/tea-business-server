import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ schedules: vi.fn(), occurrences: vi.fn(), notifications: vi.fn() }))
vi.mock('../models/CollectionSchedule.js', () => ({
  CollectionSchedule: { collection: { listIndexes: () => ({ toArray: db.schedules }) } },
  CollectionOccurrence: { collection: { listIndexes: () => ({ toArray: db.occurrences }) } },
}))
vi.mock('../models/Notification.js', () => ({
  Notification: { collection: { listIndexes: () => ({ toArray: db.notifications }) } },
}))

const uniqueNotification = { key: { dedupeKey: 1 }, unique: true }
const expiry = { key: { expiresAt: 1 }, expireAfterSeconds: 0 }
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  db.schedules.mockResolvedValue([{ name: 'collection_schedule_customer_unique', key: { shop: 1, customer: 1 }, unique: true }])
  db.occurrences.mockResolvedValue([{ name: 'collection_occurrence_unique', key: { shop: 1, schedule: 1, scheduledDate: 1 }, unique: true }])
  db.notifications.mockResolvedValue([uniqueNotification, expiry])
})

describe('collection deployment prerequisites without a database', () => {
  it('accepts complete unique indexes and persistent collection reminders', async () => {
    const { requireCollectionIndexes } = await import('./collectionReadiness.js')
    await expect(requireCollectionIndexes()).resolves.toBeUndefined()
  })
  it.each([
    [expiry],
    [{ ...uniqueNotification, unique: false }, expiry],
    [{ ...uniqueNotification, sparse: true }, expiry],
    [{ ...uniqueNotification, partialFilterExpression: { type: 'LOW_STOCK' } }, expiry],
    [uniqueNotification, expiry, { key: { createdAt: 1 }, expireAfterSeconds: 5184000 }],
  ])('fails closed for unsafe notification indexes: %j', async (...indexes) => {
    db.notifications.mockResolvedValue(indexes)
    const { requireCollectionIndexes } = await import('./collectionReadiness.js')
    await expect(requireCollectionIndexes()).rejects.toMatchObject({ statusCode: 503 })
  })
  it('allows a retry after an administrator completes index deployment', async () => {
    db.notifications.mockResolvedValueOnce([])
    const { requireCollectionIndexes } = await import('./collectionReadiness.js')
    await expect(requireCollectionIndexes()).rejects.toMatchObject({ statusCode: 503 })
    await expect(requireCollectionIndexes()).resolves.toBeUndefined()
  })
})

import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ settings: vi.fn(), device: vi.fn(), delivery: vi.fn(), receipt: vi.fn() }))
vi.mock('../models/ReminderDelivery.js', () => ({
  ReminderSettings: { collection: { listIndexes: () => ({ toArray: db.settings }) } },
  PushDevice: { collection: { listIndexes: () => ({ toArray: db.device }) } },
  ReminderDelivery: { collection: { listIndexes: () => ({ toArray: db.delivery }) } },
  ReminderReceipt: { collection: { listIndexes: () => ({ toArray: db.receipt }) } },
}))
import { requireReminderIndexes } from './readiness.js'
beforeEach(() => {
  db.settings.mockResolvedValue([{ name: 'reminder_settings_shop_unique', unique: true, key: { shop: 1 } }])
  db.device.mockResolvedValue([{ name: 'push_endpoint_unique', unique: true, key: { endpointHash: 1 } }])
  db.delivery.mockResolvedValue([{ name: 'reminder_delivery_unique', unique: true, key: { shop: 1, occurrence: 1, channel: 1, recipient: 1 } }])
  db.receipt.mockResolvedValue([{ name: 'reminder_receipt_unique', unique: true, key: { providerMessageId: 1, status: 1 } }])
})
it('requires every queue and receipt identity index before delivery configuration', async () => {
  await expect(requireReminderIndexes()).resolves.toBeUndefined()
  db.receipt.mockResolvedValue([])
  await expect(requireReminderIndexes()).rejects.toMatchObject({ statusCode: 503 })
})
it('rejects partial endpoint uniqueness that could allow cross-account duplicates', async () => {
  db.device.mockResolvedValue([{ name: 'push_endpoint_unique', unique: true, key: { endpointHash: 1 }, partialFilterExpression: { active: true } }])
  await expect(requireReminderIndexes()).rejects.toMatchObject({ statusCode: 503 })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ known: vi.fn(), delivery: vi.fn(), receipt: vi.fn(), rows: vi.fn() }))
vi.mock('../models/ReminderDelivery.js', () => ({
  ReminderDelivery: { exists: db.known, updateOne: db.delivery },
  ReminderReceipt: { updateOne: db.receipt, find: db.rows },
}))
import { persistReceipt, reconcileReceipts } from './receipts.js'
const row = { providerMessageId: 'offline-id', status: 'delivered', businessId: 'business', phoneId: 'sender' }
beforeEach(() => {
  vi.resetAllMocks(); db.receipt.mockResolvedValue({}); db.delivery.mockResolvedValue({})
  const query = { sort() { return this }, limit() { return this }, lean: async () => [row] }
  db.rows.mockReturnValue(query)
})
describe('signed receipt inbox reconciliation', () => {
  it('recovers a callback that arrived before provider acknowledgment persistence', async () => {
    db.known.mockResolvedValue(false)
    await persistReceipt(row)
    expect(db.delivery).not.toHaveBeenCalled()
    expect(db.receipt.mock.calls[0][1].$setOnInsert.processed).toBe(false)
    db.known.mockResolvedValue(true)
    await reconcileReceipts({ businessId: 'business', phoneId: 'sender' })
    expect(db.delivery.mock.calls[0][1].$set.status).toBe('delivered')
    expect(db.receipt.mock.calls.at(-1)[1]).toEqual({ $set: { processed: true } })
  })
  it('limits reconciliation to the verified sender account', async () => {
    await reconcileReceipts({ businessId: 'business', phoneId: 'sender' })
    expect(db.rows).toHaveBeenCalledWith({ businessId: 'business', phoneId: 'sender', processed: false })
  })
})

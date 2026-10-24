import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ sale: vi.fn(), purchase: vi.fn() }))
vi.mock('../models/Sale.js', () => ({ Sale: { find: mocks.sale } }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { find: mocks.purchase } }))
import { recordSearchQuery, searchRecords } from './globalSearchService.js'
let chain
beforeEach(() => {
  chain = { select: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maxTimeMS: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([]) }
  mocks.sale.mockReturnValue(chain); mocks.purchase.mockReturnValue(chain)
})
describe('bounded read-only record search', () => {
  it('validates input and bounds pagination', () => {
    for (const input of [{ search: 'a' }, { search: 'x'.repeat(101) }, { search: {} }, { search: 'tea', limit: 9 }, { search: 'tea', page: -1 }]) expect(recordSearchQuery.safeParse(input).success).toBe(false)
  })
  it.each(['sales', 'purchases'])('scopes %s to the authenticated shop and escapes regex', async kind => {
    await searchRecords(kind, 'shop-a', { search: 'a.*', page: 2, limit: 6 })
    const model = kind === 'sales' ? mocks.sale : mocks.purchase
    expect(model).toHaveBeenLastCalledWith(expect.objectContaining({ shop: 'shop-a', $or: expect.arrayContaining([expect.objectContaining({ businessDate: { $regex: 'a\\.\\*', $options: 'i' } })]) }))
    expect(chain.limit).toHaveBeenCalledWith(6); expect(chain.skip).toHaveBeenCalledWith(6)
    expect(chain.sort).toHaveBeenCalledWith({ businessDate: -1, _id: -1 })
    expect(chain.select.mock.calls[0][0]).not.toContain('notes')
  })
  it('returns actual projected records and payment labels', async () => {
    chain.lean.mockResolvedValue([{ _id: 'record', customerName: 'Customer', totalAmount: 500, amountPaid: 100, status: 'completed', businessDate: '2026-10-23' }])
    expect((await searchRecords('sales', 'shop-b', { search: 'Customer' })).results[0]).toMatchObject({ id: 'record', title: 'Customer', total: 500, status: 'Partial' })
  })
})

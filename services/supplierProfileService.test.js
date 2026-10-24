import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ find: vi.fn(), supplierAggregate: vi.fn(), purchaseAggregate: vi.fn() }))
vi.mock('../models/Supplier.js', () => ({ Supplier: { findOne: db.find, aggregate: db.supplierAggregate } }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { aggregate: db.purchaseAggregate } }))
import { profileQuery, statsStages, supplierHistory, supplierProfile } from './supplierProfileService.js'
const shop = '507f1f77bcf86cd799439001', supplierId = '507f1f77bcf86cd799439002'
beforeEach(() => {
  vi.clearAllMocks()
  db.find.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: async () => ({ _id: supplierId, name: 'Persisted supplier' }) })
  db.purchaseAggregate.mockReturnValue({ option: async () => [{ rows: [], total: [], selected: [], current: [], products: [], regions: [], trend: [] }] })
  db.supplierAggregate.mockReturnValue({ option: async () => [{ rows: [], total: [] }] })
})
describe('supplier profile bounded shop-scoped reads, offline query contracts', () => {
  it('separates selected period statistics from current lifetime payables', async () => {
    const result = await supplierProfile({ shop, supplierId, from: '2026-10-01', to: '2026-10-23' })
    const pipeline = db.purchaseAggregate.mock.calls[0][0]
    expect(String(pipeline[0].$match.shop)).toBe(shop)
    expect(String(pipeline[0].$match.supplier)).toBe(supplierId)
    expect(pipeline[1].$facet.selected[0]).toEqual({ $match: { businessDate: { $gte: '2026-10-01', $lte: '2026-10-23' } } })
    expect(JSON.stringify(pipeline[1].$facet.current)).not.toContain('2026-10-01')
    expect(statsStages()[0]).toEqual({ $match: { status: { $ne: 'voided' } } })
    expect(result.stats).toMatchObject({ count: 0, outstandingPkr: 0 })
  })
  it.each(['purchases', 'payments', 'movements', 'activity'])('paginates %s and returns no fabricated history', async tab => {
    expect(await supplierHistory({ shop, supplierId, tab, page: 2, limit: 10 })).toMatchObject({ rows: [], total: 0, page: 2, limit: 10 })
    const pipeline = (tab === 'activity' ? db.supplierAggregate : db.purchaseAggregate).mock.calls[0][0]
    expect(String(pipeline[0].$match.shop)).toBe(shop)
    expect(pipeline.at(-1).$facet.rows.slice(0, 2)).toEqual([{ $skip: 10 }, { $limit: 10 }])
    expect(pipeline.at(-1).$facet.total).toEqual([{ $count: 'count' }])
    if (tab === 'activity') expect(pipeline.at(-1).$facet.rows).toContainEqual({ $project: { key: 0, fingerprint: 0 } })
  })
  it('escapes invoice search, scopes receiving regions, and looks up only scoped purchase movements', async () => {
    await supplierHistory({ shop, supplierId, tab: 'movements', search: 'a.*', region: supplierId, status: 'received' })
    const pipeline = db.purchaseAggregate.mock.calls[0][0]
    expect(pipeline[0].$match.$or[0]).toEqual({ reference: { $regex: 'a\\.\\*', $options: 'i' } })
    expect(String(pipeline[0].$match.receivingRegion)).toBe(supplierId)
    const join = pipeline.find(stage => stage.$lookup).$lookup
    expect(String(join.pipeline[0].$match.shop)).toBe(shop)
    expect(join.pipeline[0].$match.type).toEqual({ $in: ['purchase_receipt', 'purchase_reversal'] })
  })
  it('validates input before database reads and rejects foreign suppliers', async () => {
    for (const value of [{ limit: 31 }, { page: 0 }, { search: 'x'.repeat(161) }, { tab: 'secret' }, { from: '2026-10-23', to: '2026-10-01' }, { shop: 'forged' }]) expect(profileQuery.safeParse(value).success).toBe(false)
    db.find.mockReturnValue({ select: vi.fn().mockReturnThis(), lean: async () => null })
    await expect(supplierHistory({ shop, supplierId, tab: 'purchases' })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.purchaseAggregate).not.toHaveBeenCalled()
  })
  it('bounds real analytics groups and handles a supplier without purchases', async () => {
    expect(await supplierHistory({ shop, supplierId, tab: 'analytics' })).toEqual({ products: [], regions: [], trend: [] })
    const facet = db.purchaseAggregate.mock.calls[0][0].at(-1).$facet
    for (const stages of Object.values(facet)) expect(stages).toContainEqual({ $limit: 30 })
  })
})

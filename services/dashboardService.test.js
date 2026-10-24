import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ sales: vi.fn(), ledger: vi.fn(), inventory: vi.fn() }))
vi.mock('../models/Sale.js', () => ({ Sale: { aggregate: db.sales }, SALE_IDEMPOTENCY_KEY_MAX_LENGTH: 128 }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { aggregate: db.ledger, collection: { name: 'customerledgertransactions' } } }))
vi.mock('./dashboardStockService.js', () => ({ dashboardStockKg: (...args) => db.inventory(...args) }))
import { dashboardMatch, fillDailyBuckets, getDashboard } from './dashboardService.js'
const shop = '507f1f77bcf86cd799439001', region = '507f1f77bcf86cd799439002'
const query = { shop, from: '2026-10-17', to: '2026-10-18' }
let sales, pipeline, ledgerPipeline
// Offline fixture executor for the actual sale facet expressions; not a MongoDB engine.
function expr(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)]
  if (Array.isArray(value)) return value.map(v => expr(v, row))
  if (!value || typeof value !== 'object') return value
  if (value.$ifNull) return expr(value.$ifNull[0], row) ?? expr(value.$ifNull[1], row)
  if (value.$cond) return expr(value.$cond[0], row) ? expr(value.$cond[1], row) : expr(value.$cond[2], row)
  if (value.$in) return expr(value.$in[1], row).includes(expr(value.$in[0], row))
  if (value.$multiply) return expr(value.$multiply[0], row) * expr(value.$multiply[1], row)
  if (value.$eq) return expr(value.$eq[0], row) === expr(value.$eq[1], row)
  throw new Error('Unsupported expression')
}
function run(stages, rows) {
  for (const stage of stages) {
    if (stage.$match) rows = rows.filter(row => Object.entries(stage.$match).every(([key, value]) => {
      if (value.$gt !== undefined) return row[key] > value.$gt
      if (value.$in) return value.$in.includes(row[key])
      if (value.$gte) return row[key] >= value.$gte && row[key] <= value.$lte
      return String(row[key]) === String(value)
    }))
    else if (stage.$facet) return [Object.fromEntries(Object.entries(stage.$facet).map(([key, steps]) => [key, run(steps, [...rows])]))]
    else if (stage.$group) {
      const groups = new Map()
      for (const row of rows) {
        const key = expr(stage.$group._id, row), group = groups.get(key) ?? { _id: key }
        for (const [field, accumulator] of Object.entries(stage.$group)) if (field !== '_id') group[field] = (group[field] ?? 0) + expr(accumulator.$sum, row)
        groups.set(key, group)
      }
      rows = [...groups.values()]
    } else if (stage.$sort) rows.sort((a, b) => { for (const [key, direction] of Object.entries(stage.$sort)) { if (a[key] !== b[key]) return a[key] < b[key] ? -direction : direction }; return 0 })
    else if (stage.$limit) rows = rows.slice(0, stage.$limit)
    else if (stage.$project) rows = rows.map(row => Object.fromEntries(['_id', ...Object.keys(stage.$project)].filter(key => key in row).map(key => [key, row[key]])))
    else throw new Error('Unsupported stage')
  }
  return rows
}
const sale = (patch = {}) => ({ _id: 'sale', shop, businessDate: '2026-10-18', totalAmount: 100, sellingRegion: region, status: 'completed', paymentMethod: 'cash', teaType: 'green', ...patch })
beforeEach(() => {
  vi.clearAllMocks(); sales = []
  db.sales.mockImplementation(stages => { pipeline = stages; return Promise.resolve(run(stages, sales)) })
  db.ledger.mockImplementation(stages => { ledgerPipeline = stages; return Promise.resolve([{ balances: [], payments: [] }]) })
  db.inventory.mockResolvedValue(0)
})
describe('dashboard read aggregation offline', () => {
  it('counts saved sales and sums value with rounded average; pending is a qualifying sale', async () => {
    sales = [sale(), sale({ totalAmount: 201, paymentMethod: 'credit', status: 'pending' })]
    const result = await getDashboard(query)
    expect(result.metrics).toEqual({ orders: 2, salesPkr: 301, averageOrderPkr: 150.5, stockKg: 0, creditSalesPkr: 201 })
    expect(result.categories).toEqual([{ label: 'green', orders: 2, percent: 100 }])
    expect(result.daily).toEqual([{ date: '2026-10-17', salesPkr: 0 }, { date: '2026-10-18', salesPkr: 301 }])
  })
  it('empty periods return zero rather than demonstrations', async () => {
    expect((await getDashboard(query)).metrics).toEqual({ orders: 0, salesPkr: 0, averageOrderPkr: 0, stockKg: 0, creditSalesPkr: 0 })
  })
  it('isolates shop, region, inclusive date limits and voided sales', async () => {
    sales = [sale(), sale({ businessDate: '2026-10-17' }), sale({ shop: region }), sale({ sellingRegion: shop }), sale({ status: 'voided' }), sale({ businessDate: '2026-10-16' }), sale({ businessDate: '2026-10-19' })]
    expect((await getDashboard({ ...query, regionId: region })).metrics.orders).toBe(2)
    expect(String(pipeline[0].$match.shop)).toBe(shop)
    expect((await getDashboard(query)).metrics.orders).toBe(3)
  })
  it('sums current stock once per authoritative assignment, excludes inactive stock and ignores period', async () => {
    db.inventory.mockImplementation(async (_shop, selected) => selected ? .5 : 68)
    expect((await getDashboard(query)).metrics.stockKg).toBe(68)
    expect((await getDashboard({ ...query, regionId: region })).metrics.stockKg).toBe(.5)
    expect(db.inventory).toHaveBeenCalledWith(shop, undefined)
  })
  it('keeps ledger receipts and opening balances out of sales and maps current shop-wide balances', async () => {
    db.ledger.mockImplementation(stages => {
      ledgerPipeline = stages
      return Promise.resolve([{ balances: [{ outstandingPkr: 900, customers: 2 }], payments: [{ paymentsTodayPkr: 50 }] }])
    })
    const result = await getDashboard({ ...query, regionId: region }, { now: new Date('2026-10-17T21:00:00Z') })
    expect(result.metrics.salesPkr).toBe(0)
    expect(result.khata).toEqual({ outstandingPkr: 900, customers: 2, paymentsTodayPkr: 50, today: '2026-10-18' })
    expect(ledgerPipeline[0].$match).toEqual({ shop: dashboardMatch(shop, query).shop, status: 'active' })
    const facets = ledgerPipeline[1].$facet
    expect(facets.balances[0].$group.balance.$sum.$cond[0]).toEqual({ $in: ['$type', ['payment', 'return']] })
    expect(facets.payments[0].$match).toEqual({ type: 'payment', businessDate: '2026-10-18' })
    expect(facets.payments[2]).toEqual({ $match: { 'reversals.0': { $exists: false } } })
  })
  it('calculates per-customer positive outstanding using signed ledger impacts', async () => {
    const entries = [
      { shop, customer: 'a', status: 'active', type: 'opening_balance', amountPkr: 1000 },
      { shop, customer: 'a', status: 'active', type: 'purchase', amountPkr: 500 },
      { shop, customer: 'a', status: 'active', type: 'payment', amountPkr: 200 },
      { shop, customer: 'a', status: 'active', type: 'return', amountPkr: 100 },
      { shop, customer: 'a', status: 'active', type: 'adjustment', amountPkr: -50 },
      { shop, customer: 'a', status: 'voided', type: 'purchase', amountPkr: 9999 },
      { shop: region, customer: 'a', status: 'active', type: 'purchase', amountPkr: 9999 },
      { shop, customer: 'b', status: 'active', type: 'adjustment', amountPkr: -100 },
      { shop, customer: 'c', status: 'active', type: 'purchase', amountPkr: 400 },
    ]
    db.ledger.mockImplementation(stages => [{ balances: run([stages[0], ...stages[1].$facet.balances], entries), payments: [] }])
    const result = await getDashboard(query)
    expect(result.khata.outstandingPkr).toBe(1550)
    expect(result.khata.customers).toBe(2)
  })
  it('bounds recent sales and orders deterministically', async () => {
    sales = Array.from({ length: 12 }, (_, i) => sale({ _id: String(i), createdAt: i }))
    expect((await getDashboard(query)).recentSales.map(row => row._id)).toEqual(['11', '10', '9', '8', '7', '6', '5', '4', '3', '2'])
  })
  it.each([{ shop: 'bad' }, { regionId: 'bad' }, { from: '2026-02-30' }, { from: '2026-10-19' }, { from: '2000-01-01' }, { injected: true }])('rejects invalid scope before DB reads: %o', async patch => {
    await expect(getDashboard({ ...query, ...patch })).rejects.toThrow()
    expect(db.sales).not.toHaveBeenCalled()
  })
  it('propagates failures rather than returning invented zeros', async () => {
    db.sales.mockRejectedValue(new Error('offline error'))
    await expect(getDashboard(query)).rejects.toThrow('offline error')
  })
  it('fills leap-day business dates without hourly invention', () => {
    expect(fillDailyBuckets('2024-02-28', '2024-03-01', []).map(row => row.date)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01'])
  })
})




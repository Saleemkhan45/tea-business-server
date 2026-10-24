import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ aggregate: vi.fn(), items: vi.fn() }))
vi.mock('../models/Sale.js', () => ({ Sale: { aggregate: db.aggregate }, SALE_IDEMPOTENCY_KEY_MAX_LENGTH: 128 }))
vi.mock('../models/Item.js', () => ({ Item: { find: db.items } }))
import { getTopSellingProducts } from './topProductsService.js'
import { topProductsQuerySchema } from '../schemas/salesSchemas.js'
const oid = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'))
const shop = oid(1), otherShop = oid(2), region = oid(3), otherRegion = oid(4), a = oid(10), b = oid(11)
let sales, catalog, pipeline
const same = (a, b) => a == null || b == null ? a == null && b == null : String(a) === String(b)
// Small offline pipeline interpreter: exercises the actual generated stages against
// fixtures. This is not a MongoDB query-engine or live index/aggregation test.
function expression(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)]
  if (Array.isArray(value)) return value.map(entry => expression(entry, row))
  if (value == null || typeof value !== 'object' || value instanceof mongoose.Types.ObjectId) return value
  const [op, args] = Object.entries(value)[0]
  const v = x => expression(x, row)
  switch (op) {
    case '$ifNull': return v(args[0]) ?? v(args[1])
    case '$eq': return same(v(args[0]), v(args[1]))
    case '$cond': return v(args[0]) ? v(args[1]) : v(args[2])
    case '$convert': { const input = v(args.input); return /^[a-f0-9]{24}$/i.test(String(input)) ? new mongoose.Types.ObjectId(String(input)) : null }
    case '$type': return typeof v(args)
    case '$trim': return v(args.input).trim()
    case '$round': return Math.round(v(args[0]))
    case '$multiply': return v(args[0]) * v(args[1])
    case '$divide': return v(args[0]) / v(args[1])
    case '$subtract': return v(args[0]) - v(args[1])
    case '$abs': return Math.abs(v(args))
    case '$lt': return v(args[0]) < v(args[1])
    default: throw new Error(`Unimplemented fixture expression ${op}`)
  }
}
function matches(row, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$expr') return expression(condition, row)
    if (condition instanceof mongoose.Types.ObjectId) return same(row[field], condition)
    if (condition && typeof condition === 'object') return Object.entries(condition).every(([op, value]) => {
      const actual = row[field]
      switch (op) {
        case '$type': return typeof actual === value
        case '$gt': return actual > value
        case '$gte': return actual >= value
        case '$lte': return actual <= value
        case '$ne': return !same(actual, value)
        case '$in': return value.some(entry => same(entry, actual))
        default: throw new Error(`Unimplemented fixture match ${op}`)
      }
    })
    return same(row[field], condition)
  })
}
function execute(stages) {
  let rows = sales.slice()
  for (const stage of stages) {
    if (stage.$match) rows = rows.filter(row => matches(row, stage.$match))
    else if (stage.$sort) rows.sort((a, b) => { for (const [key, direction] of Object.entries(stage.$sort)) { if (!same(a[key], b[key])) return (a[key] < b[key] ? -1 : 1) * direction }; return 0 })
    else if (stage.$project) rows = rows.map(row => Object.fromEntries(Object.entries(stage.$project).map(([key, value]) => [key, value === 1 ? row[key] : expression(value, row)])))
    else if (stage.$group) {
      const grouped = new Map()
      for (const row of rows) {
        const id = expression(stage.$group._id, row), key = String(id)
        if (!grouped.has(key)) grouped.set(key, { _id: id })
        const group = grouped.get(key)
        for (const [field, acc] of Object.entries(stage.$group).filter(([key]) => key !== '_id')) {
          if (acc.$sum) group[field] = (group[field] ?? 0) + expression(acc.$sum, row)
          else if (acc.$first && !(field in group)) group[field] = expression(acc.$first, row)
        }
      }
      rows = [...grouped.values()]
    } else if (stage.$limit) rows = rows.slice(0, stage.$limit)
    else throw new Error('Unexpected aggregation stage')
  }
  return rows
}
const sale = (patch = {}) => ({ _id: oid(100), shop, sellingRegion: region, product: a, productName: 'Snapshot Tea', quantityKg: .125, businessDate: '2026-10-16', createdAt: '2026-10-16T09:00:00Z', status: 'completed', ...patch })
const query = { shop: String(shop), from: '2026-10-16', to: '2026-10-16' }
beforeEach(() => {
  vi.clearAllMocks(); sales = []; catalog = []
  db.aggregate.mockImplementation(stages => { pipeline = stages; return { allowDiskUse: async () => execute(stages) } })
  db.items.mockImplementation(filter => ({ select: () => ({ lean: async () => catalog.filter(item => same(item.shop, filter.shop) && filter._id.$in.some(id => same(id, item._id))) }) }))
})
describe('top products aggregation (offline fixture interpreter)', () => {
  it('ranks by summed grams with stable product-ID ties and a five-product bound', async () => {
    sales = [sale(), sale({ _id: oid(101), quantityKg: .375 }), sale({ _id: oid(102), product: b, quantityKg: .5 }), ...Array.from({ length: 6 }, (_, i) => sale({ _id: oid(110 + i), product: oid(20 + i), quantityKg: .01 }))]
    const result = await getTopSellingProducts(query)
    expect(result.products).toHaveLength(5)
    expect(result.products.slice(0, 2)).toEqual([{ productId: String(a), name: 'Snapshot Tea', quantityKg: .5 }, { productId: String(b), name: 'Snapshot Tea', quantityKg: .5 }])
    expect(pipeline[0].$match.shop).toBeInstanceOf(mongoose.Types.ObjectId)
    expect(pipeline.at(-1)).toEqual({ $limit: 5 })
  })
  it('filters shop, inclusive business dates, selling region and cancellations before grouping', async () => {
    sales = [sale(), sale({ shop: otherShop, quantityKg: 99 }), sale({ businessDate: '2026-10-15', quantityKg: 1 }), sale({ sellingRegion: otherRegion, quantityKg: 2 }), sale({ status: 'voided', quantityKg: 999 }), sale({ status: 'pending', quantityKg: .125 })]
    expect((await getTopSellingProducts({ ...query, regionId: String(region) })).products[0].quantityKg).toBe(.25)
    expect((await getTopSellingProducts({ ...query, from: '2026-10-10' })).products[0].quantityKg).toBe(3.25)
    expect((await getTopSellingProducts({ ...query, shop: String(otherShop) })).products[0].quantityKg).toBe(99)
  })
  it('defaults to Karachi today across the UTC date boundary', async () => {
    const result = await getTopSellingProducts({ shop: String(shop) }, { now: new Date('2026-10-15T19:01:00Z') })
    expect(result.from).toBe('2026-10-16'); expect(result.to).toBe('2026-10-16')
  })
  it('excludes missing, zero, negative, invalid and sub-gram quantities without demo fallback', async () => {
    sales = [0, -1, undefined, '3', Infinity, .0001, .0015].map(quantityKg => sale({ quantityKg }))
    expect((await getTopSellingProducts(query)).products).toEqual([])
    expect(db.items).not.toHaveBeenCalled()
  })
  it('groups duplicate names by canonical IDs and uses the latest historical name snapshot', async () => {
    sales = [sale({ productName: 'Old name', businessDate: '2026-10-15' }), sale({ productName: 'Latest name' }), sale({ product: b, productName: 'Latest name' })]
    const result = await getTopSellingProducts({ ...query, from: '2026-10-15' })
    expect(result.products.map(row => row.productId)).toEqual([String(a), String(b)])
    expect(result.products.map(row => row.name)).toEqual(['Latest name', 'Latest name'])
    expect(db.items).not.toHaveBeenCalled()
  })
  it('supports legacy Item IDs without mistaking regional stock IDs for product identity', async () => {
    sales = [sale({ product: undefined, sellingRegion: undefined, stockLocationId: String(a) }), sale({ product: undefined, stockLocationId: String(b), quantityKg: 99 })]
    expect((await getTopSellingProducts(query)).products.map(row => row.productId)).toEqual([String(a)])
  })
  it('does not sum edit history or stock movement reversals as extra sale lines', async () => {
    sales = [sale({ inventoryMovements: [{ quantityKg: 500 }], editHistory: [{ quantityKg: 999 }] })]
    expect((await getTopSellingProducts(query)).products[0].quantityKg).toBe(.125)
    expect(pipeline.some(stage => stage.$lookup || stage.$unwind || stage.$merge || stage.$out)).toBe(false)
  })
  it('falls back to a same-shop Item name only when the snapshot is missing', async () => {
    sales = [sale({ productName: ' ' })]
    catalog = [{ _id: a, shop: otherShop, name: 'Other shop name' }, { _id: a, shop, name: 'Catalog name' }]
    expect((await getTopSellingProducts(query)).products[0].name).toBe('Catalog name')
    expect(db.items.mock.calls[0][0].shop).toEqual(shop)
    catalog = [{ _id: a, shop, name: '   ' }]; expect((await getTopSellingProducts(query)).products[0].name).toBe('Historical product')
    catalog = []; expect((await getTopSellingProducts(query)).products[0].name).toBe('Historical product')
  })
  it.each([{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-16' }, { from: '2026-10-17', to: '2026-10-16' }, { regionId: 'not-an-id' }, { shop: 'forged' }])('rejects invalid or injected report filters %j', filters => {
    expect(topProductsQuerySchema.safeParse(filters).success).toBe(false)
  })
  it('rejects an invalid tenant before making any database call', async () => {
    await expect(getTopSellingProducts({ shop: 'bad' })).rejects.toThrow('Shop must be a valid ID')
    expect(db.aggregate).not.toHaveBeenCalled()
  })
})

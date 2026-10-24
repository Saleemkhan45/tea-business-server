import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ sales: vi.fn(), purchases: vi.fn(), ledger: vi.fn(), users: vi.fn(), operations: vi.fn(), regions: vi.fn(), region: vi.fn(), inventory: vi.fn(), aggregate: vi.fn() }))
vi.mock('../models/Sale.js', () => ({ Sale: { find: db.sales, aggregate: db.aggregate } }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { find: db.purchases } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { find: db.ledger } }))
vi.mock('../models/User.js', () => ({ User: { find: db.users } }))
vi.mock('../models/Region.js', () => ({ Region: { find: db.regions } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { find: db.operations } }))
vi.mock('./regionalInventoryService.js', () => ({ getRegion: db.region, listInventory: db.inventory, objectId: value => value }))
import { regionReport, regionalOverview, regionalSalesPipeline, summarizeRegionalSales } from './regionalReportService.js'

const shop = '507f1f77bcf86cd799439001', regionId = '507f1f77bcf86cd799439002', other = '507f1f77bcf86cd799439003', item = '507f1f77bcf86cd799439004', actor = '507f1f77bcf86cd799439005'
let sales, ledger, operations
function query(value) { return { select() { return this }, sort() { return this }, lean: async () => structuredClone(value) } }
beforeEach(() => {
  vi.clearAllMocks()
  sales = [
    { _id: 's1', shop, sellingRegion: regionId, businessDate: '2026-10-15', product: item, productName: 'Green Tea', customer: 'customer', quantityKg: 2, totalAmount: 1000, paymentMethod: 'credit', status: 'completed', createdBy: actor, salespersonName: 'Ali', ledgerRecorded: true, inventoryMovements: [] },
    { _id: 'void', shop, sellingRegion: regionId, businessDate: '2026-10-15', quantityKg: 9, totalAmount: 9000, paymentMethod: 'cash', status: 'voided', createdBy: actor, inventoryMovements: [] },
    { _id: 'other', shop, sellingRegion: other, businessDate: '2026-10-15', quantityKg: 5, totalAmount: 5000, paymentMethod: 'cash', status: 'completed', inventoryMovements: [] },
    { _id: 'foreign', shop: other, sellingRegion: regionId, businessDate: '2026-10-15', quantityKg: 100, totalAmount: 100000, status: 'completed', inventoryMovements: [] },
  ]
  ledger = [{ shop, saleId: 's1', type: 'purchase', amountPkr: 1000, status: 'active' }, { shop, saleId: 's1', type: 'payment', amountPkr: 300, status: 'active' }, { shop, saleId: 's1', type: 'return', amountPkr: 100, status: 'active' }, { shop, type: 'opening_balance', amountPkr: 99999, status: 'active' }, { shop, type: 'payment', amountPkr: 88888, status: 'active' }, { shop, saleId: 's1', type: 'payment', amountPkr: 77777, status: 'voided' }, { shop: other, saleId: 's1', type: 'payment', amountPkr: 66666, status: 'active' }]
  operations = [
    { _id: 'transfer', shop, region: regionId, destination: other, item, type: 'transfer', quantityGrams: 1000, createdAt: '2026-10-14T19:00:00.000Z', createdBy: actor, reason: 'Dispatch', balances: [{ region: regionId, beforeGrams: 5000, afterGrams: 4000 }, { region: other, beforeGrams: 0, afterGrams: 1000 }] },
    { _id: 'before', shop, region: regionId, item, type: 'receipt', createdAt: '2026-10-14T18:59:59.999Z', balances: [{ region: regionId, beforeGrams: 0, afterGrams: 5000 }] },
  ]
  db.region.mockImplementation(async (scope, requested) => { if (scope !== shop || ![regionId, other].includes(requested)) throw new Error('Region not found'); return { _id: requested, name: 'Islamabad', status: 'inactive' } })
  db.regions.mockReturnValue(query([{ _id: regionId, name: 'Islamabad' }, { _id: other, name: 'Peshawar' }]))
  db.inventory.mockResolvedValue([{ id: 'stock1', regionId, itemId: item, name: 'Green Tea', availableKg: 4, status: 'inactive', lowStockThreshold: 1 }, { id: 'stock2', regionId: other, itemId: item, name: 'Green Tea', availableKg: 1, status: 'available', lowStockThreshold: 1 }])
  db.sales.mockImplementation(filter => query(sales.filter(sale => sale.shop === filter.shop && (!filter.sellingRegion || typeof filter.sellingRegion !== 'string' || sale.sellingRegion === filter.sellingRegion) && (!filter.businessDate?.$gte || sale.businessDate >= filter.businessDate.$gte) && (!filter.businessDate?.$lte || sale.businessDate <= filter.businessDate.$lte) && (!filter.product || sale.product === filter.product))))
  db.aggregate.mockImplementation(pipeline => {
    const match=pipeline[0].$match, selected=sales.filter(sale=>sale.shop===String(match.shop) && sale.sellingRegion!==undefined && sale.status!=='voided' && (!match.businessDate?.$gte || sale.businessDate>=match.businessDate.$gte) && (!match.businessDate?.$lte || sale.businessDate<=match.businessDate.$lte))
    function value(expression,row){
      if(typeof expression==='string'&&expression.startsWith('$'))return row[expression.slice(1)]
      if(!expression||typeof expression!=='object')return expression
      if(expression.$ifNull)return value(expression.$ifNull[0],row)??value(expression.$ifNull[1],row)
      if(expression.$cond)return value(expression.$cond[0],row)?value(expression.$cond[1],row):value(expression.$cond[2],row)
      if(expression.$eq)return value(expression.$eq[0],row)===value(expression.$eq[1],row)
      if(expression.$floor)return Math.floor(value(expression.$floor,row))
      if(expression.$add)return expression.$add.reduce((sum,item)=>sum+value(item,row),0)
      if(expression.$multiply)return expression.$multiply.reduce((sum,item)=>sum*value(item,row),1)
      throw new Error('Unsupported fixture expression')
    }
    const groups=new Map(),group=pipeline[1].$group
    for(const row of selected){const key=value(group._id,row),total=groups.get(key)??{_id:key};for(const [field,expr]of Object.entries(group))if(field!=='_id')total[field]=(total[field]??0)+value(expr.$sum,row);groups.set(key,total)}
    const result=[...groups.values()]
    return {option(settings){expect(settings.maxTimeMS).toBe(10000);return Promise.resolve(result)}}
  })
  db.purchases.mockReturnValue(query([{ _id: 'purchase1', status: 'received', quantityKg: 3, payments: [{ amountPkr: 100 }] }, { _id: 'pending', status: 'pending', quantityKg: 100 }, { _id: 'reversed', status: 'voided', quantityKg: 200 }]))
  db.operations.mockReturnValue(query(operations))
  db.ledger.mockImplementation(filter => query(ledger.filter(row => row.shop === filter.shop && row.status === filter.status && filter.saleId.$in.includes(row.saleId))))
  db.users.mockReturnValue(query([{ _id: actor, name: 'Admin' }]))
})
describe('region reports (offline)', () => {
  it('uses effective regional thresholds and does not invent an alert when a threshold is missing', async () => {
    db.inventory.mockResolvedValue([
      { regionId, itemId: item, availableKg: 75, status: 'available', lowStockThreshold: 50 },
      { regionId, itemId: other, availableKg: 0, status: 'out_of_stock', lowStockThreshold: null },
      { regionId: other, itemId: item, availableKg: 75, status: 'available', lowStockThreshold: 100 },
    ])
    const overview = await regionalOverview({ shop })
    expect(overview.regions.map(row => row.lowStockProducts)).toEqual([0, 1])
    const report = await regionReport({ shop, regionId })
    expect(report.summary.lowStockProducts).toBe(0)
  })
  it('derives exact selected-region sales without opening balances, standalone payments, cancellations or other shops', async () => {
    const result = await regionReport({ shop, regionId, from: '2026-10-15', to: '2026-10-15' })
    expect(result.summary).toMatchObject({ orders: 1, quantityKg: 2, salesPkr: 1000, creditSalesPkr: 1000, cashSalesPkr: 0, paymentsPkr: 300, purchasedKg: 3, stockKg: 4, outstandingKhataPkr: null })
    expect(result.sales.find(row => row._id === 's1')).toMatchObject({ saleLinkedDuePkr: 600, recordedByName: 'Admin', salespersonName: 'Ali' })
    expect(result.sales).toHaveLength(2)
    expect(result.products[0]).toMatchObject({ name: 'Green Tea', quantityKg: 2 })
    expect(result.salespeople[0].name).toBe('Ali')
    expect(db.purchases).toHaveBeenCalledWith(expect.objectContaining({ shop, receivingRegion: regionId, businessDate: { $gte: '2026-10-15', $lte: '2026-10-15' } }))
  })
  it('keeps inactive-region history readable and filters movement timestamps at Pakistan midnight', async () => {
    const result = await regionReport({ shop, regionId, from: '2026-10-15', to: '2026-10-15' })
    expect(result.region.status).toBe('inactive')
    expect(result.movements).toHaveLength(1)
    expect(result.movements[0]).toMatchObject({ type: 'transfer_out', quantityChangeKg: -1, balanceAfterKg: 4, reference: 'transfer', performedBy: 'Admin' })
  })
  it('shows the linked destination entry under the same transfer reference', async () => {
    const result = await regionReport({ shop, regionId: other })
    expect(result.movements[0]).toMatchObject({ type: 'transfer_in', quantityChangeKg: 1, reference: 'transfer' })
  })
  it('uses a recorded transfer business date and retains sale cancellation movements', async () => {
    operations[0].businessDate = '2026-10-01'
    db.operations.mockReturnValue(query(operations))
    sales[1].inventoryMovements = [{ region: regionId, item, type: 'sale_restore', stockBeforeKg: 1, stockAfterKg: 10, createdAt: '2026-10-01T07:00:00.000Z', createdBy: actor }]
    const result = await regionReport({ shop, regionId, from: '2026-10-01', to: '2026-10-01' })
    expect(result.movements.map(row => row.type).sort()).toEqual(['sale_restore', 'transfer_out'])
    expect(result.summary.orders).toBe(0)
  })
  it('reports empty ranges and rejects invalid dates before querying business records', async () => {
    const result = await regionReport({ shop, regionId, from: '2026-11-01', to: '2026-11-30' })
    expect(result.summary.orders).toBe(0)
    db.sales.mockClear()
    await expect(regionReport({ shop, regionId, from: '2026-10-20', to: '2026-10-01' })).rejects.toThrow()
    expect(db.sales).not.toHaveBeenCalled()
  })
  it('scopes overview sales and stock without counting voided or foreign records', async () => {
    const result = await regionalOverview({ shop })
    expect(result.regions[0]).toMatchObject({ stockKg: 0, salesPkr: 1000, quantityKg: 2 })
    expect(result.regions[1]).toMatchObject({ stockKg: 1, salesPkr: 5000, quantityKg: 5 })
    expect(db.regions).toHaveBeenCalledWith({ shop })
  })
  it('uses the same summary formulas in aggregation, including fractional kg and missing optional fields', async () => {
    sales=[{shop,sellingRegion:regionId,businessDate:'2026-10-15',status:'completed',quantityKg:.001,totalAmount:10,paymentMethod:'credit',recordedPaidPkr:3},{shop,sellingRegion:regionId,businessDate:'2026-10-15',status:'pending',quantityKg:.002,totalAmount:20,paymentMethod:'cash'}, {shop,sellingRegion:regionId,businessDate:'2026-10-15',status:'voided',quantityKg:999,totalAmount:999}]
    const result=await regionalOverview({shop,from:'2026-10-15',to:'2026-10-15'})
    expect(result.regions[0]).toMatchObject(summarizeRegionalSales(sales))
    const pipeline=regionalSalesPipeline(shop,'2026-10-15','2026-10-15')
    expect(String(pipeline[0].$match.shop)).toBe(shop)
    expect(pipeline[0].$match.status).toEqual({$ne:'voided'})
    expect(pipeline[0].$match.businessDate).toEqual({$gte:'2026-10-15',$lte:'2026-10-15'})
  })
  it('sums gram precision without including cancelled sales', () => {
    expect(summarizeRegionalSales([{ status: 'completed', quantityKg: 0.001, totalAmount: 1, recordedPaidPkr: 1 }, { status: 'completed', quantityKg: 0.002, totalAmount: 2, recordedPaidPkr: 2 }, { status: 'voided', quantityKg: 10, totalAmount: 10000 }])).toMatchObject({ quantityKg: 0.003, salesPkr: 3, paymentsPkr: 3 })
  })
})



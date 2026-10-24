import { Region } from '../models/Region.js'
import { Sale } from '../models/Sale.js'
import { Purchase } from '../models/Purchase.js'
import { User } from '../models/User.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { RegionalStockOperation } from '../models/RegionalStockOperation.js'
import { getRegion, listInventory, objectId } from './regionalInventoryService.js'
import { regionReportQuerySchema } from '../schemas/regionalSchemas.js'
import { getBusinessDate } from '../utils/businessDay.js'
import mongoose from 'mongoose'

const id = value => String(value ?? '')
export function summarizeRegionalSales(sales) {
  const active = sales.filter(sale => sale.status !== 'voided')
  return active.reduce((result, sale) => ({
    orders: result.orders + 1,
    quantityKg: (Math.round(result.quantityKg * 1000) + Math.round((sale.quantityKg ?? 0) * 1000)) / 1000,
    salesPkr: result.salesPkr + sale.totalAmount,
    cashSalesPkr: result.cashSalesPkr + (sale.paymentMethod === 'credit' ? 0 : sale.totalAmount),
    creditSalesPkr: result.creditSalesPkr + (sale.paymentMethod === 'credit' ? sale.totalAmount : 0),
    paymentsPkr: result.paymentsPkr + (sale.recordedPaidPkr ?? 0),
  }), { orders: 0, quantityKg: 0, salesPkr: 0, cashSalesPkr: 0, creditSalesPkr: 0, paymentsPkr: 0 })
}
function dateFilter(from, to) { return from || to ? { businessDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {} }
function withinMovementPeriod(value, from, to, businessDate) {
  const date = businessDate || getBusinessDate(new Date(value))
  return (!from || date >= from) && (!to || date <= to)
}
function groupSales(sales, key) {
  const groups = new Map()
  for (const sale of sales.filter(row => row.status !== 'voided')) {
    const label = key(sale)
    const rows = groups.get(label) ?? []; rows.push(sale); groups.set(label, rows)
  }
  return [...groups].map(([name, rows]) => ({ name, ...summarizeRegionalSales(rows) })).sort((a, b) => a.name.localeCompare(b.name))
}
export async function regionalOverview({ shop, from, to }) {
  regionReportQuerySchema.parse({ from, to })
  const [regions, inventory, sales] = await Promise.all([
    Region.find({ shop }).sort({ name: 1 }).lean(), listInventory({ shop }),
    Sale.aggregate(regionalSalesPipeline(shop, from, to)).option({ maxTimeMS: 10_000 }),
  ])
  const salesByRegion = new Map(sales.map(row => [id(row._id), row]))
  const rows = regions.map(region => {
    const stock = inventory.filter(row => row.regionId === id(region._id) && row.status !== 'inactive')
    return { ...region, stockKg: stock.reduce((sum, row) => sum + Math.round(row.availableKg * 1000), 0) / 1000,
      lowStockProducts: stock.filter(row => row.status !== 'inactive' && row.lowStockThreshold != null && row.availableKg <= row.lowStockThreshold).length,
      ...Object.fromEntries(['orders', 'salesPkr', 'cashSalesPkr', 'creditSalesPkr', 'paymentsPkr'].map(key => [key, salesByRegion.get(id(region._id))?.[key] ?? 0])),
      quantityKg: (salesByRegion.get(id(region._id))?.quantityGrams ?? 0) / 1000,
    }
  })
  return { regions: rows }
}
export function regionalSalesPipeline(shop, from, to) {
  return [
    { $match: { shop: new mongoose.Types.ObjectId(objectId(shop, 'Shop')), sellingRegion: { $exists: true }, status: { $ne: 'voided' }, ...dateFilter(from, to) } },
    { $group: {
      _id: '$sellingRegion', orders: { $sum: 1 },
      quantityGrams: { $sum: { $floor: { $add: [{ $multiply: [{ $ifNull: ['$quantityKg', 0] }, 1000] }, 0.5] } } },
      salesPkr: { $sum: '$totalAmount' },
      cashSalesPkr: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'credit'] }, 0, '$totalAmount'] } },
      creditSalesPkr: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'credit'] }, '$totalAmount', 0] } },
      paymentsPkr: { $sum: { $ifNull: ['$recordedPaidPkr', 0] } },
    } },
  ]
}
export async function regionReport({ shop, regionId, from, to, itemId }) {
  regionReportQuerySchema.parse({ from, to, itemId })
  regionId = objectId(regionId, 'Region')
  if (itemId) itemId = objectId(itemId, 'Product')
  const region = await getRegion(shop, regionId)
  const regionObjectId = objectId(regionId, 'Region')
  const [inventory, sales, purchases, operations, movementSales] = await Promise.all([
    listInventory({ shop }),
    Sale.find({ shop, sellingRegion: regionObjectId, ...dateFilter(from, to), ...(itemId ? { product: itemId } : {}) }).sort({ businessDate: -1, createdAt: -1, _id: -1 }).lean(),
    Purchase.find({ shop, receivingRegion: regionObjectId, ...dateFilter(from, to), ...(itemId ? { item: itemId } : {}) }).sort({ businessDate: -1, createdAt: -1, _id: -1 }).lean(),
    RegionalStockOperation.find({ shop, $or: [{ region: regionObjectId }, { destination: regionObjectId }], ...(itemId ? { item: itemId } : {}) }).sort({ createdAt: -1, _id: -1 }).lean(),
    Sale.find({ shop, 'inventoryMovements.region': regionObjectId }).select('_id productName inventoryMovements').lean(),
  ])
  const [ledger, users] = await Promise.all([
    CustomerLedgerTransaction.find({ shop, saleId: { $in: sales.map(sale => sale._id) }, status: 'active' }).lean(),
    User.find({ shop }).select('_id name').lean(),
  ])
  const userNames = new Map(users.map(user => [id(user._id), user.name]))
  const saleRows = sales.map(sale => {
    const entries = ledger.filter(row => id(row.saleId) === id(sale._id))
    const paid = entries.filter(row => row.type === 'payment').reduce((sum, row) => sum + row.amountPkr, 0)
    const charges = entries.filter(row => row.type === 'purchase').reduce((sum, row) => sum + row.amountPkr, 0)
    const hasCharge = entries.some(row => row.type === 'purchase')
    const returns = entries.filter(row => row.type === 'return').reduce((sum, row) => sum + row.amountPkr, 0)
    const recordedPaidPkr = entries.length || sale.ledgerRecorded ? paid : sale.amountPaid ?? 0
    return { ...sale, recordedByName: userNames.get(id(sale.createdBy)) ?? 'Unknown operator', recordedPaidPkr,
      saleLinkedDuePkr: sale.status === 'voided' ? null : hasCharge ? charges - paid - returns : !sale.customer && sale.paymentMethod !== 'credit' ? sale.totalAmount - recordedPaidPkr : null }
  })
  const stockRows = inventory.filter(row => row.regionId === regionId && (!itemId || row.itemId === itemId))
  const movements = operations.flatMap(operation => (operation.balances ?? []).filter(balance => id(balance.region) === regionId).map(balance => ({
    id: `${operation._id}:${regionId}`, date: operation.createdAt, businessDate: operation.businessDate, regionId,
    itemId: id(operation.item), productName: inventory.find(row => row.itemId === id(operation.item))?.name ?? 'Historical product',
    type: operation.type === 'transfer' ? (balance.afterGrams > balance.beforeGrams ? 'transfer_in' : 'transfer_out') : operation.type,
    quantityChangeKg: (balance.afterGrams - balance.beforeGrams) / 1000, balanceAfterKg: balance.afterGrams / 1000,
    reference: operation.reference || id(operation.purchase || operation._id), performedBy: userNames.get(id(operation.createdBy)) ?? 'Unknown operator', reason: operation.reason,
  })))
  for (const sale of movementSales) for (const [index, movement] of (sale.inventoryMovements ?? []).entries()) {
    if (id(movement.region) !== regionId || (itemId && id(movement.item) !== itemId)) continue
    movements.push({ id: `${sale._id}:${index}`, date: movement.createdAt, regionId, itemId: id(movement.item), productName: sale.productName,
      type: movement.type, quantityChangeKg: movement.stockAfterKg - movement.stockBeforeKg, balanceAfterKg: movement.stockAfterKg,
      reference: id(sale._id), performedBy: userNames.get(id(movement.createdBy)) ?? 'Unknown operator', reason: movement.reason })
  }
  return {
    region, inventory: stockRows, sales: saleRows, purchases: purchases.map(purchase => ({ ...purchase, paidAmount: (purchase.payments ?? []).reduce((sum, row) => sum + row.amountPkr, 0) })),
    summary: { ...summarizeRegionalSales(saleRows), stockKg: stockRows.reduce((sum, row) => sum + Math.round(row.availableKg * 1000), 0) / 1000,
      purchasedKg: purchases.filter(row => row.status === 'received').reduce((sum, row) => sum + Math.round(row.quantityKg * 1000), 0) / 1000,
      lowStockProducts: stockRows.filter(row => row.status !== 'inactive' && row.lowStockThreshold != null && row.availableKg <= row.lowStockThreshold).length,
      outstandingKhataPkr: null,
      accountingNote: 'Payments shown are linked to these sales. Standalone customer payments and opening Khata are not allocated to regions; regional outstanding Khata is unavailable.' },
    products: groupSales(saleRows, sale => sale.productName ?? 'Historical product'),
    daily: groupSales(saleRows, sale => sale.businessDate),
    salespeople: groupSales(saleRows, sale => sale.salespersonName || 'Not recorded'),
    movements: movements.filter(row => row.date && withinMovementPeriod(row.date, from, to, row.businessDate)).sort((a, b) => new Date(b.date) - new Date(a.date) || a.id.localeCompare(b.id)),
  }
}



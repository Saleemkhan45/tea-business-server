import mongoose from 'mongoose'
import { Sale } from '../models/Sale.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { topProductsQuerySchema } from '../schemas/salesSchemas.js'
import { dashboardStockKg } from './dashboardStockService.js'
import { getBusinessDate } from '../utils/businessDay.js'

export function dashboardMatch(shop, filters) {
  if (!/^[a-f\d]{24}$/i.test(String(shop ?? ''))) throw new TypeError('Shop must be a valid ID.')
  return { shop: new mongoose.Types.ObjectId(String(shop)), businessDate: { $gte: filters.from, $lte: filters.to },
    status: { $in: ['completed', 'pending'] }, ...(filters.regionId ? { sellingRegion: new mongoose.Types.ObjectId(filters.regionId) } : {}) }
}
export function fillDailyBuckets(from, to, rows) {
  const values = new Map(rows.map(row => [row._id, row.salesPkr]))
  const result = []
  for (let day = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); day <= end; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10)
    result.push({ date, salesPkr: values.get(date) ?? 0 })
  }
  return result
}
export async function getDashboard({ shop, ...input }, { now = new Date() } = {}) {
  const filters = topProductsQuerySchema.parse(input)
  const from = filters.from ?? getBusinessDate(now), to = filters.to ?? from
  // Bound the response size even for valid but impractically large custom ranges.
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 3660) throw Object.assign(new Error('Choose a range of at most ten years.'), { statusCode: 400 })
  const match = dashboardMatch(shop, { ...filters, from, to })
  const [results, stockKg, ledger] = await Promise.all([
    Sale.aggregate([{ $match: match }, { $facet: {
      totals: [{ $group: { _id: null, orders: { $sum: 1 }, salesPkr: { $sum: '$totalAmount' }, creditSalesPkr: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'credit'] }, '$totalAmount', 0] } } } }],
      daily: [{ $group: { _id: '$businessDate', salesPkr: { $sum: '$totalAmount' } } }, { $sort: { _id: 1 } }],
      categories: [{ $group: { _id: { $ifNull: ['$teaType', 'Not recorded'] }, orders: { $sum: 1 } } }, { $sort: { orders: -1, _id: 1 } }],
      recentSales: [{ $sort: { businessDate: -1, createdAt: -1, _id: -1 } }, { $limit: 10 }, { $project: { businessDate: 1, customerName: 1, productName: 1, quantityKg: 1, sellingRegionName: 1, totalAmount: 1, paymentMethod: 1, status: 1 } }],
    } }], { maxTimeMS: 10_000 }),
    dashboardStockKg(shop, filters.regionId),
    CustomerLedgerTransaction.aggregate([{ $match: { shop: match.shop, status: 'active' } }, { $facet: {
      balances: [{ $group: { _id: '$customer', balance: { $sum: { $cond: [{ $in: ['$type', ['payment', 'return']] }, { $multiply: ['$amountPkr', -1] }, '$amountPkr'] } } } }, { $match: { balance: { $gt: 0 } } }, { $group: { _id: null, outstandingPkr: { $sum: '$balance' }, customers: { $sum: 1 } } }],
      payments: [{ $match: { type: 'payment', businessDate: getBusinessDate(now) } },
        { $lookup: { from: CustomerLedgerTransaction.collection.name, let: { payment: '$_id', shop: '$shop' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$shop', '$$shop'] }, { $eq: ['$reversalOf', '$$payment'] }, { $eq: ['$status', 'active'] }] } } }], as: 'reversals' } },
        { $match: { 'reversals.0': { $exists: false } } }, { $group: { _id: null, paymentsTodayPkr: { $sum: '$amountPkr' } } }],
    } }], { maxTimeMS: 10_000 }),
  ])
  const result = results[0] ?? {}, totals = result.totals?.[0] ?? { orders: 0, salesPkr: 0, creditSalesPkr: 0 }
  return { from, to, regionId: filters.regionId ?? null,
    metrics: { orders: totals.orders, salesPkr: totals.salesPkr, averageOrderPkr: totals.orders ? Math.round(totals.salesPkr / totals.orders * 100) / 100 : 0, stockKg, creditSalesPkr: totals.creditSalesPkr },
    daily: fillDailyBuckets(from, to, result.daily ?? []), categories: (result.categories ?? []).map(row => ({ label: row._id, orders: row.orders, percent: totals.orders ? row.orders / totals.orders * 100 : 0 })),
    recentSales: (result.recentSales ?? []).map(row => ({ ...row, _id: String(row._id) })),
    khata: { outstandingPkr: ledger[0]?.balances?.[0]?.outstandingPkr ?? 0, customers: ledger[0]?.balances?.[0]?.customers ?? 0, paymentsTodayPkr: ledger[0]?.payments?.[0]?.paymentsTodayPkr ?? 0, today: getBusinessDate(now) },
  }
}


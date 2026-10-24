import mongoose from 'mongoose'
import { z } from 'zod'
import { Supplier } from '../models/Supplier.js'
import { Purchase } from '../models/Purchase.js'
import { regionalDate } from '../schemas/regionalSchemas.js'
import { supplierError } from '../utils/supplierErrors.js'

export const profileQuery = z.object({
  tab: z.enum(['purchases', 'payments', 'movements', 'activity', 'analytics']).optional(),
  from: regionalDate.or(z.literal('')).optional(), to: regionalDate.or(z.literal('')).optional(),
  search: z.string().trim().max(160).default(''), status: z.enum(['', 'received', 'pending', 'in_transit', 'voided']).default(''),
  region: z.string().regex(/^[a-f\d]{24}$/i).or(z.literal('')).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(30).default(10),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, 'End date must follow start date.')
const id = value => new mongoose.Types.ObjectId(z.string().regex(/^[a-f\d]{24}$/i).parse(String(value)))
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const period = query => query.from || query.to ? { businessDate: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}
const invoice = { $and: [{ $ne: [{ $ifNull: ['$receivingRegion', null] }, null] }, { $isArray: '$payments' }] }
const paid = { $sum: { $map: { input: { $ifNull: ['$payments', []] }, as: 'payment', in: '$$payment.amountPkr' } } }
export const statsStages = () => [
  { $match: { status: { $ne: 'voided' } } },
  { $group: { _id: null, count: { $sum: 1 }, grams: { $sum: { $round: [{ $multiply: ['$quantityKg', 1000] }, 0] } },
    valuePkr: { $sum: '$totalAmount' }, lastPurchase: { $max: '$businessDate' },
    invoicedPkr: { $sum: { $cond: [invoice, '$totalAmount', 0] } }, paymentsPkr: { $sum: { $cond: [invoice, paid, 0] } },
    outstandingPkr: { $sum: { $cond: [invoice, { $max: [0, { $subtract: ['$totalAmount', paid] }] }, 0] } },
    unknownPayableCount: { $sum: { $cond: [invoice, 0, 1] } },
  } },
  { $project: { _id: 0, count: 1, quantityKg: { $divide: ['$grams', 1000] }, valuePkr: 1, lastPurchase: 1, invoicedPkr: 1, paymentsPkr: 1, outstandingPkr: 1, unknownPayableCount: 1 } },
]
const emptyStats = { count: 0, quantityKg: 0, valuePkr: 0, lastPurchase: null, invoicedPkr: 0, paymentsPkr: 0, outstandingPkr: 0, unknownPayableCount: 0 }
async function supplierFor(shop, supplierId) {
  const supplier = await Supplier.findOne({ shop: id(shop), _id: id(supplierId) }).select('-creationIdempotencyKey -creationFingerprint -profileHistory').lean()
  if (!supplier) throw supplierError('SUPPLIER_NOT_FOUND', 'Supplier not found.', 404)
  return { ...supplier, revision: supplier.revision ?? 0 }
}
export async function supplierProfile({ shop, supplierId, ...raw }) {
  const query = profileQuery.parse(raw), supplier = await supplierFor(shop, supplierId)
  const [result] = await Purchase.aggregate([{ $match: { shop: id(shop), supplier: id(supplierId) } }, { $facet: {
    selected: [{ $match: period(query) }, ...statsStages()], current: statsStages(),
  } }]).option({ maxTimeMS: 5000 })
  return { supplier, stats: result?.selected[0] ?? emptyStats, currentStats: result?.current[0] ?? emptyStats }
}
function facet(query, stages = []) {
  return { $facet: { rows: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }, ...stages], total: [{ $count: 'count' }] } }
}
const purchaseProjection = { $project: { _id: 1, businessDate: 1, reference: 1, productName: 1, quantityKg: 1, unitCost: 1, totalAmount: 1, regionName: 1, receivingRegion: 1, status: 1 } }
function operatorLookup(field, output, shop) {
  return [{ $lookup: { from: 'users', let: { operatorId: field }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$operatorId'] }, { $eq: ['$shop', id(shop)] }] } } }, { $project: { _id: 0, name: 1 } }], as: '_operator' } },
    { $set: { [output]: { $ifNull: [{ $arrayElemAt: ['$_operator.name', 0] }, null] } } }, { $unset: '_operator' }]
}
export async function supplierHistory({ shop, supplierId, ...raw }) {
  const query = profileQuery.parse(raw)
  await supplierFor(shop, supplierId)
  if (!query.tab) throw supplierError('SUPPLIER_VALIDATION_FAILED', 'Choose a supplier history tab.')
  if (query.tab === 'activity') {
    const [result] = await Supplier.aggregate([{ $match: { shop: id(shop), _id: id(supplierId) } },
      { $project: { entries: { $reverseArray: { $ifNull: ['$profileHistory', []] } } } }, { $unwind: '$entries' },
      { $replaceWith: '$entries' }, { $sort: { revision: -1, _id: -1 } }, facet(query, [
        ...operatorLookup('$modifiedBy', 'operatorName', shop), { $project: { key: 0, fingerprint: 0 } },
      ])]).option({ maxTimeMS: 5000 })
    return { rows: result?.rows ?? [], total: result?.total[0]?.count ?? 0, page: query.page, limit: query.limit }
  }
  const filter = { shop: id(shop), supplier: id(supplierId), ...period(query) }
  if (query.status) filter.status = query.status
  if (query.region) filter.receivingRegion = id(query.region)
  if (query.search) filter.$or = ['reference', 'productName', 'regionName'].map(field => ({ [field]: { $regex: escaped(query.search), $options: 'i' } }))
  const stages = [{ $match: filter }]
  if (query.tab === 'analytics') {
    const group = field => [{ $group: { _id: { $ifNull: [field, 'Not recorded'] }, count: { $sum: 1 }, grams: { $sum: { $round: [{ $multiply: ['$quantityKg', 1000] }, 0] } }, valuePkr: { $sum: '$totalAmount' } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 30 }, { $project: { _id: 0, name: '$_id', count: 1, quantityKg: { $divide: ['$grams', 1000] }, valuePkr: 1 } }]
    const [result] = await Purchase.aggregate([...stages, { $match: { status: { $ne: 'voided' } } }, { $facet: {
      products: group('$productName'), regions: group('$regionName'),
      trend: [...group('$businessDate').slice(0, 1), { $sort: { _id: -1 } }, { $limit: 30 }, { $project: { _id: 0, name: '$_id', count: 1, quantityKg: { $divide: ['$grams', 1000] }, valuePkr: 1 } }],
    } }]).option({ maxTimeMS: 5000 })
    return { products: result?.products ?? [], regions: result?.regions ?? [], trend: result?.trend.reverse() ?? [] }
  }
  if (query.tab === 'purchases') stages.push({ $sort: { businessDate: -1, _id: -1 } }, facet(query, [purchaseProjection]))
  if (query.tab === 'payments') stages.push({ $unwind: { path: '$payments', includeArrayIndex: 'paymentIndex' } },
    { $sort: { 'payments.businessDate': -1, _id: -1, paymentIndex: -1 } }, facet(query, [
      ...operatorLookup('$payments.createdBy', 'operatorName', shop),
      { $project: { _id: 0, purchaseId: '$_id', reference: 1, invoiceStatus: '$status', paymentIndex: 1, date: '$payments.businessDate', amountPkr: '$payments.amountPkr', method: '$payments.method', paymentReference: '$payments.reference', operatorName: 1 } },
    ]))
  if (query.tab === 'movements') stages.push({ $lookup: { from: 'regionalstockoperations', let: { purchaseId: '$_id' }, pipeline: [
    { $match: { shop: id(shop), type: { $in: ['purchase_receipt', 'purchase_reversal'] }, $expr: { $eq: ['$purchase', '$$purchaseId'] } } },
    { $project: { _id: 1, businessDate: 1, createdAt: 1, type: 1, quantityGrams: 1, reason: 1, createdBy: 1, region: 1 } },
  ], as: 'movement' } }, { $unwind: '$movement' }, { $sort: { 'movement.createdAt': -1, 'movement._id': -1 } }, facet(query, [
    ...operatorLookup('$movement.createdBy', 'operatorName', shop),
    { $project: { _id: '$movement._id', purchaseId: '$_id', reference: 1, productName: 1, regionName: 1, region: '$movement.region', invoiceStatus: '$status', date: '$movement.businessDate', createdAt: '$movement.createdAt', type: '$movement.type', quantityGrams: '$movement.quantityGrams', reason: '$movement.reason', operatorName: 1 } },
  ]))
  const [result] = await Purchase.aggregate(stages).option({ maxTimeMS: 5000 })
  return { rows: result?.rows ?? [], total: result?.total[0]?.count ?? 0, page: query.page, limit: query.limit }
}

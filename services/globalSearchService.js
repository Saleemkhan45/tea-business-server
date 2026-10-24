import { z } from 'zod'
import { Sale } from '../models/Sale.js'
import { Purchase } from '../models/Purchase.js'

export const recordSearchQuery = z.object({
  search: z.string().trim().min(2).max(100),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(8).default(6),
})

export async function searchRecords(kind, shop, query) {
  const { search, page, limit } = recordSearchQuery.parse(query)
  const text = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  const fields = kind === 'sales'
    ? ['customerName', 'productName', 'teaType', 'businessDate']
    : ['supplierName', 'productName', 'reference', 'businessDate']
  const alternatives = fields.map(field => ({ [field]: text }))
  if (/^[a-f\d]{24}$/i.test(search)) alternatives.push({ _id: search })
  const Model = kind === 'sales' ? Sale : Purchase
  const rows = await Model.find({ shop, $or: alternatives })
    .select('_id customerName supplierName productName reference businessDate totalAmount amountPaid paymentMethod status')
    .sort({ businessDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).maxTimeMS(3000).lean()
  return { results: rows.map(row => ({
    id: String(row._id),
    title: (kind === 'sales' ? row.customerName : row.supplierName) || 'Historical record',
    reference: row.reference || String(row._id),
    description: row.productName || '',
    date: row.businessDate,
    total: row.totalAmount,
    status: kind === 'sales' ? row.status === 'voided' ? 'Cancelled'
      : (row.amountPaid ?? (row.paymentMethod === 'credit' ? 0 : row.totalAmount)) >= row.totalAmount ? 'Paid'
        : (row.amountPaid ?? 0) > 0 ? 'Partial' : 'Khata' : row.status.replaceAll('_', ' '),
  })), page, limit }
}

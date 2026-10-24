import mongoose from 'mongoose'
import { Sale } from '../models/Sale.js'
import { Item } from '../models/Item.js'
import { topProductsQuerySchema } from '../schemas/salesSchemas.js'
import { getBusinessDate } from '../utils/businessDay.js'

const TOP_PRODUCTS_LIMIT = 5

/** Read only. Sale is one current product/quantity per document, not an array of lines. */
export async function getTopSellingProducts({ shop, ...input }, { now = new Date() } = {}) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(shop ?? ''))) throw new TypeError('Shop must be a valid ID.')
  const filters = topProductsQuerySchema.parse(input)
  const from = filters.from ?? getBusinessDate(now)
  const to = filters.to ?? from
  const scopedShop = new mongoose.Types.ObjectId(String(shop))

  // Existing (shop, businessDate) and (shop, sellingRegion, businessDate) indexes
  // support this leading match. Never read movements, editHistory or ledger entries as sales.
  const rows = await Sale.aggregate([
    { $match: {
      shop: scopedShop,
      businessDate: { $gte: from, $lte: to },
      ...(filters.regionId ? { sellingRegion: new mongoose.Types.ObjectId(filters.regionId) } : {}),
      status: { $in: ['completed', 'pending'] },
      quantityKg: { $type: 'number', $gt: 0, $lte: Number.MAX_SAFE_INTEGER / 1000 },
    } },
    { $sort: { businessDate: -1, createdAt: -1, _id: -1 } },
    { $project: {
      // Regional sales store Item identity in product. In the legacy stock system,
      // stockLocationId itself is the Item ID; it is NOT an Item ID for regional sales.
      productId: { $convert: { input: { $ifNull: ['$product', { $cond: [
        { $eq: [{ $ifNull: ['$sellingRegion', null] }, null] }, '$stockLocationId', null,
      ] }] }, to: 'objectId', onError: null, onNull: null } },
      name: { $cond: [{ $eq: [{ $type: '$productName' }, 'string'] }, { $trim: { input: '$productName' } }, ''] },
      quantityGrams: { $round: [{ $multiply: ['$quantityKg', 1000] }, 0] },
      quantityKg: 1,
    } },
    { $match: {
      productId: { $ne: null }, quantityGrams: { $gt: 0 },
      // Preserve the same three-decimal kg precision accepted by sale writes.
      $expr: { $lt: [{ $abs: { $subtract: ['$quantityKg', { $divide: ['$quantityGrams', 1000] }] } }, 1e-9] },
    } },
    { $group: { _id: '$productId', quantityGrams: { $sum: '$quantityGrams' }, name: { $first: '$name' } } },
    { $sort: { quantityGrams: -1, _id: 1 } },
    { $limit: TOP_PRODUCTS_LIMIT },
  ]).allowDiskUse(true)

  // Prefer the latest sale snapshot, including deleted/inactive historical products.
  // At most five same-shop catalog records are needed when snapshots have no name.
  const missingNames = rows.filter(row => !row.name).map(row => row._id)
  const catalog = missingNames.length ? await Item.find({ shop: scopedShop, _id: { $in: missingNames } }).select('_id name').lean() : []
  const names = new Map(catalog.map(item => [String(item._id), item.name]))
  const products = rows.map(row => {
    if (!Number.isSafeInteger(row.quantityGrams) || row.quantityGrams <= 0) throw new Error('Top product quantity is outside the supported range.')
    const name = String(row.name || names.get(String(row._id)) || '').trim() || 'Historical product'
    return {
      productId: String(row._id),
      name: name.slice(0, 160),
      quantityKg: row.quantityGrams / 1000,
    }
  })
  return { from, to, regionId: filters.regionId ?? null, products }
}

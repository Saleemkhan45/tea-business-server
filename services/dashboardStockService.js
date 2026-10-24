import mongoose from 'mongoose'
import { RegionalStock } from '../models/RegionalStock.js'
import { Item } from '../models/Item.js'
import { Region } from '../models/Region.js'

export function dashboardStockPipeline(shop, regionId) {
  const scope = new mongoose.Types.ObjectId(String(shop))
  return [
    { $match: { shop: scope, ...(regionId ? { region: new mongoose.Types.ObjectId(regionId) } : {}) } },
    { $lookup: { from: Item.collection.name, localField: 'item', foreignField: '_id', pipeline: [{ $match: { shop: scope, status: 'active' } }, { $project: { _id: 1 } }], as: 'activeItem' } },
    { $lookup: { from: Region.collection.name, localField: 'region', foreignField: '_id', pipeline: [{ $match: { shop: scope, status: 'active' } }, { $project: { _id: 1 } }], as: 'activeRegion' } },
    { $match: { 'activeItem.0': { $exists: true }, 'activeRegion.0': { $exists: true } } },
    { $group: { _id: null, quantityGrams: { $sum: '$quantityGrams' } } },
  ]
}

export async function dashboardStockKg(shop, regionId) {
  // Aggregate integer grams in MongoDB; do not materialize products, regions,
  // configuration history, or every assignment just to display one number.
  const rows = await RegionalStock.aggregate(dashboardStockPipeline(shop, regionId)).option({ maxTimeMS: 10_000 })
  const grams = rows[0]?.quantityGrams ?? 0
  if (!Number.isSafeInteger(grams) || grams < 0) throw Object.assign(new Error('Regional stock exceeds the supported reporting limit.'), { statusCode: 409 })
  return grams / 1000
}

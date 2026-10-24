import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { Region } from '../models/Region.js'
import { RegionalStock } from '../models/RegionalStock.js'
import { RegionalStockOperation } from '../models/RegionalStockOperation.js'
import { Item } from '../models/Item.js'
import { User } from '../models/User.js'
import { Sale } from '../models/Sale.js'
import { Purchase } from '../models/Purchase.js'
import { regionInputSchema, regionCreateSchema, regionalDate, regionalSettingsSchema } from '../schemas/regionalSchemas.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { ITEM_TEA_TYPES } from '../constants/teaCategories.js'

export function inventoryError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}
export function objectId(value, label) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw inventoryError(`${label} must be a valid ID.`)
  return value.toLowerCase()
}
function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw inventoryError(`${label} is required (maximum ${limit} characters).`)
  return value.trim()
}
export function quantityGrams(value, signed = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw inventoryError('Quantity must be a number in kg.')
  const grams = Math.round(value * 1000)
  if (!Number.isSafeInteger(grams) || Math.abs(value - grams / 1000) >= 1e-9 || (signed ? grams === 0 : grams <= 0)) throw inventoryError('Quantity must use up to three decimals and have a nonzero permitted sign.')
  return grams
}
export async function requireRegion(shop, id, session) {
  const region = await Region.findOne({ _id: objectId(String(id), 'Region'), shop, status: 'active' }).session(session ?? null).lean()
  if (!region) throw inventoryError('Region is unavailable.', 404)
  return region
}
export async function requireManager(shop, actor, session) {
  const user = await User.exists({ _id: actor, shop, status: 'active', role: { $in: ['owner', 'admin'] } }).session(session ?? null)
  if (!user) throw inventoryError('Only an owner or admin can manage regional stock.', 403)
}
export async function listRegions(shop) {
  return Region.find({ shop }).sort({ name: 1, _id: 1 }).lean()
}
export async function createRegion({ shop, actor, ...input }) {
  const { openingProducts, idempotencyKey, openingStockConfirmed, ...fields } = regionCreateSchema.parse(input)
  await requireManager(shop, actor)
  await Promise.all([Region.init(), RegionalStock.init(), RegionalStockOperation.init()])
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...fields, openingProducts })).digest('hex')
  const replay = async session => {
    if (!idempotencyKey) return null
    const prior = await Region.findOne({ shop, idempotencyKey }).select('+fingerprint').session(session ?? null).lean()
    if (prior && prior.fingerprint !== fingerprint) throw inventoryError('Creation key was used for a different region.', 409)
    if (!prior) return null
    const { fingerprint: ignoredFingerprint, idempotencyKey: ignoredKey, ...region } = prior
    return region
  }
  const existing = await replay()
  if (existing) return existing
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      await requireManager(shop, actor, session)
      const prior = await replay(session)
      if (prior) return prior
      for (const row of openingProducts) {
        const product = await Item.findOne({ _id: row.itemId, shop, status: 'active' }).session(session).lean()
        if (!product) throw inventoryError('Every opening product must be active and belong to this shop.', 404)
        if (row.quantityKg > 0 && product.stockKg > 0) throw inventoryError('This product has legacy unallocated stock. Reconcile or transfer it through an approved migration before recording opening stock.', 409)
      }
      const [region] = await Region.create([{ ...fields, shop, nameKey: fields.name.toLocaleLowerCase(), createdBy: actor, ...(idempotencyKey ? { idempotencyKey, fingerprint } : {}) }], { session })
      for (const row of openingProducts) {
        await createOpeningAssignment({ shop, actor, regionId: region._id, itemId: row.itemId,
          quantityKg: row.quantityKg, fingerprint, session,
          reason: 'Authorized opening stock at region creation', reference: String(region._id),
          settings: { sellingPriceOverride: row.sellingPriceOverride ?? null, lowStockThresholdOverride: row.lowStockThresholdOverride ?? null },
        })
      }
      const { fingerprint: ignoredFingerprint, idempotencyKey: ignoredKey, ...result } = region.toObject()
      return result
    })
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      const winner = await replay()
      if (winner) return winner
    }
    throw error
  } finally { await session.endSession() }
}
export async function getRegion(shop, regionId) {
  const region = await Region.findOne({ shop, _id: objectId(regionId, 'Region') }).lean()
  if (!region) throw inventoryError('Region not found.', 404)
  return region
}
export async function updateRegion({ shop, actor, regionId, ...input }) {
  await requireManager(shop, actor)
  const fields = regionInputSchema.partial().parse(input)
  if (fields.name !== undefined) {
    fields.nameKey = fields.name.toLocaleLowerCase()
  }
  const region = await Region.findOneAndUpdate({ shop, _id: objectId(regionId, 'Region') }, { $set: { ...fields, updatedBy: actor } }, { new: true, runValidators: true })
  if (!region) throw inventoryError('Region not found.', 404)
  return region
}
export async function listProducts(shop) {
  return Item.find({ shop }).select('_id name teaType status sellingPrice lowStockThreshold').sort({ name: 1 }).lean()
}
// Shared by region creation and catalog opening stock; callers validate authorization
// and product/region ownership inside the same transaction before calling this helper.
async function createOpeningAssignment({ shop, actor, regionId, itemId, quantityKg, fingerprint, session, reason, settings = {}, reference = String(itemId) }) {
  const grams = quantityKg === 0 ? 0 : quantityGrams(quantityKg)
  await RegionalStock.create([{ shop, region: regionId, item: itemId, quantityGrams: grams, ...settings,
    configurationHistory: settings.sellingPriceOverride != null || settings.lowStockThresholdOverride != null
      ? [configurationChange({}, settings, actor)] : [],
  }], { session })
  if (grams) await RegionalStockOperation.create([{
    shop, region: regionId, item: itemId, type: 'opening_stock', quantityGrams: grams,
    idempotencyKey: `opening:${regionId}:${itemId}`, fingerprint, reason, createdBy: actor,
    businessDate: getBusinessDate(), reference,
    balances: [{ region: regionId, beforeGrams: 0, afterGrams: grams }],
  }], { session })
}
function publicProduct(product) {
  const { catalogCreationKey, catalogFingerprint, ...result } = product.toObject ? product.toObject() : product
  return result
}
export async function createProduct({ shop, actor, ...input }) {
  await requireManager(shop, actor)
  const name = text(input.name, 'Product name', 160)
  if (!ITEM_TEA_TYPES.includes(input.teaType)) throw inventoryError('Tea type is invalid.')
  if (input.sellingPrice !== undefined && (!Number.isSafeInteger(input.sellingPrice) || input.sellingPrice < 0)) throw inventoryError('Selling price must be a non-negative whole PKR amount.')
  if (input.teaType === 'Other' && !(input.sellingPrice > 0)) throw inventoryError('Custom products require a positive whole PKR selling price.')
  const lowStockThreshold = input.lowStockThreshold ?? 100
  if (typeof lowStockThreshold !== 'number' || !Number.isFinite(lowStockThreshold) || lowStockThreshold < 0) throw inventoryError('Low stock threshold must be non-negative kg.')
  const status = input.status ?? 'active'
  if (!['active', 'inactive'].includes(status)) throw inventoryError('Product status is invalid.')
  const openingQuantityKg = input.openingQuantityKg ?? 0
  if (openingQuantityKg !== 0) quantityGrams(openingQuantityKg)
  const regionId = openingQuantityKg > 0 ? objectId(input.receivingRegionId, 'Receiving region') : null
  if (openingQuantityKg > 0 && (status !== 'active' || input.openingStockConfirmed !== true)) throw inventoryError('Confirm genuine opening stock for an active product.')
  const key = input.idempotencyKey === undefined ? null : text(input.idempotencyKey, 'Idempotency key', 128)
  if (openingQuantityKg > 0 && !key) throw inventoryError('Opening stock requires an idempotency key.')
  const fields = { name, teaType: input.teaType, sellingPrice: input.sellingPrice, lowStockThreshold, status, stockKg: 0 }
  await Item.init()
  // Preserve the existing catalog-only API for older callers.
  if (!key) return Item.create({ ...fields, shop })
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...fields, openingQuantityKg, regionId })).digest('hex')
  const replay = async session => {
    const prior = await Item.findOne({ shop, catalogCreationKey: key }).select('+catalogCreationKey +catalogFingerprint').session(session ?? null).lean()
    if (prior && prior.catalogFingerprint !== fingerprint) throw inventoryError('Creation key was used for a different product.', 409)
    return prior ? publicProduct(prior) : null
  }
  const existing = await replay()
  if (existing) return existing
  if (openingQuantityKg > 0) await Promise.all([RegionalStock.init(), RegionalStockOperation.init()])
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      await requireManager(shop, actor, session)
      const prior = await replay(session)
      if (prior) return prior
      if (regionId) await requireRegion(shop, regionId, session)
      const [product] = await Item.create([{ ...fields, shop, catalogCreationKey: key, catalogFingerprint: fingerprint }], { session })
      if (regionId) await createOpeningAssignment({ shop, actor, regionId, itemId: product._id,
        quantityKg: openingQuantityKg, fingerprint, session, reason: 'Authorized opening stock at catalog product creation' })
      return publicProduct(product)
    })
  } catch (error) {
    if (error.code === 11000) {
      const winner = await replay()
      if (winner) return winner
    }
    throw error
  } finally { await session.endSession() }
}
export async function assignProduct({ shop, actor, regionId, itemId }) {
  await requireManager(shop, actor)
  await requireRegion(shop, regionId)
  const item = await Item.exists({ _id: objectId(itemId, 'Product'), shop, status: 'active' })
  if (!item) throw inventoryError('Product is unavailable.', 404)
  await RegionalStock.init()
  const filter = { shop, region: regionId, item: itemId }
  try {
    return await RegionalStock.findOneAndUpdate(filter, { $setOnInsert: { quantityGrams: 0 } }, { upsert: true, new: true, runValidators: true })
  } catch (error) {
    if (error.code !== 11000) throw error
    return RegionalStock.findOne(filter)
  }
}
export async function listInventory({ shop, regionId, search = '', availability = 'all' }) {
  if (regionId) await getRegion(shop, regionId)
  const [stocks, products, regions] = await Promise.all([
    RegionalStock.find({ shop, ...(regionId ? { region: regionId } : {}) }).sort({ region: 1, item: 1 }).lean(),
    listProducts(shop), listRegions(shop),
  ])
  const productMap = new Map(products.map(item => [String(item._id), item]))
  const regionMap = new Map(regions.map(region => [String(region._id), region]))
  return stocks.flatMap(stock => {
    const item = productMap.get(String(stock.item)), region = regionMap.get(String(stock.region))
    if (!item || !region || !item.name.toLocaleLowerCase().includes(String(search).trim().toLocaleLowerCase())) return []
    const status = item.status !== 'active' || region.status !== 'active' ? 'inactive' : stock.quantityGrams === 0 ? 'out_of_stock' : 'available'
    if (availability !== 'all' && availability !== status) return []
    return [{ id: String(stock._id), itemId: String(item._id), regionId: String(region._id), regionName: region.name, name: item.name, teaType: item.teaType, availableKg: stock.quantityGrams / 1000, ...effectiveRegionalSettings(stock, item), status, updatedAt: stock.updatedAt }]
  })
}
export function effectiveRegionalSettings(stock, item) {
  return {
    sellingPriceOverride: stock.sellingPriceOverride ?? null,
    lowStockThresholdOverride: stock.lowStockThresholdOverride ?? null,
    catalogSellingPrice: item.sellingPrice ?? null,
    catalogLowStockThreshold: item.lowStockThreshold ?? null,
    sellingPrice: stock.sellingPriceOverride ?? item.sellingPrice ?? null,
    lowStockThreshold: stock.lowStockThresholdOverride ?? item.lowStockThreshold ?? null,
  }
}
function configurationChange(before, after, actor) {
  return { createdBy: actor, createdAt: new Date(), beforePrice: before.sellingPriceOverride ?? null,
    afterPrice: after.sellingPriceOverride ?? null, beforeThreshold: before.lowStockThresholdOverride ?? null,
    afterThreshold: after.lowStockThresholdOverride ?? null }
}
export async function updateRegionalSettings({ shop, actor, regionId, itemId, ...raw }) {
  const settings = regionalSettingsSchema.parse(raw)
  if (!Object.keys(settings).length) throw inventoryError('Specify a regional price or threshold.')
  regionId = objectId(regionId, 'Region'); itemId = objectId(itemId, 'Product')
  await requireManager(shop, actor)
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      await requireManager(shop, actor, session)
      const region = await Region.findOne({ shop, _id: regionId }).session(session).lean()
      if (!region) throw inventoryError('Region not found.', 404)
      const stock = await RegionalStock.findOne({ shop, region: regionId, item: itemId }).session(session).lean()
      if (!stock) throw inventoryError('Regional product assignment not found.', 404)
      const item = await Item.findOne({ shop, _id: itemId }).session(session).lean()
      if (!item) throw inventoryError('Product not found.', 404)
      const after = { sellingPriceOverride: stock.sellingPriceOverride ?? null, lowStockThresholdOverride: stock.lowStockThresholdOverride ?? null, ...settings }
      if (after.sellingPriceOverride !== (stock.sellingPriceOverride ?? null) || after.lowStockThresholdOverride !== (stock.lowStockThresholdOverride ?? null)) {
        const updated = await RegionalStock.findOneAndUpdate({ shop, _id: stock._id }, {
          $set: after, $push: { configurationHistory: configurationChange(stock, after, actor) },
        }, { session, new: true, runValidators: true })
        if (!updated) throw inventoryError('Regional assignment changed. Reload before retrying.', 409)
      }
      return effectiveRegionalSettings(after, item)
    })
  } finally { await session.endSession() }
}
export async function removeUnusedAssignment({ shop, actor, regionId, itemId }) {
  regionId = objectId(regionId, 'Region'); itemId = objectId(itemId, 'Product')
  await requireManager(shop, actor)
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      await requireManager(shop, actor, session)
      await getRegion(shop, regionId)
      // Deleting the stock row conflicts with concurrent transactional stock writes.
      const stock = await RegionalStock.findOneAndDelete({ shop, region: regionId, item: itemId, quantityGrams: 0 }, { session })
      if (!stock) throw inventoryError('Only a zero-stock, unused assignment can be removed.', 409)
      if (stock.configurationHistory?.length) throw inventoryError('This product has configuration history and must remain assigned.', 409)
      const operation = await RegionalStockOperation.exists({ shop, item: itemId, $or: [{ region: regionId }, { destination: regionId }] }).session(session)
      const sale = await Sale.exists({ shop, $or: [{ stockLocationId: stock._id }, { sellingRegion: regionId, product: itemId }, { 'inventoryMovements.regionalStock': stock._id }] }).session(session)
      const purchase = await Purchase.exists({ shop, receivingRegion: regionId, item: itemId }).session(session)
      if (operation || sale || purchase) throw inventoryError('This product has business history and must remain assigned.', 409)
      return { removed: true }
    })
  } finally { await session.endSession() }
}
export function normalizeStockOperation(input) {
  const type = input.type
  if (!['receipt', 'correction', 'transfer'].includes(type)) throw inventoryError('Stock operation type is invalid.')
  const region = objectId(input.regionId, 'Region'), item = objectId(input.itemId, 'Product')
  const destination = type === 'transfer' ? objectId(input.destinationId, 'Destination') : undefined
  if (destination === region) throw inventoryError('Transfer destination must differ from source.')
  const payload = { type, region, item, ...(destination ? { destination } : {}), quantityGrams: quantityGrams(input.quantityKg, type === 'correction'), reason: text(input.reason, 'Audit reason', 240) }
  if (input.businessDate !== undefined) payload.businessDate = regionalDate.parse(input.businessDate)
  if (input.reference !== undefined && input.reference !== '') payload.reference = text(input.reference, 'Reference', 160)
  return payload
}
export async function recordStockOperation({ shop, actor, ...input }) {
  const payload = normalizeStockOperation(input)
  const idempotencyKey = text(input.idempotencyKey, 'Idempotency key', 128)
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  await requireManager(shop, actor)
  await RegionalStockOperation.init()
  const scope = { shop, idempotencyKey }
  const replay = async session => {
    const prior = await RegionalStockOperation.findOne(scope).session(session ?? null).lean()
    if (prior && prior.fingerprint !== fingerprint) throw inventoryError('Idempotency key was used for another stock operation.', 409)
    return prior
  }
  const prior = await replay()
  if (prior) return prior
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(async () => {
      await requireManager(shop, actor, session)
      const existing = await replay(session)
      if (existing) return existing
      await requireRegion(shop, payload.region, session)
      if (payload.destination) await requireRegion(shop, payload.destination, session)
      if (!await Item.exists({ _id: payload.item, shop, status: 'active' }).session(session)) throw inventoryError('Product is unavailable.', 404)
      const balances = []
      const changes = [{ region: payload.region, delta: payload.type === 'transfer' ? -payload.quantityGrams : payload.quantityGrams }, ...(payload.destination ? [{ region: payload.destination, delta: payload.quantityGrams }] : [])].sort((a, b) => a.region.localeCompare(b.region))
      for (const { region, delta } of changes) {
        const before = await RegionalStock.findOneAndUpdate({ shop, region, item: payload.item, quantityGrams: { $gte: Math.max(0, -delta), $lte: Number.MAX_SAFE_INTEGER - Math.max(0, delta) } }, { $inc: { quantityGrams: delta } }, { new: false, session, runValidators: true })
        if (!before) throw inventoryError('Assign the product first and ensure sufficient stock and a safe quantity.', 409)
        balances.push({ region, beforeGrams: before.quantityGrams, afterGrams: before.quantityGrams + delta })
      }
      const [operation] = await RegionalStockOperation.create([{ ...scope, ...payload, fingerprint, createdBy: actor, balances }], { session })
      return operation
    })
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
      const winner = await replay()
      if (winner) return winner
    }
    throw error
  } finally { await session.endSession() }
}
export async function regionHistory({ shop, regionId }) {
  await requireRegion(shop, regionId)
  const [operations, sales] = await Promise.all([
    RegionalStockOperation.find({ shop, $or: [{ region: regionId }, { destination: regionId }] }).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
    Sale.find({ shop, $or: [{ sellingRegion: regionId }, { 'inventoryMovements.region': regionId }] }).select('businessDate productName quantityKg totalAmount status inventoryMovements createdBy').sort({ businessDate: -1, createdAt: -1, _id: -1 }).limit(100).lean(),
  ])
  return { operations, sales }
}

import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import { Purchase } from '../models/Purchase.js'
import { Supplier } from '../models/Supplier.js'
import { Item } from '../models/Item.js'
import { RegionalStock } from '../models/RegionalStock.js'
import { RegionalStockOperation } from '../models/RegionalStockOperation.js'
import { requireManager, requireRegion, objectId, quantityGrams, inventoryError } from './regionalInventoryService.js'
import { purchaseInputSchema, purchasePaymentSchema, regionalDate } from '../schemas/regionalSchemas.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { saveSupplier } from './supplierService.js'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function purchaseTotal(input) {
  const grams = quantityGrams(input.quantityKg)
  const subtotal = grams * input.unitCost
  if (!Number.isSafeInteger(subtotal) || subtotal % 1000 !== 0) throw inventoryError('Quantity and cost must produce a whole PKR subtotal.')
  const total = subtotal / 1000 + input.taxAmount + input.shippingAmount - input.discountAmount
  if (!Number.isSafeInteger(total) || total < 0) throw inventoryError('Purchase total must be a non-negative safe whole PKR amount.')
  return total
}
function publicPurchase(doc) {
  const value = doc.toObject ? doc.toObject() : doc
  const { idempotencyKey, fingerprint, revision, ...result } = value
  return { ...result, paidAmount: (result.payments ?? []).reduce((sum, payment) => sum + payment.amountPkr, 0) }
}
async function transact(callback) {
  const session = await mongoose.startSession()
  try { return await session.withTransaction(() => callback(session)) } finally { await session.endSession() }
}
async function findPurchase(shop, purchaseId, session) {
  const purchase = await Purchase.findOne({ shop, _id: objectId(purchaseId, 'Purchase') }).session(session ?? null).lean()
  if (!purchase) throw inventoryError('Purchase not found.', 404)
  if (!purchase.receivingRegion) throw inventoryError('Legacy purchase needs explicit reconciliation before receipt or reversal.', 409)
  return purchase
}
async function validateDestination(payload, shop, session) {
  const region = await requireRegion(shop, String(payload.receivingRegion), session)
  const item = await Item.findOne({ _id: payload.item, shop, status: 'active' }).session(session).lean()
  const supplier = await Supplier.findOne({ _id: payload.supplier, shop, status: 'active' }).session(session).lean()
  if (!item || !supplier) throw inventoryError('Active shop-owned product and supplier are required.', 404)
  // Claim the assignment even for pending purchases, serializing with unused-assignment removal.
  const stock = await RegionalStock.findOneAndUpdate({ shop, region: payload.receivingRegion, item: payload.item }, { $inc: { assignmentRevision: 1 } }, { session, new: false, runValidators: true })
  if (!stock) throw inventoryError('Assign this product to the receiving region before recording a purchase.', 409)
  return { regionName: region.name, productName: item.name, supplierName: supplier.name }
}
async function movePurchaseStock(purchase, actor, session, reverse = false, reason = 'Purchase received') {
  const grams = quantityGrams(purchase.quantityKg)
  const filter = { shop: purchase.shop, region: purchase.receivingRegion, item: purchase.item, quantityGrams: reverse ? { $gte: grams } : { $lte: Number.MAX_SAFE_INTEGER - grams } }
  const before = await RegionalStock.findOneAndUpdate(filter, { $inc: { quantityGrams: reverse ? -grams : grams } }, { new: false, session, runValidators: true })
  if (!before) throw inventoryError('Regional stock is missing, insufficient for reversal, or exceeds the safe quantity limit.', 409)
  const type = reverse ? 'purchase_reversal' : 'purchase_receipt'
  await RegionalStockOperation.create([{
    shop: purchase.shop, purchase: purchase._id, item: purchase.item, region: purchase.receivingRegion,
    type, quantityGrams: grams, businessDate: getBusinessDate(), reference: String(purchase._id),
    idempotencyKey: `purchase:${purchase._id}:${type}`, fingerprint: digest({ purchase: String(purchase._id), type }),
    reason, createdBy: actor,
    balances: [{ region: purchase.receivingRegion, beforeGrams: before.quantityGrams, afterGrams: before.quantityGrams + (reverse ? -grams : grams) }],
  }], { session })
}
export async function purchaseOptions(shop) {
  return { suppliers: await Supplier.find({ shop, status: 'active' }).select('_id name phone').sort({ name: 1 }).lean() }
}
export async function createSupplier({ shop, actor, name, phone = '' }) {
  return saveSupplier({ shop, actor, name, phone })
}
export async function listPurchases({ shop, regionId, from, to }) {
  const filter = { shop }
  if (regionId) filter.receivingRegion = objectId(regionId, 'Region')
  if (from || to) filter.businessDate = { ...(from ? { $gte: regionalDate.parse(from) } : {}), ...(to ? { $lte: regionalDate.parse(to) } : {}) }
  if (from && to && from > to) throw inventoryError('End date must follow start date.')
  const rows = await Purchase.find(filter).sort({ businessDate: -1, createdAt: -1, _id: -1 }).lean()
  return rows.map(publicPurchase)
}
export async function createPurchase({ shop, actor, ...raw }) {
  const input = purchaseInputSchema.parse(raw)
  const totalAmount = purchaseTotal(input)
  if (input.payment && input.payment.amountPkr > totalAmount) throw inventoryError('Payment exceeds the purchase total.')
  await requireManager(shop, actor)
  await Purchase.init(); await RegionalStockOperation.init()
  const { idempotencyKey, payment, ...payload } = input
  const fingerprint = digest(payloadWithPayment(input))
  const replay = async session => {
    const prior = await Purchase.findOne({ shop, idempotencyKey }).select('+fingerprint').session(session ?? null).lean()
    if (prior && prior.fingerprint !== fingerprint) throw inventoryError('Idempotency key was used for a different purchase.', 409)
    return prior ? publicPurchase(prior) : null
  }
  const prior = await replay()
  if (prior) return prior
  try {
    return await transact(async session => {
      await requireManager(shop, actor, session)
      const existing = await replay(session)
      if (existing) return existing
      const names = await validateDestination(payload, shop, session)
      const [purchase] = await Purchase.create([{
        ...payload, ...names, shop, totalAmount, createdBy: actor, idempotencyKey, fingerprint,
        payments: payment ? [{ ...payment, createdBy: actor }] : [],
        ...(payload.status === 'received' ? { receivedAt: new Date(), receivedBy: actor } : {}),
      }], { session })
      if (payload.status === 'received') await movePurchaseStock(purchase, actor, session)
      return publicPurchase(purchase)
    })
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
      const winner = await replay()
      if (winner) return winner
    }
    throw error
  }
}
function payloadWithPayment({ idempotencyKey, ...payload }) { return payload }
export async function receivePurchase({ shop, actor, purchaseId }) {
  await requireManager(shop, actor)
  await RegionalStockOperation.init()
  return transact(async session => {
    await requireManager(shop, actor, session)
    const purchase = await findPurchase(shop, purchaseId, session)
    if (purchase.status === 'received') return publicPurchase(purchase)
    if (purchase.status === 'voided') throw inventoryError('Voided purchases cannot be received.', 409)
    await validateDestination(purchase, shop, session)
    const updated = await Purchase.findOneAndUpdate({ _id: purchase._id, shop, status: purchase.status, revision: purchase.revision }, { $set: { status: 'received', receivedAt: new Date(), receivedBy: actor }, $inc: { revision: 1 } }, { new: true, session, runValidators: true })
    if (!updated) throw inventoryError('Purchase changed concurrently. Reload before retrying.', 409)
    await movePurchaseStock(purchase, actor, session)
    return publicPurchase(updated)
  })
}
export async function payPurchase({ shop, actor, purchaseId, ...raw }) {
  const payment = purchasePaymentSchema.parse(raw)
  await requireManager(shop, actor)
  return transact(async session => {
    await requireManager(shop, actor, session)
    const purchase = await findPurchase(shop, purchaseId, session)
    const prior = (purchase.payments ?? []).find(row => row.idempotencyKey === payment.idempotencyKey)
    if (prior) {
      if (['amountPkr', 'method', 'businessDate', 'reference'].some(field => (prior[field] ?? '') !== (payment[field] ?? ''))) throw inventoryError('Payment key was used for another payment.', 409)
      return publicPurchase(purchase)
    }
    if (purchase.status === 'voided') throw inventoryError('Voided purchases cannot receive payments.', 409)
    const paid = (purchase.payments ?? []).reduce((sum, row) => sum + row.amountPkr, 0)
    if (!Number.isSafeInteger(paid + payment.amountPkr) || paid + payment.amountPkr > purchase.totalAmount) throw inventoryError('Payment exceeds the remaining purchase balance.')
    const updated = await Purchase.findOneAndUpdate({ _id: purchase._id, shop, revision: purchase.revision, status: purchase.status }, { $push: { payments: { ...payment, createdBy: actor } }, $inc: { revision: 1 } }, { new: true, session, runValidators: true })
    if (!updated) throw inventoryError('Purchase changed concurrently. Reload before retrying.', 409)
    return publicPurchase(updated)
  })
}
export async function voidPurchase({ shop, actor, purchaseId, reason }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 240) throw inventoryError('A reversal reason is required (maximum 240 characters).')
  await requireManager(shop, actor)
  await RegionalStockOperation.init()
  return transact(async session => {
    await requireManager(shop, actor, session)
    const purchase = await findPurchase(shop, purchaseId, session)
    if (purchase.status === 'voided') return publicPurchase(purchase)
    if ((purchase.payments ?? []).length) throw inventoryError('This purchase has recorded supplier payments. Resolve refunds through an approved accounting workflow before reversal.', 409)
    const updated = await Purchase.findOneAndUpdate({ _id: purchase._id, shop, revision: purchase.revision, status: purchase.status }, { $set: { status: 'voided', voidedAt: new Date(), voidedBy: actor, voidReason: reason.trim() }, $inc: { revision: 1 } }, { new: true, session, runValidators: true })
    if (!updated) throw inventoryError('Purchase changed concurrently. Reload before retrying.', 409)
    if (purchase.status === 'received') await movePurchaseStock(purchase, actor, session, true, reason.trim())
    return publicPurchase(updated)
  })
}

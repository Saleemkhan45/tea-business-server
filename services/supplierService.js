import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { Supplier } from '../models/Supplier.js'
import { Purchase } from '../models/Purchase.js'
import { Item } from '../models/Item.js'
import { Region } from '../models/Region.js'
import { RegionalStockOperation } from '../models/RegionalStockOperation.js'
import { requireManager, objectId, inventoryError } from './regionalInventoryService.js'
import { regionalDate } from '../schemas/regionalSchemas.js'
import { isUncertainSupplierWrite, supplierError } from '../utils/supplierErrors.js'

const text = max => z.string().trim().max(max).default('')
const phone = text(40).refine(value => !value || (/^[+\d\s().-]{7,40}$/.test(value) && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15), 'Enter a valid phone number.')
const ids = z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).default([]).refine(value => new Set(value).size === value.length, 'Duplicate selections are not allowed.')
const offering = z.string().trim().min(1, 'Enter a product name or remove this row.').max(160).transform(value => value.replace(/\s+/g, ' '))
const offerings = z.array(offering).max(100).default([]).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, 'Product names must be unique within this supplier.')
export const supplierInput = z.object({
  name: z.string().trim().min(1).max(160).transform(value => value.replace(/\s+/g, ' ')), contactPerson: text(160), phone, alternatePhone: phone,
  email: text(254).transform(value => value.toLowerCase()).refine(value => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email.'),
  city: text(120), address: text(500), notes: text(2000), regions: ids, products: ids, productOfferings: offerings,
  status: z.enum(['active', 'inactive']).default('active'),
})
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const creationKey = z.string().trim().min(8).max(128)
// Reuse the existing unique _id index for replay safety; no index migration or backfill.
export const supplierCreationId = (shop, key) => digest([String(shop), key]).slice(0, 24)
function publicSupplier(doc) {
  const { creationIdempotencyKey, creationFingerprint, profileHistory, ...record } = doc.toObject ? doc.toObject() : doc
  return { ...record, revision: record.revision ?? 0 }
}
function duplicateSupplier(row) {
  return supplierError('SUPPLIER_ALREADY_EXISTS', 'A supplier with this name already exists.', 409, { existingSupplierId: String(row._id) })
}
function findName(shop, name, excludeId) {
  const pattern = name.split(' ').map(escape).join('\\s+')
  return Supplier.findOne({ shop, name: { $regex: `^\\s*${pattern}\\s*$`, $options: 'i' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean()
}
async function findCreation(shop, key) {
  return Supplier.findOne({ shop, _id: supplierCreationId(shop, key) }).select('+creationIdempotencyKey +creationFingerprint').read('primary').readConcern('majority').lean()
}
export async function reconcileSupplier({ shop, creationIdempotencyKey }) {
  const key = creationKey.parse(creationIdempotencyKey)
  const supplier = await findCreation(shop, key)
  if (!supplier || supplier.creationIdempotencyKey !== key) return { status: 'unconfirmed' }
  return { status: 'confirmed', supplier: publicSupplier(supplier) }
}
function dates(from, to) {
  if (from) regionalDate.parse(from)
  if (to) regionalDate.parse(to)
  if (from && to && from > to) throw inventoryError('End date must follow start date.')
  return from || to ? { businessDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}
}
export function supplierStats(rows) {
  const active = rows.filter(row => row.status !== 'voided')
  const invoices = active.filter(row => row.receivingRegion && Array.isArray(row.payments))
  const paid = row => (row.payments ?? []).reduce((sum, payment) => sum + payment.amountPkr, 0)
  return {
    quantityKg: active.reduce((sum, row) => sum + Math.round(row.quantityKg * 1000), 0) / 1000,
    valuePkr: active.reduce((sum, row) => sum + row.totalAmount, 0),
    invoicedPkr: invoices.reduce((sum, row) => sum + row.totalAmount, 0),
    paymentsPkr: invoices.reduce((sum, row) => sum + paid(row), 0),
    outstandingPkr: invoices.reduce((sum, row) => sum + Math.max(0, row.totalAmount - paid(row)), 0),
    unknownPayableCount: active.length - invoices.length,
    count: active.length, lastPurchase: active.map(row => row.businessDate).sort().at(-1) ?? null,
  }
}
async function references(shop, input) {
  for (const [model, field] of [[Region, 'regions'], [Item, 'products']]) {
    const count = await model.countDocuments({ shop, _id: { $in: input[field] } })
    if (count !== input[field].length) throw inventoryError(`Choose shop-owned ${field}.`)
  }
}
export async function saveSupplier({ shop, actor, supplierId, revision, creationIdempotencyKey, ...raw }) {
  await requireManager(shop, actor)
  const input = supplierInput.parse(raw)
  const id = supplierId ? objectId(supplierId, 'Supplier') : undefined
  const key = !id ? creationKey.parse(creationIdempotencyKey ?? randomUUID()) : undefined
  const fingerprint = digest(input)
  const replay = async () => {
    const prior = await findCreation(shop, key)
    if (!prior) return null
    if (prior.creationIdempotencyKey !== key || prior.creationFingerprint !== fingerprint) throw supplierError('IDEMPOTENCY_CONFLICT', 'This supplier request key belongs to different information. Open the saved supplier before continuing.', 409)
    return publicSupplier(prior)
  }
  const resolveNameDuplicate = async duplicate => {
    if (!id) {
      const prior = await replay()
      if (prior) return prior
      // A local read can see the operation before a majority read confirms it.
      if (String(duplicate._id) === supplierCreationId(shop, key)) {
        throw supplierError('SUPPLIER_SAVE_FAILED', 'Saving this supplier request is still unconfirmed. Use the read-only check before another write.', 503, { outcomeUncertain: true })
      }
    }
    throw duplicateSupplier(duplicate)
  }
  if (!id) { const prior = await replay(); if (prior) return prior }
  let before, editFingerprint, editKey
  if (id) {
    z.number().int().nonnegative().safe().parse(revision)
    before = await Supplier.findOne({ shop, _id: id }).select('+profileHistory').lean()
    if (!before) throw supplierError('SUPPLIER_NOT_FOUND', 'Supplier not found.', 404)
    editFingerprint = digest({ revision, actor: String(actor), input })
    editKey = `edit:${revision}:${editFingerprint}`
    if (before.profileHistory?.some(entry => entry.key === editKey)) return publicSupplier(before)
    if ((before.revision ?? 0) !== revision) throw supplierError('SUPPLIER_EDIT_CONFLICT', 'Supplier changed. Reopen the record before saving again.', 409)
  }
  await references(shop, input)
  const duplicate = await findName(shop, input.name, id)
  if (duplicate) {
    // A same-key request may have committed while references/name were checked.
    // Resolve replay or payload conflict before reporting a genuine name duplicate.
    return resolveNameDuplicate(duplicate)
  }
  const writeConcern = { w: 'majority', wtimeout: 10000 }
  try {
    if (!id) {
      await Supplier.init()
      const [created] = await Supplier.create([{
        ...input, _id: supplierCreationId(shop, key), shop, createdBy: actor, updatedBy: actor,
        creationIdempotencyKey: key, creationFingerprint: fingerprint,
        profileHistory: [{ revision: 0, key, fingerprint, action: 'create', changes: Object.entries(input).map(([field, next]) => ({ field, previous: null, next })), modifiedBy: actor, createdAt: new Date() }],
      }], { writeConcern })
      return publicSupplier(created)
    }
    const changes = Object.entries(input).filter(([field, next]) => JSON.stringify(before[field] ?? (Array.isArray(next) ? [] : '')) !== JSON.stringify(next))
      .map(([field, next]) => ({ field, previous: before[field] ?? null, next }))
    if (!changes.length) return publicSupplier(before)
    if (!Number.isSafeInteger(revision + 1)) throw supplierError('SUPPLIER_EDIT_CONFLICT', 'Supplier revision limit reached. No changes were saved.', 409)
    const entry = { revision: revision + 1, key: editKey, fingerprint: editFingerprint, action: 'edit', changes, modifiedBy: actor, createdAt: new Date() }
    // Never discard audit history to make room. Fail before changing the profile.
    if (Buffer.byteLength(JSON.stringify([...(before.profileHistory ?? []), entry])) > 8 * 1024 * 1024) throw supplierError('SUPPLIER_AUDIT_CAPACITY', 'Profile history requires approved archival before another edit. No changes were saved.', 409)
    // Legacy documents without a revision start at zero; the first edit claims it atomically.
    const filter = { shop, _id: id, ...(revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision }) }
    const supplier = await Supplier.findOneAndUpdate(filter, { $set: { ...input, updatedBy: actor }, $inc: { revision: 1 }, $push: { profileHistory: entry } }, { new: true, runValidators: true, writeConcern })
    if (!supplier) {
      const exists = await Supplier.findOne({ shop, _id: id }).select('+profileHistory').lean()
      if (!exists) throw supplierError('SUPPLIER_NOT_FOUND', 'Supplier not found.', 404)
      if (exists.profileHistory?.some(entry => entry.key === editKey)) return publicSupplier(exists)
      throw supplierError('SUPPLIER_EDIT_CONFLICT', 'Supplier changed. Reopen the record before saving again.', 409)
    }
    return publicSupplier(supplier)
  } catch (error) {
    if (error.code === 11000) {
      // A duplicate key proves this insert was rejected. Reconcile only by reads.
      if (!id) { const prior = await replay(); if (prior) return prior }
      const existing = await findName(shop, input.name, id)
      if (existing) return resolveNameDuplicate(existing)
      throw supplierError('SUPPLIER_SAVE_FAILED', 'A database constraint prevented this supplier save. No uniqueness rules were changed. Read-only index verification is required.', 409)
    }
    if (isUncertainSupplierWrite(error)) throw supplierError('SUPPLIER_SAVE_FAILED', 'Saving could not be confirmed. Check the saved supplier before attempting another write.', 503, { outcomeUncertain: true })
    throw error
  }
}
export async function listSuppliers({ shop, search = '', region, product, status, from, to }) {
  const filter = { shop }
  if (search) filter.$or = ['name', 'contactPerson', 'phone', 'alternatePhone'].map(field => ({ [field]: { $regex: escape(String(search).slice(0, 160)), $options: 'i' } }))
  if (region) filter.regions = objectId(region, 'Region')
  if (product) filter.products = objectId(product, 'Product')
  if (status) filter.status = z.enum(['active', 'inactive']).parse(status)
  const period = dates(from, to)
  const suppliers = await Supplier.find(filter).sort({ name: 1, _id: 1 }).lean()
  const purchases = await Purchase.find({ shop, supplier: { $in: suppliers.map(row => row._id) }, ...period }).lean()
  return { suppliers: suppliers.map(row => ({ ...row, revision: row.revision ?? 0, stats: supplierStats(purchases.filter(purchase => String(purchase.supplier) === String(row._id))) })), stats: supplierStats(purchases) }
}
export async function supplierDetails({ shop, supplierId, from, to }) {
  const supplier = await Supplier.findOne({ shop, _id: objectId(supplierId, 'Supplier') }).lean()
  if (!supplier) throw supplierError('SUPPLIER_NOT_FOUND', 'Supplier not found.', 404)
  const purchases = await Purchase.find({ shop, supplier: supplier._id, ...dates(from, to) }).sort({ businessDate: -1, createdAt: -1, _id: -1 }).lean()
  const movements = await RegionalStockOperation.find({ shop, purchase: { $in: purchases.map(row => row._id) }, type: { $in: ['purchase_receipt', 'purchase_reversal'] } }).sort({ createdAt: -1, _id: -1 }).lean()
  return { supplier: { ...supplier, revision: supplier.revision ?? 0 }, purchases, movements, stats: supplierStats(purchases) }
}

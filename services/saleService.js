import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { Customer } from '../models/Customer.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { Item } from '../models/Item.js'
import { RegionalStock } from '../models/RegionalStock.js'
import { requireRegion, listInventory, inventoryError } from './regionalInventoryService.js'
import { Sale, SALE_IDEMPOTENCY_KEY_MAX_LENGTH } from '../models/Sale.js'
import { Shop } from '../models/Shop.js'
import { User } from '../models/User.js'
import * as customerLedgerService from './customerLedgerService.js'
import * as customerDirectoryService from './customerDirectoryService.js'
import * as notificationService from './notificationService.js'
import { getBusinessDate } from '../utils/businessDay.js'

const SALE_PAYMENT_METHODS = ['cash', 'credit', 'bank_transfer', 'card', 'cheque', 'other']
const SALE_STATUSES = ['completed', 'pending']
const SALE_TEA_TYPES = ['green', 'black', 'jasmine', 'herbal', 'other']
const SALE_EDIT_HISTORY_FIELDS = [
  'salespersonName',
  'customer', 'customerName', 'businessDate', 'teaType', 'stockLocationId', 'sellingRegion', 'sellingRegionName',
  'quantityKg', 'unitPrice', 'totalAmount', 'amountPaid', 'receivedPaymentMethod', 'status', 'paymentMethod', 'notes', 'createdBy',
]
const ITEM_TEA_TYPE_BY_SALE_TEA_TYPE = {
  green: 'Green Tea',
  black: 'Black Tea',
  jasmine: 'Jasmine Tea',
  herbal: 'Herbal Blend',
  other: 'Other',
}

function requireObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw new TypeError(`${label} must be a valid ID.`)
  return value
}

function requireText(value, label, maxLength) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || trimmed.length > maxLength) throw new TypeError(`${label} is required and must be at most ${maxLength} characters.`)
  return trimmed
}

function normalizeNotes(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim().length > 500) throw new TypeError('Notes must be at most 500 characters.')
  return value.trim() || null
}

function normalizeOptionalText(value, label, maxLength) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new RangeError(`${label} must be at most ${maxLength} characters.`)
  return trimmed || undefined
}

function normalizeNewCustomer(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('New customer details are invalid.')
  const phone = normalizeOptionalText(value.phone, 'Customer phone', 40)
  if (phone && (!/^\+?[0-9\s().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 7)) {
    throw new TypeError('Customer phone must be a valid phone number.')
  }
  const openingBalancePkr = value.openingBalancePkr ?? 0
  if (!Number.isSafeInteger(openingBalancePkr) || openingBalancePkr < 0) {
    throw new RangeError('Opening balance must be a non-negative whole PKR amount.')
  }
  return {
    name: requireText(value.name, 'Customer name', 160),
    phone,
    address: normalizeOptionalText(value.address, 'Customer address', 300),
    region: normalizeOptionalText(value.region, 'Customer region', 120),
    city: normalizeOptionalText(value.city, 'Customer city', 120),
    notes: normalizeOptionalText(value.notes, 'Customer notes', 1000),
    openingBalancePkr,
  }
}

function requireBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('Business date must be a valid YYYY-MM-DD date.')
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError('Business date must be a valid YYYY-MM-DD date.')
  }
  return value
}

function requireQuantityKg(value) {
  const quantityKg = Number(value)
  if (!Number.isFinite(quantityKg) || quantityKg <= 0) throw new RangeError('Quantity must be greater than zero.')
  const grams = Math.round(quantityKg * 1000)
  if (!Number.isSafeInteger(grams) || Math.abs(quantityKg - grams / 1000) >= 1e-9) {
    throw new RangeError('Quantity must use no more than three decimal places.')
  }
  return quantityKg
}

function requireUnitPrice(value) {
  const unitPrice = Number(value)
  if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
    throw new RangeError('Unit price must be a non-negative integer PKR value.')
  }
  return unitPrice
}

function calculateSaleAmountPkr(quantityKg, unitPrice) {
  const quantityGrams = Math.round(quantityKg * 1000)
  const thousandths = quantityGrams * unitPrice
  if (!Number.isSafeInteger(thousandths) || thousandths % 1000 !== 0) {
    throw new RangeError('Quantity and unit price must produce a whole PKR total.')
  }
  return thousandths / 1000
}

function sameObjectId(first, second) {
  if (!first || !second) return false
  return String(first) === String(second)
}

function withSession(query, options) {
  return options.session ? query.session(options.session) : query
}

async function requireShop(scope, options = {}) {
  const exists = await withSession(Shop.exists({ _id: scope.shop }), options)
  if (!exists) throw new Error('Shop not found.')
}

async function requireCustomer(scope, options = {}) {
  await requireShop(scope, options)
  const customer = await withSession(Customer.findOne({ _id: scope.customer, shop: scope.shop }), options).lean()
  if (!customer) throw new Error('Customer not found.')
  return customer
}

async function requireActor(shop, actor, options = {}) {
  requireObjectId(actor, 'Operator')
  const user = await withSession(User.exists({ _id: actor, shop, status: 'active' }), options)
  if (!user) throw new Error('Operator not found.')
}

async function findStockItem({ shop, stockLocationId, teaType, sellingRegion }, options = {}) {
  if (sellingRegion) {
    const region = await requireRegion(shop, sellingRegion, options.session)
    const stock = await withSession(RegionalStock.findOne({ _id: requireObjectId(stockLocationId, 'Stock location'), shop, region: sellingRegion }), options).lean()
    if (!stock) throw inventoryError('Regional stock is unavailable.', 404)
    const product = await withSession(Item.findOne({ _id: stock.item, shop, status: 'active' }), options).lean()
    if (!product || product.teaType !== ITEM_TEA_TYPE_BY_SALE_TEA_TYPE[teaType]) throw inventoryError('Regional product is unavailable or tea type does not match.')
    return { ...product, _id: stock._id, productId: product._id, stockKg: stock.quantityGrams / 1000, sellingRegion, sellingRegionName: region.name }
  }
  const itemId = requireObjectId(stockLocationId, 'Stock location')
  const item = await withSession(Item.findOne({ _id: itemId, shop, status: 'active' }), options)
  validateStockItemForSale(item, { shop, stockLocationId: itemId, teaType })
  return item
}

function validateStockItemForSale(item, { shop, stockLocationId, teaType }) {
  const itemId = requireObjectId(stockLocationId, 'Stock location')
  if (!item) throw new Error('Stock location not found.')
  if (!sameObjectId(item._id, itemId) || !sameObjectId(item.shop, shop) || item.status !== 'active') {
    throw new Error('Stock location not found.')
  }
  if (item.teaType !== ITEM_TEA_TYPE_BY_SALE_TEA_TYPE[teaType]) {
    throw new Error('Stock location tea type does not match the sale tea type.')
  }
  return itemId
}

async function decreaseStock({ shop, stockLocationId, teaType, quantityKg, createdBy, reason, validatedStockItem, sellingRegion }, options = {}) {
  const itemId = requireObjectId(stockLocationId, 'Stock location')
  if (sellingRegion) {
    await findStockItem({ shop, stockLocationId, teaType, sellingRegion }, options)
    const grams = Math.round(quantityKg * 1000)
    const before = await withSession(RegionalStock.findOneAndUpdate(
      { _id: itemId, shop, region: sellingRegion, quantityGrams: { $gte: grams } },
      { $inc: { quantityGrams: -grams } }, { new: false, runValidators: true },
    ), options)
    if (!before) throw new RangeError('Insufficient stock for sale.')
    return { item: before.item, regionalStock: before._id, region: before.region, type: reason === 'Sale update' ? 'sale_update_adjustment' : 'sale_decrease', quantityKg, stockBeforeKg: before.quantityGrams / 1000, stockAfterKg: (before.quantityGrams - grams) / 1000, createdBy, reason }
  }
  if (validatedStockItem) {
    validateStockItemForSale(validatedStockItem, { shop, stockLocationId: itemId, teaType })
  } else {
    await findStockItem({ shop, stockLocationId: itemId, teaType }, options)
  }
  const item = await withSession(Item.findOneAndUpdate(
    { _id: itemId, shop, status: 'active', stockKg: { $gte: quantityKg } },
    { $inc: { stockKg: -quantityKg } },
    { new: false, runValidators: true },
  ), options)
  if (!item) throw new RangeError('Insufficient stock for sale.')

  return {
    item: item._id,
    type: reason === 'Sale update' ? 'sale_update_adjustment' : 'sale_decrease',
    quantityKg,
    stockBeforeKg: item.stockKg,
    stockAfterKg: item.stockKg - quantityKg,
    createdBy,
    reason,
  }
}

async function restoreStock({ shop, stockLocationId, teaType, quantityKg, createdBy, reason, sellingRegion }, options = {}) {
  if (sellingRegion) {
    // Restoration uses the original record even after region/product deactivation.
    const grams = Math.round(quantityKg * 1000)
    const before = await withSession(RegionalStock.findOneAndUpdate(
      { _id: requireObjectId(stockLocationId, 'Stock location'), shop, region: sellingRegion, quantityGrams: { $lte: Number.MAX_SAFE_INTEGER - grams } },
      { $inc: { quantityGrams: grams } }, { new: false, runValidators: true },
    ), options)
    if (!before) throw inventoryError('Original regional stock is unavailable for restoration.', 409)
    return { item: before.item, regionalStock: before._id, region: before.region, type: reason === 'Sale update' ? 'sale_update_adjustment' : 'sale_restore', quantityKg, stockBeforeKg: before.quantityGrams / 1000, stockAfterKg: (before.quantityGrams + grams) / 1000, createdBy, reason }
  }
  const item = await findStockItem({ shop, stockLocationId, teaType }, options)
  const before = item.stockKg
  item.stockKg += quantityKg
  await item.save({ session: options.session })

  return {
    item: item._id,
    type: reason === 'Sale update' ? 'sale_update_adjustment' : 'sale_restore',
    quantityKg,
    stockBeforeKg: before,
    stockAfterKg: item.stockKg,
    createdBy,
    reason,
  }
}

function hasRecordedInventoryEffect(sale) {
  return Array.isArray(sale.inventoryMovements) && sale.inventoryMovements.length > 0
}

async function applyInventoryForNewSale(payload, validatedStockItem, options = {}) {
  return decreaseStock({
    shop: payload.shop,
    stockLocationId: payload.stockLocationId,
    sellingRegion: payload.sellingRegion,
    teaType: payload.teaType,
    quantityKg: payload.quantityKg,
    createdBy: payload.createdBy,
    reason: 'Sale created',
    validatedStockItem,
  }, options)
}

async function applyInventoryForSaleUpdate(existing, normalized, options = {}) {
  const movements = []
  await findStockItem({
    shop: normalized.shop,
    stockLocationId: normalized.stockLocationId,
    sellingRegion: normalized.sellingRegion,
    teaType: normalized.teaType,
  }, options)

  if (!sameObjectId(existing.stockLocationId, normalized.stockLocationId)) {
    movements.push(await restoreStock({
      shop: normalized.shop,
      stockLocationId: existing.stockLocationId,
      sellingRegion: existing.sellingRegion,
      teaType: existing.teaType,
      quantityKg: existing.quantityKg,
      createdBy: normalized.createdBy,
      reason: 'Sale update',
    }, options))
    movements.push(await decreaseStock({
      shop: normalized.shop,
      stockLocationId: normalized.stockLocationId,
      sellingRegion: normalized.sellingRegion,
      teaType: normalized.teaType,
      quantityKg: normalized.quantityKg,
      createdBy: normalized.createdBy,
      reason: 'Sale update',
    }, options))
    return movements
  }

  const quantityDelta = normalized.quantityKg - existing.quantityKg
  if (quantityDelta > 0) {
    movements.push(await decreaseStock({
      shop: normalized.shop,
      stockLocationId: normalized.stockLocationId,
      sellingRegion: normalized.sellingRegion,
      teaType: normalized.teaType,
      quantityKg: quantityDelta,
      createdBy: normalized.createdBy,
      reason: 'Sale update',
    }, options))
  } else if (quantityDelta < 0) {
    movements.push(await restoreStock({
      shop: normalized.shop,
      stockLocationId: normalized.stockLocationId,
      sellingRegion: normalized.sellingRegion,
      teaType: normalized.teaType,
      quantityKg: Math.abs(quantityDelta),
      createdBy: normalized.createdBy,
      reason: 'Sale update',
    }, options))
  }

  return movements
}

async function evaluateStockAfterCommit(itemIds) {
  for (const itemId of [...new Set(itemIds.filter(Boolean).map(String))]) {
    try {
      await notificationService.evaluate({ type: 'stock', itemId })
    } catch {
      // Notification failures must not invalidate an already committed sale.
    }
  }
}

function buildSalePayload(input) {
  const quantityKg = requireQuantityKg(input.quantityKg)
  const unitPrice = requireUnitPrice(input.unitPrice)
  const sale = {
    shop: requireObjectId(input.shop, 'Shop'),
    customer: input.customer ? requireObjectId(input.customer, 'Customer') : undefined,
    customerName: input.customerName ? requireText(input.customerName, 'Customer name', 160) : undefined,
    businessDate: requireBusinessDate(input.businessDate),
    teaType: input.teaType,
    stockLocationId: requireObjectId(input.stockLocationId, 'Stock location'),
    ...(input.sellingRegion ? { sellingRegion: requireObjectId(input.sellingRegion, 'Selling region') } : {}),
    quantityKg,
    unitPrice,
    totalAmount: calculateSaleAmountPkr(quantityKg, unitPrice),
    status: input.status ?? 'completed',
    paymentMethod: input.paymentMethod ?? 'cash',
    createdBy: requireObjectId(input.createdBy, 'Creator'),
    notes: normalizeNotes(input.notes),
    salespersonName: normalizeOptionalText(input.salespersonName, 'Salesperson name', 160) ?? null,
    newCustomer: normalizeNewCustomer(input.newCustomer),
  }

  if (!SALE_TEA_TYPES.includes(sale.teaType)) throw new TypeError('Sale tea type is invalid.')
  if (!SALE_PAYMENT_METHODS.includes(sale.paymentMethod)) {
    throw new TypeError('Sale payment method is invalid.')
  }
  if (!SALE_STATUSES.includes(sale.status)) throw new TypeError('Sale status is invalid.')
  if (sale.newCustomer && sale.customer) throw new TypeError('Choose an existing customer or enter a new customer, not both.')
  if (sale.paymentMethod === 'credit' && !sale.customer && !sale.newCustomer) throw new TypeError('Customer is required for credit sales.')
  if (sale.newCustomer && sale.unitPrice <= 0) throw new RangeError('Unit price must be greater than zero for a new customer first sale.')
  if (sale.customerName && sale.customerName.trim().length > 160) throw new TypeError('Customer name is too long.')

  sale.amountPaid = input.amountPaid ?? (sale.paymentMethod === 'credit' ? 0 : sale.totalAmount)
  if (!Number.isSafeInteger(sale.amountPaid) || sale.amountPaid < 0 || sale.amountPaid > sale.totalAmount) {
    throw new RangeError('Amount paid must be a non-negative whole PKR value no greater than the sale total.')
  }
  if (sale.paymentMethod !== 'credit' && sale.amountPaid !== sale.totalAmount) throw new RangeError('Non-credit sales must be fully paid.')
  sale.receivedPaymentMethod = sale.paymentMethod === 'credit' ? input.receivedPaymentMethod ?? 'cash' : sale.paymentMethod
  if (!SALE_PAYMENT_METHODS.includes(sale.receivedPaymentMethod) || sale.receivedPaymentMethod === 'credit') throw new TypeError('Received payment method is invalid.')
  sale.ledgerRecorded = Boolean(sale.customer)

  return sale
}

function toObject(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc
}

function saleRequestFingerprint(payload) {
  const request = {
    version: 1,
    customer: payload.customer ? new mongoose.Types.ObjectId(payload.customer).toHexString() : null,
    customerName: payload.customerName ?? null,
    businessDate: payload.businessDate,
    teaType: payload.teaType,
    stockLocationId: new mongoose.Types.ObjectId(payload.stockLocationId).toHexString(),
    quantityGrams: Math.round(payload.quantityKg * 1000),
    unitPrice: payload.unitPrice,
    status: payload.status,
    paymentMethod: payload.paymentMethod,
    amountPaid: payload.amountPaid,
    receivedPaymentMethod: payload.receivedPaymentMethod,
    notes: payload.notes,
    newCustomer: payload.newCustomer ?? null,
  }
  if (payload.sellingRegion) request.sellingRegion = String(payload.sellingRegion).toLowerCase()
  // Omit absent attribution to preserve fingerprints of existing requests.
  if (payload.salespersonName) request.salespersonName = payload.salespersonName
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function publicSale(sale) {
  const { idempotencyKey, idempotencyFingerprint, ledgerRevision, ...result } = toObject(sale)
  return result
}

function sameSaleContent(existing, next) {
  if ((existing.salespersonName ?? null) !== (next.salespersonName ?? null)) return false
  if (!sameObjectId(existing.customer, next.customer) && (existing.customer || next.customer)) return false
  return (existing.customerName ?? null) === (next.customerName ?? null)
    && existing.businessDate === next.businessDate
    && String(existing.sellingRegion ?? '') === String(next.sellingRegion ?? '')
    && existing.teaType === next.teaType
    && sameObjectId(existing.stockLocationId, next.stockLocationId)
    && existing.quantityKg === next.quantityKg
    && existing.unitPrice === next.unitPrice
    && existing.totalAmount === next.totalAmount
    && existing.status === next.status
    && existing.paymentMethod === next.paymentMethod
    && (existing.amountPaid ?? (existing.paymentMethod === 'credit' ? 0 : existing.totalAmount)) === next.amountPaid
    && (existing.receivedPaymentMethod ?? (existing.paymentMethod === 'credit' ? 'cash' : existing.paymentMethod)) === next.receivedPaymentMethod
    && (existing.notes ?? null) === (next.notes ?? null)
}

async function requireConsistentSaleCharge(sale, options) {
  const active = await withSession(CustomerLedgerTransaction.findOne({
    shop: sale.shop, saleId: sale._id, type: 'purchase', status: 'active',
  }), options)
  if (sale.paymentMethod === 'credit' || sale.ledgerRecorded) {
    if (!active) throw new Error('Credit Sale is missing its active ledger charge.')
    if (!sameObjectId(active.customer, sale.customer)) throw new Error('Sale ledger charge customer does not match the Sale.')
    if (active.amountPkr !== sale.totalAmount) throw new Error('Sale ledger charge amount does not match the Sale.')
  } else if (active) {
    throw new Error('Non-credit Sale has an active ledger charge.')
  }
  return active
}

async function createSaleLedger(sale, actor, session) {
  if (!sale.customer) return
  await customerLedgerService.createPurchase({
    shop: sale.shop, customer: sale.customer, saleId: sale._id,
    businessDate: sale.businessDate, teaType: sale.teaType, stockLocationId: sale.stockLocationId,
    quantityKg: sale.quantityKg, ratePerKgPkr: sale.unitPrice, createdBy: actor, notes: sale.notes,
  }, { session })
  if (sale.amountPaid > 0) {
    await customerLedgerService.createPayment({
      shop: sale.shop, customer: sale.customer, businessDate: sale.businessDate,
      amountPkr: sale.amountPaid, paymentMethod: sale.receivedPaymentMethod,
      createdBy: actor, notes: sale.notes,
    }, { session, saleId: sale._id })
  }
  if (await customerLedgerService.getCurrentBalance({ shop: sale.shop, customer: sale.customer }, { session }) < 0) {
    throw new RangeError('Sale change would create customer credit. Record a refund or adjustment first.')
  }
}

async function activeSalePayment(sale, session) {
  const payment = await CustomerLedgerTransaction.findOne({ shop: sale.shop, saleId: sale._id, type: 'payment', status: 'active' }).session(session)
  if (sale.ledgerRecorded && sale.amountPaid > 0 && (!payment || payment.amountPkr !== sale.amountPaid || !sameObjectId(payment.customer, sale.customer))) {
    throw new Error('Sale payment ledger entry is inconsistent.')
  }
  return payment
}

async function findIdempotentSale(scope, fingerprint, options = {}) {
  const sale = await withSession(Sale.findOne(scope).select('+idempotencyFingerprint'), options).lean()
  if (!sale) return null
  if (sale.idempotencyFingerprint !== fingerprint) {
    throw new Error('Idempotency key was already used for a different sale request.')
  }
  return publicSale(sale)
}

function isIdempotencyDuplicate(error) {
  return error.code === 11000 && error.keyPattern?.shop === 1 && error.keyPattern?.idempotencyKey === 1
}

export async function listSales({ shop, ...query } = {}, options = {}) {
  requireObjectId(shop, 'Shop')
  const filter = { shop }
  if (query.customerId) filter.customer = requireObjectId(query.customerId, 'Customer')
  if (query.status) filter.status = query.status
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod
  if (query.from || query.to) {
    filter.businessDate = {}
    if (query.from) filter.businessDate.$gte = requireBusinessDate(query.from)
    if (query.to) filter.businessDate.$lte = requireBusinessDate(query.to)
  }
  const sales = await Sale.find(filter).sort({ businessDate: -1, createdAt: -1, _id: -1 }).lean()
  const users = await User.find({ shop, _id: { $in: sales.map(sale => sale.createdBy).filter(Boolean) } }).select('_id name').lean()
  const names = new Map(users.map(user => [String(user._id), user.name]))
  return sales.map(sale => ({ ...sale, enteredByName: names.get(String(sale.createdBy)) ?? null }))
}

export async function getSale({ shop, saleId }, options = {}) {
  requireObjectId(shop, 'Shop')
  const document = await withSession(Sale.findOne({ _id: requireObjectId(saleId, 'Sale'), shop }), options).lean()
  return document
}

export async function createSale(input, options = {}) {
  const idempotencyKey = requireText(input.idempotencyKey, 'Idempotency key', SALE_IDEMPOTENCY_KEY_MAX_LENGTH)
  const payload = buildSalePayload({ ...input, shop: input.shop ?? input.businessShop })
  const fingerprint = saleRequestFingerprint(payload)
  const scope = { shop: payload.shop, idempotencyKey }

  await Sale.init()
  await CustomerLedgerTransaction.init()
  await requireActor(payload.shop, payload.createdBy, options)
  const replay = await findIdempotentSale(scope, fingerprint, options)
  if (replay) return replay

  let outcome
  const session = options.session ?? await mongoose.startSession()
  const shouldEndSession = !options.session

  try {
    outcome = await session.withTransaction(async () => {
      await requireActor(payload.shop, payload.createdBy, { ...options, session })
      // Recheck on every transaction retry, before consuming stock again.
      const existing = await findIdempotentSale(scope, fingerprint, { session })
      if (existing) return { sale: existing, stockItemId: null }

      const transactionPayload = { ...payload }
      if (payload.newCustomer) {
        const customer = await customerDirectoryService.createCustomer({
          ...payload.newCustomer,
          shop: payload.shop,
          createdBy: payload.createdBy,
          businessDate: payload.businessDate,
        }, { session })
        transactionPayload.customer = customer.id
        transactionPayload.customerName = customer.name
        transactionPayload.customerRegion = customer.region
        transactionPayload.ledgerRecorded = true
      } else if (payload.customer) {
        const customer = await requireCustomer({ shop: payload.shop, customer: payload.customer }, { ...options, session })
        transactionPayload.customerName = customer.name
        transactionPayload.customerRegion = customer.region
      }
      if (transactionPayload.customer && !(payload.newCustomer?.openingBalancePkr > 0)) {
        await customerLedgerService.claimCustomerLedgerWrite({ shop: payload.shop, customer: transactionPayload.customer }, { session })
      }

      const stock = await findStockItem(transactionPayload, { session })
      transactionPayload.productName = stock.name
      if (stock.productId) { transactionPayload.product = stock.productId; transactionPayload.sellingRegionName = stock.sellingRegionName }

      const inventoryMovement = await applyInventoryForNewSale(transactionPayload, stock, { session })
      const { newCustomer, ...salePayload } = transactionPayload

      const [sale] = await Sale.create([{
        ...salePayload,
        idempotencyKey,
        idempotencyFingerprint: fingerprint,
        inventoryMovements: [inventoryMovement],
      }], { session })

      await createSaleLedger(sale, payload.createdBy, session)
      return { sale: publicSale(sale), stockItemId: payload.sellingRegion ? null : inventoryMovement.item }
    })
  } catch (error) {
    if (!isIdempotencyDuplicate(error)) throw error
    // The failed transaction has aborted; read the winner outside its snapshot.
    const existing = await findIdempotentSale(scope, fingerprint)
    if (!existing) throw new Error('Sale creation is already in progress. Retry with the same idempotency key.')
    outcome = { sale: existing, stockItemId: null }
  } finally {
    if (shouldEndSession) await session.endSession()
  }

  if (outcome.stockItemId) await evaluateStockAfterCommit([outcome.stockItemId])
  return outcome.sale
}

export async function getEntryOptions({ shop, userId, regionId }) {
  if (regionId) {
    requireObjectId(shop, 'Shop')
    const operator = await User.findOne({ _id: userId, shop, status: 'active' }).select('_id name role').lean()
    if (!operator) throw new Error('Operator not found.')
    const rows = await listInventory({ shop, regionId })
    const items = rows.filter(row => row.status !== 'inactive').map(row => ({
      id: row.id, itemId: row.itemId, regionId: row.regionId, name: row.name,
      teaType: Object.keys(ITEM_TEA_TYPE_BY_SALE_TEA_TYPE).find(key => ITEM_TEA_TYPE_BY_SALE_TEA_TYPE[key] === row.teaType),
      availableKg: row.availableKg, sellingPrice: row.sellingPrice, lowStockThreshold: row.lowStockThreshold, updatedAt: row.updatedAt,
    }))
    return { operator: { id: String(operator._id), name: operator.name, role: operator.role }, items, inventorySummary: {
      totalItems: rows.length, activeItems: items.length, inactiveItems: rows.length - items.length,
      sellableItems: items.filter(item => item.availableKg > 0).length, outOfStockItems: items.filter(item => item.availableKg === 0).length,
    } }
  }
  requireObjectId(shop, 'Shop')
  const [operator, catalogItems, prices] = await Promise.all([
    User.findOne({ _id: userId, shop, status: 'active' }).select('_id name role').lean(),
    Item.find({ shop }).select('_id name teaType stockKg sellingPrice lowStockThreshold status updatedAt').sort({ name: 1 }).lean(),
    Sale.aggregate([
      { $match: { shop: new mongoose.Types.ObjectId(String(shop)), status: { $ne: 'voided' }, unitPrice: { $gte: 0 } } },
      { $sort: { businessDate: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: '$stockLocationId', price: { $first: '$unitPrice' } } },
    ]),
  ])
  if (!operator) throw new Error('Operator not found.')
  const items = catalogItems.filter(item => item.status === 'active')
  const recentPrice = new Map(prices.map(row => [String(row._id), row.price]))
  return {
    operator: { id: String(operator._id), name: operator.name, role: operator.role },
    inventorySummary: {
      totalItems: catalogItems.length,
      activeItems: items.length,
      inactiveItems: catalogItems.length - items.length,
      sellableItems: items.filter(item => item.stockKg > 0).length,
      outOfStockItems: items.filter(item => item.stockKg <= 0).length,
    },
    items: items.map(item => ({
      id: String(item._id), name: item.name,
      teaType: Object.keys(ITEM_TEA_TYPE_BY_SALE_TEA_TYPE).find(key => ITEM_TEA_TYPE_BY_SALE_TEA_TYPE[key] === item.teaType),
      availableKg: item.stockKg,
      sellingPrice: item.sellingPrice ?? recentPrice.get(String(item._id)) ?? null,
      lowStockThreshold: item.lowStockThreshold ?? 0,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt ?? null,
    })),
  }
}

export async function getSalesSummary({ shop, date }) {
  requireObjectId(shop, 'Shop')
  requireBusinessDate(date)
  const scopedShop = new mongoose.Types.ObjectId(String(shop))
  const [sales, receipts, balances] = await Promise.all([
    Sale.aggregate([
      { $match: { shop: scopedShop, businessDate: date, status: { $ne: 'voided' } } },
      { $group: {
        _id: null, salesPkr: { $sum: '$totalAmount' }, transactions: { $sum: 1 },
        greenKg: { $sum: { $cond: [{ $eq: ['$teaType', 'green'] }, '$quantityKg', 0] } },
        blackKg: { $sum: { $cond: [{ $eq: ['$teaType', 'black'] }, '$quantityKg', 0] } },
        khataPkr: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'credit'] }, '$totalAmount', 0] } },
        legacyCashPkr: { $sum: { $cond: [{ $and: [{ $ne: ['$ledgerRecorded', true] }, { $eq: ['$paymentMethod', 'cash'] }] }, '$totalAmount', 0] } },
      } },
    ]),
    CustomerLedgerTransaction.aggregate([
      { $match: { shop: scopedShop, businessDate: date, status: 'active', paymentMethod: 'cash' } },
      { $group: { _id: null, cashPkr: { $sum: { $switch: { branches: [
        { case: { $eq: ['$type', 'payment'] }, then: '$amountPkr' },
        { case: { $and: [{ $eq: ['$type', 'adjustment'] }, { $ne: [{ $ifNull: ['$reversalOf', null] }, null] }] }, then: { $multiply: ['$amountPkr', -1] } },
      ], default: 0 } } } } },
    ]),
    CustomerLedgerTransaction.aggregate([
      { $match: { shop: scopedShop, status: 'active' } },
      { $group: { _id: '$customer', balance: { $sum: { $cond: [{ $in: ['$type', ['payment', 'return']] }, { $multiply: ['$amountPkr', -1] }, '$amountPkr'] } } } },
      { $group: { _id: null, outstandingPkr: { $sum: { $max: [0, '$balance'] } } } },
    ]),
  ])
  const day = sales[0] ?? {}
  return { date, salesPkr: day.salesPkr ?? 0, greenKg: day.greenKg ?? 0, blackKg: day.blackKg ?? 0,
    transactions: day.transactions ?? 0, khataPkr: day.khataPkr ?? 0,
    cashReceivedPkr: (day.legacyCashPkr ?? 0) + (receipts[0]?.cashPkr ?? 0), outstandingPkr: balances[0]?.outstandingPkr ?? 0 }
}

export async function updateSale(input, options = {}) {
  const { saleId, shop, ...changes } = input
  const saleObjectId = requireObjectId(saleId, 'Sale')
  const shopObjectId = requireObjectId(shop, 'Shop')
  await CustomerLedgerTransaction.init()
  const session = options.session ?? await mongoose.startSession()
  const shouldEndSession = !options.session

  let updated
  const affectedStockItemIds = []
  try {
    await session.withTransaction(async () => {
      const existingDocument = await Sale.findOne({ _id: saleObjectId, shop: shopObjectId }).session(session)
      if (!existingDocument) throw new Error('Sale not found.')
      if (existingDocument.status === 'voided') throw new Error('Sale is already voided.')

      const existing = toObject(existingDocument)
      if (!hasRecordedInventoryEffect(existing)) {
        throw new Error('Legacy sale inventory audit is unavailable; editing requires inventory reconciliation.')
      }
      const next = {
        ...existing,
        ...changes,
        shop: shopObjectId,
        customer: changes.customer ?? changes.customerId ?? existing.customer,
        customerName: changes.customerName ?? existing.customerName,
        businessDate: requireBusinessDate(changes.businessDate ?? existing.businessDate),
        teaType: changes.teaType ?? existing.teaType,
        stockLocationId: changes.stockLocationId ?? existing.stockLocationId,
        quantityKg: changes.quantityKg ?? existing.quantityKg,
        unitPrice: changes.unitPrice ?? existing.unitPrice,
        status: changes.status ?? existing.status,
        paymentMethod: changes.paymentMethod ?? existing.paymentMethod,
        notes: changes.notes === undefined ? existing.notes : normalizeNotes(changes.notes),
        amountPaid: changes.amountPaid ?? (changes.paymentMethod && changes.paymentMethod !== existing.paymentMethod ? undefined : existing.amountPaid),
        receivedPaymentMethod: changes.receivedPaymentMethod ?? existing.receivedPaymentMethod,
        createdBy: changes.createdBy ?? existing.createdBy,
      }

      if (Boolean(existing.sellingRegion) !== Boolean(next.sellingRegion)) throw inventoryError('Legacy sale stock requires explicit reconciliation before changing its stock system.', 409)
      const normalized = buildSalePayload(next)
      await requireActor(normalized.shop, normalized.createdBy, { ...options, session })
      if (normalized.customer) {
        await requireCustomer({ shop: normalized.shop, customer: normalized.customer }, { ...options, session })
      }

      const oldActivePurchase = await requireConsistentSaleCharge(existing, { session })
      const oldPayment = await activeSalePayment(existing, session)
      if (sameSaleContent(existing, normalized)) {
        updated = publicSale(existing)
        return
      }

      // Use the same customer write boundary as payments, in stable order on reassignment.
      for (const customer of [...new Set([existing.customer, normalized.customer].filter(Boolean).map(String))].sort()) {
        await customerLedgerService.claimCustomerLedgerWrite({ shop: shopObjectId, customer }, { session })
      }

      const inventoryMovements = await applyInventoryForSaleUpdate(existing, normalized, { ...options, session })
      affectedStockItemIds.push(...inventoryMovements.filter(movement => !movement.regionalStock).map(movement => movement.item))

      if (oldActivePurchase) {
        await customerLedgerService.voidSalePurchase({
          shop: normalized.shop,
          customer: existing.customer,
          saleId: existing._id,
          transactionId: oldActivePurchase._id,
          voidedBy: normalized.createdBy,
          voidReason: 'Replaced by sale update',
        }, { session })
      }
      if (oldPayment) {
        await customerLedgerService.voidSalePurchase({
          shop: shopObjectId, customer: existing.customer, saleId: existing._id,
          transactionId: oldPayment._id, voidedBy: normalized.createdBy, voidReason: 'Replaced by sale update',
        }, { session })
      }
      const customer = normalized.customer ? await requireCustomer({ shop: shopObjectId, customer: normalized.customer }, { session }) : null
      const item = await findStockItem(normalized, { session })
      normalized.customerName = customer?.name ?? normalized.customerName
      normalized.customerRegion = customer?.region
      normalized.productName = item.name
      if (item.productId) { normalized.product = item.productId; normalized.sellingRegionName = item.sellingRegionName }

      const sale = await Sale.findOneAndUpdate(
        { _id: existing._id, shop: normalized.shop },
        {
          $set: { ...normalized, createdBy: existing.createdBy },
          $push: {
            editHistory: {
              ...Object.fromEntries(SALE_EDIT_HISTORY_FIELDS.map(field => [field, existing[field]])),
              changedBy: normalized.createdBy,
            },
            ...(inventoryMovements.length > 0 ? { inventoryMovements: { $each: inventoryMovements } } : {}),
          },
        },
        { new: true, runValidators: true, session },
      )
      updated = toObject(sale)

      await createSaleLedger(sale, normalized.createdBy, session)
      if (existing.customer && !sameObjectId(existing.customer, normalized.customer)
        && await customerLedgerService.getCurrentBalance({ shop: shopObjectId, customer: existing.customer }, { session }) < 0) {
        throw new RangeError('Sale change would create customer credit. Record a refund or adjustment first.')
      }
    })
  } finally {
    if (shouldEndSession) await session.endSession()
  }

  await evaluateStockAfterCommit(affectedStockItemIds)
  return updated
}

export async function voidSale(input, options = {}) {
  const { saleId, shop, voidedBy, voidReason } = input
  const saleObjectId = requireObjectId(saleId, 'Sale')
  const shopObjectId = requireObjectId(shop, 'Shop')
  const voidOperator = requireObjectId(voidedBy, 'Void operator')
  const normalizedVoidReason = requireText(voidReason, 'Void reason', 240)
  await CustomerLedgerTransaction.init()
  const session = options.session ?? await mongoose.startSession()
  const shouldEndSession = !options.session

  let voided
  const affectedStockItemIds = []
  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findOne({ _id: saleObjectId, shop: shopObjectId }).session(session)
      if (!sale) throw new Error('Sale not found.')
      if (sale.status === 'voided') throw new Error('Sale is already voided.')

      await requireActor(shopObjectId, voidOperator, { ...options, session })

      if (sale.customer) await customerLedgerService.claimCustomerLedgerWrite({ shop: shopObjectId, customer: sale.customer }, { session, allowInactive: true })
      const activePurchase = await requireConsistentSaleCharge(sale, { session })
      const payment = await activeSalePayment(sale, session)
      if (activePurchase) {
        const balance = await customerLedgerService.getCurrentBalance({ shop: shopObjectId, customer: sale.customer }, { session })
        const reversedPaymentPkr = sale.ledgerRecorded ? payment?.amountPkr ?? 0 : 0
        if (balance < activePurchase.amountPkr - reversedPaymentPkr) {
          throw new RangeError('Sale cancellation would create a negative customer balance. Resolve later payments or ledger activity before cancelling this sale.')
        }
      }
      if (activePurchase && sale.ledgerRecorded) {
        const base = { shop: shopObjectId, customer: sale.customer, saleId: sale._id, status: 'active', businessDate: getBusinessDate(options.now), createdBy: voidOperator, notes: normalizedVoidReason }
        await CustomerLedgerTransaction.create([{
          ...base, type: 'return', amountPkr: sale.totalAmount, reversalOf: activePurchase._id,
          productName: sale.productName, teaType: sale.teaType, quantityKg: sale.quantityKg, ratePerKgPkr: sale.unitPrice,
          stockLocationId: sale.stockLocationId,
        }], { session })
        if (payment) await CustomerLedgerTransaction.create([{
          ...base, type: 'adjustment', amountPkr: payment.amountPkr, reversalOf: payment._id,
          reason: 'Sale cancellation: payment reversed', paymentMethod: payment.paymentMethod,
        }], { session })
      } else if (activePurchase) {
        await customerLedgerService.voidSalePurchase({
          shop: shopObjectId,
          customer: sale.customer,
          saleId: sale._id,
          transactionId: activePurchase._id,
          voidedBy: voidOperator,
          voidReason: normalizedVoidReason,
        }, { session })
      }

      if (hasRecordedInventoryEffect(sale)) {
        const inventoryMovement = await restoreStock({
          shop: shopObjectId,
          stockLocationId: sale.stockLocationId,
          sellingRegion: sale.sellingRegion,
          teaType: sale.teaType,
          quantityKg: sale.quantityKg,
          createdBy: voidOperator,
          reason: 'Sale voided',
        }, { ...options, session })
        sale.inventoryMovements.push(inventoryMovement)
        if (!inventoryMovement.regionalStock) affectedStockItemIds.push(inventoryMovement.item)
      }

      sale.status = 'voided'
      sale.voidedAt = options.now ?? new Date()
      sale.voidedBy = voidOperator
      sale.voidReason = normalizedVoidReason
      await sale.save({ session })
      voided = toObject(sale)
    })
  } finally {
    if (shouldEndSession) await session.endSession()
  }

  await evaluateStockAfterCommit(affectedStockItemIds)
  return voided
}

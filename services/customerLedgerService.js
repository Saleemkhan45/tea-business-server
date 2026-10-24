import mongoose from 'mongoose'
import { Customer } from '../models/Customer.js'
import { Sale } from '../models/Sale.js'
import { Shop } from '../models/Shop.js'
import { User } from '../models/User.js'
import { CollectionOccurrence } from '../models/CollectionSchedule.js'
import * as ledgerRepository from '../repositories/customerLedgerTransactionRepository.js'
import {
  balancePkr,
  customerSummary,
  dailyPaymentBuckets,
  ledgerRows,
  orderedTransactions,
  paymentCalendarBuckets,
  paymentInsight,
  reminderCandidate,
} from './customerLedgerCalculations.js'

const TEA_TYPES = new Set(['green', 'black', 'jasmine', 'herbal', 'other'])
const PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'card', 'cheque', 'other'])

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

function requireAmount(value, label, sign) {
  if (!Number.isSafeInteger(value) || (sign === 'positive' && value <= 0) || (sign === 'nonzero' && value === 0)) {
    throw new RangeError(`${label} must be ${sign === 'positive' ? 'a positive' : 'a nonzero'} integer PKR amount.`)
  }
  return value
}

function requireScope({ shop, customer }) {
  return { shop: requireObjectId(shop, 'Shop'), customer: requireObjectId(customer, 'Customer') }
}

function withSession(query, options) {
  return options.session ? query.session(options.session) : query
}

async function runLedgerTransaction(options, operation) {
  if (options.session) return operation(options)
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(() => operation({ ...options, session }))
  } finally {
    await session.endSession()
  }
}

async function getCustomer(scope, options, requireActive = false) {
  const shop = await withSession(Shop.exists({ _id: scope.shop }), options)
  if (!shop) throw new Error('Shop not found.')

  const customer = await withSession(Customer.findOne({ _id: scope.customer, shop: scope.shop }), options).lean()
  if (!customer) throw new Error('Customer not found.')
  if (requireActive && customer.status !== 'active') throw new Error('Customer is inactive.')
  return customer
}

export async function claimCustomerLedgerWrite(scope, options) {
  const customer = await withSession(Customer.findOneAndUpdate(
    { _id: scope.customer, shop: scope.shop, ...(options.allowInactive ? {} : { status: 'active' }) },
    { $inc: { ledgerRevision: 1 } },
    { new: true, runValidators: true },
  ), options).lean()
  if (!customer) throw new Error('Customer is inactive.')
  return customer
}

async function requireActor(shop, actor, options) {
  requireObjectId(actor, 'Operator')
  const user = await withSession(User.exists({ _id: actor, shop, status: 'active' }), options)
  if (!user) throw new Error('Operator not found.')
}

function baseTransaction(input) {
  return {
    shop: input.shop,
    customer: input.customer,
    businessDate: requireBusinessDate(input.businessDate),
    createdBy: requireObjectId(input.createdBy, 'Creator'),
    notes: normalizeNotes(input.notes),
    status: 'active',
  }
}

function requireDateRange({ startDate, endDate }) {
  requireBusinessDate(startDate)
  requireBusinessDate(endDate)
  if (startDate > endDate) throw new RangeError('Payment date range start must be on or before its end.')
}

export async function createPurchase(input, options = {}) {
  const scope = requireScope(input)
  const base = baseTransaction(input)
  const saleId = requireObjectId(input.saleId, 'Sale ID')
  const stockLocationId = requireText(input.stockLocationId, 'Stock location ID', 120)
  if (!TEA_TYPES.has(input.teaType)) throw new TypeError('Customer purchase tea type is invalid.')
  if (!Number.isFinite(input.quantityKg) || input.quantityKg <= 0) throw new RangeError('Quantity must be greater than zero.')
  const quantityGrams = Math.round(input.quantityKg * 1000)
  if (!Number.isSafeInteger(quantityGrams) || Math.abs(input.quantityKg - quantityGrams / 1000) >= 1e-9) {
    throw new RangeError('Quantity must use no more than three decimal places.')
  }
  if (!Number.isSafeInteger(input.ratePerKgPkr) || input.ratePerKgPkr < 0) throw new RangeError('Rate per kilogram must be a non-negative integer PKR amount.')
  const thousandths = quantityGrams * input.ratePerKgPkr
  if (!Number.isSafeInteger(thousandths) || thousandths % 1000 !== 0) {
    throw new RangeError('Quantity and rate must produce a whole PKR amount.')
  }

  async function createInSession(writeOptions) {
    await getCustomer(scope, writeOptions, true)
    await requireActor(scope.shop, base.createdBy, writeOptions)
    const sale = await withSession(Sale.findOne({ _id: saleId, shop: scope.shop }), writeOptions).lean()
    if (!sale) throw new Error('Sale not found.')
    if (String(sale.customer) !== String(scope.customer)) throw new Error('Sale customer does not match the ledger customer.')
    if (sale.paymentMethod !== 'credit' && !sale.ledgerRecorded) throw new Error('Sale is not a credit sale.')
    if (sale.status === 'voided') throw new Error('Voided Sale cannot receive a ledger charge.')
    if (sale.businessDate !== base.businessDate || sale.teaType !== input.teaType
      || String(sale.stockLocationId) !== stockLocationId || sale.quantityKg !== input.quantityKg
      || sale.unitPrice !== input.ratePerKgPkr || sale.totalAmount !== thousandths / 1000) {
      throw new Error('Ledger purchase details do not match the Sale.')
    }

    if (!options.session) {
      await claimCustomerLedgerWrite(scope, writeOptions)
      // A write to Sale makes a direct repair conflict with concurrent Sale edits or voids.
      const claimed = await Sale.findOneAndUpdate(
        { _id: saleId, shop: scope.shop, customer: scope.customer, paymentMethod: 'credit', status: { $ne: 'voided' } },
        { $inc: { ledgerRevision: 1 } },
        { session: writeOptions.session, new: true },
      ).lean()
      if (!claimed) throw new Error('Sale changed while adding its ledger charge. Retry the request.')
    }

    const active = await ledgerRepository.findActivePurchaseBySale({ shop: scope.shop, saleId }, writeOptions)
    if (active) throw new Error('Sale already has an active customer ledger charge.')
    return ledgerRepository.create({
      ...base,
      type: 'purchase',
      saleId: sale._id,
      teaType: sale.teaType,
      stockLocationId: sale.stockLocationId,
      quantityKg: sale.quantityKg,
      ratePerKgPkr: sale.unitPrice,
      amountPkr: thousandths / 1000,
      productName: sale.productName,
      salePaymentMethod: sale.paymentMethod,
    }, writeOptions)
  }

  if (options.session) return createInSession(options)
  await ledgerRepository.ensureActiveSalePurchaseIndex()
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(() => createInSession({ ...options, session }))
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.saleId === 1) {
      throw new Error('Sale already has an active customer ledger charge.')
    }
    throw error
  } finally {
    await session.endSession()
  }
}

export async function createPayment(input, options = {}) {
  const scope = requireScope(input)
  const base = baseTransaction(input)
  const amountPkr = requireAmount(input.amountPkr, 'Payment amount', 'positive')
  if (input.collectionOccurrence) {
    requireObjectId(input.collectionOccurrence, 'Collection occurrence')
    if (!input.idempotencyKey) throw new TypeError('Payment idempotency key is required for collection payments.')
  }
  const idempotencyKey = input.idempotencyKey === undefined ? undefined : requireText(input.idempotencyKey, 'Payment idempotency key', 120)
  if (!PAYMENT_METHODS.has(input.paymentMethod)) throw new TypeError('Customer payment method is invalid.')

  async function createInSession(writeOptions) {
    await getCustomer(scope, writeOptions, true)
    await requireActor(scope.shop, base.createdBy, writeOptions)
    await claimCustomerLedgerWrite(scope, writeOptions)
    // The customer revision claim serializes keyed payment retries with every ledger write.
    const transactions = idempotencyKey
      ? await ledgerRepository.findByShopAndCustomer(scope, writeOptions)
      : await ledgerRepository.findActiveByShopAndCustomer(scope, writeOptions)
    const existing = idempotencyKey && transactions.find(transaction => transaction.type === 'payment' && transaction.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.status !== 'active' || existing.saleId || options.saleId
        || existing.amountPkr !== amountPkr || existing.businessDate !== base.businessDate
        || existing.paymentMethod !== input.paymentMethod || String(existing.createdBy) !== String(base.createdBy)
        || (existing.notes || null) !== base.notes || (existing.reference || '') !== (input.reference || '')
        || String(existing.collectionOccurrence || '') !== String(input.collectionOccurrence || '')) {
        throw new Error('Payment idempotency key was already used for a different or voided payment.')
      }
      return existing
    }
    const active = transactions.filter(transaction => transaction.status === 'active')
    if (input.collectionOccurrence) {
      const occurrence = await CollectionOccurrence.findOne({ _id: input.collectionOccurrence, ...scope }).session(writeOptions.session).lean()
      if (!occurrence || occurrence.scheduledDate > base.businessDate) {
        throw Object.assign(new Error('Collection occurrence is invalid for this customer or payment date.'), { statusCode: 400 })
      }
    }
    if (amountPkr > balancePkr(active)) throw new RangeError('Payment cannot exceed the active customer balance.')

    const payment = await ledgerRepository.create({
      ...base, type: 'payment', amountPkr, paymentMethod: input.paymentMethod,
      reference: input.reference,
      ...(input.collectionOccurrence ? { collectionOccurrence: input.collectionOccurrence } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(options.saleId ? { saleId: options.saleId } : {}),
    }, writeOptions)
    return payment
  }

  return runLedgerTransaction(options, createInSession)
}

export async function createOpeningBalance(input, options = {}) {
  const scope = requireScope(input)
  const base = baseTransaction(input)
  const amountPkr = requireAmount(input.amountPkr, 'Opening balance amount', 'positive')

  return runLedgerTransaction(options, async writeOptions => {
    await getCustomer(scope, writeOptions, true)
    await requireActor(scope.shop, base.createdBy, writeOptions)
    await claimCustomerLedgerWrite(scope, writeOptions)
    const existing = await ledgerRepository.findRelevant({ ...scope, type: 'opening_balance', status: 'active' }, writeOptions)
    if (existing.length > 0) throw new Error('Customer already has an active opening balance.')
    const active = await ledgerRepository.findActiveByShopAndCustomer(scope, writeOptions)
    const transaction = { ...base, type: 'opening_balance', amountPkr }
    if (balancePkr([...active, transaction]) < 0) throw new RangeError('Opening balance would leave a negative customer balance.')
    return ledgerRepository.create(transaction, writeOptions)
  })
}

export async function createAdjustment(input, options = {}) {
  const scope = requireScope(input)
  const base = baseTransaction(input)
  const amountPkr = requireAmount(input.amountPkr, 'Adjustment amount', 'nonzero')
  const reason = requireText(input.reason, 'Adjustment reason', 240)

  return runLedgerTransaction(options, async writeOptions => {
    await getCustomer(scope, writeOptions, true)
    await requireActor(scope.shop, base.createdBy, writeOptions)
    await claimCustomerLedgerWrite(scope, writeOptions)
    const active = await ledgerRepository.findActiveByShopAndCustomer(scope, writeOptions)
    const transaction = { ...base, type: 'adjustment', amountPkr, reason }
    if (balancePkr([...active, transaction]) < 0) throw new RangeError('Adjustment cannot create a negative customer balance.')
    return ledgerRepository.create(transaction, writeOptions)
  })
}

export async function getCurrentBalance(scopeInput, options = {}) {
  const scope = requireScope(scopeInput)
  await getCustomer(scope, options)
  const active = await ledgerRepository.findActiveByShopAndCustomer(scope, options)
  return balancePkr(active)
}

export async function getLedger(scopeInput, options = {}) {
  const scope = requireScope(scopeInput)
  const customer = await getCustomer(scope, options)
  const transactions = orderedTransactions(await ledgerRepository.findByShopAndCustomer(scope, options))
  const users = await withSession(User.find({
    shop: scope.shop,
    _id: { $in: [...new Set(transactions.map(transaction => String(transaction.createdBy)))] },
  }).select('_id name'), options).lean()
  const names = new Map(users.map(user => [String(user._id), user.name]))
  const namedTransactions = transactions.map(transaction => ({
    ...transaction,
    enteredByName: names.get(String(transaction.createdBy)) ?? null,
  }))
  const rows = ledgerRows(namedTransactions)
  return { customerId: customer._id, transactions: namedTransactions, rows, currentBalancePkr: rows.at(-1)?.runningBalancePkr ?? 0 }
}

export async function getSummary(input, options = {}) {
  const scope = requireScope(input)
  const referenceDate = requireBusinessDate(input.referenceDate)
  const customer = await getCustomer(scope, options)
  const transactions = await ledgerRepository.findByShopAndCustomer(scope, options)
  return customerSummary(customer, transactions, referenceDate)
}

export async function getDailyPayments(input, options = {}) {
  const scope = requireScope(input)
  requireDateRange(input)
  await getCustomer(scope, options)
  const transactions = await ledgerRepository.findRelevant({
    ...scope, fromBusinessDate: input.startDate, toBusinessDate: input.endDate,
    type: 'payment', status: 'active',
  }, options)
  return dailyPaymentBuckets(transactions, input.startDate, input.endDate)
}

export async function getPaymentInsight(input, options = {}) {
  const scope = requireScope(input)
  requireDateRange(input)
  const referenceDate = requireBusinessDate(input.referenceDate)
  await getCustomer(scope, options)
  const transactions = await ledgerRepository.findByShopAndCustomer(scope, options)
  const buckets = dailyPaymentBuckets(transactions, input.startDate, input.endDate)
  return paymentInsight(buckets, referenceDate, balancePkr(transactions))
}

export async function getPaymentCalendar(input, options = {}) {
  return paymentCalendarBuckets(await getDailyPayments(input, options))
}

export async function getReminderCandidate(input, options = {}) {
  const scope = requireScope(input)
  const referenceDate = requireBusinessDate(input.referenceDate)
  if (!Number.isInteger(input.thresholdDays) || input.thresholdDays < 0) {
    throw new RangeError('Reminder threshold must be a non-negative integer number of days.')
  }
  const customer = await getCustomer(scope, options)
  const transactions = await ledgerRepository.findByShopAndCustomer(scope, options)
  return reminderCandidate(customer, transactions, referenceDate, input.thresholdDays)
}

async function voidExistingTransaction(input, options = {}, saleId = null) {
  const scope = requireScope(input)
  const transactionId = requireObjectId(input.transactionId, 'Transaction')
  const voidedBy = requireObjectId(input.voidedBy, 'Void operator')
  const voidReason = requireText(input.voidReason, 'Void reason', 240)
  async function voidInSession(writeOptions) {
    await getCustomer(scope, writeOptions)
    await requireActor(scope.shop, voidedBy, writeOptions)
    if (saleId === null) await claimCustomerLedgerWrite(scope, { ...writeOptions, allowInactive: true })
    const existing = await ledgerRepository.findById({ ...scope, transactionId }, writeOptions)
    if (!existing) throw new Error('Customer ledger transaction not found.')
    if (existing.status !== 'active') throw new Error('Customer ledger transaction is already voided.')
    if (saleId === null && existing.type === 'purchase' && existing.saleId) {
      throw new Error('Sale-linked ledger charges must be voided through the Sale.')
    }
    if (saleId === null && existing.saleId) throw new Error('Sale-linked ledger transactions must be reversed through the Sale.')
    if (saleId !== null && String(existing.saleId) !== String(saleId)) {
      throw new Error('Sale-linked ledger charge does not match the Sale.')
    }
    if (saleId === null) {
      const active = await ledgerRepository.findActiveByShopAndCustomer(scope, writeOptions)
      if (balancePkr(active.filter(transaction => String(transaction._id) !== String(existing._id))) < 0) {
        throw new RangeError('Ledger reversal would create a negative customer balance. Resolve later payments or ledger activity first.')
      }
    }

    const voided = await ledgerRepository.markVoided({
      ...scope,
      transactionId,
      voidedAt: writeOptions.now ?? new Date(),
      voidedBy,
      voidReason,
    }, writeOptions)
    if (!voided) throw new Error('Customer ledger transaction is already voided.')
    return voided
  }

  // Sale edits can temporarily remove a charge before its replacement is inserted.
  // Their owning Sale transaction validates the final balance and claims the customer.
  return saleId === null ? runLedgerTransaction(options, voidInSession) : voidInSession(options)
}

export function voidTransaction(input, options = {}) {
  return voidExistingTransaction(input, options)
}

export function voidSalePurchase(input, options = {}) {
  if (!options.session) throw new TypeError('Sale-linked ledger void requires a transaction session.')
  return voidExistingTransaction(input, options, requireObjectId(input.saleId, 'Sale ID'))
}

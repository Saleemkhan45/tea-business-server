import {
  CustomerLedgerTransaction,
  CUSTOMER_LEDGER_TRANSACTION_STATUSES,
  CUSTOMER_LEDGER_TRANSACTION_TYPES,
} from '../models/CustomerLedgerTransaction.js'
import mongoose from 'mongoose'

export const LEDGER_TRANSACTION_SORT_ASC = Object.freeze({ businessDate: 1, createdAt: 1, _id: 1 })
export const LEDGER_TRANSACTION_SORT_DESC = Object.freeze({ businessDate: -1, createdAt: -1, _id: -1 })

const TRANSACTION_TYPES = new Set(CUSTOMER_LEDGER_TRANSACTION_TYPES)
const TRANSACTION_STATUSES = new Set(CUSTOMER_LEDGER_TRANSACTION_STATUSES)

function isBlankIdentifier(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function requireIdentifier(value, label) {
  if (isBlankIdentifier(value)) throw new TypeError(`${label} is required.`)
  return value
}

function requireLedgerScope({ shop, customer }) {
  return {
    shop: requireIdentifier(shop, 'shop'),
    customer: requireIdentifier(customer, 'customer'),
  }
}

function requireTransactionId(transactionId) {
  return requireIdentifier(transactionId, 'transactionId')
}

function requireCustomerIds(customers) {
  if (!Array.isArray(customers)) throw new TypeError('customers is required.')
  return [...new Map(customers.map(customer => {
    const value = requireIdentifier(customer, 'customer')
    return [String(value), value]
  })).values()]
}

function normalizeMongoIdentifier(value) {
  return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : value
}

function assertKnownType(type) {
  if (type !== undefined && !TRANSACTION_TYPES.has(type)) {
    throw new TypeError(`Unsupported customer ledger transaction type: ${type}`)
  }
}

function requireKnownType(type) {
  if (isBlankIdentifier(type)) throw new TypeError('type is required.')
  assertKnownType(type)
  return type
}

function assertKnownStatus(status) {
  if (status !== undefined && !TRANSACTION_STATUSES.has(status)) {
    throw new TypeError(`Unsupported customer ledger transaction status: ${status}`)
  }
}

function buildDateRangeFilter(fromBusinessDate, toBusinessDate) {
  const range = {}
  if (fromBusinessDate) range.$gte = fromBusinessDate
  if (toBusinessDate) range.$lte = toBusinessDate
  return Object.keys(range).length > 0 ? { businessDate: range } : {}
}

function ledgerSort(direction = 'asc') {
  return direction === 'desc' ? LEDGER_TRANSACTION_SORT_DESC : LEDGER_TRANSACTION_SORT_ASC
}

function applyReadOptions(query, options = {}) {
  const scopedQuery = options.session ? query.session(options.session) : query
  const sortedQuery = scopedQuery.sort(ledgerSort(options.sortDirection))
  const skippedQuery = Number.isInteger(options.skip) && options.skip > 0
    ? sortedQuery.skip(options.skip)
    : sortedQuery
  const limitedQuery = Number.isInteger(options.limit) && options.limit > 0
    ? skippedQuery.limit(options.limit)
    : skippedQuery
  return limitedQuery.lean()
}

function writeOptions(options = {}) {
  return options.session ? { session: options.session } : {}
}

function toPlainObject(document) {
  return typeof document?.toObject === 'function' ? document.toObject() : document
}

async function executeAggregate(aggregate, options = {}) {
  const scopedAggregate = options.session ? aggregate.session(options.session) : aggregate
  return scopedAggregate.exec()
}

export function findById({ shop, customer, transactionId }, options = {}) {
  const query = CustomerLedgerTransaction.findOne({
    ...requireLedgerScope({ shop, customer }),
    _id: requireTransactionId(transactionId),
  })
  return (options.session ? query.session(options.session) : query).lean()
}

export function findActivePurchaseBySale({ shop, saleId }, options = {}) {
  const query = CustomerLedgerTransaction.findOne({
    shop: requireIdentifier(shop, 'shop'),
    saleId: requireIdentifier(saleId, 'saleId'),
    type: 'purchase',
    status: 'active',
  })
  return (options.session ? query.session(options.session) : query).lean()
}

export function ensureActiveSalePurchaseIndex() {
  return CustomerLedgerTransaction.init()
}

export function findByShopAndCustomer({ shop, customer, limit, skip, sortDirection } = {}, options = {}) {
  const query = CustomerLedgerTransaction.find(requireLedgerScope({ shop, customer }))
  return applyReadOptions(query, { limit, skip, sortDirection, session: options.session })
}

export function findByBusinessDateRange({
  shop,
  customer,
  fromBusinessDate,
  toBusinessDate,
  limit,
  skip,
  sortDirection,
} = {}, options = {}) {
  const scope = requireLedgerScope({ shop, customer })
  if (!fromBusinessDate) throw new TypeError('fromBusinessDate is required.')
  if (!toBusinessDate) throw new TypeError('toBusinessDate is required.')

  const query = CustomerLedgerTransaction.find({
    ...scope,
    businessDate: { $gte: fromBusinessDate, $lte: toBusinessDate },
  })
  return applyReadOptions(query, { limit, skip, sortDirection, session: options.session })
}

export function findByType({ shop, customer, type, limit, skip, sortDirection } = {}, options = {}) {
  const query = CustomerLedgerTransaction.find({
    ...requireLedgerScope({ shop, customer }),
    type: requireKnownType(type),
  })
  return applyReadOptions(query, { limit, skip, sortDirection, session: options.session })
}

export function findActiveByShopAndCustomer({ shop, customer, limit, skip, sortDirection } = {}, options = {}) {
  return findRelevant({
    shop,
    customer,
    status: 'active',
    limit,
    skip,
    sortDirection,
  }, options)
}

export function findRelevant({
  shop,
  customer,
  fromBusinessDate,
  toBusinessDate,
  type,
  status,
  limit,
  skip,
  sortDirection,
} = {}, options = {}) {
  assertKnownType(type)
  assertKnownStatus(status)

  const query = CustomerLedgerTransaction.find({
    ...requireLedgerScope({ shop, customer }),
    ...buildDateRangeFilter(fromBusinessDate, toBusinessDate),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  })
  return applyReadOptions(query, { limit, skip, sortDirection, session: options.session })
}

export async function aggregateActiveBalancesByCustomers({ shop, customers } = {}, options = {}) {
  const scopedShop = requireIdentifier(shop, 'shop')
  const customerIds = requireCustomerIds(customers)
  if (customerIds.length === 0) return new Map()

  const rows = await executeAggregate(CustomerLedgerTransaction.aggregate([
    {
      $match: {
        shop: normalizeMongoIdentifier(scopedShop),
        customer: { $in: customerIds.map(normalizeMongoIdentifier) },
        status: 'active',
      },
    },
    {
      $project: {
        customer: 1,
        balanceImpactPkr: {
          $switch: {
            branches: [
              { case: { $in: ['$type', ['payment', 'return']] }, then: { $multiply: ['$amountPkr', -1] } },
              { case: { $in: ['$type', ['purchase', 'opening_balance', 'adjustment']] }, then: '$amountPkr' },
            ],
            default: 0,
          },
        },
      },
    },
    { $group: { _id: '$customer', currentBalancePkr: { $sum: '$balanceImpactPkr' } } },
  ]), options)

  return new Map(rows.map(row => {
    if (!Number.isSafeInteger(row.currentBalancePkr)) throw new RangeError('Ledger balance exceeds the safe integer PKR range.')
    return [String(row._id), row.currentBalancePkr]
  }))
}

export async function create(data, options = {}) {
  const [created] = await CustomerLedgerTransaction.create([data], writeOptions(options))
  return toPlainObject(created)
}

export function markVoided({
  shop,
  customer,
  transactionId,
  voidedAt,
  voidedBy,
  voidReason,
}, options = {}) {
  return CustomerLedgerTransaction
    .findOneAndUpdate(
      {
        ...requireLedgerScope({ shop, customer }),
        _id: requireTransactionId(transactionId),
        status: 'active',
      },
      {
        $set: {
          status: 'voided',
          voidedAt,
          voidedBy,
          voidReason,
        },
      },
      {
        new: true,
        runValidators: true,
        ...writeOptions(options),
      },
    )
    .lean()
}

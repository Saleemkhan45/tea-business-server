import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import {
  CUSTOMER_DIRECTORY_DEFAULT_LIMIT,
  CUSTOMER_DIRECTORY_DEFAULT_PAGE,
  CUSTOMER_DIRECTORY_MAX_LIMIT,
  CUSTOMER_DIRECTORY_MAX_PAGE,
  CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH,
} from '../constants/customerDirectory.js'
import { Customer, CUSTOMER_STATUSES } from '../models/Customer.js'
import * as ledgerRepository from '../repositories/customerLedgerTransactionRepository.js'
import * as customerLedgerService from './customerLedgerService.js'

const CUSTOMER_STATUS_SET = new Set(CUSTOMER_STATUSES)
const CUSTOMER_DIRECTORY_SORT = Object.freeze({ name: 1, _id: 1 })

function requireObjectId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw new TypeError(`${label} must be a valid ID.`)
  return value
}

function normalizePositiveInteger(value, label, defaultValue, maxValue) {
  const normalized = value === undefined || value === null || value === '' ? defaultValue : Number(value)
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maxValue) {
    throw new RangeError(`${label} must be an integer between 1 and ${maxValue}.`)
  }
  return normalized
}

function normalizeStatus(status) {
  if (status === undefined || status === null || status === '') return undefined
  if (!CUSTOMER_STATUS_SET.has(status)) throw new TypeError('Customer status is invalid.')
  return status
}

function normalizeSearch(search) {
  if (search === undefined || search === null) return undefined
  if (typeof search !== 'string') throw new TypeError('Customer search must be text.')
  const trimmed = search.trim()
  if (trimmed.length > CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH) {
    throw new RangeError(`Customer search must be at most ${CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH} characters.`)
  }
  return trimmed || undefined
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function withSession(query, options) {
  return options.session ? query.session(options.session) : query
}

function normalizeOptionalText(value, label, maxLength) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new RangeError(`${label} must be at most ${maxLength} characters.`)
  return trimmed || undefined
}

function normalizePhone(value) {
  const phone = normalizeOptionalText(value, 'Customer phone', 40)
  if (phone && (!/^\+?[0-9\s().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 7)) {
    throw new TypeError('Customer phone must be a valid phone number.')
  }
  return phone
}

function normalizeOpeningBalance(value) {
  if (value === undefined || value === null || value === '') return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Opening balance must be a non-negative whole PKR amount.')
  }
  return value
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

function creationFingerprint(data, openingBalancePkr) {
  return createHash('sha256').update(JSON.stringify({
    name: data.name,
    phone: data.phone ?? null,
    address: data.address ?? null,
    region: data.region ?? null,
    city: data.city ?? null,
    notes: data.notes ?? null,
    openingBalancePkr,
  })).digest('hex')
}

async function balanceForCustomer(shop, customerId, options) {
  const balances = await ledgerRepository.aggregateActiveBalancesByCustomers({ shop, customers: [customerId] }, options)
  return balances.get(String(customerId)) ?? 0
}

async function findIdempotentCustomer(shop, idempotencyKey, fingerprint, options = {}) {
  if (!idempotencyKey) return null
  const customer = await withSession(Customer.findOne({ shop, creationIdempotencyKey: idempotencyKey })
    .select('+creationFingerprint'), options).lean()
  if (!customer) return null
  if (customer.creationFingerprint !== fingerprint) {
    throw new Error('Customer idempotency key was already used for different customer details.')
  }
  return {
    ...customerResponse(customer),
    currentBalancePkr: await balanceForCustomer(shop, customer._id, options),
  }
}

function isCreationIdempotencyDuplicate(error) {
  return error?.code === 11000 && error.keyPattern?.shop === 1 && error.keyPattern?.creationIdempotencyKey === 1
}

function customerResponse(customer) {
  return {
    id: String(customer._id),
    name: customer.name,
    phone: customer.phone ?? '',
    address: customer.address ?? '',
    status: customer.status,
    ...(customer.region ? { region: customer.region } : {}),
    ...(customer.city ? { city: customer.city } : {}),
    ...(customer.notes ? { notes: customer.notes } : {}),
    ...(customer.createdAt ? { createdAt: customer.createdAt instanceof Date ? customer.createdAt.toISOString() : customer.createdAt } : {}),
  }
}

export async function getCustomerById(input = {}, options = {}) {
  const shop = requireObjectId(input.shop, 'Shop')
  const customerId = requireObjectId(input.customerId, 'Customer')
  const customer = await withSession(Customer.findOne({ _id: customerId, shop })
    .select('_id name phone address region city notes status createdAt'), options).lean()
  if (!customer) throw new Error('Customer not found.')
  return customerResponse(customer)
}

export async function listCustomers(input = {}, options = {}) {
  const shop = requireObjectId(input.shop, 'Shop')
  const page = normalizePositiveInteger(input.page, 'Customer directory page', CUSTOMER_DIRECTORY_DEFAULT_PAGE, CUSTOMER_DIRECTORY_MAX_PAGE)
  const limit = normalizePositiveInteger(input.limit, 'Customer directory limit', CUSTOMER_DIRECTORY_DEFAULT_LIMIT, CUSTOMER_DIRECTORY_MAX_LIMIT)
  const status = normalizeStatus(input.status)
  const search = normalizeSearch(input.search)
  const filter = {
    shop,
    ...(status ? { status } : {}),
    ...(search ? {
      $or: [
        { name: { $regex: escapeRegExp(search), $options: 'i' } },
        { phone: { $regex: escapeRegExp(search), $options: 'i' } },
      ],
    } : {}),
  }
  const skip = (page - 1) * limit

  const [customers, total] = await Promise.all([
    withSession(Customer.find(filter)
      .select('_id name phone address region city status')
      .sort(CUSTOMER_DIRECTORY_SORT)
      .skip(skip)
      .limit(limit), options).lean(),
    withSession(Customer.countDocuments(filter), options),
  ])
  const balances = await ledgerRepository.aggregateActiveBalancesByCustomers({
    shop,
    customers: customers.map(customer => customer._id),
  }, options)

  return {
    customers: customers.map(customer => ({
      ...customerResponse(customer),
      currentBalancePkr: balances.get(String(customer._id)) ?? 0,
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  }
}

export async function createCustomer(input, options = {}) {
  const shop = requireObjectId(input.shop, 'Shop')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 160) throw new TypeError('Customer name is required and must be at most 160 characters.')
  const openingBalancePkr = normalizeOpeningBalance(input.openingBalancePkr)
  const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 'Customer idempotency key', 128)
  const data = {
    shop,
    name,
    phone: normalizePhone(input.phone),
    address: normalizeOptionalText(input.address, 'Customer address', 300),
    region: normalizeOptionalText(input.region, 'Customer region', 120),
    city: normalizeOptionalText(input.city, 'Customer city', 120),
    notes: normalizeOptionalText(input.notes, 'Customer notes', 1000),
    status: 'active',
  }
  const fingerprint = idempotencyKey ? creationFingerprint(data, openingBalancePkr) : undefined
  const businessDate = openingBalancePkr > 0 ? requireBusinessDate(input.businessDate) : undefined
  const createdBy = openingBalancePkr > 0 ? requireObjectId(input.createdBy, 'Creator') : undefined

  async function createInSession(writeOptions) {
    const replay = await findIdempotentCustomer(shop, idempotencyKey, fingerprint, writeOptions)
    if (replay) return replay
    const creationData = {
      ...data,
      ...(idempotencyKey ? { creationIdempotencyKey: idempotencyKey, creationFingerprint: fingerprint } : {}),
    }
    const customer = writeOptions.session
      ? (await Customer.create([creationData], { session: writeOptions.session }))[0]
      : await Customer.create(creationData)
    if (openingBalancePkr > 0) {
      await customerLedgerService.createOpeningBalance({
        shop,
        customer: customer._id,
        businessDate,
        amountPkr: openingBalancePkr,
        createdBy,
        notes: 'Opening Khata recorded during customer creation',
      }, writeOptions)
    }
    return { ...customerResponse(customer), currentBalancePkr: openingBalancePkr }
  }

  if (options.session) return createInSession(options)
  if (!idempotencyKey && openingBalancePkr === 0) return createInSession(options)

  if (idempotencyKey) {
    await Customer.init()
    const replay = await findIdempotentCustomer(shop, idempotencyKey, fingerprint)
    if (replay) return replay
  }

  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(() => createInSession({ ...options, session }))
  } catch (error) {
    if (!idempotencyKey || !isCreationIdempotencyDuplicate(error)) throw error
    const replay = await findIdempotentCustomer(shop, idempotencyKey, fingerprint)
    if (!replay) throw new Error('Customer creation is already in progress. Retry with the same idempotency key.')
    return replay
  } finally {
    await session.endSession()
  }
}

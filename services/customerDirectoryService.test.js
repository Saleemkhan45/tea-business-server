import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const customerModel = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  countDocuments: vi.fn(),
  create: vi.fn(),
  init: vi.fn(),
}))
const ledgerRepository = vi.hoisted(() => ({
  aggregateActiveBalancesByCustomers: vi.fn(),
}))
const ledgerService = vi.hoisted(() => ({ createOpeningBalance: vi.fn() }))

vi.mock('../models/Customer.js', () => ({
  CUSTOMER_STATUSES: ['active', 'inactive'],
  Customer: customerModel,
}))
vi.mock('../repositories/customerLedgerTransactionRepository.js', () => ledgerRepository)
vi.mock('./customerLedgerService.js', () => ledgerService)

import {
  CUSTOMER_DIRECTORY_MAX_LIMIT,
  CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH,
} from '../constants/customerDirectory.js'
import * as service from './customerDirectoryService.js'

const shop = new mongoose.Types.ObjectId()
const otherShop = new mongoose.Types.ObjectId()
const firstCustomerId = new mongoose.Types.ObjectId()
const secondCustomerId = new mongoose.Types.ObjectId()

function customer(overrides = {}) {
  return {
    _id: firstCustomerId,
    shop,
    name: 'Ahmed Traders',
    phone: '+92 300 1112223',
    address: 'Main bazaar',
    status: 'active',
    balanceDue: 999999,
    ...overrides,
  }
}

function findQuery(result = []) {
  const query = {
    select: vi.fn(function select() { return query }),
    sort: vi.fn(function sort() { return query }),
    skip: vi.fn(function skip() { return query }),
    limit: vi.fn(function limit() { return query }),
    session: vi.fn(function session() { return query }),
    lean: vi.fn().mockResolvedValue(result),
  }
  customerModel.find.mockReturnValue(query)
  return query
}

function countQuery(total = 0) {
  const query = {
    session: vi.fn(function session() { return query }),
    then(resolve, reject) {
      return Promise.resolve(total).then(resolve, reject)
    },
  }
  customerModel.countDocuments.mockReturnValue(query)
  return query
}

function profileQuery(result = null) {
  const query = {
    select: vi.fn(function select() { return query }),
    session: vi.fn(function session() { return query }),
    lean: vi.fn().mockResolvedValue(result),
  }
  customerModel.findOne.mockReturnValue(query)
  return query
}

beforeEach(() => {
  vi.resetAllMocks()
  findQuery([])
  profileQuery()
  countQuery(0)
  customerModel.init.mockResolvedValue(undefined)
  customerModel.create.mockImplementation(async data => {
    const record = {
      _id: firstCustomerId,
      ...(Array.isArray(data) ? data[0] : data),
      createdAt: new Date('2026-10-01T09:00:00Z'),
    }
    return Array.isArray(data) ? [record] : record
  })
  ledgerRepository.aggregateActiveBalancesByCustomers.mockResolvedValue(new Map())
})
afterEach(() => vi.restoreAllMocks())

describe('customer-by-ID service', () => {
  it('reads only the requested shop and customer and returns identity without financial or internal fields', async () => {
    const query = profileQuery(customer({ notes: 'Internal note', __v: 3 }))

    const result = await service.getCustomerById({ shop, customerId: firstCustomerId })

    expect(customerModel.findOne).toHaveBeenCalledWith({ _id: firstCustomerId, shop })
    expect(query.select).toHaveBeenCalledWith('_id name phone address region city notes status createdAt')
    expect(result).toEqual({
      id: String(firstCustomerId), name: 'Ahmed Traders', phone: '+92 300 1112223',
      address: 'Main bazaar', notes: 'Internal note', status: 'active',
    })
    expect(customerModel.find).not.toHaveBeenCalled()
    expect(customerModel.countDocuments).not.toHaveBeenCalled()
    expect(ledgerRepository.aggregateActiveBalancesByCustomers).not.toHaveBeenCalled()
  })

  it('preserves inactive status and optional profile fields without inventing missing data', async () => {
    profileQuery(customer({
      phone: undefined,
      address: undefined,
      region: 'Lahore',
      notes: 'Prefers weekly follow-up',
      createdAt: new Date('2026-10-01T09:00:00Z'),
      status: 'inactive',
    }))

    expect(await service.getCustomerById({ shop, customerId: firstCustomerId })).toEqual({
      id: String(firstCustomerId),
      name: 'Ahmed Traders',
      phone: '',
      address: '',
      region: 'Lahore',
      notes: 'Prefers weekly follow-up',
      createdAt: '2026-10-01T09:00:00.000Z',
      status: 'inactive',
    })
  })

  it('returns the established not-found error for an unknown customer', async () => {
    await expect(service.getCustomerById({ shop, customerId: secondCustomerId }))
      .rejects.toThrow('Customer not found.')
  })

  it('cannot resolve a customer belonging to another shop or accept a client shop override', async () => {
    const foreignCustomer = customer({ shop: otherShop })
    const query = profileQuery()
    customerModel.findOne.mockImplementation(filter => {
      const matches = String(filter.shop) === String(foreignCustomer.shop)
        && String(filter._id) === String(foreignCustomer._id)
      query.lean.mockResolvedValue(matches ? foreignCustomer : null)
      return query
    })

    await expect(service.getCustomerById({ shop, customerId: firstCustomerId, clientShop: otherShop }))
      .rejects.toThrow('Customer not found.')
    expect(customerModel.findOne).toHaveBeenCalledWith({ _id: firstCustomerId, shop })
    await expect(service.getCustomerById({ shop: otherShop, customerId: firstCustomerId }))
      .resolves.toMatchObject({ id: String(firstCustomerId), name: foreignCustomer.name })
  })

  it('rejects missing or invalid scope before accessing the database', async () => {
    for (const input of [
      { customerId: firstCustomerId }, { shop: 'invalid', customerId: firstCustomerId },
      { shop }, { shop, customerId: 'invalid' },
    ]) {
      await expect(service.getCustomerById(input)).rejects.toThrow('must be a valid ID.')
    }
    expect(customerModel.findOne).not.toHaveBeenCalled()
  })

  it('passes an existing session through the customer read', async () => {
    const session = { id: 'profile-session' }
    const query = profileQuery(customer())

    await service.getCustomerById({ shop, customerId: firstCustomerId }, { session })

    expect(query.session).toHaveBeenCalledWith(session)
  })

  it('creates a shop-scoped active customer with optional notes and no starting ledger balance', async () => {
    const result = await service.createCustomer({
      shop,
      name: '  New Retailer  ',
      phone: ' 0300 1112223 ',
      address: ' Main bazaar ',
      region: ' Lahore ',
      city: ' Lahore ',
      notes: ' Deliver before noon ',
    })

    expect(customerModel.create).toHaveBeenCalledWith({
      shop,
      name: 'New Retailer',
      phone: '0300 1112223',
      address: 'Main bazaar',
      region: 'Lahore',
      city: 'Lahore',
      notes: 'Deliver before noon',
      status: 'active',
    })
    expect(result).toMatchObject({
      id: String(firstCustomerId),
      name: 'New Retailer',
      phone: '0300 1112223',
      address: 'Main bazaar',
      region: 'Lahore',
      city: 'Lahore',
      notes: 'Deliver before noon',
      currentBalancePkr: 0,
    })
  })

  it('creates an inline-sale customer with the caller transaction session', async () => {
    const session = { id: 'sale-session' }
    customerModel.create.mockResolvedValueOnce([customer({ city: 'Lahore' })])

    await service.createCustomer({ shop, name: 'Ahmed Traders', city: 'Lahore' }, { session })

    expect(customerModel.create).toHaveBeenCalledWith([expect.objectContaining({ shop, name: 'Ahmed Traders', city: 'Lahore', status: 'active' })], { session })
  })

  it('creates opening Khata in the caller transaction without updating the legacy balance cache', async () => {
    const session = { id: 'onboarding-session' }

    const result = await service.createCustomer({
      shop,
      name: 'Opening Retailer',
      openingBalancePkr: 2500,
      businessDate: '2026-10-14',
      createdBy: secondCustomerId,
    }, { session })

    expect(customerModel.create).toHaveBeenCalledWith([expect.not.objectContaining({ balanceDue: expect.anything() })], { session })
    expect(ledgerService.createOpeningBalance).toHaveBeenCalledWith({
      shop,
      customer: firstCustomerId,
      businessDate: '2026-10-14',
      amountPkr: 2500,
      createdBy: secondCustomerId,
      notes: 'Opening Khata recorded during customer creation',
    }, { session })
    expect(result.currentBalancePkr).toBe(2500)
  })

  it('uses a tenant-scoped idempotency key for customer-only onboarding retries', async () => {
    const session = { withTransaction: vi.fn(callback => callback()), endSession: vi.fn() }
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session)
    const input = { shop, name: 'Keyed Retailer', idempotencyKey: 'customer-key-1' }

    const created = await service.createCustomer(input)
    const creationData = customerModel.create.mock.calls[0][0][0]
    profileQuery({ _id: firstCustomerId, ...creationData })
    ledgerRepository.aggregateActiveBalancesByCustomers.mockResolvedValue(new Map([[String(firstCustomerId), 0]]))
    const replay = await service.createCustomer(input)

    expect(created.id).toBe(String(firstCustomerId))
    expect(replay.id).toBe(created.id)
    expect(customerModel.create).toHaveBeenCalledOnce()
    expect(customerModel.findOne).toHaveBeenCalledWith({ shop, creationIdempotencyKey: 'customer-key-1' })
    expect(session.withTransaction).toHaveBeenCalledOnce()
    expect(session.endSession).toHaveBeenCalledOnce()
  })
})

describe('customer directory service', () => {
  it('lists customers inside the authenticated shop with deterministic paging', async () => {
    const first = customer()
    const second = customer({ _id: secondCustomerId, name: 'Bismillah Store', balanceDue: 1 })
    const query = findQuery([first, second])
    countQuery(12)
    ledgerRepository.aggregateActiveBalancesByCustomers.mockResolvedValue(new Map([
      [String(firstCustomerId), 12000],
      [String(secondCustomerId), -500],
    ]))

    const result = await service.listCustomers({ shop, page: 2, limit: 2 })

    expect(customerModel.find).toHaveBeenCalledWith({ shop })
    expect(query.select).toHaveBeenCalledWith('_id name phone address region city status')
    expect(query.sort).toHaveBeenCalledWith({ name: 1, _id: 1 })
    expect(query.skip).toHaveBeenCalledWith(2)
    expect(query.limit).toHaveBeenCalledWith(2)
    expect(customerModel.countDocuments).toHaveBeenCalledWith({ shop })
    expect(ledgerRepository.aggregateActiveBalancesByCustomers).toHaveBeenCalledWith({
      shop,
      customers: [firstCustomerId, secondCustomerId],
    }, {})
    expect(result.pagination).toEqual({ page: 2, limit: 2, total: 12, pages: 6 })
    expect(result.customers).toEqual([
      {
        id: String(firstCustomerId),
        name: 'Ahmed Traders',
        phone: '+92 300 1112223',
        address: 'Main bazaar',
        status: 'active',
        currentBalancePkr: 12000,
      },
      {
        id: String(secondCustomerId),
        name: 'Bismillah Store',
        phone: '+92 300 1112223',
        address: 'Main bazaar',
        status: 'active',
        currentBalancePkr: -500,
      },
    ])
    expect(result.customers[0]).not.toHaveProperty('balanceDue')
  })

  it('searches by escaped name or phone text and supports status filtering', async () => {
    await service.listCustomers({ shop, search: 'A.+', status: 'inactive' })

    expect(customerModel.find).toHaveBeenCalledWith({
      shop,
      status: 'inactive',
      $or: [
        { name: { $regex: 'A\\.\\+', $options: 'i' } },
        { phone: { $regex: 'A\\.\\+', $options: 'i' } },
      ],
    })
    expect(customerModel.countDocuments).toHaveBeenCalledWith({
      shop,
      status: 'inactive',
      $or: [
        { name: { $regex: 'A\\.\\+', $options: 'i' } },
        { phone: { $regex: 'A\\.\\+', $options: 'i' } },
      ],
    })
  })

  it('uses only the provided shop scope and passes sessions through both customer and ledger reads', async () => {
    const session = { id: 'directory-session' }
    const query = findQuery([customer()])
    const count = countQuery(1)

    await service.listCustomers({ shop, page: 1, limit: 20, clientShop: otherShop }, { session })

    expect(customerModel.find).toHaveBeenCalledWith({ shop })
    expect(query.session).toHaveBeenCalledWith(session)
    expect(count.session).toHaveBeenCalledWith(session)
    expect(ledgerRepository.aggregateActiveBalancesByCustomers).toHaveBeenCalledWith({
      shop,
      customers: [firstCustomerId],
    }, { session })
  })

  it('rejects invalid filters before querying customers', async () => {
    await expect(service.listCustomers({ shop: 'not-an-id' })).rejects.toThrow('Shop must be a valid ID.')
    await expect(service.listCustomers({ shop, page: 0 })).rejects.toThrow('Customer directory page')
    await expect(service.listCustomers({ shop, limit: CUSTOMER_DIRECTORY_MAX_LIMIT + 1 })).rejects.toThrow('Customer directory limit')
    await expect(service.listCustomers({ shop, status: 'ACTIVE' })).rejects.toThrow('Customer status is invalid.')
    await expect(service.listCustomers({ shop, search: 'x'.repeat(CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH + 1) }))
      .rejects.toThrow('Customer search')
    expect(customerModel.find).not.toHaveBeenCalled()
  })
})

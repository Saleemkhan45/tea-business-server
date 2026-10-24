import { beforeEach, describe, expect, it, vi } from 'vitest'

const transactionModel = vi.hoisted(() => ({
  findOne: vi.fn(),
  find: vi.fn(),
  aggregate: vi.fn(),
  create: vi.fn(),
  findOneAndUpdate: vi.fn(),
  init: vi.fn(),
}))

vi.mock('../models/CustomerLedgerTransaction.js', () => ({
  CUSTOMER_LEDGER_TRANSACTION_TYPES: ['purchase', 'payment', 'opening_balance', 'adjustment'],
  CUSTOMER_LEDGER_TRANSACTION_STATUSES: ['active', 'voided'],
  CustomerLedgerTransaction: transactionModel,
}))

import * as repository from './customerLedgerTransactionRepository.js'

const shopA = 'shop-a'
const shopB = 'shop-b'
const customerA = 'customer-a'
const customerB = 'customer-b'
const transactionA = 'transaction-a'

function mockFindOne(result = null) {
  const query = {
    session: vi.fn(function session() { return query }),
    lean: vi.fn().mockResolvedValue(result),
  }
  transactionModel.findOne.mockReturnValue(query)
  return query
}

function mockFind(result = []) {
  const query = {
    session: vi.fn(function session() { return query }),
    sort: vi.fn(function sort() { return query }),
    skip: vi.fn(function skip() { return query }),
    limit: vi.fn(function limit() { return query }),
    lean: vi.fn().mockResolvedValue(result),
  }
  transactionModel.find.mockReturnValue(query)
  return query
}

function mockAggregate(result = []) {
  const aggregate = {
    session: vi.fn(function session() { return aggregate }),
    exec: vi.fn().mockResolvedValue(result),
  }
  transactionModel.aggregate.mockReturnValue(aggregate)
  return aggregate
}

function mockFindOneAndUpdate(result = null) {
  const query = {
    lean: vi.fn().mockResolvedValue(result),
  }
  transactionModel.findOneAndUpdate.mockReturnValue(query)
  return query
}

describe('customer ledger transaction repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds one transaction only inside the requested shop and customer scope', async () => {
    const row = { _id: transactionA, shop: shopA, customer: customerA }
    const query = mockFindOne(row)

    await expect(repository.findById({
      shop: shopA,
      customer: customerA,
      transactionId: transactionA,
    })).resolves.toBe(row)

    expect(transactionModel.findOne).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      _id: transactionA,
    })
    expect(query.lean).toHaveBeenCalledTimes(1)
  })

  it('finds an active Sale-linked purchase under shop scope and passes the session', async () => {
    const session = { id: 'tx' }
    const query = mockFindOne({ _id: transactionA })
    await expect(repository.findActivePurchaseBySale({ shop: shopA, saleId: transactionA }, { session }))
      .resolves.toEqual({ _id: transactionA })
    expect(transactionModel.findOne).toHaveBeenCalledWith({
      shop: shopA, saleId: transactionA, type: 'purchase', status: 'active',
    })
    expect(query.session).toHaveBeenCalledWith(session)
  })

  it('waits for the Sale charge index before direct writes', async () => {
    transactionModel.init.mockResolvedValue(undefined)
    await repository.ensureActiveSalePurchaseIndex()
    expect(transactionModel.init).toHaveBeenCalledOnce()
  })

  it('uses a caller session for scoped reads', async () => {
    const session = { id: 'session-read' }
    const one = mockFindOne()
    await repository.findById({ shop: shopA, customer: customerA, transactionId: transactionA }, { session })
    expect(one.session).toHaveBeenCalledWith(session)

    const many = mockFind()
    await repository.findActiveByShopAndCustomer({ shop: shopA, customer: customerA }, { session })
    expect(many.session).toHaveBeenCalledWith(session)
  })

  it('keeps a matching transaction id isolated from another shop', async () => {
    mockFindOne(null)

    await expect(repository.findById({
      shop: shopB,
      customer: customerA,
      transactionId: transactionA,
    })).resolves.toBeNull()

    expect(transactionModel.findOne).toHaveBeenCalledWith({
      shop: shopB,
      customer: customerA,
      _id: transactionA,
    })
  })

  it('finds customer transactions with deterministic ledger ordering and optional pagination', async () => {
    const query = mockFind([])

    await repository.findByShopAndCustomer({
      shop: shopA,
      customer: customerA,
      skip: 20,
      limit: 10,
    })

    expect(transactionModel.find).toHaveBeenCalledWith({ shop: shopA, customer: customerA })
    expect(query.sort).toHaveBeenCalledWith({ businessDate: 1, createdAt: 1, _id: 1 })
    expect(query.skip).toHaveBeenCalledWith(20)
    expect(query.limit).toHaveBeenCalledWith(10)
    expect(query.lean).toHaveBeenCalledTimes(1)
  })

  it('supports explicit reverse deterministic ordering', async () => {
    const query = mockFind([])

    await repository.findByShopAndCustomer({
      shop: shopA,
      customer: customerA,
      sortDirection: 'desc',
    })

    expect(query.sort).toHaveBeenCalledWith({ businessDate: -1, createdAt: -1, _id: -1 })
  })

  it('finds transactions inside an inclusive businessDate range', async () => {
    const query = mockFind([])

    await repository.findByBusinessDateRange({
      shop: shopA,
      customer: customerA,
      fromBusinessDate: '2026-01-01',
      toBusinessDate: '2026-01-31',
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      businessDate: { $gte: '2026-01-01', $lte: '2026-01-31' },
    })
    expect(query.sort).toHaveBeenCalledWith({ businessDate: 1, createdAt: 1, _id: 1 })
  })

  it('filters by type without bypassing shop and customer ownership', async () => {
    mockFind([])

    await repository.findByType({
      shop: shopA,
      customer: customerA,
      type: 'purchase',
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      type: 'purchase',
    })
  })

  it('filters active transactions through the relevant transaction query', async () => {
    mockFind([])

    await repository.findActiveByShopAndCustomer({
      shop: shopA,
      customer: customerA,
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      status: 'active',
    })
  })

  it('includes voided transactions when status is explicitly requested', async () => {
    mockFind([])

    await repository.findRelevant({
      shop: shopA,
      customer: customerA,
      status: 'voided',
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      status: 'voided',
    })
  })

  it('combines relevant date range, type, and status filters under the same customer scope', async () => {
    mockFind([])

    await repository.findRelevant({
      shop: shopA,
      customer: customerA,
      fromBusinessDate: '2026-02-01',
      toBusinessDate: '2026-02-28',
      type: 'payment',
      status: 'active',
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerA,
      businessDate: { $gte: '2026-02-01', $lte: '2026-02-28' },
      type: 'payment',
      status: 'active',
    })
  })

  it('requires shop and customer before building scoped ledger queries', () => {
    expect(() => repository.findByShopAndCustomer({ shop: shopA })).toThrow('customer is required.')
    expect(() => repository.findByShopAndCustomer({ customer: customerA })).toThrow('shop is required.')
    expect(transactionModel.find).not.toHaveBeenCalled()
  })

  it('aggregates active balances for a page of customers in one ledger query', async () => {
    mockAggregate([
      { _id: customerA, currentBalancePkr: 9000 },
      { _id: customerB, currentBalancePkr: 0 },
    ])

    const balances = await repository.aggregateActiveBalancesByCustomers({
      shop: shopA,
      customers: [customerA, customerB, customerA],
    })

    expect(balances).toEqual(new Map([[customerA, 9000], [customerB, 0]]))
    expect(transactionModel.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          shop: shopA,
          customer: { $in: [customerA, customerB] },
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
    ])
  })

  it('supports sessions and empty customer pages for balance aggregation', async () => {
    await expect(repository.aggregateActiveBalancesByCustomers({ shop: shopA, customers: [] })).resolves.toEqual(new Map())
    expect(transactionModel.aggregate).not.toHaveBeenCalled()

    const session = { id: 'aggregate-session' }
    const aggregate = mockAggregate([])
    await repository.aggregateActiveBalancesByCustomers({ shop: shopA, customers: [customerA] }, { session })
    expect(aggregate.session).toHaveBeenCalledWith(session)
  })

  it('keeps customer isolation in every query scope', async () => {
    mockFind([])

    await repository.findByShopAndCustomer({
      shop: shopA,
      customer: customerB,
    })

    expect(transactionModel.find).toHaveBeenCalledWith({
      shop: shopA,
      customer: customerB,
    })
  })

  it('creates a transaction with optional MongoDB session support', async () => {
    const data = {
      shop: shopA,
      customer: customerA,
      type: 'payment',
      businessDate: '2026-03-01',
      amountPkr: 25000,
      paymentMethod: 'cash',
      createdBy: 'user-a',
    }
    const plain = { _id: transactionA, ...data }
    const document = { toObject: vi.fn(() => plain) }
    const session = { id: 'session-a' }
    transactionModel.create.mockResolvedValue([document])

    await expect(repository.create(data, { session })).resolves.toEqual(plain)

    expect(transactionModel.create).toHaveBeenCalledWith([data], { session })
    expect(document.toObject).toHaveBeenCalledTimes(1)
  })

  it('marks a transaction voided through a narrowly scoped persistence update', async () => {
    const voidedAt = new Date('2026-03-03T10:00:00.000Z')
    const session = { id: 'session-b' }
    const query = mockFindOneAndUpdate({ _id: transactionA, status: 'voided' })

    await repository.markVoided({
      shop: shopA,
      customer: customerA,
      transactionId: transactionA,
      voidedAt,
      voidedBy: 'user-a',
      voidReason: 'Duplicate entry',
    }, { session })

    expect(transactionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { shop: shopA, customer: customerA, _id: transactionA, status: 'active' },
      {
        $set: {
          status: 'voided',
          voidedAt,
          voidedBy: 'user-a',
          voidReason: 'Duplicate entry',
        },
      },
      { new: true, runValidators: true, session },
    )
    expect(query.lean).toHaveBeenCalledTimes(1)
  })

  it('does not expose hard-delete repository methods', () => {
    expect(repository.delete).toBeUndefined()
    expect(repository.deleteById).toBeUndefined()
    expect(repository.removeTransaction).toBeUndefined()
  })
})

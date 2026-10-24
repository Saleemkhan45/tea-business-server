import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const models = vi.hoisted(() => ({
  shopExists: vi.fn(), customerFindOne: vi.fn(), customerFindOneAndUpdate: vi.fn(), userExists: vi.fn(),
  userFind: vi.fn(), saleFindOne: vi.fn(), saleFindOneAndUpdate: vi.fn(),
  occurrenceFindOne: vi.fn(),
}))
const repository = vi.hoisted(() => ({
  create: vi.fn(),
  findActiveByShopAndCustomer: vi.fn(),
  findByShopAndCustomer: vi.fn(),
  findRelevant: vi.fn(),
  findById: vi.fn(),
  findActivePurchaseBySale: vi.fn(),
  ensureActiveSalePurchaseIndex: vi.fn(),
  markVoided: vi.fn(),
}))

vi.mock('../models/Shop.js', () => ({ Shop: { exists: models.shopExists } }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOne: models.customerFindOne, findOneAndUpdate: models.customerFindOneAndUpdate } }))
vi.mock('../models/User.js', () => ({ User: { exists: models.userExists, find: models.userFind } }))
vi.mock('../models/Sale.js', () => ({ Sale: { findOne: models.saleFindOne, findOneAndUpdate: models.saleFindOneAndUpdate } }))
vi.mock('../models/CollectionSchedule.js', () => ({ CollectionOccurrence: { findOne: models.occurrenceFindOne } }))
vi.mock('../repositories/customerLedgerTransactionRepository.js', () => repository)

import * as service from './customerLedgerService.js'

const shop = new mongoose.Types.ObjectId()
const otherShop = new mongoose.Types.ObjectId()
const customer = new mongoose.Types.ObjectId()
const otherCustomer = new mongoose.Types.ObjectId()
const actor = new mongoose.Types.ObjectId()
const saleId = new mongoose.Types.ObjectId()
const transactionId = new mongoose.Types.ObjectId()
const session = { withTransaction: vi.fn(callback => callback()), endSession: vi.fn() }

function query(result) {
  const value = {
    select: vi.fn(function select() { return value }),
    session: vi.fn(function session() { return value }),
    lean: vi.fn().mockResolvedValue(result),
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
  }
  return value
}

function customerRecord(overrides = {}) {
  return { _id: customer, shop, name: 'Ayesha', status: 'active', balanceDue: 999999, ...overrides }
}

function saleRecord(overrides = {}) {
  return {
    _id: saleId, shop, customer, businessDate: '2026-10-01', teaType: 'green',
    stockLocationId: 'main', quantityKg: 10, unitPrice: 500, totalAmount: 5000,
    paymentMethod: 'credit', status: 'completed', ...overrides,
  }
}

function base(overrides = {}) {
  return { shop, customer, businessDate: '2026-10-01', createdBy: actor, ...overrides }
}

function purchaseInput(overrides = {}) {
  return base({ saleId, stockLocationId: 'main', teaType: 'green', quantityKg: 10, ratePerKgPkr: 500, ...overrides })
}

function paymentInput(overrides = {}) {
  return base({ amountPkr: 5000, paymentMethod: 'cash', ...overrides })
}

function row(type, amountPkr, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), shop, customer, type, amountPkr,
    businessDate: '2026-10-01', createdAt: new Date('2026-10-01T09:00:00Z'),
    createdBy: actor, status: 'active', ...overrides,
  }
}

function impact(transaction) {
  if (transaction.status === 'voided') return 0
  return transaction.type === 'payment' ? -transaction.amountPkr : transaction.amountPkr
}

function ledgerBalance(transactions) {
  return transactions.reduce((total, transaction) => total + impact(transaction), 0)
}

function useFreshTransactionSessions() {
  const started = []
  mongoose.startSession.mockImplementation(async () => {
    const next = { withTransaction: vi.fn(callback => callback()), endSession: vi.fn() }
    started.push(next)
    return next
  })
  return started
}

function mockCustomerScopedRevisionQueue() {
  const tails = new Map()
  const releases = new WeakMap()

  function keyFor(scope) {
    return `${scope.shop}:${scope.customer ?? scope._id}`
  }

  models.customerFindOneAndUpdate.mockImplementation(filter => {
    const key = keyFor(filter)
    let owner

    const value = {
      session: vi.fn(function session(next) { owner = next; return value }),
      lean: vi.fn(async () => {
        const held = releases.get(owner) ?? new Map()
        if (held.has(key)) return customerRecord({ _id: filter._id, shop: filter.shop, ledgerRevision: 1 })
        const previous = tails.get(key) ?? Promise.resolve()
        let release
        const current = new Promise(resolve => { release = resolve })
        tails.set(key, previous.then(() => current))
        await previous
        held.set(key, release)
        releases.set(owner, held)
        return customerRecord({ _id: filter._id, shop: filter.shop, ledgerRevision: 1 })
      }),
    }
    return value
  })

  return owner => {
    for (const release of releases.get(owner)?.values() ?? []) release()
    releases.delete(owner)
  }
}

function useInMemoryPaymentLedger(rowsByCustomer) {
  const releaseSession = mockCustomerScopedRevisionQueue()
  const ledgers = new Map(Object.entries(rowsByCustomer))
  const startSession = mongoose.startSession.getMockImplementation()
  mongoose.startSession.mockImplementation(async () => {
    const next = await startSession()
    next.withTransaction.mockImplementation(async callback => {
      try {
        return await callback()
      } finally {
        releaseSession(next)
      }
    })
    return next
  })

  models.customerFindOne.mockImplementation(filter => query(customerRecord({ _id: filter._id, shop: filter.shop })))
  repository.findActiveByShopAndCustomer.mockImplementation(async ({ customer: scopedCustomer }) =>
    (ledgers.get(String(scopedCustomer)) ?? []).filter(transaction => transaction.status === 'active'))
  repository.findByShopAndCustomer.mockImplementation(async ({ customer: scopedCustomer }) =>
    ledgers.get(String(scopedCustomer)) ?? [])
  repository.findRelevant.mockImplementation(async ({ customer: scopedCustomer, type, status }) =>
    (ledgers.get(String(scopedCustomer)) ?? []).filter(transaction => transaction.type === type && transaction.status === status))
  repository.findById.mockImplementation(async ({ customer: scopedCustomer, transactionId: id }) =>
    (ledgers.get(String(scopedCustomer)) ?? []).find(transaction => String(transaction._id) === String(id)) ?? null)
  repository.markVoided.mockImplementation(async data => {
    const existing = (ledgers.get(String(data.customer)) ?? []).find(transaction => String(transaction._id) === String(data.transactionId))
    if (!existing || existing.status !== 'active') return null
    Object.assign(existing, { status: 'voided', voidedBy: data.voidedBy, voidedAt: data.voidedAt, voidReason: data.voidReason })
    return { ...existing }
  })
  repository.create.mockImplementation(async data => {
    const created = { _id: new mongoose.Types.ObjectId(), ...data }
    const customerRows = ledgers.get(String(data.customer)) ?? []
    customerRows.push(created)
    ledgers.set(String(data.customer), customerRows)
    return created
  })

  return ledgers
}

beforeEach(() => {
  vi.resetAllMocks()
  session.withTransaction.mockImplementation(callback => callback())
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session)
  models.shopExists.mockImplementation(() => query({ _id: shop }))
  models.customerFindOne.mockImplementation(() => query(customerRecord()))
  models.customerFindOneAndUpdate.mockImplementation(() => query(customerRecord({ ledgerRevision: 1 })))
  models.userExists.mockImplementation(() => query({ _id: actor }))
  models.userFind.mockImplementation(() => query([{ _id: actor, name: 'Admin' }]))
  models.saleFindOne.mockImplementation(() => query(saleRecord()))
  models.saleFindOneAndUpdate.mockImplementation(() => query(saleRecord()))
  repository.create.mockImplementation(async data => ({ _id: transactionId, ...data }))
  repository.ensureActiveSalePurchaseIndex.mockResolvedValue(undefined)
  repository.findActivePurchaseBySale.mockResolvedValue(null)
  repository.findActiveByShopAndCustomer.mockResolvedValue([])
  repository.findByShopAndCustomer.mockResolvedValue([])
  repository.findRelevant.mockResolvedValue([])
  repository.findById.mockResolvedValue(null)
  repository.markVoided.mockResolvedValue(null)
})

afterEach(() => vi.restoreAllMocks())

describe('customer ledger service writes', () => {
  it('records a collection payment through the same ledger without a sale or inventory operation', async () => {
    const occurrenceId = new mongoose.Types.ObjectId()
    models.occurrenceFindOne.mockReturnValue(query({ _id: occurrenceId, scheduledDate: '2026-10-01' }))
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 20000)])
    const result = await service.createPayment(paymentInput({ amountPkr: 2000, idempotencyKey: 'collection-payment', collectionOccurrence: occurrenceId }))
    expect(result.collectionOccurrence).toBe(occurrenceId)
    expect(result.type).toBe('payment')
    expect(result.amountPkr).toBe(2000)
    expect(models.occurrenceFindOne).toHaveBeenCalledWith({ _id: occurrenceId, shop, customer })
    expect(models.saleFindOne).not.toHaveBeenCalled()
    expect(models.saleFindOneAndUpdate).not.toHaveBeenCalled()
    expect(ledgerBalance([row('opening_balance', 20000), result])).toBe(18000)
  })

  it('rejects foreign or nonexistent collection references before creating a payment', async () => {
    models.occurrenceFindOne.mockReturnValue(query(null))
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 20000)])
    await expect(service.createPayment(paymentInput({ idempotencyKey: 'collection-payment', collectionOccurrence: otherCustomer }))).rejects.toThrow('invalid for this customer')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('keeps collection linkage in idempotency intent and replays without another deduction', async () => {
    const existing = row('payment', 2000, { paymentMethod: 'cash', notes: null, idempotencyKey: 'collection-key', collectionOccurrence: transactionId })
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 20000), existing])
    const input = paymentInput({ amountPkr: 2000, idempotencyKey: 'collection-key', collectionOccurrence: transactionId })
    await expect(service.createPayment(input)).resolves.toBe(existing)
    await expect(service.createPayment({ ...input, collectionOccurrence: otherCustomer })).rejects.toThrow('already used')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('serializes concurrent collection retries with one payment deduction', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [row('opening_balance', 20000)] })
    models.occurrenceFindOne.mockReturnValue(query({ _id: transactionId, scheduledDate: '2026-10-01' }))
    const input = paymentInput({ amountPkr: 1000, idempotencyKey: 'collection-concurrent', collectionOccurrence: transactionId })
    const [first, second] = await Promise.all([service.createPayment(input), service.createPayment(input)])
    expect(first._id).toEqual(second._id)
    expect(repository.create).toHaveBeenCalledOnce()
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(19000)
  })

  it('records one payment for concurrent matching retry keys under the customer revision lock', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [row('opening_balance', 10000)] })
    const input = paymentInput({ amountPkr: 4000, idempotencyKey: 'payment-retry-key' })
    const [first, second] = await Promise.all([service.createPayment(input), service.createPayment(input)])
    expect(String(first._id)).toBe(String(second._id))
    expect(repository.create).toHaveBeenCalledOnce()
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(6000)
    expect(models.saleFindOneAndUpdate).not.toHaveBeenCalled()
    expect(repository.findByShopAndCustomer).toHaveBeenCalledWith({ shop, customer }, expect.objectContaining({ session: expect.anything() }))
  })

  it('returns a recorded payment on retry even when the remaining balance is now below the payment amount', async () => {
    const existing = row('payment', 5000, { idempotencyKey: 'payment-key', paymentMethod: 'cash', notes: null })
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000), existing])
    await expect(service.createPayment(paymentInput({ idempotencyKey: 'payment-key' }))).resolves.toBe(existing)
    expect(repository.create).not.toHaveBeenCalled()
  })

  it.each([
    { amountPkr: 4000 }, { paymentMethod: 'bank_transfer' }, { notes: 'Changed' },
    { reference: 'Changed' }, { businessDate: '2026-10-02' }, { status: 'voided' },
    { createdBy: otherCustomer }, { saleId },
  ])('rejects a reused payment key with different intent or audit state: %j', changes => {
    repository.findByShopAndCustomer.mockResolvedValue([row('payment', 5000, { idempotencyKey: 'payment-key', paymentMethod: 'cash', ...changes })])
    return expect(service.createPayment(paymentInput({ idempotencyKey: 'payment-key' }))).rejects.toThrow('already used')
  })

  it('creates a purchase with a calculated whole-PKR amount and ignores caller amount', async () => {
    models.saleFindOne.mockImplementation(() => query(saleRecord({ quantityKg: 1.25, unitPrice: 400, totalAmount: 500 })))
    models.saleFindOneAndUpdate.mockImplementation(() => query(saleRecord({ quantityKg: 1.25, unitPrice: 400, totalAmount: 500 })))
    const transaction = await service.createPurchase(purchaseInput({ quantityKg: 1.25, ratePerKgPkr: 400, amountPkr: 999999 }))
    expect(transaction.amountPkr).toBe(500)
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      shop, customer, saleId, stockLocationId: 'main', type: 'purchase', amountPkr: 500,
    }), { session })
    expect(models.shopExists).toHaveBeenCalledWith({ _id: shop })
    expect(models.customerFindOne).toHaveBeenCalledWith({ _id: customer, shop })
    expect(models.userExists).toHaveBeenCalledWith({ _id: actor, shop, status: 'active' })
    expect(models.saleFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: saleId, shop, customer, paymentMethod: 'credit', status: { $ne: 'voided' } },
      { $inc: { ledgerRevision: 1 } },
      { session, new: true },
    )
    expect(repository.ensureActiveSalePurchaseIndex).toHaveBeenCalledOnce()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('requires an existing Sale in the authenticated shop', async () => {
    models.saleFindOne.mockImplementation(() => query(null))
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('Sale not found')
    expect(models.saleFindOne).toHaveBeenCalledWith({ _id: saleId, shop })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a foreign-shop Sale and a Sale belonging to another customer', async () => {
    models.saleFindOne.mockImplementationOnce(() => query(null))
      .mockImplementationOnce(() => query(saleRecord({ customer: otherCustomer })))
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('Sale not found')
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('Sale customer does not match')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects cash and voided Sales and mismatched sale details', async () => {
    models.saleFindOne.mockImplementationOnce(() => query(saleRecord({ paymentMethod: 'cash' })))
      .mockImplementationOnce(() => query(saleRecord({ status: 'voided' })))
      .mockImplementationOnce(() => query(saleRecord()))
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('not a credit sale')
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('Voided Sale')
    await expect(service.createPurchase(purchaseInput({ quantityKg: 11 }))).rejects.toThrow('do not match')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a second active charge but allows replacement after a historical void', async () => {
    repository.findActivePurchaseBySale.mockResolvedValueOnce(row('purchase', 5000, { saleId }))
      .mockResolvedValueOnce(null)
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('already has an active')
    await expect(service.createPurchase(purchaseInput())).resolves.toMatchObject({ saleId, amountPkr: 5000 })
    expect(repository.create).toHaveBeenCalledOnce()
  })

  it('uses the caller transaction when the Sale service creates the charge', async () => {
    await service.createPurchase(purchaseInput(), { session })
    expect(models.saleFindOneAndUpdate).not.toHaveBeenCalled()
    expect(models.saleFindOne.mock.results[0].value.session).toHaveBeenCalledWith(session)
    expect(repository.findActivePurchaseBySale).toHaveBeenCalledWith({ shop, saleId }, { session })
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ amountPkr: 5000 }), { session })
  })

  it.each([0, -1, 1.0001, Infinity])('rejects invalid purchase quantity %s', async quantityKg => {
    await expect(service.createPurchase(purchaseInput({ quantityKg }))).rejects.toThrow()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Infinity])('rejects invalid purchase rate %s', async ratePerKgPkr => {
    await expect(service.createPurchase(purchaseInput({ ratePerKgPkr }))).rejects.toThrow()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a fractional PKR purchase rather than rounding money', async () => {
    await expect(service.createPurchase(purchaseInput({ quantityKg: 0.001, ratePerKgPkr: 1 }))).rejects.toThrow('whole PKR')
  })

  it('requires the model sale reference and a valid tea type', async () => {
    await expect(service.createPurchase(purchaseInput({ saleId: undefined }))).rejects.toThrow('Sale ID')
    await expect(service.createPurchase(purchaseInput({ teaType: 'oolong' }))).rejects.toThrow('tea type')
  })

  it('records a payment and passes it to the repository', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    const transaction = await service.createPayment(paymentInput({ amountPkr: 2000 }))
    expect(transaction.type).toBe('payment')
    expect(models.customerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: customer, shop, status: 'active' },
      { $inc: { ledgerRevision: 1 } },
      { new: true, runValidators: true },
    )
    expect(models.customerFindOneAndUpdate.mock.results[0].value.session).toHaveBeenCalledWith(session)
    expect(repository.findActiveByShopAndCustomer).toHaveBeenCalledWith({ shop, customer }, { session })
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ amountPkr: 2000, paymentMethod: 'cash' }), { session })
    expect(session.withTransaction).toHaveBeenCalledOnce()
  })

  it.each(['bank_transfer', 'card', 'cheque', 'other'])('keeps %s customer payments out of physical cash', async paymentMethod => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    await service.createPayment(paymentInput({ amountPkr: 1000, paymentMethod }))
  })

  it('lets the Sale own cash posting for its linked Khata receipt', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    await service.createPayment(paymentInput({ amountPkr: 1000 }), { saleId, session })
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ saleId, type: 'payment' }), { saleId, session })
  })


  it('allows an exact-balance payment', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    await expect(service.createPayment(paymentInput())).resolves.toMatchObject({ amountPkr: 5000 })
  })

  it('rejects an overpayment using active ledger rows, even when legacy balanceDue is high', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    await expect(service.createPayment(paymentInput({ amountPkr: 5001 }))).rejects.toThrow('exceed')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('allows two same-customer concurrent payments only when their combined amount fits the active balance', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({
      [String(customer)]: [row('opening_balance', 1000)],
    })

    const results = await Promise.allSettled([
      service.createPayment(paymentInput({ amountPkr: 500 })),
      service.createPayment(paymentInput({ amountPkr: 500 })),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(repository.create).toHaveBeenCalledTimes(2)
    expect(ledgers.get(String(customer)).filter(transaction => transaction.type === 'payment')).toHaveLength(2)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(0)
  })

  it('rejects one same-customer concurrent overpayment and creates only one payment', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({
      [String(customer)]: [row('opening_balance', 1000)],
    })

    const results = await Promise.allSettled([
      service.createPayment(paymentInput({ amountPkr: 600 })),
      service.createPayment(paymentInput({ amountPkr: 600 })),
    ])
    const succeeded = results.filter(result => result.status === 'fulfilled')
    const failed = results.filter(result => result.status === 'rejected')

    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toBeInstanceOf(RangeError)
    expect(failed[0].reason.message).toBe('Payment cannot exceed the active customer balance.')
    expect(repository.create).toHaveBeenCalledTimes(1)
    expect(ledgers.get(String(customer)).filter(transaction => transaction.type === 'payment')).toHaveLength(1)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(400)
  })

  it('does not coordinate payments for different customers against each other', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({
      [String(customer)]: [row('opening_balance', 1000)],
      [String(otherCustomer)]: [row('opening_balance', 1000, { customer: otherCustomer })],
    })

    const results = await Promise.allSettled([
      service.createPayment(paymentInput({ amountPkr: 600 })),
      service.createPayment(paymentInput({ customer: otherCustomer, amountPkr: 600 })),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(repository.create).toHaveBeenCalledTimes(2)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(400)
    expect(ledgerBalance(ledgers.get(String(otherCustomer)))).toBe(400)
  })

  it('rejects a payment against an already-zero active balance without creating a ledger row', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([])
    await expect(service.createPayment(paymentInput({ amountPkr: 1 }))).rejects.toThrow('exceed')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('does not count voided transactions as available balance for payments', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([
      row('opening_balance', 1000),
      row('opening_balance', 1000, { status: 'voided' }),
    ].filter(transaction => transaction.status === 'active'))
    await expect(service.createPayment(paymentInput({ amountPkr: 1001 }))).rejects.toThrow('exceed')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects invalid payment amount and method', async () => {
    await expect(service.createPayment(paymentInput({ amountPkr: 1.5 }))).rejects.toThrow('integer PKR')
    await expect(service.createPayment(paymentInput({ paymentMethod: 'crypto' }))).rejects.toThrow('method')
  })

  it('creates one positive opening balance and rejects a second active one', async () => {
    await expect(service.createOpeningBalance(base({ amountPkr: 7000 }))).resolves.toMatchObject({ type: 'opening_balance', amountPkr: 7000 })
    repository.findRelevant.mockResolvedValue([row('opening_balance', 7000)])
    await expect(service.createOpeningBalance(base({ amountPkr: 7000 }))).rejects.toThrow('already has')
    expect(repository.findRelevant).toHaveBeenCalledWith({ shop, customer, type: 'opening_balance', status: 'active' }, { session })
  })

  it('creates signed adjustments and keeps the reason', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 1000)])
    const positive = await service.createAdjustment(base({ amountPkr: 200, reason: '  Correction  ' }))
    const negative = await service.createAdjustment(base({ amountPkr: -100, reason: 'Credit' }))
    expect(positive).toMatchObject({ type: 'adjustment', amountPkr: 200, reason: 'Correction' })
    expect(negative).toMatchObject({ type: 'adjustment', amountPkr: -100, reason: 'Credit' })
  })

  it('rejects zero adjustment and blank reason', async () => {
    await expect(service.createAdjustment(base({ amountPkr: 0, reason: 'Correction' }))).rejects.toThrow('nonzero')
    await expect(service.createAdjustment(base({ amountPkr: 100, reason: '  ' }))).rejects.toThrow('reason')
  })

  it('rejects a missing or cross-shop customer before touching the ledger repository', async () => {
    models.customerFindOne.mockImplementation(() => query(null))
    await expect(service.createPayment(paymentInput({ shop: otherShop }))).rejects.toThrow('Customer not found')
    expect(models.customerFindOne).toHaveBeenCalledWith({ _id: customer, shop: otherShop })
    expect(repository.findActiveByShopAndCustomer).not.toHaveBeenCalled()
  })

  it('rejects an inactive customer and a missing shop', async () => {
    models.customerFindOne.mockImplementation(() => query(customerRecord({ status: 'inactive' })))
    await expect(service.createPurchase(purchaseInput())).rejects.toThrow('inactive')
    models.shopExists.mockImplementation(() => query(null))
    await expect(service.getCurrentBalance({ shop, customer })).rejects.toThrow('Shop not found')
  })

  it('passes a caller session through owner checks, balance read, and write', async () => {
    const session = { id: 'tx' }
    const shopQuery = query({ _id: shop })
    const customerQuery = query(customerRecord())
    const userQuery = query({ _id: actor })
    models.shopExists.mockReturnValue(shopQuery)
    models.customerFindOne.mockReturnValue(customerQuery)
    models.userExists.mockReturnValue(userQuery)
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000)])
    await service.createPayment(paymentInput({ amountPkr: 1000 }), { session })
    expect(shopQuery.session).toHaveBeenCalledWith(session)
    expect(customerQuery.session).toHaveBeenCalledWith(session)
    expect(userQuery.session).toHaveBeenCalledWith(session)
    expect(models.customerFindOneAndUpdate.mock.results[0].value.session).toHaveBeenCalledWith(session)
    expect(repository.findActiveByShopAndCustomer).toHaveBeenCalledWith({ shop, customer }, { session })
    expect(repository.create).toHaveBeenCalledWith(expect.any(Object), { session })
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })
})

describe('customer ledger write-boundary hardening', () => {
  it.each(['createOpeningBalance', 'createAdjustment', 'voidTransaction'])('serializes %s before reading financial state', async method => {
    const payment = row('payment', 200)
    repository.findById.mockResolvedValue(payment)
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 1000), payment])
    const input = method === 'voidTransaction'
      ? { shop, customer, transactionId: payment._id, voidedBy: actor, voidReason: 'Correction' }
      : base({ amountPkr: 100, reason: 'Correction' })
    repository.markVoided.mockResolvedValue({ ...payment, status: 'voided' })

    await service[method](input)

    expect(models.customerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: customer, shop, ...(method === 'voidTransaction' ? {} : { status: 'active' }) },
      { $inc: { ledgerRevision: 1 } },
      { new: true, runValidators: true },
    )
    expect(models.customerFindOneAndUpdate.mock.results[0].value.session).toHaveBeenCalledWith(session)
    expect(models.customerFindOneAndUpdate.mock.invocationCallOrder[0])
      .toBeLessThan(repository.findActiveByShopAndCustomer.mock.invocationCallOrder[0])
    expect(session.withTransaction).toHaveBeenCalledOnce()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it.each(['createOpeningBalance', 'createAdjustment'])('borrows the caller transaction for %s', async method => {
    await service[method](base({ amountPkr: 100, reason: 'Correction' }), { session })
    expect(mongoose.startSession).not.toHaveBeenCalled()
    expect(session.endSession).not.toHaveBeenCalled()
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ amountPkr: 100 }), { session })
  })

  it('rejects an adjustment that would create customer credit without inserting it', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 1000), row('payment', 600)])
    await expect(service.createAdjustment(base({ amountPkr: -401, reason: 'Correction' })))
      .rejects.toThrow('negative customer balance')
    expect(repository.create).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('allows an adjustment to exactly clear the remaining balance', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([row('opening_balance', 1000), row('payment', 600)])
    await expect(service.createAdjustment(base({ amountPkr: -400, reason: 'Correction' })))
      .resolves.toMatchObject({ amountPkr: -400 })
  })

  it('rejects reversal of an opening balance already consumed by payments', async () => {
    const opening = row('opening_balance', 1000)
    const active = [opening, row('payment', 600)]
    repository.findById.mockResolvedValue(opening)
    repository.findActiveByShopAndCustomer.mockResolvedValue(active)
    const before = active.map(transaction => ({ ...transaction }))
    await expect(service.voidTransaction({ shop, customer, transactionId: opening._id, voidedBy: actor, voidReason: 'Correction' }))
      .rejects.toThrow('Resolve later payments or ledger activity first')
    expect(active).toEqual(before)
    expect(repository.markVoided).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('rejects reversal of a positive adjustment already consumed by payments', async () => {
    const adjustment = row('adjustment', 1000)
    repository.findById.mockResolvedValue(adjustment)
    repository.findActiveByShopAndCustomer.mockResolvedValue([adjustment, row('payment', 1000)])
    await expect(service.voidTransaction({ shop, customer, transactionId: adjustment._id, voidedBy: actor, voidReason: 'Correction' }))
      .rejects.toThrow('negative customer balance')
    expect(repository.markVoided).not.toHaveBeenCalled()
  })

  it('admits only one of two concurrent opening balances', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [] })
    const results = await Promise.allSettled([
      service.createOpeningBalance(base({ amountPkr: 1000 })),
      service.createOpeningBalance(base({ amountPkr: 1000 })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.message).toContain('already has an active opening balance')
    expect(ledgers.get(String(customer))).toHaveLength(1)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(1000)
  })

  it('serializes concurrent adjustments against the newly committed balance', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [row('opening_balance', 1000)] })
    const results = await Promise.allSettled([
      service.createAdjustment(base({ amountPkr: -600, reason: 'Correction A' })),
      service.createAdjustment(base({ amountPkr: -600, reason: 'Correction B' })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.message).toContain('negative customer balance')
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(400)
  })

  it('serializes payments and adjustments through the same customer claim', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [row('opening_balance', 1000)] })
    const results = await Promise.allSettled([
      service.createPayment(paymentInput({ amountPkr: 600 })),
      service.createAdjustment(base({ amountPkr: -600, reason: 'Correction' })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(400)
    expect(repository.create).toHaveBeenCalledOnce()
  })

  it('serializes opening-balance reversal against a concurrent payment', async () => {
    useFreshTransactionSessions()
    const opening = row('opening_balance', 1000)
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [opening] })
    const results = await Promise.allSettled([
      service.voidTransaction({ shop, customer, transactionId: opening._id, voidedBy: actor, voidReason: 'Correction' }),
      service.createPayment(paymentInput({ amountPkr: 600 })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBeGreaterThanOrEqual(0)
    if (opening.status === 'voided') {
      expect(ledgers.get(String(customer))).toHaveLength(1)
      expect(ledgerBalance(ledgers.get(String(customer)))).toBe(0)
    } else {
      expect(ledgers.get(String(customer))).toHaveLength(2)
      expect(ledgerBalance(ledgers.get(String(customer)))).toBe(400)
    }
  })

  it('preserves both concurrent positive adjustments instead of overwriting a cached balance', async () => {
    useFreshTransactionSessions()
    const ledgers = useInMemoryPaymentLedger({ [String(customer)]: [] })
    await Promise.all([
      service.createAdjustment(base({ amountPkr: 100, reason: 'Correction A' })),
      service.createAdjustment(base({ amountPkr: 200, reason: 'Correction B' })),
    ])
    expect(ledgers.get(String(customer))).toHaveLength(2)
    expect(ledgerBalance(ledgers.get(String(customer)))).toBe(300)
  })
})

describe('customer ledger service reads and voids', () => {
  it('derives balance from active transactions, ignoring voided rows and Customer.balanceDue', async () => {
    repository.findActiveByShopAndCustomer.mockResolvedValue([
      row('opening_balance', 10000), row('purchase', 5000), row('payment', 2000),
      row('adjustment', -1000), row('payment', 100000, { status: 'voided' }),
    ])
    await expect(service.getCurrentBalance({ shop, customer })).resolves.toBe(12000)
    expect(repository.findActiveByShopAndCustomer).toHaveBeenCalledWith({ shop, customer }, {})
  })

  it('calculates deterministic running balances without mutating stored transactions', async () => {
    const createdAt = new Date('2026-10-01T09:00:00Z')
    const firstId = new mongoose.Types.ObjectId('000000000000000000000001')
    const secondId = new mongoose.Types.ObjectId('000000000000000000000002')
    const rows = [
      row('payment', 2000, { _id: secondId, createdAt }),
      row('opening_balance', 10000, { _id: firstId, createdAt }),
      row('purchase', 5000, { businessDate: '2026-10-02' }),
      row('adjustment', -500, { businessDate: '2026-10-03', status: 'voided' }),
    ]
    repository.findByShopAndCustomer.mockResolvedValue(rows)
    const ledger = await service.getLedger({ shop, customer })
    expect(ledger.rows.map(item => item.runningBalancePkr)).toEqual([10000, 8000, 13000, 13000])
    expect(ledger.rows.map(item => item.balanceImpactPkr)).toEqual([10000, -2000, 5000, 0])
    expect(ledger.currentBalancePkr).toBe(13000)
    expect(rows[0]).not.toHaveProperty('runningBalancePkr')
  })

  it('computes a customer summary from ledger transactions', async () => {
    repository.findByShopAndCustomer.mockResolvedValue([
      row('opening_balance', 2000, { businessDate: '2026-09-28' }),
      row('purchase', 5000, { quantityKg: 10, teaType: 'green', productName: 'Green Tea Classic', businessDate: '2026-09-29' }),
      row('purchase', 3000, { quantityKg: 4, teaType: 'black', productName: 'Black Tea', businessDate: '2026-10-01' }),
      row('payment', 1000, { businessDate: '2026-09-30' }),
      row('payment', 8000, { status: 'voided' }),
    ])
    const summary = await service.getSummary({ shop, customer, referenceDate: '2026-10-01' })
    expect(summary).toMatchObject({
      totalPurchasedKg: 14,
      totalPurchasedPkr: 8000,
      totalPaidPkr: 1000,
      openingBalancePkr: 2000,
      currentBalancePkr: 9000,
      purchaseCount: 2,
      lastPurchaseDate: '2026-10-01',
      lastPaymentDate: '2026-09-30',
      daysSinceLastPayment: 1,
      productSummary: [
        {
          productName: 'Black Tea',
          teaType: 'black',
          totalQuantityKg: 4,
          totalSpendingPkr: 3000,
          purchaseCount: 1,
          lastPurchaseDate: '2026-10-01',
        },
        {
          productName: 'Green Tea Classic',
          teaType: 'green',
          totalQuantityKg: 10,
          totalSpendingPkr: 5000,
          purchaseCount: 1,
          lastPurchaseDate: '2026-09-29',
        },
      ],
    })
  })

  it('calculates inclusive daily payments, insights, and calendar levels from active rows', async () => {
    const payments = [row('payment', 1000, { businessDate: '2026-10-01' }), row('payment', 2000, { businessDate: '2026-10-03' })]
    repository.findRelevant.mockResolvedValue(payments)
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 10000), ...payments])
    const input = { shop, customer, startDate: '2026-10-01', endDate: '2026-10-03', referenceDate: '2026-10-03' }
    const buckets = await service.getDailyPayments(input)
    expect(buckets.map(bucket => bucket.amountPkr)).toEqual([1000, 0, 2000])
    expect(repository.findRelevant).toHaveBeenCalledWith({ shop, customer, fromBusinessDate: input.startDate, toBusinessDate: input.endDate, type: 'payment', status: 'active' }, {})
    const insight = await service.getPaymentInsight(input)
    expect(insight).toMatchObject({ paymentDaysCount: 2, paymentTransactionCount: 2, zeroPaymentDays: 1, highestPaymentDay: { date: '2026-10-03', amountPkr: 2000 }, estimatedDaysToClear: 7 })
    const calendar = await service.getPaymentCalendar(input)
    expect(calendar.map(bucket => bucket.level)).toEqual(['medium', 'none', 'high'])
  })

  it('uses earliest active debt date for a never-paid reminder candidate', async () => {
    repository.findByShopAndCustomer.mockResolvedValue([row('opening_balance', 5000, { businessDate: '2026-09-25' })])
    const result = await service.getReminderCandidate({ shop, customer, referenceDate: '2026-10-02', thresholdDays: 7 })
    expect(result).toMatchObject({ balanceDuePkr: 5000, lastPaymentDate: null, daysSinceLastPayment: null })
  })

  it('rejects cross-shop and cross-customer transaction access with the same not-found error', async () => {
    await expect(service.voidTransaction({ shop: otherShop, customer, transactionId, voidedBy: actor, voidReason: 'Duplicate' })).rejects.toThrow('not found')
    await expect(service.voidTransaction({ shop, customer: otherCustomer, transactionId, voidedBy: actor, voidReason: 'Duplicate' })).rejects.toThrow('not found')
    expect(repository.findById).toHaveBeenNthCalledWith(1, { shop: otherShop, customer, transactionId }, { session })
    expect(repository.findById).toHaveBeenNthCalledWith(2, { shop, customer: otherCustomer, transactionId }, { session })
    expect(repository.markVoided).not.toHaveBeenCalled()
  })

  it('voids an active transaction with operator, timestamp, reason and session', async () => {
    const now = new Date('2026-10-02T12:00:00Z')
    const session = { id: 'void-tx' }
    repository.findById.mockResolvedValue(row('payment', 1000))
    repository.markVoided.mockImplementation(async data => ({ ...data, status: 'voided' }))
    const result = await service.voidTransaction({ shop, customer, transactionId, voidedBy: actor, voidReason: '  Duplicate  ' }, { session, now })
    expect(result).toMatchObject({ status: 'voided', voidedAt: now, voidedBy: actor, voidReason: 'Duplicate' })
    expect(repository.findById).toHaveBeenCalledWith({ shop, customer, transactionId }, { session, now })
    expect(repository.markVoided).toHaveBeenCalledWith({ shop, customer, transactionId, voidedAt: now, voidedBy: actor, voidReason: 'Duplicate' }, { session, now })
  })

  it('rejects an already voided transaction and an atomic update that lost the race', async () => {
    repository.findById.mockResolvedValue(row('purchase', 1000, { status: 'voided' }))
    const input = { shop, customer, transactionId, voidedBy: actor, voidReason: 'Duplicate' }
    await expect(service.voidTransaction(input)).rejects.toThrow('already voided')
    repository.findById.mockResolvedValue(row('payment', 1000))
    await expect(service.voidTransaction(input)).rejects.toThrow('already voided')
  })

  it('rejects direct void of a Sale-linked charge and permits the Sale-owned void inside a session', async () => {
    repository.findById.mockResolvedValue(row('purchase', 5000, { saleId }))
    repository.markVoided.mockImplementation(async data => ({ ...data, status: 'voided' }))
    const input = { shop, customer, saleId, transactionId, voidedBy: actor, voidReason: 'Correction' }
    await expect(service.voidTransaction(input)).rejects.toThrow('voided through the Sale')
    expect(repository.markVoided).not.toHaveBeenCalled()
    expect(() => service.voidSalePurchase(input)).toThrow('requires a transaction session')
    await expect(service.voidSalePurchase({ ...input, saleId: new mongoose.Types.ObjectId() }, { session }))
      .rejects.toThrow('does not match')
    await expect(service.voidSalePurchase(input, { session })).resolves.toMatchObject({ status: 'voided' })
  })

  it('requires a void reason before reading a transaction', async () => {
    await expect(service.voidTransaction({ shop, customer, transactionId, voidedBy: actor, voidReason: '  ' })).rejects.toThrow('Void reason')
    expect(repository.findById).not.toHaveBeenCalled()
  })

  it('does not directly import the ledger Mongoose model', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('./customerLedgerService.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]\.\.\/models\/CustomerLedgerTransaction\.js['"]/)
  })
})

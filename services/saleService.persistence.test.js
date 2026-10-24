import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  saleInit: vi.fn(), saleFind: vi.fn(), saleCreate: vi.fn(), saleAggregate: vi.fn(), ledgerInit: vi.fn(),
  customerFind: vi.fn(), createCustomer: vi.fn(), shopExists: vi.fn(), userExists: vi.fn(), userFind: vi.fn(),
  itemFind: vi.fn(), itemList: vi.fn(), itemUpdate: vi.fn(),
  claim: vi.fn(), purchase: vi.fn(), payment: vi.fn(), balance: vi.fn(), notify: vi.fn(),
}))
vi.mock('../models/Sale.js', () => ({ Sale: { init: db.saleInit, findOne: db.saleFind, create: db.saleCreate, aggregate: db.saleAggregate }, SALE_IDEMPOTENCY_KEY_MAX_LENGTH: 128 }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { init: db.ledgerInit } }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOne: db.customerFind } }))
vi.mock('../models/Shop.js', () => ({ Shop: { exists: db.shopExists } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.userExists, findOne: db.userFind } }))
vi.mock('../models/Item.js', () => ({ Item: { findOne: db.itemFind, find: db.itemList, findOneAndUpdate: db.itemUpdate } }))
vi.mock('./customerLedgerService.js', () => ({ claimCustomerLedgerWrite: db.claim, createPurchase: db.purchase, createPayment: db.payment, getCurrentBalance: db.balance }))
vi.mock('./customerDirectoryService.js', () => ({ createCustomer: db.createCustomer }))
vi.mock('./notificationService.js', () => ({ evaluate: db.notify }))
import { createSale, getEntryOptions } from './saleService.js'

const shop = new mongoose.Types.ObjectId().toHexString()
const customer = new mongoose.Types.ObjectId().toHexString()
const actor = new mongoose.Types.ObjectId().toHexString()
const itemId = new mongoose.Types.ObjectId().toHexString()
const saleId = new mongoose.Types.ObjectId().toHexString()
const input = { shop, customer, createdBy: actor, stockLocationId: itemId, businessDate: '2026-10-13', teaType: 'green', quantityKg: 10, unitPrice: 1500, paymentMethod: 'credit', amountPaid: 5000, idempotencyKey: 'sale-retry-key' }
const item = { _id: itemId, shop, status: 'active', name: 'Green Tea Classic', teaType: 'Green Tea', stockKg: 100 }
let saved
let session

function query(result) {
  return { select() { return this }, session() { return this }, lean: async () => result, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) } }
}

function sortedQuery(result) {
  return { select() { return this }, sort() { return this }, lean: async () => result, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) } }
}

beforeEach(() => {
  vi.resetAllMocks()
  saved = undefined
  session = { withTransaction: vi.fn(callback => callback()), endSession: vi.fn() }
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session)
  db.saleInit.mockResolvedValue(undefined)
  db.ledgerInit.mockResolvedValue(undefined)
  db.saleFind.mockImplementation(() => query(saved))
  db.saleCreate.mockImplementation(async ([data]) => { saved = { _id: saleId, ...data }; return [saved] })
  db.shopExists.mockImplementation(() => query({ _id: shop }))
  db.customerFind.mockImplementation(() => query({ _id: customer, shop, name: 'Ahmed Khan', region: 'Lahore' }))
  db.userExists.mockImplementation(() => query({ _id: actor }))
  db.userFind.mockImplementation(() => query({ _id: actor, name: 'Admin', role: 'admin' }))
  db.itemFind.mockImplementation(() => query(item))
  db.itemList.mockImplementation(() => sortedQuery([]))
  db.itemUpdate.mockImplementation(() => query(item))
  db.saleAggregate.mockResolvedValue([])
  db.createCustomer.mockResolvedValue({ id: customer, name: 'New Retailer', city: 'Lahore', status: 'active' })
  db.balance.mockResolvedValue(13000)
})
afterEach(() => vi.restoreAllMocks())

describe('offline Sale persistence orchestration', () => {
  it.each([
    ['cash', 15000], ['credit', 5000], ['credit', 0],
  ])('persists a %s sale paid %i with inventory and customer accounting in the same session', async (paymentMethod, amountPaid) => {
    const result = await createSale({ ...input, paymentMethod, amountPaid })
    expect(result).toMatchObject({ _id: saleId, customer, customerName: 'Ahmed Khan', productName: item.name, totalAmount: 15000, amountPaid })
    expect(db.saleCreate).toHaveBeenCalledWith([expect.objectContaining({ quantityKg: 10, unitPrice: 1500, totalAmount: 15000, ledgerRecorded: true })], { session })
    expect(db.itemUpdate).toHaveBeenCalledWith({ _id: itemId, shop, status: 'active', stockKg: { $gte: 10 } }, { $inc: { stockKg: -10 } }, { new: false, runValidators: true })
    expect(result.inventoryMovements[0]).toMatchObject({ stockBeforeKg: 100, stockAfterKg: 90 })
    expect(db.purchase).toHaveBeenCalledWith(expect.objectContaining({ customer, saleId, quantityKg: 10, ratePerKgPkr: 1500 }), { session })
    if (amountPaid) expect(db.payment).toHaveBeenCalledWith(expect.objectContaining({ amountPkr: amountPaid, customer }), { session, saleId })
    else expect(db.payment).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('rejects insufficient stock before persisting sales or ledger entries', async () => {
    db.itemUpdate.mockImplementation(() => query(null))
    await expect(createSale(input)).rejects.toThrow('Insufficient stock')
    expect(db.saleCreate).not.toHaveBeenCalled()
    expect(db.purchase).not.toHaveBeenCalled()
    expect(db.payment).not.toHaveBeenCalled()
  })

  it('returns the persisted sale on retry without decrementing stock or adding accounting again', async () => {
    const first = await createSale(input)
    const retry = await createSale(input)
    expect(retry._id).toBe(first._id)
    expect(db.saleCreate).toHaveBeenCalledOnce()
    expect(db.itemUpdate).toHaveBeenCalledOnce()
    expect(db.purchase).toHaveBeenCalledOnce()
    expect(db.payment).toHaveBeenCalledOnce()
    await expect(createSale({ ...input, amountPaid: 1000 })).rejects.toThrow('different sale request')
  })

  it('rejects foreign customer ownership and unauthorized operators', async () => {
    db.customerFind.mockImplementation(() => query(null))
    await expect(createSale(input)).rejects.toThrow('Customer not found')
    expect(db.customerFind).toHaveBeenCalledWith({ _id: customer, shop })
    db.userExists.mockImplementation(() => query(null))
    await expect(createSale(input)).rejects.toThrow('Operator not found')
    expect(db.saleCreate).not.toHaveBeenCalled()
    expect(db.itemUpdate).not.toHaveBeenCalled()
  })

  it('creates an inline customer inside the sale transaction and links stock and Khata to it', async () => {
    const newCustomer = { name: ' New Retailer ', phone: ' 0300 1234567 ' }
    const result = await createSale({ ...input, customer: undefined, newCustomer })
    const retry = await createSale({ ...input, customer: undefined, newCustomer })

    expect(db.createCustomer).toHaveBeenCalledWith({
      shop,
      name: 'New Retailer',
      city: undefined,
      phone: '0300 1234567',
      address: undefined,
      region: undefined,
      notes: undefined,
      openingBalancePkr: 0,
      createdBy: actor,
      businessDate: input.businessDate,
    }, { session })
    expect(db.saleCreate).toHaveBeenCalledWith([expect.objectContaining({ customer, customerName: 'New Retailer', ledgerRecorded: true })], { session })
    expect(db.purchase).toHaveBeenCalledWith(expect.objectContaining({ customer, saleId }), { session })
    expect(result).toMatchObject({ customer, customerName: 'New Retailer' })
    expect(retry._id).toBe(result._id)
    expect(db.createCustomer).toHaveBeenCalledOnce()
    expect(db.saleCreate).toHaveBeenCalledOnce()
  })

  it('aborts inline-customer sale work on failure and accepts a same-key retry', async () => {
    const newCustomer = { name: 'New Retailer', address: 'Main Road' }
    db.itemUpdate
      .mockImplementationOnce(() => query(null))
      .mockImplementation(() => query(item))

    await expect(createSale({ ...input, customer: undefined, newCustomer }))
      .rejects.toThrow('Insufficient stock')

    expect(session.withTransaction).toHaveBeenCalledOnce()
    expect(db.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ shop, name: 'New Retailer' }), { session })
    expect(db.saleCreate).not.toHaveBeenCalled()
    expect(db.purchase).not.toHaveBeenCalled()
    expect(db.payment).not.toHaveBeenCalled()

    const retry = await createSale({ ...input, customer: undefined, newCustomer })

    expect(retry).toMatchObject({ _id: saleId, customer, customerName: 'New Retailer' })
    expect(db.createCustomer).toHaveBeenCalledTimes(2)
    expect(db.saleCreate).toHaveBeenCalledOnce()
    expect(db.purchase).toHaveBeenCalledOnce()
    expect(db.payment).toHaveBeenCalledOnce()
  })

  it('keeps opening Khata inside new-customer sale orchestration and the idempotency fingerprint', async () => {
    const newCustomer = { name: 'Opening Retailer', openingBalancePkr: 3000 }

    await createSale({ ...input, customer: undefined, newCustomer })

    expect(db.createCustomer).toHaveBeenCalledWith(expect.objectContaining({
      shop,
      name: 'Opening Retailer',
      openingBalancePkr: 3000,
      createdBy: actor,
      businessDate: input.businessDate,
    }), { session })
    expect(db.claim).not.toHaveBeenCalled()
    await expect(createSale({ ...input, customer: undefined, newCustomer: { ...newCustomer, openingBalancePkr: 4000 } }))
      .rejects.toThrow('different sale request')
  })

  it('returns shop-scoped inventory metadata and matches recent prices by normalized item ID', async () => {
    const updatedAt = new Date('2026-10-14T08:00:00.000Z')
    db.itemList.mockImplementation(() => sortedQuery([{ ...item, sellingPrice: undefined, lowStockThreshold: 20, updatedAt }]))
    db.saleAggregate.mockResolvedValue([{ _id: new mongoose.Types.ObjectId(itemId), price: 1750 }])

    await expect(getEntryOptions({ shop, userId: actor })).resolves.toEqual({
      operator: { id: actor, name: 'Admin', role: 'admin' },
      inventorySummary: { totalItems: 1, activeItems: 1, inactiveItems: 0, sellableItems: 1, outOfStockItems: 0 },
      items: [{ id: itemId, name: item.name, teaType: 'green', availableKg: 100, sellingPrice: 1750, lowStockThreshold: 20, updatedAt: updatedAt.toISOString() }],
    })
    expect(db.itemList).toHaveBeenCalledWith({ shop })
  })

  it('reports inactive and out-of-stock catalog state without exposing inactive products for sale', async () => {
    const inactiveId = new mongoose.Types.ObjectId().toHexString()
    const emptyId = new mongoose.Types.ObjectId().toHexString()
    db.itemList.mockImplementation(() => sortedQuery([
      { ...item, _id: inactiveId, status: 'inactive', name: 'Inactive Tea', stockKg: 40 },
      { ...item, _id: emptyId, status: 'active', name: 'Empty Tea', stockKg: 0 },
    ]))

    const result = await getEntryOptions({ shop, userId: actor })

    expect(result.inventorySummary).toEqual({ totalItems: 2, activeItems: 1, inactiveItems: 1, sellableItems: 0, outOfStockItems: 1 })
    expect(result.items).toEqual([expect.objectContaining({ id: emptyId, name: 'Empty Tea', availableKg: 0 })])
    expect(result.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: inactiveId })]))
  })
})

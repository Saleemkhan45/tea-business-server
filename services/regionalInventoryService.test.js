import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ region: vi.fn(), regions: vi.fn(), stock: vi.fn(), stocks: vi.fn(), change: vi.fn(), product: vi.fn(), products: vi.fn(), exists: vi.fn(), user: vi.fn(), operation: vi.fn(), operations: vi.fn(), createOperation: vi.fn(), sale: vi.fn(), createSale: vi.fn(), updateSale: vi.fn(), ledger: vi.fn(), createLedger: vi.fn(), purchase: vi.fn(), payment: vi.fn(), balance: vi.fn(), customer: vi.fn(), newCustomer: vi.fn() }))
vi.mock('../models/Region.js', () => ({ Region: { findOne: db.region, find: db.regions } }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { init: vi.fn(), findOne: db.stock, find: db.stocks, findOneAndUpdate: db.change } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { init: vi.fn(), findOne: db.operation, find: db.operations, create: db.createOperation } }))
vi.mock('../models/Item.js', () => ({ Item: { findOne: db.product, find: db.products, exists: db.exists } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.user, findOne: db.user } }))
vi.mock('../models/Sale.js', () => ({ Sale: { init: vi.fn(), findOne: db.sale, create: db.createSale, findOneAndUpdate: db.updateSale }, SALE_IDEMPOTENCY_KEY_MAX_LENGTH: 128 }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOne: db.customer } }))
vi.mock('../models/Shop.js', () => ({ Shop: { exists: vi.fn(() => ({ then: resolve => resolve(true), session() { return this } })) } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { init: vi.fn(), findOne: db.ledger, create: db.createLedger } }))
vi.mock('./customerLedgerService.js', () => ({ claimCustomerLedgerWrite: vi.fn(), createPurchase: db.purchase, createPayment: db.payment, getCurrentBalance: db.balance }))
vi.mock('./customerDirectoryService.js', () => ({ createCustomer: db.newCustomer }))
vi.mock('./notificationService.js', () => ({ evaluate: vi.fn() }))
import { createSale, getEntryOptions, updateSale, voidSale } from './saleService.js'
import { listInventory, normalizeStockOperation, recordStockOperation } from './regionalInventoryService.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', customer = '507f1f77bcf86cd799439003'
const islamabad = '507f1f77bcf86cd799439004', peshawar = '507f1f77bcf86cd799439005', item = '507f1f77bcf86cd799439006'
const islamabadStock = '507f1f77bcf86cd799439007', peshawarStock = '507f1f77bcf86cd799439008'
const input = { shop, createdBy: actor, customer, sellingRegion: islamabad, stockLocationId: islamabadStock, teaType: 'green', businessDate: '2026-10-15', quantityKg: 200, unitPrice: 800, paymentMethod: 'credit', amountPaid: 100000, idempotencyKey: 'sale-1' }
const transfer = { shop, actor, type: 'transfer', regionId: peshawar, destinationId: islamabad, itemId: item, quantityKg: 100, reason: 'Approved dispatch', idempotencyKey: 'transfer-1' }
let state, failLedger, failOperation, sessions, transactionTail
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(row, part))
    if (value && typeof value === 'object') return Object.entries(value).every(([operator, expected]) => operator === '$gte' ? row[key] >= expected : operator === '$lte' ? row[key] <= expected : operator === '$in' ? expected.includes(row[key]) : false)
    return String(row[key]) === String(value)
  })
}
function query(value) {
  return { session() { return this }, select() { return this }, sort() { return this }, limit() { return this }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } }
}
function document(row) { return row ? { ...structuredClone(row), save: async function () { state.sales[state.sales.findIndex(sale => sale._id === this._id)] = this.toObject() }, toObject() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')) } } : null }
beforeEach(() => {
  vi.clearAllMocks()
  failLedger = false; failOperation = false; sessions = []; transactionTail = Promise.resolve()
  state = {
    regions: [{ _id: islamabad, shop, name: 'Islamabad', status: 'active' }, { _id: peshawar, shop, name: 'Peshawar', status: 'active' }],
    products: [{ _id: item, shop, name: 'Green Tea', teaType: 'Green Tea', status: 'active', sellingPrice: 800, stockKg: 999 }],
    stocks: [{ _id: islamabadStock, shop, region: islamabad, item, quantityGrams: 500000, updatedAt: new Date() }, { _id: peshawarStock, shop, region: peshawar, item, quantityGrams: 350000, updatedAt: new Date() }], sales: [], operations: [], ledger: [],
  }
  vi.spyOn(mongoose, 'startSession').mockImplementation(async () => {
    const session = { endSession: vi.fn(), withTransaction: async callback => {
      const previous = transactionTail
      let release; transactionTail = new Promise(resolve => { release = resolve })
      await previous
      const before = structuredClone(state)
      try { return await callback() } catch (error) { state = before; throw error } finally { release() }
    } }; sessions.push(session); return session
  })
  db.region.mockImplementation(filter => query(state.regions.find(row => matches(row, filter)) ?? null))
  db.regions.mockImplementation(filter => query(state.regions.filter(row => matches(row, filter))))
  db.stock.mockImplementation(filter => query(state.stocks.find(row => matches(row, filter)) ?? null))
  db.stocks.mockImplementation(filter => query(state.stocks.filter(row => matches(row, filter))))
  db.change.mockImplementation((filter, update) => {
    const row = state.stocks.find(row => matches(row, filter)); const before = row ? structuredClone(row) : null
    if (row) row.quantityGrams += update.$inc.quantityGrams
    return query(before)
  })
  db.product.mockImplementation(filter => query(state.products.find(row => matches(row, filter)) ?? null))
  db.products.mockImplementation(filter => query(state.products.filter(row => matches(row, filter))))
  db.exists.mockImplementation(filter => query(state.products.find(row => matches(row, filter)) ?? null))
  db.user.mockImplementation(() => query({ _id: actor, name: 'Admin', role: 'admin' }))
  db.customer.mockImplementation(() => query({ _id: customer, shop, name: 'Retailer', region: 'Customer address region' }))
  db.newCustomer.mockImplementation(async value => { if (value.openingBalancePkr) state.ledger.push({ type: 'opening_balance', amountPkr: value.openingBalancePkr }); return { id: customer, name: value.name, region: 'Customer region' } })
  db.sale.mockImplementation(filter => query(document(state.sales.find(row => matches(row, filter)))))
  db.createSale.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); const row = { _id: '507f1f77bcf86cd799439009', ...value }; state.sales.push(row); return [row] })
  db.updateSale.mockImplementation((filter, changes, options) => {
    expect(options.session).toBeTruthy()
    const row = state.sales.find(row => matches(row, filter))
    if (!row) return query(null)
    Object.assign(row, changes.$set)
    row.editHistory ??= []; row.editHistory.push(changes.$push.editHistory)
    if (changes.$push.inventoryMovements) row.inventoryMovements.push(...changes.$push.inventoryMovements.$each)
    return query(row)
  })
  db.operation.mockImplementation(filter => query(state.operations.find(row => matches(row, filter)) ?? null))
  db.createOperation.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); if (failOperation) throw new Error('Audit write failed'); const row = { _id: 'op-1', ...value }; state.operations.push(row); return [row] })
  db.purchase.mockImplementation(async (value, options) => { expect(options.session).toBeTruthy(); if (failLedger) throw new Error('Ledger failed'); state.ledger.push({ _id: 'purchase', ...value, type: 'purchase', amountPkr: value.quantityKg * value.ratePerKgPkr, status: 'active' }) })
  db.payment.mockImplementation(async (value, options) => { state.ledger.push({ _id: 'payment', ...value, saleId: options.saleId, type: 'payment', status: 'active' }) })
  db.balance.mockImplementation(async () => state.ledger.reduce((sum, row) => sum + (['payment', 'return'].includes(row.type) ? -row.amountPkr : row.amountPkr), 0))
  db.ledger.mockImplementation(filter => query(state.ledger.find(row => matches(row, filter)) ?? null))
  db.createLedger.mockImplementation(async rows => { state.ledger.push(...rows); return rows })
})
afterEach(() => vi.restoreAllMocks())

describe('regional inventory offline orchestration (simulated transactions, no Mongo connection)', () => {
  it('records salesperson independently of the operator and binds attribution to idempotency', async () => {
    const request = { ...input, salespersonName: '  Ali  ' }
    const sale = await createSale(request)
    expect(sale).toMatchObject({ shop, salespersonName: 'Ali', createdBy: actor })
    expect(sale.inventoryMovements[0].createdBy).toBe(actor)
    expect(state.ledger.every(row => row.createdBy === actor)).toBe(true)
    await createSale({ ...request, salespersonName: 'Ali' })
    expect(db.createSale).toHaveBeenCalledOnce()
    await expect(createSale({ ...request, salespersonName: 'Kamran' })).rejects.toThrow('different sale request')
    expect(state.stocks.map(stock => stock.quantityGrams)).toEqual([300000, 350000])
  })

  it('validates salesperson before writing and retains operator authorization', async () => {
    await expect(createSale({ ...input, salespersonName: 'a'.repeat(161) })).rejects.toThrow('Salesperson name')
    expect(db.change).not.toHaveBeenCalled()
    db.user.mockImplementation(() => query(null))
    await expect(createSale({ ...input, salespersonName: 'Admin' })).rejects.toThrow('Operator not found')
    expect(db.createSale).not.toHaveBeenCalled()
  })

  it('includes salesperson changes in audited sale edits without replacing the creator', async () => {
    const sale = await createSale({ ...input, customer: undefined, paymentMethod: 'cash', amountPaid: 160000, salespersonName: 'Ali' })
    const updated = await updateSale({ shop, saleId: sale._id, createdBy: actor, salespersonName: '  Jahan  ' })
    expect(updated).toMatchObject({ salespersonName: 'Jahan', createdBy: actor })
    expect(updated.editHistory.at(-1)).toMatchObject({ salespersonName: 'Ali', createdBy: actor, changedBy: actor })
    expect(state.stocks.map(stock => stock.quantityGrams)).toEqual([300000, 350000])
  })
  it('lists the same catalog product with independent quantities in two regions', async () => {
    const rows = await listInventory({ shop })
    expect(rows.map(row => [row.itemId, row.regionName, row.availableKg])).toEqual([[item, 'Islamabad', 500], [item, 'Peshawar', 350]])
  })
  it('returns only the selected region from entry-options', async () => {
    const result = await getEntryOptions({ shop, userId: actor, regionId: peshawar })
    expect(result.items).toEqual([expect.objectContaining({ id: peshawarStock, itemId: item, regionId: peshawar, availableKg: 350 })])
  })
  it('deducts Islamabad only and preserves customer region, product identity and exact Khata', async () => {
    const sale = await createSale(input)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 350000])
    expect(state.products[0].stockKg).toBe(999)
    expect(sale).toMatchObject({ sellingRegion: islamabad, product: item, customerRegion: 'Customer address region', totalAmount: 160000, amountPaid: 100000 })
    expect(await db.balance()).toBe(60000)
    expect(db.change).toHaveBeenCalledWith({ _id: islamabadStock, shop, region: islamabad, quantityGrams: { $gte: 200000 } }, { $inc: { quantityGrams: -200000 } }, { new: false, runValidators: true })
  })
  it('rejects insufficient stock without Sale or ledger writes', async () => {
    await expect(createSale({ ...input, quantityKg: 501 })).rejects.toThrow('Insufficient stock')
    expect(state.sales).toHaveLength(0); expect(state.ledger).toHaveLength(0)
    expect(state.stocks[0].quantityGrams).toBe(500000)
  })
  it('concurrent simulated sales cannot consume more than the guarded regional balance', async () => {
    const results = await Promise.allSettled([createSale({ ...input, quantityKg: 300, idempotencyKey: 'one' }), createSale({ ...input, quantityKg: 300, idempotencyKey: 'two' })])
    expect(results.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([200000, 350000])
  })
  it.each(['unknown', 'inactive', 'cross-shop'])('rejects %s selling regions', async mode => {
    if (mode === 'unknown') state.regions = []
    else if (mode === 'inactive') state.regions[0].status = 'inactive'
    else state.regions[0].shop = peshawar
    await expect(createSale(input)).rejects.toThrow('Region is unavailable')
    expect(db.change).not.toHaveBeenCalled()
  })
  it('rejects a product stock ID belonging to the other region', async () => {
    await expect(createSale({ ...input, stockLocationId: peshawarStock })).rejects.toThrow('Regional stock is unavailable')
    expect(db.change).not.toHaveBeenCalled()
  })
  it('rejects cross-shop stock', async () => {
    state.stocks[0].shop = peshawar
    await expect(createSale(input)).rejects.toThrow('Regional stock is unavailable')
  })
  it('rejects inactive catalog products', async () => {
    state.products[0].status = 'inactive'
    await expect(createSale(input)).rejects.toThrow('Regional product is unavailable')
  })
  it('replays the same sale without a second stock deduction and binds the key to region', async () => {
    const first = await createSale(input); const second = await createSale(input)
    expect(second._id).toBe(first._id); expect(db.change).toHaveBeenCalledOnce()
    await expect(createSale({ ...input, sellingRegion: peshawar, stockLocationId: peshawarStock })).rejects.toThrow('different sale request')
  })
  it('records a fully paid cash sale without new debt', async () => {
    await createSale({ ...input, paymentMethod: 'cash', amountPaid: 160000 })
    expect(await db.balance()).toBe(0)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 350000])
  })
  it('records new-customer opening Khata atomically with regional stock', async () => {
    await createSale({ ...input, customer: undefined, newCustomer: { name: 'New Retailer', openingBalancePkr: 20000 } })
    expect(db.newCustomer).toHaveBeenCalledWith(expect.objectContaining({ openingBalancePkr: 20000 }), { session: sessions[0] })
    expect(await db.balance()).toBe(80000)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 350000])
  })
  it('rolls back simulated stock, new customer opening ledger and sale when ledger creation fails', async () => {
    failLedger = true
    await expect(createSale({ ...input, customer: undefined, newCustomer: { name: 'New', openingBalancePkr: 20000 } })).rejects.toThrow('Ledger failed')
    expect(state.sales).toHaveLength(0); expect(state.ledger).toHaveLength(0)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 350000])
    failLedger = false; await createSale(input)
    expect(state.sales).toHaveLength(1)
  })
  it('restores the original region once on cancellation even when inactive', async () => {
    const sale = await createSale(input)
    state.regions[0].status = 'inactive'; state.products[0].status = 'inactive'
    await voidSale({ shop, saleId: sale._id, voidedBy: actor, voidReason: 'Cancelled' })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 350000])
    expect(state.sales[0].inventoryMovements.at(-1)).toMatchObject({ regionalStock: islamabadStock, region: islamabad, item, type: 'sale_restore' })
    await expect(voidSale({ shop, saleId: sale._id, voidedBy: actor, voidReason: 'Again' })).rejects.toThrow('already voided')
    expect(state.stocks[0].quantityGrams).toBe(500000)
  })
  it('transfers stock atomically between the two region records and replays exactly once', async () => {
    await recordStockOperation(transfer); await recordStockOperation(transfer)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([600000, 250000])
    expect(state.operations).toHaveLength(1)
    expect(state.operations[0]).toMatchObject({ type: 'transfer', region: peshawar, destination: islamabad, createdBy: actor, quantityGrams: 100000 })
    await expect(recordStockOperation({ ...transfer, quantityKg: 1 })).rejects.toThrow('another stock operation')
  })
  it('rejects insufficient source stock and rolls back any destination increment', async () => {
    await expect(recordStockOperation({ ...transfer, quantityKg: 351 })).rejects.toThrow('sufficient stock')
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 350000]); expect(state.operations).toHaveLength(0)
  })
  it('rolls back both transfer sides if audit persistence fails', async () => {
    failOperation = true
    await expect(recordStockOperation(transfer)).rejects.toThrow('Audit write failed')
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 350000])
  })
  it('records receipts and signed corrections and prevents negative balances', async () => {
    await recordStockOperation({ ...transfer, type: 'receipt', regionId: islamabad, quantityKg: 0.125 })
    expect(state.stocks[0].quantityGrams).toBe(500125)
    await recordStockOperation({ ...transfer, type: 'correction', regionId: islamabad, quantityKg: -0.125, idempotencyKey: 'correction' })
    expect(state.stocks[0].quantityGrams).toBe(500000)
    await expect(recordStockOperation({ ...transfer, type: 'correction', regionId: islamabad, quantityKg: -501, idempotencyKey: 'bad-correction' })).rejects.toThrow('sufficient stock')
  })
  it('requires manager authorization for stock operations', async () => {
    db.user.mockImplementation(() => query(null))
    await expect(recordStockOperation(transfer)).rejects.toThrow('Only an owner or admin')
    expect(db.change).not.toHaveBeenCalled()
  })
  it('filters inventory by region, name and availability without leaking other shops', async () => {
    state.stocks[1].shop = peshawar
    expect(await listInventory({ shop, search: 'GREEN', availability: 'available' })).toHaveLength(1)
    expect(await listInventory({ shop, search: 'missing' })).toEqual([])
    state.stocks[0].quantityGrams = 0
    expect(await listInventory({ shop, availability: 'out_of_stock' })).toHaveLength(1)
  })
  it('keeps inactive regional inventory readable without allowing sales or stock operations', async () => {
    state.regions[0].status = 'inactive'
    const rows = await listInventory({ shop, regionId: islamabad })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ regionId: islamabad, availableKg: 500, status: 'inactive' })
    await expect(createSale(input)).rejects.toThrow()
    await expect(recordStockOperation({ ...transfer, regionId: islamabad, destinationId: peshawar })).rejects.toThrow('unavailable')
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 350000])
  })
  it('rejects another shop region when reading filtered inventory', async () => {
    state.regions[0].shop = peshawar
    await expect(listInventory({ shop, regionId: islamabad })).rejects.toThrow('Region not found')
    expect(db.stocks).not.toHaveBeenCalled()
  })
  it.each([0, -1, 0.0001, NaN, Infinity, '1'])('rejects invalid receipt quantity %s', quantityKg => {
    expect(() => normalizeStockOperation({ ...transfer, type: 'receipt', quantityKg })).toThrow('Quantity')
  })
  it('rejects transfers to the source region', () => {
    expect(() => normalizeStockOperation({ ...transfer, destinationId: peshawar })).toThrow('differ')
  })
})

it('moves a corrected regional sale by restoring the old region and deducting only the new region', async () => {
  const sale = await createSale({ ...input, customer: undefined, paymentMethod: 'cash', amountPaid: 160000 })
  await updateSale({ shop, saleId: sale._id, createdBy: actor, sellingRegion: peshawar, stockLocationId: peshawarStock, quantityKg: 50, amountPaid: 40000 })
  expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 300000])
  expect(state.sales[0]).toMatchObject({ sellingRegion: peshawar, sellingRegionName: 'Peshawar', product: item })
  expect(state.sales[0].editHistory[0]).toMatchObject({ sellingRegion: islamabad })
})
it('rolls back an old-region restoration if the replacement regional stock is insufficient', async () => {
  const sale = await createSale({ ...input, customer: undefined, paymentMethod: 'cash', amountPaid: 160000 })
  await expect(updateSale({ shop, saleId: sale._id, createdBy: actor, sellingRegion: peshawar, stockLocationId: peshawarStock, quantityKg: 400, amountPaid: 320000 })).rejects.toThrow('Insufficient stock')
  expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 350000])
  expect(state.sales[0].sellingRegion).toBe(islamabad)
})

it('makes custom Other stock available to sales and records the same category in credit Khata', async () => {
  state.products[0].teaType = 'Other'; state.products[0].name = 'Special Green Tea'; state.products[0].sellingPrice = 950
  const options = await getEntryOptions({ shop, userId: actor, regionId: islamabad })
  expect(options.items[0]).toMatchObject({ teaType: 'other', name: 'Special Green Tea', availableKg: 500, sellingPrice: 950 })
  const sale = await createSale({ ...input, teaType: 'other', unitPrice: 950, amountPaid: 0 })
  expect(sale).toMatchObject({ teaType: 'other', productName: 'Special Green Tea', totalAmount: 190000 })
  expect(state.ledger[0]).toMatchObject({ teaType: 'other', ratePerKgPkr: 950 })
  expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 350000])
})
it.each(['inactive', 'zero'])('keeps custom products unsellable when %s', async condition => {
  state.products[0].teaType = 'Other'
  if (condition === 'inactive') state.products[0].status = 'inactive'
  else state.stocks[0].quantityGrams = 0
  await expect(createSale({ ...input, teaType: 'other' })).rejects.toThrow()
  expect(state.sales).toEqual([]); expect(state.ledger).toEqual([])
})

import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ purchase: vi.fn(), purchases: vi.fn(), create: vi.fn(), update: vi.fn(), supplier: vi.fn(), region: vi.fn(), item: vi.fn(), stockExists: vi.fn(), stockUpdate: vi.fn(), movement: vi.fn(), actor: vi.fn() }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { init: vi.fn(), findOne: db.purchase, find: db.purchases, create: db.create, findOneAndUpdate: db.update } }))
vi.mock('../models/Supplier.js', () => ({ Supplier: { findOne: db.supplier } }))
vi.mock('../models/Region.js', () => ({ Region: { findOne: db.region } }))
vi.mock('../models/Item.js', () => ({ Item: { findOne: db.item } }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { exists: db.stockExists, findOneAndUpdate: db.stockUpdate } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { init: vi.fn(), create: db.movement } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.actor } }))
import { createPurchase, receivePurchase, payPurchase, voidPurchase } from './purchaseService.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', region = '507f1f77bcf86cd799439003', other = '507f1f77bcf86cd799439004', item = '507f1f77bcf86cd799439005', supplier = '507f1f77bcf86cd799439006'
const input = { shop, actor, supplier, item, receivingRegion: region, businessDate: '2026-10-15', quantityKg: 200, unitCost: 600, status: 'received', idempotencyKey: 'purchase-1' }
let state, failAudit, allowed, tail
function matches(row, filter) { return row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' ? Object.entries(value).every(([op, limit]) => op === '$gte' ? row[key] >= limit : op === '$lte' ? row[key] <= limit : false) : String(row[key]) === String(value)) }
function query(value) { const copy = structuredClone(value); return { session() { return this }, select() { return this }, sort() { return this }, lean: async () => copy, then(resolve, reject) { return Promise.resolve(copy).then(resolve, reject) } } }
beforeEach(() => {
  vi.clearAllMocks(); failAudit = false; allowed = true; tail = Promise.resolve()
  state = { purchases: [], movements: [], stocks: [{ shop, region, item, quantityGrams: 300000 }, { shop, region: other, item, quantityGrams: 300000 }] }
  vi.spyOn(mongoose, 'startSession').mockImplementation(async () => ({ endSession: vi.fn(), withTransaction: async callback => {
    const prior = tail; let release; tail = new Promise(resolve => { release = resolve }); await prior
    const before = structuredClone(state)
    try { return await callback() } catch (error) { state = before; throw error } finally { release() }
  } }))
  db.actor.mockImplementation(() => query(allowed ? { _id: actor } : null))
  db.region.mockImplementation(filter => query(matches({ _id: region, shop, status: 'active', name: 'Islamabad' }, filter) ? { _id: region, name: 'Islamabad' } : null))
  db.item.mockImplementation(filter => query(matches({ _id: item, shop, status: 'active' }, filter) ? { _id: item, name: 'Green Tea' } : null))
  db.supplier.mockImplementation(filter => query(matches({ _id: supplier, shop, status: 'active' }, filter) ? { _id: supplier, name: 'Supplier' } : null))
  db.stockExists.mockImplementation(filter => query(state.stocks.find(row => matches(row, filter)) ?? null))
  db.purchase.mockImplementation(filter => query(state.purchases.find(row => matches(row, filter)) ?? null))
  db.purchases.mockImplementation(filter => query(state.purchases.filter(row => matches(row, filter))))
  db.create.mockImplementation(async ([value], options) => {
    expect(options.session).toBeTruthy()
    const row = { _id: `507f1f77bcf86cd7994390${String(10 + state.purchases.length).padStart(2, '0')}`, revision: 0, ...structuredClone(value) }
    state.purchases.push(row); return [row]
  })
  db.update.mockImplementation((filter, changes, options) => {
    expect(options.session).toBeTruthy()
    const row = state.purchases.find(row => matches(row, filter)); if (!row) return query(null)
    Object.assign(row, changes.$set ?? {})
    if (changes.$inc?.revision) row.revision += changes.$inc.revision
    if (changes.$push?.payments) row.payments.push(changes.$push.payments)
    return query(row)
  })
  db.stockUpdate.mockImplementation((filter, changes, options) => {
    expect(options.session).toBeTruthy()
    const row = state.stocks.find(row => matches(row, filter)); const before = row ? structuredClone(row) : null
    if (row) {
      row.quantityGrams += changes.$inc.quantityGrams ?? 0
      if (changes.$inc.assignmentRevision) row.assignmentRevision = (row.assignmentRevision ?? 0) + changes.$inc.assignmentRevision
    }
    return query(before)
  })
  db.movement.mockImplementation(async ([row], options) => { expect(options.session).toBeTruthy(); if (failAudit) throw new Error('Audit failed'); state.movements.push(row); return [row] })
})
afterEach(() => vi.restoreAllMocks())

describe('regional purchase orchestration (simulated transactions, no database connection)', () => {
  it('receives exactly one regional purchase and preserves the other region', async () => {
    const purchase = await createPurchase(input)
    expect(purchase).toMatchObject({ regionName: 'Islamabad', supplierName: 'Supplier', totalAmount: 120000, createdBy: actor, paidAmount: 0 })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 300000])
    expect(state.movements[0]).toMatchObject({ type: 'purchase_receipt', purchase: purchase._id, region, createdBy: actor })
    expect(state.movements[0].balances[0]).toMatchObject({ beforeGrams: 300000, afterGrams: 500000 })
  })
  it('replays a purchase key without another receipt and rejects altered intent', async () => {
    await createPurchase(input); await createPurchase(input)
    expect(db.create).toHaveBeenCalledOnce(); expect(state.movements).toHaveLength(1)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 300000])
    await expect(createPurchase({ ...input, quantityKg: 201 })).rejects.toThrow('different purchase')
  })
  it.each(['pending', 'in_transit'])('does not add stock until a %s purchase is received, and receipt replay is safe', async status => {
    const purchase = await createPurchase({ ...input, status })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 300000])
    expect(state.stocks[0].assignmentRevision).toBe(1)
    expect(state.movements).toHaveLength(0)
    await receivePurchase({ shop, actor, purchaseId: purchase._id })
    await receivePurchase({ shop, actor, purchaseId: purchase._id })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([500000, 300000])
    expect(state.movements).toHaveLength(1)
  })
  it('rolls back purchase creation and regional stock if the audit write fails', async () => {
    failAudit = true
    await expect(createPurchase(input)).rejects.toThrow('Audit failed')
    expect(state.purchases).toEqual([]); expect(state.stocks[0].quantityGrams).toBe(300000)
    failAudit = false; await createPurchase(input)
    expect(state.stocks[0].quantityGrams).toBe(500000)
  })
  it('guards concurrent receipt retries against double stock additions', async () => {
    const purchase = await createPurchase({ ...input, status: 'pending' })
    await Promise.all([receivePurchase({ shop, actor, purchaseId: purchase._id }), receivePurchase({ shop, actor, purchaseId: purchase._id })])
    expect(state.stocks[0].quantityGrams).toBe(500000); expect(state.movements).toHaveLength(1)
  })
  it('rolls back a failed receipt transition and permits the same purchase to be received once on retry', async () => {
    const purchase = await createPurchase({ ...input, status: 'pending' })
    failAudit = true
    await expect(receivePurchase({ shop, actor, purchaseId: purchase._id })).rejects.toThrow('Audit failed')
    expect(state.purchases[0].status).toBe('pending'); expect(state.stocks[0].quantityGrams).toBe(300000)
    failAudit = false
    await receivePurchase({ shop, actor, purchaseId: purchase._id })
    expect(state.stocks[0].quantityGrams).toBe(500000)
  })
  it('does not allow concurrent purchase payments to exceed the invoice total', async () => {
    const purchase = await createPurchase(input)
    const payment = { shop, actor, purchaseId: purchase._id, amountPkr: 70000, method: 'cash', businessDate: input.businessDate }
    const results = await Promise.allSettled([payPurchase({ ...payment, idempotencyKey: 'payment-a' }), payPurchase({ ...payment, idempotencyKey: 'payment-b' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(state.purchases[0].payments).toHaveLength(1)
  })
  it('voids an unreceived purchase without moving stock and rejects cross-shop purchase access', async () => {
    const purchase = await createPurchase({ ...input, status: 'in_transit' })
    await expect(receivePurchase({ shop: other, actor, purchaseId: purchase._id })).rejects.toThrow('Purchase not found')
    await voidPurchase({ shop, actor, purchaseId: purchase._id, reason: 'Order cancelled before receipt' })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 300000])
    expect(state.movements).toHaveLength(0)
    expect(state.purchases[0].status).toBe('voided')
  })
  it('records immutable purchase payments idempotently and prevents overpayment', async () => {
    const purchase = await createPurchase(input)
    const payment = { shop, actor, purchaseId: purchase._id, amountPkr: 50000, method: 'cash', businessDate: '2026-10-15', idempotencyKey: 'payment-1' }
    await payPurchase(payment); const replay = await payPurchase(payment)
    expect(replay.paidAmount).toBe(50000); expect(replay.payments).toHaveLength(1)
    expect(replay.payments[0].createdBy).toBe(actor)
    await expect(payPurchase({ ...payment, amountPkr: 1 })).rejects.toThrow('another payment')
    await expect(payPurchase({ ...payment, amountPkr: 70001, idempotencyKey: 'overpay' })).rejects.toThrow('remaining purchase balance')
  })
  it('records an initial supplier payment inside the purchase transaction', async () => {
    const purchase = await createPurchase({ ...input, payment: { amountPkr: 1000, method: 'cash', businessDate: input.businessDate, idempotencyKey: 'initial-payment' } })
    expect(purchase.paidAmount).toBe(1000)
    expect(purchase.payments[0].createdBy).toBe(actor)
    await expect(voidPurchase({ shop, actor, purchaseId: purchase._id, reason: 'Returned' })).rejects.toThrow('refunds')
  })
  it('reverses a receipt once, retaining purchase and movement audit history', async () => {
    const purchase = await createPurchase(input)
    await voidPurchase({ shop, actor, purchaseId: purchase._id, reason: 'Supplier return' })
    await voidPurchase({ shop, actor, purchaseId: purchase._id, reason: 'Supplier return' })
    expect(state.stocks.map(row => row.quantityGrams)).toEqual([300000, 300000])
    expect(state.purchases[0]).toMatchObject({ status: 'voided', voidedBy: actor })
    expect(state.movements.map(row => row.type)).toEqual(['purchase_receipt', 'purchase_reversal'])
  })
  it('rejects a reversal after stock consumption and rolls the status back', async () => {
    const purchase = await createPurchase(input); state.stocks[0].quantityGrams = 1000
    await expect(voidPurchase({ shop, actor, purchaseId: purchase._id, reason: 'Return' })).rejects.toThrow('insufficient')
    expect(state.purchases[0].status).toBe('received'); expect(state.movements).toHaveLength(1)
  })
  it('rejects foreign or inactive destinations, suppliers, products, missing assignments and unauthorized actors', async () => {
    for (const change of [{ receivingRegion: other }, { supplier: other }, { item: other }]) await expect(createPurchase({ ...input, ...change })).rejects.toThrow()
    state.stocks = []; await expect(createPurchase(input)).rejects.toThrow('Assign this product')
    allowed = false; await expect(createPurchase(input)).rejects.toThrow('owner or admin')
    expect(db.create).not.toHaveBeenCalled()
  })
  it('rejects fractional PKR totals and forged audit fields before performing writes', async () => {
    await expect(createPurchase({ ...input, quantityKg: 0.001, unitCost: 1 })).rejects.toThrow('whole PKR subtotal')
    await expect(createPurchase({ ...input, createdBy: other })).rejects.toThrow()
    await expect(createPurchase({ ...input, payment: { amountPkr: 120001, method: 'cash', businessDate: input.businessDate, idempotencyKey: 'overpayment' } })).rejects.toThrow('exceeds')
    expect(db.create).not.toHaveBeenCalled()
  })
})

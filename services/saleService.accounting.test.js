import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  saleFindOne: vi.fn(), saleSave: vi.fn(), itemFindOne: vi.fn(), itemSave: vi.fn(),
  ledgerFindOne: vi.fn(), ledgerCreate: vi.fn(), ledgerInit: vi.fn(),
  userExists: vi.fn(), claim: vi.fn(), balance: vi.fn(), voidPurchase: vi.fn(), notify: vi.fn(),
}))

vi.mock('../models/Sale.js', () => ({ Sale: { findOne: db.saleFindOne }, SALE_IDEMPOTENCY_KEY_MAX_LENGTH: 128 }))
vi.mock('../models/Item.js', () => ({ Item: { findOne: db.itemFindOne } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({
  CustomerLedgerTransaction: { init: db.ledgerInit, findOne: db.ledgerFindOne, create: db.ledgerCreate },
}))
vi.mock('../models/User.js', () => ({ User: { exists: db.userExists } }))
vi.mock('../models/Customer.js', () => ({ Customer: {} }))
vi.mock('../models/Shop.js', () => ({ Shop: {} }))
vi.mock('./customerLedgerService.js', () => ({
  claimCustomerLedgerWrite: db.claim, getCurrentBalance: db.balance, voidSalePurchase: db.voidPurchase,
}))
vi.mock('./customerDirectoryService.js', () => ({ createCustomer: vi.fn() }))
vi.mock('./notificationService.js', () => ({ evaluate: db.notify }))

import { voidSale } from './saleService.js'
import { balancePkr } from './customerLedgerCalculations.js'
import { mapSalesError } from '../controllers/salesController.js'
import { mapCustomerLedgerError } from '../controllers/customerLedgerController.js'

const shop = new mongoose.Types.ObjectId().toHexString()
const customer = new mongoose.Types.ObjectId().toHexString()
const actor = new mongoose.Types.ObjectId().toHexString()
const saleId = new mongoose.Types.ObjectId().toHexString()
const itemId = new mongoose.Types.ObjectId().toHexString()
const purchaseId = new mongoose.Types.ObjectId().toHexString()
const now = new Date('2026-10-07T06:00:00Z')
const input = { shop, saleId, voidedBy: actor, voidReason: 'Customer cancelled' }
let state
let session

function query(result) {
  return {
    session() { return this },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
  }
}

function document(data, save) {
  const value = { ...data }
  value.toObject = () => Object.fromEntries(Object.entries(value).filter(([, field]) => typeof field !== 'function'))
  value.save = save.bind(null, value)
  return value
}

function payment(amountPkr, extra = {}) {
  return { _id: new mongoose.Types.ObjectId().toHexString(), shop, customer, type: 'payment', status: 'active', amountPkr, paymentMethod: 'cash', ...extra }
}

beforeEach(() => {
  vi.resetAllMocks()
  state = {
    customer: { ledgerRevision: 0, balanceDue: 999999 },
    item: { _id: itemId, shop, name: 'Green Tea', teaType: 'Green Tea', status: 'active', stockKg: 90 },
    sale: {
      _id: saleId, shop, customer, status: 'completed', paymentMethod: 'credit', ledgerRecorded: true,
      totalAmount: 10000, amountPaid: 0, quantityKg: 10, unitPrice: 1000, teaType: 'green',
      productName: 'Green Tea', stockLocationId: itemId, inventoryMovements: [{ type: 'sale_decrease', item: itemId }],
    },
    ledger: [{ _id: purchaseId, shop, customer, saleId, type: 'purchase', status: 'active', amountPkr: 10000 }],
  }
  session = {
    withTransaction: vi.fn(async callback => {
      const before = structuredClone(state)
      try { return await callback() } catch (error) { state = before; throw error }
    }),
    endSession: vi.fn(),
  }
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session)
  db.saleFindOne.mockImplementation(filter => query(filter._id === saleId && filter.shop === shop
    ? document(structuredClone(state.sale), async (value, options) => {
      state.sale = value.toObject()
      await db.saleSave(options)
    }) : null))
  db.itemFindOne.mockImplementation(() => query(state.item.status === 'active'
    ? document({ ...state.item }, async (value, options) => {
      state.item = value.toObject()
      await db.itemSave(options)
    }) : null))
  db.ledgerFindOne.mockImplementation(filter => query(state.ledger.find(row =>
    Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null))
  db.ledgerCreate.mockImplementation(async rows => {
    const created = rows.map(row => ({ _id: new mongoose.Types.ObjectId().toHexString(), ...row }))
    state.ledger.push(...created)
    return created
  })
  db.userExists.mockImplementation(() => query({ _id: actor }))
  db.claim.mockImplementation(async () => { state.customer.ledgerRevision += 1 })
  db.balance.mockImplementation(async () => balancePkr(state.ledger))
  db.voidPurchase.mockImplementation(async data => {
    const row = state.ledger.find(row => row._id === data.transactionId)
    Object.assign(row, { status: 'voided', voidedBy: data.voidedBy, voidedAt: now, voidReason: data.voidReason })
    return row
  })
})

afterEach(() => vi.restoreAllMocks())

describe('sale cancellation accounting hardening', () => {
  it('cancels unpaid credit with one auditable reversal and one stock restoration', async () => {
    const result = await voidSale(input, { now })
    expect(result).toMatchObject({ status: 'voided', voidedBy: actor, voidedAt: now, voidReason: input.voidReason })
    expect(state.ledger[0]).toMatchObject({ _id: purchaseId, status: 'active', amountPkr: 10000 })
    expect(state.ledger[1]).toMatchObject({ type: 'return', amountPkr: 10000, reversalOf: purchaseId, createdBy: actor, businessDate: '2026-10-07' })
    expect(balancePkr(state.ledger)).toBe(0)
    expect(state.item.stockKg).toBe(100)
    expect(state.sale.inventoryMovements).toHaveLength(2)
    expect(db.itemSave).toHaveBeenCalledWith({ session })
    expect(db.saleSave).toHaveBeenCalledWith({ session })
    expect(db.ledgerCreate).toHaveBeenCalledWith(expect.any(Array), { session })
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it.each([4000, 10000])('rejects cancellation after a later PKR %s payment without changing any state', async amountPkr => {
    state.ledger.push(payment(amountPkr))
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('Resolve later payments or ledger activity before cancelling this sale')
    expect(state).toEqual(before)
    expect(balancePkr(state.ledger)).toBe(10000 - amountPkr)
    expect(db.ledgerCreate).not.toHaveBeenCalled()
    expect(db.itemSave).not.toHaveBeenCalled()
    expect(db.saleSave).not.toHaveBeenCalled()
    expect(db.notify).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('claims the customer before validating its ledger balance', async () => {
    await voidSale(input)
    expect(db.claim).toHaveBeenCalledWith({ shop, customer }, { session, allowInactive: true })
    expect(db.claim.mock.invocationCallOrder[0]).toBeLessThan(db.ledgerFindOne.mock.invocationCallOrder[0])
    expect(db.claim.mock.invocationCallOrder[0]).toBeLessThan(db.balance.mock.invocationCallOrder[0])
    expect(db.balance).toHaveBeenCalledWith({ shop, customer }, { session })
  })

  it('does not restore stock or create another reversal on duplicate cancellation', async () => {
    await voidSale(input)
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('already voided')
    expect(state).toEqual(before)
    expect(db.itemSave).toHaveBeenCalledOnce()
    expect(db.ledgerCreate).toHaveBeenCalledOnce()
  })

  it('rolls back reversal entries and the customer revision when stock restoration fails', async () => {
    state.item.status = 'inactive'
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('Stock location not found')
    expect(state).toEqual(before)
    expect(db.ledgerCreate).toHaveBeenCalledOnce()
    expect(db.saleSave).not.toHaveBeenCalled()
  })

  it('rolls back ledger and inventory if saving the voided Sale fails', async () => {
    db.saleSave.mockRejectedValueOnce(new Error('Sale persistence failed'))
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('Sale persistence failed')
    expect(state).toEqual(before)
    expect(db.notify).not.toHaveBeenCalled()
  })

  it('retains the existing explicit reversal of a Sale-linked receipt', async () => {
    state.sale.amountPaid = 2500
    const receipt = payment(2500, { saleId })
    state.ledger.push(receipt)
    await voidSale(input)
    expect(balancePkr(state.ledger)).toBe(0)
    expect(state.ledger).toHaveLength(4)
    expect(state.ledger[3]).toMatchObject({ type: 'adjustment', amountPkr: 2500, reversalOf: receipt._id, reason: 'Sale cancellation: payment reversed' })
  })

  it('does not reverse an unrelated later payment along with a Sale-linked receipt', async () => {
    state.sale.amountPaid = 2500
    state.ledger.push(payment(2500, { saleId }), payment(1000))
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('negative customer balance')
    expect(state).toEqual(before)
  })

  it('allows cancellation when other active debt covers the reversal', async () => {
    state.ledger.push({ _id: new mongoose.Types.ObjectId().toHexString(), type: 'opening_balance', status: 'active', amountPkr: 6000 }, payment(4000))
    await voidSale(input)
    expect(balancePkr(state.ledger)).toBe(2000)
  })

  it('applies the same balance guard to legacy Sale charge voiding', async () => {
    state.sale.ledgerRecorded = false
    state.ledger.push(payment(10000))
    const before = structuredClone(state)
    await expect(voidSale(input)).rejects.toThrow('negative customer balance')
    expect(state).toEqual(before)
    expect(db.voidPurchase).not.toHaveBeenCalled()
  })

  it('returns a business conflict for unsafe cancellation', () => {
    const error = new RangeError('Sale cancellation would create a negative customer balance. Resolve later payments or ledger activity before cancelling this sale.')
    const next = vi.fn()
    mapSalesError(error, {}, {}, next)
    expect(error.statusCode).toBe(409)
    expect(next).toHaveBeenCalledWith(error)
  })

  it.each([
    'Opening balance would leave a negative customer balance.',
    'Adjustment cannot create a negative customer balance.',
    'Ledger reversal would create a negative customer balance. Resolve later payments or ledger activity first.',
  ])('returns a business conflict for %s', message => {
    const error = new RangeError(message)
    mapCustomerLedgerError(error, {}, {}, vi.fn())
    expect(error.statusCode).toBe(409)
  })
})

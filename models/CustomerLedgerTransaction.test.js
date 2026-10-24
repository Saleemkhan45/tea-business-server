import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  CustomerLedgerTransaction,
  ACTIVE_SALE_PURCHASE_INDEX_NAME,
  CUSTOMER_LEDGER_PAYMENT_METHODS,
  CUSTOMER_LEDGER_TEA_TYPES,
  CUSTOMER_LEDGER_TRANSACTION_STATUSES,
  CUSTOMER_LEDGER_TRANSACTION_TYPES,
} from './CustomerLedgerTransaction.js'

function objectId() {
  return new mongoose.Types.ObjectId()
}

function baseTransaction(overrides = {}) {
  return {
    shop: objectId(),
    customer: objectId(),
    businessDate: '2026-10-01',
    createdBy: objectId(),
    notes: '  Wholesale counter entry  ',
    ...overrides,
  }
}

function validPurchase(overrides = {}) {
  return new CustomerLedgerTransaction(baseTransaction({
    type: 'purchase',
    saleId: objectId(),
    teaType: 'green',
    stockLocationId: 'stock-location-islamabad',
    quantityKg: 125.5,
    ratePerKgPkr: 1000,
    amountPkr: 125500,
    ...overrides,
  }))
}

async function getValidationError(document) {
  try {
    await document.validate()
    return null
  } catch (error) {
    return error
  }
}

function indexByFields(fields) {
  return CustomerLedgerTransaction.schema.indexes().find(([indexFields]) => {
    const fieldNames = Object.keys(fields)
    return fieldNames.length === Object.keys(indexFields).length
      && fieldNames.every(fieldName => indexFields[fieldName] === fields[fieldName])
  })
}

describe('CustomerLedgerTransaction model', () => {
  it('declares a partial unique index for active Sale purchases only', () => {
    expect(indexByFields({ saleId: 1 })).toEqual([
      { saleId: 1 },
      {
        name: ACTIVE_SALE_PURCHASE_INDEX_NAME,
        unique: true,
        partialFilterExpression: { type: 'purchase', status: 'active', saleId: { $type: 'objectId' } },
      },
    ])
  })
  it('requires shop, customer, type, businessDate, and createdBy', async () => {
    const error = await getValidationError(new CustomerLedgerTransaction({}))

    expect(error?.errors.shop).toBeDefined()
    expect(error?.errors.customer).toBeDefined()
    expect(error?.errors.type).toBeDefined()
    expect(error?.errors.businessDate).toBeDefined()
    expect(error?.errors.createdBy).toBeDefined()
  })

  it('accepts the existing ledger transaction types and rejects unknown types', async () => {
    expect(CUSTOMER_LEDGER_TRANSACTION_TYPES).toEqual(['purchase', 'payment', 'opening_balance', 'adjustment', 'return'])

    await expect(validPurchase({ type: 'purchase' }).validate()).resolves.toBeUndefined()
    await expect(new CustomerLedgerTransaction(baseTransaction({ type: 'refund', amountPkr: 1000 })).validate()).rejects.toThrow()
  })

  it('validates businessDate separately from timestamps', async () => {
    await expect(validPurchase({ businessDate: '2026-02-28' }).validate()).resolves.toBeUndefined()

    const invalidFormat = await getValidationError(validPurchase({ businessDate: '28-02-2026' }))
    const invalidDate = await getValidationError(validPurchase({ businessDate: '2026-02-30' }))

    expect(invalidFormat?.errors.businessDate).toBeDefined()
    expect(invalidDate?.errors.businessDate).toBeDefined()
  })

  it('stores purchase fields using domain terminology', async () => {
    const transaction = validPurchase()

    await expect(transaction.validate()).resolves.toBeUndefined()
    expect(CUSTOMER_LEDGER_TEA_TYPES).toEqual(['green', 'black', 'jasmine', 'herbal', 'other'])
    expect(transaction.notes).toBe('Wholesale counter entry')
    expect(transaction.quantityKg).toBe(125.5)
    expect(transaction.ratePerKgPkr).toBe(1000)
    expect(transaction.amountPkr).toBe(125500)
  })

  it('rejects invalid purchase fields', async () => {
    const missingPurchaseFields = await getValidationError(validPurchase({
      saleId: undefined,
      stockLocationId: undefined,
      teaType: undefined,
      quantityKg: undefined,
      ratePerKgPkr: undefined,
    }))
    const invalidQuantity = await getValidationError(validPurchase({ quantityKg: 1.0001 }))
    const negativeRate = await getValidationError(validPurchase({ ratePerKgPkr: -1 }))

    expect(missingPurchaseFields?.errors.saleId).toBeDefined()
    expect(missingPurchaseFields?.errors.stockLocationId).toBeDefined()
    expect(missingPurchaseFields?.errors.teaType).toBeDefined()
    expect(missingPurchaseFields?.errors.quantityKg).toBeDefined()
    expect(missingPurchaseFields?.errors.ratePerKgPkr).toBeDefined()
    expect(invalidQuantity?.errors.quantityKg).toBeDefined()
    expect(negativeRate?.errors.ratePerKgPkr).toBeDefined()
  })

  it('accepts payment fields and rejects invalid payment money or method', async () => {
    const payment = new CustomerLedgerTransaction(baseTransaction({
      type: 'payment',
      amountPkr: 25000,
      paymentMethod: 'cash',
    }))
    const zeroPayment = await getValidationError(new CustomerLedgerTransaction(baseTransaction({
      type: 'payment',
      amountPkr: 0,
      paymentMethod: 'cash',
    })))
    const invalidMethod = await getValidationError(new CustomerLedgerTransaction(baseTransaction({
      type: 'payment',
      amountPkr: 25000,
      paymentMethod: 'crypto',
    })))

    expect(CUSTOMER_LEDGER_PAYMENT_METHODS).toEqual(['cash', 'bank_transfer', 'card', 'cheque', 'other'])
    await expect(payment.validate()).resolves.toBeUndefined()
    expect(zeroPayment?.errors.amountPkr).toBeDefined()
    expect(invalidMethod?.errors.paymentMethod).toBeDefined()
  })

  it('accepts opening balance transactions and rejects zero opening balances', async () => {
    const openingBalance = new CustomerLedgerTransaction(baseTransaction({
      type: 'opening_balance',
      amountPkr: 120000,
    }))
    const zeroOpeningBalance = await getValidationError(new CustomerLedgerTransaction(baseTransaction({
      type: 'opening_balance',
      amountPkr: 0,
    })))

    await expect(openingBalance.validate()).resolves.toBeUndefined()
    expect(zeroOpeningBalance?.errors.amountPkr).toBeDefined()
  })

  it('accepts positive and negative adjustment transactions but rejects zero or missing reasons', async () => {
    const positiveAdjustment = new CustomerLedgerTransaction(baseTransaction({
      type: 'adjustment',
      amountPkr: 5000,
      reason: '  Manual correction  ',
    }))
    const negativeAdjustment = new CustomerLedgerTransaction(baseTransaction({
      type: 'adjustment',
      amountPkr: -5000,
      reason: 'Returned stock credit',
    }))
    const zeroAdjustment = await getValidationError(new CustomerLedgerTransaction(baseTransaction({
      type: 'adjustment',
      amountPkr: 0,
      reason: 'Correction',
    })))
    const missingReason = await getValidationError(new CustomerLedgerTransaction(baseTransaction({
      type: 'adjustment',
      amountPkr: 5000,
    })))

    await expect(positiveAdjustment.validate()).resolves.toBeUndefined()
    await expect(negativeAdjustment.validate()).resolves.toBeUndefined()
    expect(positiveAdjustment.reason).toBe('Manual correction')
    expect(zeroAdjustment?.errors.amountPkr).toBeDefined()
    expect(missingReason?.errors.reason).toBeDefined()
  })

  it('rejects floating-point money for all monetary fields', async () => {
    const floatingAmount = await getValidationError(validPurchase({ amountPkr: 125500.5 }))
    const floatingRate = await getValidationError(validPurchase({ ratePerKgPkr: 999.5 }))

    expect(floatingAmount?.errors.amountPkr).toBeDefined()
    expect(floatingRate?.errors.ratePerKgPkr).toBeDefined()
  })

  it('defaults to active status and supports mongoose timestamps', () => {
    const transaction = validPurchase()

    expect(CUSTOMER_LEDGER_TRANSACTION_STATUSES).toEqual(['active', 'voided'])
    expect(transaction.status).toBe('active')
    expect(CustomerLedgerTransaction.schema.options.timestamps).toBe(true)
  })

  it('represents void audit metadata and rejects incomplete or active void metadata', async () => {
    const voidedTransaction = validPurchase({
      status: 'voided',
      voidedAt: new Date('2026-10-01T09:00:00.000Z'),
      voidedBy: objectId(),
      voidReason: '  Duplicate sale posting  ',
    })
    const incompleteVoid = await getValidationError(validPurchase({
      status: 'voided',
      voidedAt: new Date('2026-10-01T09:00:00.000Z'),
      voidedBy: objectId(),
    }))
    const activeWithVoidMetadata = await getValidationError(validPurchase({
      voidedAt: new Date('2026-10-01T09:00:00.000Z'),
    }))

    await expect(voidedTransaction.validate()).resolves.toBeUndefined()
    expect(voidedTransaction.voidReason).toBe('Duplicate sale posting')
    expect(incompleteVoid?.errors.voidReason).toBeDefined()
    expect(activeWithVoidMetadata?.errors.voidedAt).toBeDefined()
  })

  it('defines scoped ledger indexes for customer, type, deterministic ordering, and shop reports', () => {
    expect(indexByFields({ shop: 1, customer: 1, businessDate: 1, createdAt: 1, _id: 1 })).toBeDefined()
    expect(indexByFields({ shop: 1, customer: 1, type: 1, businessDate: 1 })).toBeDefined()
    expect(indexByFields({ shop: 1, businessDate: 1 })).toBeDefined()
  })
})

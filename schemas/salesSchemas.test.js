import { describe, expect, it } from 'vitest'
import { saleBodySchema } from './salesSchemas.js'

const validSale = {
  businessDate: '2026-10-14',
  teaType: 'green',
  stockLocationId: '507f1f77bcf86cd799439012',
  quantityKg: 2,
  unitPrice: 500,
  paymentMethod: 'credit',
  amountPaid: 0,
  idempotencyKey: 'sale-operation-key',
}

describe('sale request schema', () => {
  it('accepts trimmed salesperson attribution and rejects forged audit identities', () => {
    const input = { ...validSale, newCustomer: { name: 'Retailer' }, salespersonName: '  Ali  ' }
    expect(saleBodySchema.parse(input).salespersonName).toBe('Ali')
    expect(saleBodySchema.safeParse({ ...input, salespersonName: 'A'.repeat(161) }).success).toBe(false)
    expect(saleBodySchema.safeParse({ ...input, salespersonName: { id: 'fake-user' } }).success).toBe(false)
    for (const field of ['createdBy', 'enteredBy', 'shop', 'salespersonId']) {
      expect(saleBodySchema.safeParse({ ...input, [field]: '507f1f77bcf86cd799439011' }).success).toBe(false)
    }
  })
  it('accepts a new customer as part of the same credit-sale request', () => {
    const result = saleBodySchema.safeParse({
      ...validSale,
      newCustomer: { name: 'New Retailer', city: 'Lahore', phone: '0300 1234567' },
    })
    expect(result.success).toBe(true)
  })

  it('allows sale-time customer creation without optional location fields', () => {
    const result = saleBodySchema.safeParse({
      ...validSale,
      newCustomer: { name: 'New Retailer', phone: '0300 1234567', address: 'Main Road' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts opening Khata for an atomic first sale and validates new-customer contact and price fields', () => {
    expect(saleBodySchema.safeParse({
      ...validSale,
      newCustomer: { name: 'New Retailer', phone: '+92 300 1234567', openingBalancePkr: 2500 },
    }).success).toBe(true)
    expect(saleBodySchema.safeParse({
      ...validSale,
      newCustomer: { name: 'New Retailer', phone: 'call me' },
    }).success).toBe(false)
    expect(saleBodySchema.safeParse({
      ...validSale,
      unitPrice: 0,
      newCustomer: { name: 'New Retailer' },
    }).success).toBe(false)
    expect(saleBodySchema.safeParse({
      ...validSale,
      newCustomer: { name: 'New Retailer', openingBalancePkr: -1 },
    }).success).toBe(false)
  })

  it('requires exactly one customer choice when inline customer details are supplied', () => {
    const result = saleBodySchema.safeParse({
      ...validSale,
      customerId: '507f1f77bcf86cd799439011',
      newCustomer: { name: 'New Retailer', city: 'Lahore' },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some(issue => issue.path.join('.') === 'newCustomer')).toBe(true)
  })

  it('rejects a credit sale with neither an existing nor new customer', () => {
    const result = saleBodySchema.safeParse(validSale)
    expect(result.success).toBe(false)
    expect(result.error?.issues.some(issue => issue.path.join('.') === 'customerId')).toBe(true)
  })
})

it('accepts Other regional sales without relaxing stock or tenant fields', () => {
  expect(saleBodySchema.safeParse({ ...validSale, teaType: 'other', newCustomer: { name: 'Retailer' } }).success).toBe(true)
  expect(saleBodySchema.safeParse({ ...validSale, teaType: 'arbitrary', newCustomer: { name: 'Retailer' } }).success).toBe(false)
})

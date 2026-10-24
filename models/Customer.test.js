import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { Customer, CUSTOMER_STATUSES } from './Customer.js'

function objectId() {
  return new mongoose.Types.ObjectId()
}

function indexByFields(fields) {
  return Customer.schema.indexes().find(([indexFields]) => {
    const fieldNames = Object.keys(fields)
    return fieldNames.length === Object.keys(indexFields).length
      && fieldNames.every(fieldName => indexFields[fieldName] === fields[fieldName])
  })
}

async function getValidationError(customer) {
  try {
    await customer.validate()
    return null
  } catch (error) {
    return error
  }
}

describe('Customer model', () => {
  it('validates a customer with shop ownership and trims text fields', async () => {
    const customer = new Customer({
      shop: objectId(),
      name: '  Haji Rashid  ',
      phone: '  +923331112222  ',
      address: '  Main wholesale market  ',
      city: '  Lahore  ',
      notes: '  Prefers weekly follow-up  ',
      status: 'active',
    })

    await expect(customer.validate()).resolves.toBeUndefined()
    expect(customer.name).toBe('Haji Rashid')
    expect(customer.phone).toBe('+923331112222')
    expect(customer.address).toBe('Main wholesale market')
    expect(customer.city).toBe('Lahore')
    expect(customer.notes).toBe('Prefers weekly follow-up')
  })

  it('requires a customer name', async () => {
    const customer = new Customer({ shop: objectId(), name: '   ' })

    const error = await getValidationError(customer)

    expect(error?.errors.name).toBeDefined()
  })

  it('requires shop ownership', async () => {
    const customer = new Customer({ name: 'Haji Rashid' })

    const error = await getValidationError(customer)

    expect(error?.errors.shop).toBeDefined()
  })

  it('uses the existing active and inactive status values', async () => {
    const activeCustomer = new Customer({ shop: objectId(), name: 'Haji Rashid' })
    const inactiveCustomer = new Customer({ shop: objectId(), name: 'Closed Account', status: 'inactive' })
    const invalidCustomer = new Customer({ shop: objectId(), name: 'Bad Status', status: 'ACTIVE' })
    const error = await getValidationError(invalidCustomer)

    expect(CUSTOMER_STATUSES).toEqual(['active', 'inactive'])
    expect(activeCustomer.status).toBe('active')
    await expect(activeCustomer.validate()).resolves.toBeUndefined()
    await expect(inactiveCustomer.validate()).resolves.toBeUndefined()
    expect(error?.errors.status).toBeDefined()
  })

  it('uses mongoose timestamps', () => {
    expect(Customer.schema.options.timestamps).toBe(true)
  })

  it('keeps the legacy balance cache as integer PKR only', async () => {
    const customer = new Customer({ shop: objectId(), name: 'Haji Rashid', balanceDue: 412000.5 })

    const error = await getValidationError(customer)

    expect(error?.errors.balanceDue).toBeDefined()
  })

  it('stores ledger coordination revision as integer metadata', async () => {
    const customer = new Customer({ shop: objectId(), name: 'Haji Rashid' })
    const invalid = new Customer({ shop: objectId(), name: 'Bad Revision', ledgerRevision: 1.5 })

    expect(customer.ledgerRevision).toBe(0)
    await expect(customer.validate()).resolves.toBeUndefined()
    expect((await getValidationError(invalid))?.errors.ledgerRevision).toBeDefined()
  })

  it('defines tenant-scoped lookup indexes without a unique phone constraint', () => {
    const shopStatusNameIndex = indexByFields({ shop: 1, status: 1, name: 1 })
    const shopPhoneIndex = indexByFields({ shop: 1, phone: 1 })
    const globalUniquePhoneIndex = Customer.schema.indexes().find(([fields, options]) => (
      Object.keys(fields).length === 1 && fields.phone === 1 && options?.unique === true
    ))

    expect(shopStatusNameIndex).toBeDefined()
    expect(shopPhoneIndex).toBeDefined()
    expect(shopPhoneIndex?.[1]?.unique).not.toBe(true)
    expect(globalUniquePhoneIndex).toBeUndefined()
  })

  it('defines a tenant-scoped partial unique customer creation key', () => {
    const index = indexByFields({ shop: 1, creationIdempotencyKey: 1 })

    expect(index?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { creationIdempotencyKey: { $type: 'string' } },
    })
  })
})

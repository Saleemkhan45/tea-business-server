// Route-contract fixtures assume a consumed approval; real enforcement is covered in authRoutes/actionAuthorization tests.
vi.mock('../services/actionAuthorization.js', async importOriginal => ({ ...await importOriginal(), consumeApproval: vi.fn(async () => {}) }))
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { AuthSession } from '../models/AuthSession.js'

const ledgerService = vi.hoisted(() => ({
  getLedger: vi.fn(),
  getSummary: vi.fn(),
  getDailyPayments: vi.fn(),
  getPaymentInsight: vi.fn(),
  getPaymentCalendar: vi.fn(),
  getReminderCandidate: vi.fn(),
  createPurchase: vi.fn(),
  createPayment: vi.fn(),
  createOpeningBalance: vi.fn(),
  createAdjustment: vi.fn(),
  voidTransaction: vi.fn(),
}))
const directoryService = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  getCustomerById: vi.fn(),
  createCustomer: vi.fn(),
}))
const collectionService = vi.hoisted(() => ({
  saveSchedule: vi.fn(), getSchedule: vi.fn(), syncShop: vi.fn(), listCollections: vi.fn(), acknowledgeCollection: vi.fn(),
}))
vi.mock('../services/collectionService.js', () => collectionService)

vi.mock('../services/customerLedgerService.js', () => ledgerService)
vi.mock('../services/customerDirectoryService.js', () => directoryService)

import { createApp } from '../app.js'

const shop = new mongoose.Types.ObjectId().toString()
const otherShop = new mongoose.Types.ObjectId().toString()
const customer = new mongoose.Types.ObjectId().toString()
const otherCustomer = new mongoose.Types.ObjectId().toString()
const actor = new mongoose.Types.ObjectId().toString()
const saleId = new mongoose.Types.ObjectId().toString()
const transactionId = new mongoose.Types.ObjectId().toString()
const token = jwt.sign({ sub: actor, shopId: otherShop, jti: 'offline-session' }, env.jwtSecret, { issuer: 'tea-business-api', audience: 'tea-business-dashboard', expiresIn: '8h' })

let server
let baseUrl

function transaction(type, overrides = {}) {
  return {
    _id: transactionId,
    shop,
    customer,
    type,
    businessDate: '2026-10-01',
    status: 'active',
    createdBy: actor,
    createdAt: new Date('2026-10-01T09:00:00Z'),
    updatedAt: new Date('2026-10-01T09:00:00Z'),
    amountPkr: 5000,
    notes: null,
    ...overrides,
  }
}

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}/api/v1/customers/${customer}${path}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

async function directoryRequest(query = '', { authenticated = true } = {}) {
  const response = await fetch(`${baseUrl}/api/v1/customers${query}`, {
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return { status: response.status, body: await response.json() }
}

function purchaseBody(overrides = {}) {
  return {
    businessDate: '2026-10-01', saleId, teaType: 'green', stockLocationId: 'main',
    quantityKg: 10, ratePerKgPkr: 500, ...overrides,
  }
}

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(AuthSession, 'findOne').mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: transactionId, user: actor, shop, csrfToken: 'offline-csrf', expiresAt: new Date(Date.now() + 3600000) }) }) }))
  vi.spyOn(Shop, 'findOne').mockImplementation(() => ({ lean: async () => ({ _id: shop, name: 'Offline shop', status: 'active' }) }))
  vi.spyOn(User, 'findById').mockImplementation(() => ({
    select: () => ({ lean: async () => ({ _id: actor, shop, role: 'staff', status: 'active' }) }),
  }))
  ledgerService.getLedger.mockResolvedValue({ customerId: customer, transactions: [], rows: [], currentBalancePkr: 0 })
  ledgerService.getSummary.mockResolvedValue({ customerId: customer, currentBalancePkr: 5000 })
  ledgerService.getDailyPayments.mockResolvedValue([])
  ledgerService.getPaymentInsight.mockResolvedValue({ paymentDaysCount: 0 })
  ledgerService.getPaymentCalendar.mockResolvedValue([])
  ledgerService.getReminderCandidate.mockResolvedValue(null)
  directoryService.getCustomerById.mockResolvedValue({
    id: customer, name: 'Ahmed Traders', phone: '+92 300 1112223',
    address: 'Main bazaar', status: 'active',
  })
  directoryService.listCustomers.mockResolvedValue({
    customers: [{
      id: customer,
      name: 'Ahmed Traders',
      phone: '+92 300 1112223',
      address: 'Main bazaar',
      status: 'active',
      currentBalancePkr: 5000,
    }],
    pagination: { page: 1, limit: 20, total: 1, pages: 1 },
  })
  directoryService.createCustomer.mockResolvedValue({
    id: customer,
    name: 'Ahmed Traders',
    phone: '+92 300 1112223',
    address: 'Main bazaar',
    region: 'Lahore',
    notes: 'Prefers weekly follow-up',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    currentBalancePkr: 0,
  })
  ledgerService.createPurchase.mockResolvedValue(transaction('purchase', {
    saleId, teaType: 'green', stockLocationId: 'main', quantityKg: 10, ratePerKgPkr: 500,
  }))
  ledgerService.createPayment.mockResolvedValue(transaction('payment', { paymentMethod: 'cash' }))
  ledgerService.createOpeningBalance.mockResolvedValue(transaction('opening_balance'))
  ledgerService.createAdjustment.mockResolvedValue(transaction('adjustment', { reason: 'Correction' }))
  ledgerService.voidTransaction.mockResolvedValue(transaction('payment', {
    status: 'voided', voidedAt: new Date('2026-10-02T09:00:00Z'), voidedBy: actor, voidReason: 'Duplicate',
  }))
})

describe('customer ledger HTTP routes', () => {
  it('retrieves a customer profile using the authenticated user shop rather than token or query claims', async () => {
    const response = await request(`?shop=${otherShop}&customerId=${otherCustomer}`)

    expect(response).toEqual({
      status: 200,
      body: { customer: {
        id: customer, name: 'Ahmed Traders', phone: '+92 300 1112223',
        address: 'Main bazaar', status: 'active',
      } },
    })
    expect(directoryService.getCustomerById).toHaveBeenCalledWith({ shop, customerId: customer })
    expect(directoryService.listCustomers).not.toHaveBeenCalled()
    for (const method of Object.values(ledgerService)) expect(method).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated profile requests before accessing the service', async () => {
    expect(await request('', { authenticated: false })).toEqual({
      status: 401, body: { message: 'Authentication required.' },
    })
    expect(directoryService.getCustomerById).not.toHaveBeenCalled()
  })

  it('validates a profile customer ID with the existing validation response', async () => {
    const response = await fetch(`${baseUrl}/api/v1/customers/not-an-id`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: 'Validation failed.', issues: [{ path: 'customerId', message: 'Invalid ID.' }],
    })
    expect(directoryService.getCustomerById).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'cross-shop'])('returns the same not-found response for a %s profile', async () => {
    directoryService.getCustomerById.mockRejectedValueOnce(new Error('Customer not found.'))

    expect(await request('')).toEqual({ status: 404, body: { message: 'Customer not found.' } })
    expect(directoryService.getCustomerById).toHaveBeenCalledWith({ shop, customerId: customer })
  })

  it('keeps profile reads separate from existing ledger routes and balance responses', async () => {
    expect((await request('')).body.customer).not.toHaveProperty('currentBalancePkr')
    expect((await request('/ledger')).body).toEqual({
      customerId: customer, transactions: [], rows: [], currentBalancePkr: 0,
    })
    expect((await request('/summary')).body.summary.currentBalancePkr).toBe(5000)
    expect(directoryService.getCustomerById).toHaveBeenCalledOnce()
    expect(ledgerService.getLedger).toHaveBeenCalledWith({ shop, customer })
    expect(ledgerService.getSummary).toHaveBeenCalledOnce()
  })

  it('uses the existing internal-error response for unexpected profile failures', async () => {
    directoryService.getCustomerById.mockRejectedValueOnce(new Error('database password is secret'))
    expect(await request('')).toEqual({ status: 500, body: { message: 'Internal server error.' } })
  })

  it('lists customers through the authenticated shop directory contract', async () => {
    const response = await directoryRequest()

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      customers: [{
        id: customer,
        name: 'Ahmed Traders',
        phone: '+92 300 1112223',
        address: 'Main bazaar',
        status: 'active',
        currentBalancePkr: 5000,
      }],
      pagination: { page: 1, limit: 20, total: 1, pages: 1 },
    })
    expect(directoryService.listCustomers).toHaveBeenCalledWith({ shop, page: 1, limit: 20 })
  })

  it('creates a customer through the authenticated shop directory contract', async () => {
    const body = {
      name: 'Ahmed Traders',
      phone: '+92 300 1112223',
      address: 'Main bazaar',
      region: 'Lahore',
      city: 'Lahore',
      notes: 'Prefers weekly follow-up',
      openingBalancePkr: 2500,
      idempotencyKey: 'customer-create-key',
    }
    const response = await fetch(`${baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, shop: otherShop, createdBy: otherCustomer }),
    })

    expect(response.status).toBe(400)
    expect(directoryService.createCustomer).not.toHaveBeenCalled()

    const created = await fetch(`${baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ customer: {
      id: customer,
      name: 'Ahmed Traders',
      phone: '+92 300 1112223',
      address: 'Main bazaar',
      region: 'Lahore',
      notes: 'Prefers weekly follow-up',
      status: 'active',
      createdAt: '2026-10-01T09:00:00.000Z',
      currentBalancePkr: 0,
    } })
    expect(directoryService.createCustomer).toHaveBeenCalledWith({
      ...body,
      shop,
      createdBy: actor,
      businessDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
  })

  it('rejects invalid customer phone and opening Khata before the service', async () => {
    for (const body of [
      { name: 'Bad phone', phone: 'call me' },
      { name: 'Bad opening', openingBalancePkr: -1 },
      { name: 'Fraction opening', openingBalancePkr: 1.5 },
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(directoryService.createCustomer).not.toHaveBeenCalled()
  })

  it('passes customer directory search, status and pagination after validation', async () => {
    const response = await directoryRequest('?search=Ahmed&status=active&page=2&limit=10')

    expect(response.status).toBe(200)
    expect(directoryService.listCustomers).toHaveBeenCalledWith({
      shop,
      search: 'Ahmed',
      status: 'active',
      page: 2,
      limit: 10,
    })
  })

  it('rejects unauthenticated customer directory requests before calling the service', async () => {
    const response = await directoryRequest('', { authenticated: false })

    expect(response).toEqual({ status: 401, body: { message: 'Authentication required.' } })
    expect(directoryService.listCustomers).not.toHaveBeenCalled()
  })

  it('rejects invalid customer directory query parameters and tenant overrides', async () => {
    for (const query of [
      '?page=0',
      '?limit=51',
      '?status=ACTIVE',
      `?search=${'x'.repeat(81)}`,
      `?shop=${otherShop}`,
      `?owner=${actor}`,
    ]) {
      expect((await directoryRequest(query)).status).toBe(400)
    }
    expect(directoryService.listCustomers).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests before calling the service', async () => {
    const response = await request('/ledger', { authenticated: false })
    expect(response).toEqual({ status: 401, body: { message: 'Authentication required.' } })
    expect(ledgerService.getLedger).not.toHaveBeenCalled()
  })

  it('uses the authenticated user lookup for shop context instead of the token shop claim', async () => {
    const response = await request('/ledger')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ customerId: customer, transactions: [], rows: [], currentBalancePkr: 0 })
    expect(ledgerService.getLedger).toHaveBeenCalledWith({ shop, customer })
  })

  it('rejects invalid customer IDs, types, statuses, dates and unsupported pagination', async () => {
    const badId = await fetch(`${baseUrl}/api/v1/customers/not-an-id/ledger`, { headers: { Authorization: `Bearer ${token}` } })
    expect(badId.status).toBe(400)
    for (const query of ['type=refund', 'status=pending', 'from=2026-02-30', 'from=2026-10-02&to=2026-10-01', 'page=2', 'limit=1000000', `shop=${otherShop}`]) {
      expect((await request(`/ledger?${query}`)).status).toBe(400)
    }
  })

  it('filters ledger transactions and rows while preserving service-computed running balances', async () => {
    const firstId = new mongoose.Types.ObjectId().toString()
    const purchase = transaction('purchase', { _id: firstId, amountPkr: 5000 })
    const payment = transaction('payment', { _id: transactionId, businessDate: '2026-10-02', amountPkr: 1000, paymentMethod: 'cash' })
    ledgerService.getLedger.mockResolvedValue({
      customerId: customer,
      transactions: [purchase, payment],
      rows: [
        { transactionId: firstId, businessDate: '2026-10-01', type: 'purchase', status: 'active', runningBalancePkr: 5000, createdBy: actor, createdAt: purchase.createdAt },
        { transactionId, businessDate: '2026-10-02', type: 'payment', status: 'active', runningBalancePkr: 4000, createdBy: actor, createdAt: payment.createdAt },
      ],
      currentBalancePkr: 4000,
    })
    const response = await request('/ledger?from=2026-10-02&type=payment&status=active')
    expect(response.status).toBe(200)
    expect(response.body.transactions).toHaveLength(1)
    expect(response.body.transactions[0]).toMatchObject({ id: transactionId, amountPkr: 1000, paymentMethod: 'cash' })
    expect(response.body.rows[0].runningBalancePkr).toBe(4000)
    expect(response.body.currentBalancePkr).toBe(4000)
    expect(response.body.transactions[0]).not.toHaveProperty('_id')
  })

  it('includes both business-date boundaries regardless of createdAt and preserves server running balances', async () => {
    const dates = ['2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04']
    const transactions = dates.map(businessDate => transaction('payment', {
      _id: new mongoose.Types.ObjectId().toString(), businessDate,
      createdAt: new Date('2030-01-01T09:00:00Z'), paymentMethod: 'cash',
    }))
    ledgerService.getLedger.mockResolvedValue({
      customerId: customer, transactions, currentBalancePkr: 7500,
      rows: transactions.map(entry => ({
        transactionId: entry._id, businessDate: entry.businessDate, type: entry.type,
        status: entry.status, runningBalancePkr: 7500, createdBy: actor, createdAt: entry.createdAt,
      })),
    })

    const response = await request('/ledger?from=2026-10-01&to=2026-10-03')

    expect(response.status).toBe(200)
    expect(response.body.transactions.map(entry => entry.businessDate)).toEqual(['2026-10-01', '2026-10-03'])
    expect(response.body.rows).toHaveLength(2)
    expect(response.body.rows.every(entry => entry.runningBalancePkr === 7500)).toBe(true)
    expect(response.body.currentBalancePkr).toBe(7500)
  })

  it('passes reference dates and date ranges to summary, daily, insight, calendar and reminder services', async () => {
    const range = '?from=2026-10-01&to=2026-10-03'
    expect((await request('/summary?referenceDate=2026-10-03')).body.summary).toEqual({ customerId: customer, currentBalancePkr: 5000 })
    expect(ledgerService.getSummary).toHaveBeenCalledWith({ shop, customer, referenceDate: '2026-10-03' })
    expect((await request(`/daily-payments${range}`)).status).toBe(200)
    expect(ledgerService.getDailyPayments).toHaveBeenCalledWith({ shop, customer, startDate: '2026-10-01', endDate: '2026-10-03' })
    expect((await request(`/payment-insights${range}&referenceDate=2026-10-03`)).status).toBe(200)
    expect(ledgerService.getPaymentInsight).toHaveBeenCalledWith({ shop, customer, startDate: '2026-10-01', endDate: '2026-10-03', referenceDate: '2026-10-03' })
    expect((await request(`/payment-calendar${range}`)).status).toBe(200)
    expect(ledgerService.getPaymentCalendar).toHaveBeenCalledWith({ shop, customer, startDate: '2026-10-01', endDate: '2026-10-03' })
    expect((await request('/reminder-candidate?thresholdDays=7&referenceDate=2026-10-03')).body).toEqual({ candidate: null })
    expect(ledgerService.getReminderCandidate).toHaveBeenCalledWith({ shop, customer, referenceDate: '2026-10-03', thresholdDays: 7 })
  })

  it('requires valid date ranges and reminder threshold values', async () => {
    expect((await request('/daily-payments?from=2026-10-01')).status).toBe(400)
    expect((await request('/payment-insights?from=2026-10-03&to=2026-10-01')).status).toBe(400)
    expect((await request('/payment-calendar?from=no&to=2026-10-01')).status).toBe(400)
    expect((await request('/reminder-candidate?thresholdDays=-1')).status).toBe(400)
  })

  it('creates a purchase with saleId and server-derived operator and shop', async () => {
    const response = await request('/purchases', { method: 'POST', body: purchaseBody() })
    expect(response.status).toBe(201)
    expect(ledgerService.createPurchase).toHaveBeenCalledWith({
      ...purchaseBody(), shop, customer, createdBy: actor,
    })
    expect(response.body.transaction).toMatchObject({ id: transactionId, businessId: shop, customerId: customer, saleId, amountPkr: 5000 })
    expect(response.body.transaction).not.toHaveProperty('_id')
  })

  it('rejects financial overrides, body IDs, and invalid purchase precision or rate', async () => {
    for (const body of [
      purchaseBody({ amountPkr: 1 }),
      purchaseBody({ shop: otherShop }),
      purchaseBody({ customerId: otherCustomer }),
      purchaseBody({ createdBy: otherCustomer }),
      purchaseBody({ quantityKg: 1.0001 }),
      purchaseBody({ ratePerKgPkr: 0 }),
      purchaseBody({ saleId: undefined }),
    ]) {
      expect((await request('/purchases', { method: 'POST', body })).status).toBe(400)
    }
    expect(ledgerService.createPurchase).not.toHaveBeenCalled()
  })

  it('creates a payment and rejects client balance fields or fractional amounts', async () => {
    const body = { businessDate: '2026-10-01', amountPkr: 1000, paymentMethod: 'cash' }
    const response = await request('/payments', { method: 'POST', body })
    expect(response.status).toBe(201)
    expect(ledgerService.createPayment).toHaveBeenCalledWith({ ...body, shop, customer, createdBy: actor })
    for (const invalid of [{ ...body, balanceAfter: 4000 }, { ...body, amountPkr: 1.5 }, { ...body, paymentMethod: 'crypto' }]) {
      expect((await request('/payments', { method: 'POST', body: invalid })).status).toBe(400)
    }
  })

  it('creates opening balance and adjustment through their service methods', async () => {
    const opening = { businessDate: '2026-10-01', amountPkr: 5000 }
    const adjustment = { businessDate: '2026-10-01', amountPkr: -100, reason: 'Correction' }
    expect((await request('/opening-balance', { method: 'POST', body: opening })).status).toBe(201)
    expect(ledgerService.createOpeningBalance).toHaveBeenCalledWith({ ...opening, shop, customer, createdBy: actor })
    expect((await request('/adjustments', { method: 'POST', body: adjustment })).status).toBe(201)
    expect(ledgerService.createAdjustment).toHaveBeenCalledWith({ ...adjustment, shop, customer, createdBy: actor })
    expect((await request('/adjustments', { method: 'POST', body: { ...adjustment, amountPkr: 0 } })).status).toBe(400)
  })

  it('voids using the authenticated operator and rejects client void metadata', async () => {
    const response = await request(`/transactions/${transactionId}/void`, { method: 'PATCH', body: { reason: 'Duplicate' } })
    expect(response.status).toBe(200)
    expect(ledgerService.voidTransaction).toHaveBeenCalledWith({ shop, customer, transactionId, voidedBy: actor, voidReason: 'Duplicate' })
    expect(response.body.transaction).toMatchObject({ status: 'voided', voidedBy: actor, voidedAt: '2026-10-02T09:00:00.000Z' })
    for (const body of [{ reason: 'Duplicate', voidedBy: otherCustomer }, { reason: 'Duplicate', voidedAt: '2026-10-01T00:00:00Z' }, { reason: 'Duplicate', status: 'voided' }]) {
      expect((await request(`/transactions/${transactionId}/void`, { method: 'PATCH', body })).status).toBe(400)
    }
    expect((await request('/transactions/not-an-id/void', { method: 'PATCH', body: { reason: 'Duplicate' } })).status).toBe(400)
  })

  it('maps service errors through the central error handler without leaking unexpected errors', async () => {
    ledgerService.getLedger.mockRejectedValueOnce(new Error('Customer not found.'))
    expect(await request('/ledger')).toEqual({ status: 404, body: { message: 'Customer not found.' } })
    ledgerService.createPayment.mockRejectedValueOnce(new RangeError('Payment cannot exceed the active customer balance.'))
    expect((await request('/payments', { method: 'POST', body: { businessDate: '2026-10-01', amountPkr: 100, paymentMethod: 'cash' } })).status).toBe(409)
    ledgerService.createAdjustment.mockRejectedValueOnce(new Error('Operator not found.'))
    expect((await request('/adjustments', { method: 'POST', body: { businessDate: '2026-10-01', amountPkr: 100, reason: 'Correction' } })).status).toBe(403)
    ledgerService.getLedger.mockRejectedValueOnce(new Error('database password is secret'))
    expect(await request('/ledger')).toEqual({ status: 500, body: { message: 'Internal server error.' } })
  })

  it('does not expose a cross-shop customer through the API', async () => {
    ledgerService.getSummary.mockRejectedValueOnce(new Error('Customer not found.'))
    const response = await request('/summary?referenceDate=2026-10-01')
    expect(response).toEqual({ status: 404, body: { message: 'Customer not found.' } })
    expect(ledgerService.getSummary).toHaveBeenCalledWith({ shop, customer, referenceDate: '2026-10-01' })
  })

  it('keeps controllers behind the service instead of importing ledger persistence', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../controllers/customerLedgerController.js', import.meta.url), 'utf8')
    expect(source).toContain("from '../services/customerLedgerService.js'")
    expect(source).not.toMatch(/from ['"]\.\.\/(models|repositories)\//)
    expect(source).not.toMatch(/\.(findOne|findById|aggregate|create)\(/)
  })

  it('saves collection schedules using authenticated shop and operator attribution', async () => {
    collectionService.saveSchedule.mockResolvedValue({ revision: 1 })
    const body = { weekdays: [3, 5], expectedAmount: 2000, startDate: '2026-10-21', status: 'active', revision: 0 }
    const response = await fetch(`${baseUrl}/api/v1/collections/${customer}/schedule`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(collectionService.saveSchedule).toHaveBeenCalledWith(shop, customer, actor,
      expect.objectContaining({ weekdays: [3, 5], expectedAmount: 2000, revision: 0 }))
  })

  it.each([
    { weekdays: [] }, { weekdays: [3, 3] }, { weekdays: [7] }, { expectedAmount: 1.5 },
    { expectedAmount: -1 }, { startDate: '2026-02-30' }, { time: '25:00' }, { shop: otherShop },
    { updatedBy: otherCustomer }, { endDate: '2026-01-01' },
  ])('rejects invalid or client-controlled collection settings: %j', async changes => {
    const response = await fetch(`${baseUrl}/api/v1/collections/${customer}/schedule`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekdays: [0, 1], expectedAmount: 1500, startDate: '2026-10-21', status: 'active', revision: 0, ...changes }),
    })
    expect(response.status).toBe(400)
    expect(collectionService.saveSchedule).not.toHaveBeenCalled()
  })

  it('requires authentication and rejects forged list scope before collection reads', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/collections`)
    expect(unauthenticated.status).toBe(401)
    const forged = await fetch(`${baseUrl}/api/v1/collections?shop=${otherShop}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(forged.status).toBe(400)
    expect(collectionService.listCollections).not.toHaveBeenCalled()
  })
})

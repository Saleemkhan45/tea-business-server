import { once } from 'node:events'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { createIntegrationLifecycle, wrapIntegrationTest } from '../test/integrationLifecycle.js'
import {
  assertEmptyValidationDatabase, assertTestWriteAuthorization, connectTestDatabase, createFixtureOwnership, getTestMongoUri,
  ownedFixtureCleanupOperations, teardownIntegrationRun, trackFixtureInsertions,
} from '../test/mongoTestDatabase.js'

const testMongoUri = getTestMongoUri()
// Model compilation can start initialization; authorize before importing models or the app.
const { Customer } = await import('../models/Customer.js')
const { CustomerLedgerTransaction, ACTIVE_SALE_PURCHASE_INDEX_NAME } = await import('../models/CustomerLedgerTransaction.js')
const { Item } = await import('../models/Item.js')
const { Notification } = await import('../models/Notification.js')
const { NotificationRead } = await import('../models/NotificationRead.js')
const { NotificationSettings } = await import('../models/NotificationSettings.js')
const { Sale } = await import('../models/Sale.js')
const { Shop } = await import('../models/Shop.js')
const { User } = await import('../models/User.js')
const { createApp } = await import('../app.js')
const customerLedgerService = await import('./customerLedgerService.js')
const saleService = await import('./saleService.js')
const testModels = [CustomerLedgerTransaction, Sale, Customer, Item, User, Shop,
  Notification, NotificationRead, NotificationSettings]
let databaseReady = false
let httpServer
let baseUrl
let stopHttpOwnershipTracking
let stopFixtureOwnershipTracking
let validationLease
const integrationLifecycle = createIntegrationLifecycle({ drainTimeoutMs: 5000 })
const trackedIt = wrapIntegrationTest(it, integrationLifecycle)
const fixtureOwnership = createFixtureOwnership()

function authorizeDatabaseWrites() {
  if (!mongoose.connection.db) throw new Error('An authorized integration database connection is required.')
  assertTestWriteAuthorization(testMongoUri, mongoose.connection.db.databaseName)
  if (!validationLease?.active || validationLease.databaseName !== mongoose.connection.db.databaseName ||
    validationLease.runId !== fixtureOwnership.runId) {
    throw new Error('An owned validation lease is required for fixture writes.')
  }
}

async function cleanDatabase() {
  integrationLifecycle.assertExclusiveOwnership('MongoDB fixture deletion')
  await integrationLifecycle.all(
    'MongoDB fixture deletion',
    ownedFixtureCleanupOperations(testModels, fixtureOwnership, authorizeDatabaseWrites),
  )
}

let sequence = 0
let requestSequence = 0

async function createContext({ stockKg = 100, shopName = 'Phase 9 Shop' } = {}) {
  authorizeDatabaseWrites()
  sequence += 1
  const suffix = `${fixtureOwnership.runId}-${sequence}`
  const shop = await Shop.create({ name: `${shopName} ${suffix}`, status: 'active' })
  const user = await User.create({
    shop: shop._id,
    name: `Operator ${suffix}`,
    email: `operator-${suffix}@phase9.test`,
    role: 'admin',
    status: 'active',
  })
  const customer = await Customer.create({
    shop: shop._id,
    name: `Customer ${suffix}`,
    phone: `0300${String(sequence).padStart(7, '0')}`,
    balanceDue: 999999,
    status: 'active',
  })
  const item = await Item.create({
    shop: shop._id,
    name: `Green Tea ${suffix}`,
    teaType: 'Green Tea',
    stockKg,
    lowStockThreshold: 0,
    status: 'active',
  })

  return { shop, user, customer, item }
}

function saleInput(context, overrides = {}) {
  return {
    idempotencyKey: `phase11-request-${++requestSequence}`,
    shop: context.shop._id,
    customer: context.customer._id,
    businessDate: '2026-10-02',
    teaType: 'green',
    stockLocationId: String(context.item._id),
    quantityKg: 10,
    unitPrice: 500,
    paymentMethod: 'credit',
    createdBy: context.user._id,
    ...overrides,
  }
}

function cashSaleInput(context, overrides = {}) {
  const input = saleInput(context, { paymentMethod: 'cash', ...overrides })
  delete input.customer
  return input
}

async function itemStock(itemId) {
  return (await Item.findById(itemId).lean()).stockKg
}

async function ledgerRows(context, extra = {}) {
  return CustomerLedgerTransaction
    .find({ shop: context.shop._id, customer: context.customer._id, ...extra })
    .sort({ businessDate: 1, createdAt: 1, _id: 1 })
    .lean()
}

async function persistedSale(saleId) {
  return Sale.findById(saleId).lean()
}

function transactionQueryCalls(spy) {
  return spy.mock.results.flatMap((result, index) => {
    const session = result.type === 'return' ? result.value.getOptions().session : null
    return session ? [{
      args: spy.mock.calls[index],
      session,
      order: spy.mock.invocationCallOrder[index],
    }] : []
  })
}

function saleRequestBody(context, overrides = {}) {
  const { shop, createdBy, customer, ...body } = saleInput(context, overrides)
  return { ...body, ...(customer ? { customerId: String(customer) } : {}) }
}

async function saleRequest(context, { body, path = '/api/v1/sales', method = 'POST', authenticated = true, tokenShop } = {}) {
  return integrationLifecycle.track(`HTTP client ${method} ${path}`, async () => {
    const token = jwt.sign({ sub: String(context.user._id), shopId: String(tokenShop ?? context.shop._id) }, env.jwtSecret)
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  })
}

async function ledgerRequest(context, { path, method = 'POST', body }) {
  return integrationLifecycle.track(`HTTP client ${method} /api/v1/customers/:customerId${path}`, async () => {
    const token = jwt.sign({ sub: String(context.user._id) }, env.jwtSecret)
    const response = await fetch(`${baseUrl}/api/v1/customers/${context.customer._id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  })
}

function purchaseForSale(context, sale, overrides = {}) {
  return {
    shop: context.shop._id, customer: context.customer._id, createdBy: context.user._id,
    saleId: sale._id, businessDate: sale.businessDate, teaType: sale.teaType,
    stockLocationId: sale.stockLocationId, quantityKg: sale.quantityKg,
    ratePerKgPkr: sale.unitPrice, ...overrides,
  }
}

async function tenantState(context) {
  const models = [Shop, User, Customer, Item, Sale, CustomerLedgerTransaction, Notification]
  const rows = await integrationLifecycle.all(
    'tenant state query',
    models.map(model => () => model
      .find(model === Shop ? { _id: context.shop._id } : { shop: context.shop._id })
      .sort({ _id: 1 }).lean()),
  )
  return Object.fromEntries(models.map((model, index) => [model.modelName, rows[index]]))
}

async function createLegacySale(context, paymentMethod = 'cash') {
  const sale = {
    _id: new mongoose.Types.ObjectId(),
    shop: context.shop._id,
    customer: paymentMethod === 'credit' ? context.customer._id : undefined,
    businessDate: '2026-09-01',
    teaType: 'green',
    stockLocationId: 'legacy-unmapped-stock',
    quantityKg: 10,
    unitPrice: 500,
    totalAmount: 5000,
    paymentMethod,
    status: 'completed',
    createdBy: context.user._id,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  }
  await Sale.collection.insertOne(sale)
  if (paymentMethod === 'credit') {
    await customerLedgerService.createPurchase({
      shop: sale.shop, customer: sale.customer, saleId: sale._id,
      businessDate: sale.businessDate, teaType: sale.teaType,
      stockLocationId: sale.stockLocationId, quantityKg: sale.quantityKg,
      ratePerKgPkr: sale.unitPrice, createdBy: sale.createdBy,
    })
  }
  return sale
}

describe('Phase 9/10/11 database-backed sales integration', () => {
  beforeAll(async () => {
    assertTestWriteAuthorization(testMongoUri)
    stopFixtureOwnershipTracking = trackFixtureInsertions(
      testModels, fixtureOwnership, authorizeDatabaseWrites,
      (label, operation) => integrationLifecycle.track(label, operation),
    )
    validationLease = await connectTestDatabase(testMongoUri, process.env, fixtureOwnership)
    await integrationLifecycle.all(
      'model index initialization',
      testModels.map(model => async () => {
        authorizeDatabaseWrites()
        await model.init()
        authorizeDatabaseWrites()
        await model.createCollection()
        authorizeDatabaseWrites()
        await model.createIndexes()
      }),
    )
    databaseReady = true
    httpServer = createApp().listen(0, '127.0.0.1')
    stopHttpOwnershipTracking = integrationLifecycle.observeHttpServer(httpServer, 'sales integration HTTP server request')
    await once(httpServer, 'listening')
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`
  }, 30000)

  beforeEach(async () => {
    authorizeDatabaseWrites()
    await integrationLifecycle.drainAndGuard('beforeEach fixture deletion', 5000)
    await cleanDatabase()
    await assertEmptyValidationDatabase(mongoose.connection.db, validationLease)
  })

  afterEach(async () => {
    await integrationLifecycle.drainAndGuard('mock restoration', 5000)
    vi.restoreAllMocks()
  })

  afterAll(() => teardownIntegrationRun({
    lifecycle: integrationLifecycle,
    shutdownHttp: async () => {
      if (!httpServer) return
      await new Promise((resolve, reject) => {
        httpServer.close(error => {
          if (error) reject(error)
          else resolve()
        })
      })
      if (stopHttpOwnershipTracking) stopHttpOwnershipTracking()
    },
    cleanup: async () => { if (databaseReady) await cleanDatabase() },
    database: () => mongoose.connection.db,
    lease: validationLease,
    ownership: fixtureOwnership,
    authorize: authorizeDatabaseWrites,
    disconnect: () => mongoose.disconnect(),
    stopTracking: () => { if (stopFixtureOwnershipTracking) stopFixtureOwnershipTracking() },
  }))

  trackedIt('creates a cash sale without customer debt while decreasing inventory', async () => {
    const context = await createContext()

    const sale = await saleService.createSale(cashSaleInput(context))

    expect(await Sale.exists({ _id: sale._id, shop: context.shop._id })).toBeTruthy()
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(1)
    expect((await persistedSale(sale._id)).inventoryMovements).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await ledgerRows(context)).toHaveLength(0)
    await expect(customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).resolves.toBe(0)
  })

  trackedIt('creates a credit sale with one sale-linked ledger purchase and derived balance', async () => {
    const context = await createContext()
    const itemFindOne = vi.spyOn(Item, 'findOne')
    const itemFindOneAndUpdate = vi.spyOn(Item, 'findOneAndUpdate')
    const itemFindById = vi.spyOn(Item, 'findById')

    const sale = await saleService.createSale(saleInput(context, { amountPkr: 1, totalAmount: 1 }))
    const stockReads = transactionQueryCalls(itemFindOne)
    const stockMutations = transactionQueryCalls(itemFindOneAndUpdate)
    expect(stockReads).toHaveLength(1)
    expect(stockMutations).toHaveLength(1)
    expect(stockReads[0].session).toBe(stockMutations[0].session)
    expect(stockReads[0].order).toBeLessThan(stockMutations[0].order)
    expect(itemFindById).toHaveBeenCalledTimes(1)
    expect(itemFindById).toHaveBeenCalledWith(String(context.item._id))
    expect(itemFindById.mock.invocationCallOrder[0]).toBeGreaterThan(stockMutations[0].order)
    const [stockLookupFilter] = stockReads[0].args
    expect(String(stockLookupFilter._id)).toBe(String(context.item._id))
    expect(String(stockLookupFilter.shop)).toBe(String(context.shop._id))
    expect(stockLookupFilter.status).toBe('active')
    const [stockMutationFilter, stockMutationUpdate, stockMutationOptions] = stockMutations[0].args
    expect(String(stockMutationFilter._id)).toBe(String(context.item._id))
    expect(String(stockMutationFilter.shop)).toBe(String(context.shop._id))
    expect(stockMutationFilter).toMatchObject({ status: 'active', stockKg: { $gte: 10 } })
    expect(stockMutationUpdate).toEqual({ $inc: { stockKg: -10 } })
    expect(stockMutationOptions).toMatchObject({ new: false, runValidators: true })
    const [stored, purchases, saleCount, stockKg, balance] = await integrationLifecycle.all(
      'credit sale verification',
      [
        () => persistedSale(sale._id),
        () => ledgerRows(context, { type: 'purchase' }),
        () => Sale.countDocuments({ shop: context.shop._id }),
        () => itemStock(context.item._id),
        () => customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id }),
      ],
    )

    expect(saleCount).toBe(1)
    expect(stored.totalAmount).toBe(5000)
    expect(stored.teaType).toBe('green')
    expect(stored.stockLocationId).toBe(String(context.item._id))
    expect(stored.productName).toBe(context.item.name)
    expect(stored.inventoryMovements).toHaveLength(1)
    expect(stored.inventoryMovements[0]).toMatchObject({
      type: 'sale_decrease', quantityKg: 10, stockBeforeKg: 100, stockAfterKg: 90,
    })
    expect(String(stored.inventoryMovements[0].item)).toBe(String(context.item._id))
    expect(String(sale.customer)).toBe(String(context.customer._id))
    expect(stockKg).toBe(90)
    expect(purchases).toHaveLength(1)
    expect(String(purchases[0].saleId)).toBe(String(sale._id))
    expect(String(purchases[0].customer)).toBe(String(context.customer._id))
    expect(purchases[0]).toMatchObject({
      teaType: 'green',
      stockLocationId: String(context.item._id),
      quantityKg: 10,
      ratePerKgPkr: 500,
      amountPkr: 5000,
      productName: context.item.name,
      status: 'active',
    })
    expect(balance).toBe(5000)
  })

  trackedIt('adds repeat credit purchases to the derived balance instead of overwriting it', async () => {
    const context = await createContext()

    const first = await saleService.createSale(saleInput(context, { quantityKg: 4, unitPrice: 500 }))
    const second = await saleService.createSale(saleInput(context, { quantityKg: 6, unitPrice: 700 }))
    const purchases = await ledgerRows(context, { type: 'purchase', status: 'active' })

    expect(purchases).toHaveLength(2)
    expect(purchases.map(row => String(row.saleId))).toEqual([String(first._id), String(second._id)])
    expect(purchases.every(row => String(row.customer) === String(context.customer._id))).toBe(true)
    expect(purchases.map(row => row.amountPkr)).toEqual([2000, 4200])
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(2)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).toBe(6200)
  })

  trackedIt('records payment after purchase, decreases balance, and creates no sale', async () => {
    const context = await createContext()
    await saleService.createSale(saleInput(context))
    const saleCount = await Sale.countDocuments({ shop: context.shop._id })

    const payment = await customerLedgerService.createPayment({
      shop: context.shop._id,
      customer: context.customer._id,
      businessDate: '2026-10-03',
      amountPkr: 2000,
      paymentMethod: 'cash',
      createdBy: context.user._id,
    })

    expect(payment).toMatchObject({ type: 'payment', amountPkr: 2000, paymentMethod: 'cash' })
    expect(await ledgerRows(context, { type: 'payment' })).toMatchObject([
      { _id: payment._id, type: 'payment', amountPkr: 2000, status: 'active' },
    ])
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).toBe(3000)
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(saleCount)
  })

  trackedIt('does not modify inventory when recording a customer payment', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const saleBeforePayment = await persistedSale(sale._id)
    const saleCount = await Sale.countDocuments({ shop: context.shop._id })
    const stockBeforePayment = await itemStock(context.item._id)

    await customerLedgerService.createPayment({
      shop: context.shop._id,
      customer: context.customer._id,
      businessDate: '2026-10-03',
      amountPkr: 1000,
      paymentMethod: 'cash',
      createdBy: context.user._id,
    })

    expect(await itemStock(context.item._id)).toBe(stockBeforePayment)
    expect(await persistedSale(sale._id)).toEqual(saleBeforePayment)
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(saleCount)
  })

  trackedIt('voids a credit sale by voiding the ledger purchase and restoring inventory', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    expect(await itemStock(context.item._id)).toBe(90)
    const before = await persistedSale(sale._id)
    expect(before.status).toBe('completed')
    expect(await ledgerRows(context, { status: 'active' })).toHaveLength(1)

    const voided = await saleService.voidSale({
      shop: context.shop._id,
      saleId: sale._id,
      voidedBy: context.user._id,
      voidReason: 'Customer cancelled',
    })

    const allRows = await ledgerRows(context)
    expect(voided.status).toBe('voided')
    expect(voided.inventoryMovements).toHaveLength(2)
    expect(allRows).toHaveLength(1)
    expect(allRows[0]).toMatchObject({ type: 'purchase', status: 'voided', amountPkr: 5000 })
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).toBe(0)
    expect(await Sale.exists({ _id: sale._id, status: 'voided' })).toBeTruthy()
    const stored = await persistedSale(sale._id)
    expect(stored.inventoryMovements[0]).toEqual(before.inventoryMovements[0])
    expect(stored.inventoryMovements[1]).toMatchObject({
      type: 'sale_restore', quantityKg: 10, stockBeforeKg: 90, stockAfterKg: 100,
    })
    expect(stored.voidedAt).toBeInstanceOf(Date)
    expect(allRows[0].voidedAt).toBeInstanceOf(Date)
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(1)
  })

  trackedIt('voids a cash sale without creating ledger rows and restores inventory', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(cashSaleInput(context))

    const voided = await saleService.voidSale({
      shop: context.shop._id,
      saleId: sale._id,
      voidedBy: context.user._id,
      voidReason: 'Entry correction',
    })

    expect(voided.status).toBe('voided')
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await Sale.exists({ _id: sale._id, status: 'voided' })).toBeTruthy()
    expect((await persistedSale(sale._id)).inventoryMovements).toHaveLength(2)
  })

  trackedIt('rolls back sale and inventory when credit ledger creation fails after stock mutation', async () => {
    const context = await createContext()
    const createPurchase = customerLedgerService.createPurchase
    const ledgerFailure = vi
      .spyOn(customerLedgerService, 'createPurchase')
      .mockImplementationOnce(async (input, options) => {
        await createPurchase(input, options)
        expect(await Sale.countDocuments({ shop: context.shop._id }).session(options.session)).toBe(1)
        expect(await CustomerLedgerTransaction.countDocuments({ shop: context.shop._id }).session(options.session)).toBe(1)
        expect((await Item.findById(context.item._id).session(options.session)).stockKg).toBe(90)
        throw new Error('Controlled ledger failure')
      })

    await expect(saleService.createSale(saleInput(context))).rejects.toThrow('Controlled ledger failure')

    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(0)
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await Sale.countDocuments({})).toBe(0)
    expect(await CustomerLedgerTransaction.countDocuments({})).toBe(0)
    ledgerFailure.mockRestore()
  })

  trackedIt('rejects a cross-shop customer before creating sale, ledger, or inventory effects', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 9 Shop' })

    await expect(saleService.createSale(saleInput(context, {
      customer: other.customer._id,
    }))).rejects.toThrow('Customer not found')

    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(0)
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await itemStock(other.item._id)).toBe(100)
    expect(await ledgerRows(other)).toHaveLength(0)
  })

  trackedIt('rejects cross-shop sale mutation and void attempts', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 9 Shop' })
    const sale = await saleService.createSale(cashSaleInput(context))

    await expect(saleService.updateSale({
      shop: other.shop._id,
      saleId: sale._id,
      quantityKg: 12,
      createdBy: other.user._id,
    })).rejects.toThrow('Sale not found')
    await expect(saleService.voidSale({
      shop: other.shop._id,
      saleId: sale._id,
      voidedBy: other.user._id,
      voidReason: 'Wrong tenant',
    })).rejects.toThrow('Sale not found')

    expect(await itemStock(context.item._id)).toBe(90)
    expect((await Sale.findById(sale._id).lean()).status).toBe('completed')
  })

  trackedIt('creates independent identical sales when their idempotency keys differ', async () => {
    const context = await createContext()
    const input = saleInput(context, { quantityKg: 5, unitPrice: 600 })

    const first = await saleService.createSale(input)
    const second = await saleService.createSale({ ...input, idempotencyKey: `${input.idempotencyKey}-second` })
    const purchases = await ledgerRows(context, { type: 'purchase', status: 'active' })

    expect(String(first._id)).not.toBe(String(second._id))
    expect(purchases).toHaveLength(2)
    const stored = await Sale.find({ shop: context.shop._id }).lean()
    expect(stored).toHaveLength(2)
    expect(stored.map(sale => sale.inventoryMovements.length)).toEqual([1, 1])
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).toBe(6000)
  })

  trackedIt('preserves ledger audit rows and adjusts inventory when updating a credit sale', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context, { quantityKg: 10, unitPrice: 500 }))

    const updated = await saleService.updateSale({
      shop: context.shop._id,
      saleId: sale._id,
      quantityKg: 14,
      unitPrice: 500,
      createdBy: context.user._id,
    })
    const allPurchases = await ledgerRows(context, { type: 'purchase' })

    expect(String(updated._id)).toBe(String(sale._id))
    expect(updated.totalAmount).toBe(7000)
    expect(updated.inventoryMovements).toHaveLength(2)
    expect(allPurchases).toHaveLength(2)
    expect(allPurchases.map(row => row.status).sort()).toEqual(['active', 'voided'])
    expect(allPurchases.find(row => row.status === 'active')).toMatchObject({ amountPkr: 7000, quantityKg: 14 })
    expect(allPurchases.every(row => String(row.saleId) === String(sale._id))).toBe(true)
    expect((await persistedSale(sale._id)).totalAmount).toBe(7000)
    expect(await itemStock(context.item._id)).toBe(86)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id,
      customer: context.customer._id,
    })).toBe(7000)
  })

  trackedIt('rejects another tenant stock and leaves both tenants unchanged', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 10 Shop' })
    await saleService.createSale(saleInput(other))
    const before = await tenantState(other)

    await expect(saleService.createSale(saleInput(context, {
      stockLocationId: String(other.item._id),
    }))).rejects.toThrow('Stock location not found')

    expect(await tenantState(other)).toEqual(before)
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(0)
    expect(await ledgerRows(context)).toHaveLength(0)
  })

  trackedIt('rejects a wrong tea type for new credit sale stock before writes', async () => {
    const context = await createContext()
    const before = await tenantState(context)

    await expect(saleService.createSale(saleInput(context, {
      teaType: 'black',
    }))).rejects.toThrow('Stock location tea type does not match the sale tea type')

    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('rejects inactive stock for a new credit sale before writes', async () => {
    const context = await createContext()
    await Item.updateOne({ _id: context.item._id }, { status: 'inactive' })
    const before = await tenantState(context)

    await expect(saleService.createSale(saleInput(context))).rejects.toThrow('Stock location not found')

    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('cannot mutate another tenant credit sale or ledger and isolates valid local operations', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 10 Shop' })
    const otherSale = await saleService.createSale(saleInput(other))
    const otherPurchase = (await ledgerRows(other))[0]
    const before = await tenantState(other)

    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: otherSale._id, quantityKg: 12, createdBy: context.user._id,
    })).rejects.toThrow('Sale not found')
    await expect(saleService.voidSale({
      shop: context.shop._id, saleId: otherSale._id,
      voidedBy: context.user._id, voidReason: 'Wrong tenant',
    })).rejects.toThrow('Sale not found')
    await expect(customerLedgerService.createPayment({
      shop: context.shop._id, customer: other.customer._id,
      amountPkr: 1000, paymentMethod: 'cash', businessDate: '2026-10-03', createdBy: context.user._id,
    })).rejects.toThrow('Customer not found')
    await expect(customerLedgerService.voidTransaction({
      shop: context.shop._id, customer: context.customer._id, transactionId: otherPurchase._id,
      voidedBy: context.user._id, voidReason: 'Wrong tenant',
    })).rejects.toThrow('Customer ledger transaction not found')

    const localSale = await saleService.createSale(saleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: localSale._id, quantityKg: 12, createdBy: context.user._id,
    })
    await customerLedgerService.createPayment({
      shop: context.shop._id, customer: context.customer._id,
      amountPkr: 1000, paymentMethod: 'cash', businessDate: '2026-10-03', createdBy: context.user._id,
    })
    expect(await tenantState(other)).toEqual(before)
  })

  trackedIt('derives repeat 100kg and 50kg purchases minus payments from separate persisted rows', async () => {
    const context = await createContext({ stockKg: 200 })
    const first = await saleService.createSale(saleInput(context, { quantityKg: 100 }))
    const second = await saleService.createSale(saleInput(context, { quantityKg: 50 }))
    await customerLedgerService.createPayment({
      shop: context.shop._id, customer: context.customer._id,
      businessDate: '2026-10-03', amountPkr: 10000, paymentMethod: 'cash', createdBy: context.user._id,
    })

    const purchases = await ledgerRows(context, { type: 'purchase', status: 'active' })
    expect(purchases.map(row => row.quantityKg)).toEqual([100, 50])
    expect(purchases.map(row => row.amountPkr)).toEqual([50000, 25000])
    expect(purchases.map(row => String(row.saleId))).toEqual([String(first._id), String(second._id)])
    expect(await itemStock(context.item._id)).toBe(50)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(65000)
  })

  trackedIt('reassigns a credit sale customer without leaving debt on the old customer', async () => {
    const context = await createContext()
    const newCustomer = await Customer.create({ shop: context.shop._id, name: 'Replacement customer' })
    const sale = await saleService.createSale(saleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, customer: newCustomer._id, createdBy: context.user._id,
    })

    const rows = await CustomerLedgerTransaction.find({ saleId: sale._id }).lean()
    expect(rows).toHaveLength(2)
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1)
    expect(String(rows.find(row => row.status === 'active').customer)).toBe(String(newCustomer._id))
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(0)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: newCustomer._id,
    })).toBe(5000)
    expect(await itemStock(context.item._id)).toBe(90)
    expect((await persistedSale(sale._id)).inventoryMovements).toHaveLength(1)
  })

  trackedIt.each([
    ['credit', 'cash', 0, 0],
    ['cash', 'credit', 5000, 1],
  ])('changes payment method from %s to %s without changing stock', async (from, to, balance, activeCount) => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context, { paymentMethod: from }))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, paymentMethod: to, createdBy: context.user._id,
    })

    expect((await ledgerRows(context, { status: 'active' }))).toHaveLength(activeCount)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(balance)
    expect(await itemStock(context.item._id)).toBe(90)
    expect((await persistedSale(sale._id)).inventoryMovements).toHaveLength(1)
  })

  trackedIt('restores a quantity reduction and restores only the remaining quantity when voided', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, quantityKg: 4, createdBy: context.user._id,
    })
    expect(await itemStock(context.item._id)).toBe(96)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(2000)

    await saleService.voidSale({
      shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancel revised sale',
    })
    expect(await itemStock(context.item._id)).toBe(100)
    const movements = (await persistedSale(sale._id)).inventoryMovements
    expect(movements.map(row => row.quantityKg)).toEqual([10, 6, 4])
    expect(movements.map(row => row.stockAfterKg)).toEqual([90, 96, 100])
    expect(await ledgerRows(context, { status: 'active' })).toHaveLength(0)
    expect(await ledgerRows(context, { status: 'voided' })).toHaveLength(2)
  })

  trackedIt('moves a sale to another item and void restores that item only', async () => {
    const context = await createContext()
    const secondItem = await Item.create({
      shop: context.shop._id, name: 'Second stock', teaType: 'Green Tea', stockKg: 50, lowStockThreshold: 0,
    })
    const sale = await saleService.createSale(saleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, stockLocationId: String(secondItem._id),
      quantityKg: 14, createdBy: context.user._id,
    })
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await itemStock(secondItem._id)).toBe(36)
    const stored = await persistedSale(sale._id)
    expect(stored.inventoryMovements).toHaveLength(3)
    expect((await ledgerRows(context, { status: 'active' }))[0]).toMatchObject({
      stockLocationId: String(secondItem._id), quantityKg: 14, amountPkr: 7000,
    })

    await saleService.voidSale({
      shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancel moved sale',
    })
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await itemStock(secondItem._id)).toBe(50)
  })

  trackedIt('rolls back an edit when replacement ledger creation fails', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const before = await tenantState(context)
    const createPurchase = customerLedgerService.createPurchase
    vi.spyOn(customerLedgerService, 'createPurchase').mockImplementationOnce(async (input, options) => {
      await createPurchase(input, options)
      throw new Error('Controlled replacement failure')
    })

    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, quantityKg: 14, createdBy: context.user._id,
    })).rejects.toThrow('Controlled replacement failure')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('rolls back stock restoration when a replacement item has insufficient stock', async () => {
    const context = await createContext()
    const secondItem = await Item.create({
      shop: context.shop._id, name: 'Insufficient stock', teaType: 'Green Tea', stockKg: 2, lowStockThreshold: 0,
    })
    const sale = await saleService.createSale(saleInput(context))
    const before = await tenantState(context)
    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, stockLocationId: String(secondItem._id), createdBy: context.user._id,
    })).rejects.toThrow('Insufficient stock')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('rolls back the ledger void when stock restoration fails', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    await Item.updateOne({ _id: context.item._id }, { status: 'inactive' })
    const before = await tenantState(context)

    await expect(saleService.voidSale({
      shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Unavailable stock',
    })).rejects.toThrow('Stock location not found')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('does not restore inventory twice when void is repeated', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const input = { shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancel' }
    await saleService.voidSale(input)
    const before = await tenantState(context)

    await expect(saleService.voidSale(input)).rejects.toThrow('already voided')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt.each(['cash', 'credit'])('reads and voids a legacy %s sale without fabricated inventory restoration', async paymentMethod => {
    const context = await createContext({ stockKg: 90 })
    const legacy = await createLegacySale(context, paymentMethod)
    expect((await saleService.getSale({ shop: context.shop._id, saleId: legacy._id })).totalAmount).toBe(5000)
    expect(await saleService.listSales({ shop: context.shop._id })).toHaveLength(1)

    await saleService.voidSale({
      shop: context.shop._id, saleId: legacy._id, voidedBy: context.user._id, voidReason: 'Legacy cancellation',
    })
    const stored = await persistedSale(legacy._id)
    expect(stored.status).toBe('voided')
    expect(stored.inventoryMovements ?? []).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await ledgerRows(context, { status: 'active' })).toHaveLength(0)
    expect(await ledgerRows(context, { status: 'voided' })).toHaveLength(paymentMethod === 'credit' ? 1 : 0)
  })

  trackedIt('refuses a legacy sale edit rather than guessing its original inventory effect', async () => {
    const context = await createContext({ stockKg: 90 })
    const legacy = await createLegacySale(context)
    await Sale.updateOne({ _id: legacy._id }, { stockLocationId: String(context.item._id) })
    const before = await tenantState(context)

    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: legacy._id, quantityKg: 12, createdBy: context.user._id,
    })).rejects.toThrow('Legacy sale inventory audit is unavailable')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('preserves the original creator and prior cash sale values on edit', async () => {
    const context = await createContext()
    const editor = await User.create({
      shop: context.shop._id, name: 'Editor', email: 'editor@phase10.test', role: 'admin', status: 'active',
    })
    const sale = await saleService.createSale(cashSaleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, unitPrice: 600, notes: 'Rate correction', createdBy: editor._id,
    })

    const stored = await persistedSale(sale._id)
    expect(String(stored.createdBy)).toBe(String(context.user._id))
    expect(stored.totalAmount).toBe(6000)
    expect(stored.editHistory).toHaveLength(1)
    expect(stored.editHistory[0]).toMatchObject({
      quantityKg: 10, unitPrice: 500, totalAmount: 5000, paymentMethod: 'cash', businessDate: '2026-10-02',
    })
    expect(String(stored.editHistory[0].changedBy)).toBe(String(editor._id))
    expect(stored.editHistory[0].createdAt).toBeInstanceOf(Date)
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(90)
  })

  trackedIt('calculates a fractional kilogram whole-PKR total and ignores client amounts', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context, {
      quantityKg: 0.125, unitPrice: 800, totalAmount: 999999, amountPkr: 999999,
    }))
    expect((await persistedSale(sale._id)).totalAmount).toBe(100)
    expect((await ledgerRows(context))[0].amountPkr).toBe(100)
    expect(await itemStock(context.item._id)).toBe(99.875)
  })

  trackedIt.each(['create', 'update'])('rejects fractional-PKR totals on %s without changing any records', async operation => {
    const context = await createContext()
    const sale = operation === 'update' ? await saleService.createSale(saleInput(context)) : null
    const before = await tenantState(context)
    const request = operation === 'create'
      ? saleService.createSale(saleInput(context, { quantityKg: 0.001, unitPrice: 501, totalAmount: 1 }))
      : saleService.updateSale({
        shop: context.shop._id, saleId: sale._id, quantityKg: 0.001, unitPrice: 501, createdBy: context.user._id,
      })
    await expect(request).rejects.toThrow('whole PKR total')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('requires a customer ID for credit and does not create debt from a cash customer name', async () => {
    const context = await createContext()
    await expect(saleService.createSale(cashSaleInput(context, {
      paymentMethod: 'credit', customerName: context.customer.name,
    }))).rejects.toThrow('Customer is required for credit sales')
    expect(await Sale.countDocuments({})).toBe(0)
    expect(await itemStock(context.item._id)).toBe(100)

    await saleService.createSale(cashSaleInput(context, { customerName: context.customer.name }))
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(0)
  })

  trackedIt('rejects a foreign customer ID on cash creation and cash edit', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 10 Shop' })
    const before = await tenantState(other)

    await expect(saleService.createSale(saleInput(context, {
      paymentMethod: 'cash', customer: other.customer._id,
    }))).rejects.toThrow('Customer not found')

    const sale = await saleService.createSale(cashSaleInput(context))
    const saleBefore = await persistedSale(sale._id)
    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, customer: other.customer._id, createdBy: context.user._id,
    })).rejects.toThrow('Customer not found')
    expect(await persistedSale(sale._id)).toEqual(saleBefore)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await tenantState(other)).toEqual(before)
  })

  trackedIt('preserves successive edit snapshots and ledger sale links when tea and date change', async () => {
    const context = await createContext()
    const blackItem = await Item.create({
      shop: context.shop._id, name: 'Black stock', teaType: 'Black Tea', stockKg: 50, lowStockThreshold: 0,
    })
    const sale = await saleService.createSale(saleInput(context))
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, unitPrice: 600, createdBy: context.user._id,
    })
    const firstHistory = (await persistedSale(sale._id)).editHistory[0]
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, teaType: 'black', stockLocationId: String(blackItem._id),
      businessDate: '2026-10-04', quantityKg: 5, unitPrice: 700, createdBy: context.user._id,
    })

    const stored = await persistedSale(sale._id)
    expect(stored.editHistory).toHaveLength(2)
    expect(stored.editHistory[0]).toEqual(firstHistory)
    expect(stored.editHistory.map(row => row.totalAmount)).toEqual([5000, 6000])
    const rows = await ledgerRows(context)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => String(row.saleId) === String(sale._id))).toBe(true)
    expect(rows.filter(row => row.status === 'active')).toMatchObject([{
      teaType: 'black', businessDate: '2026-10-04', quantityKg: 5, ratePerKgPkr: 700, amountPkr: 3500,
      stockLocationId: String(blackItem._id),
    }])
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await itemStock(blackItem._id)).toBe(45)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(3500)
  })

  trackedIt('prevents concurrent credit sales from overselling the same stock', async () => {
    const context = await createContext({ stockKg: 15 })
    const results = await Promise.allSettled([
      saleService.createSale(saleInput(context)),
      saleService.createSale(saleInput(context)),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.message).toContain('Insufficient stock')
    const sales = await Sale.find({ shop: context.shop._id }).lean()
    expect(sales).toHaveLength(1)
    expect(sales[0].inventoryMovements).toHaveLength(1)
    expect(await ledgerRows(context, { status: 'active' })).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(5)
  })

  trackedIt('replays the same request as the same Sale without changing persisted accounting state', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const first = await saleService.createSale(input)
    const before = await tenantState(context)

    const replay = await saleService.createSale({ ...input })

    expect(replay).toEqual(first)
    expect(await tenantState(context)).toEqual(before)
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(1)
    expect((await persistedSale(first._id)).inventoryMovements).toHaveLength(1)
    expect(replay).not.toHaveProperty('idempotencyKey')
    expect(replay).not.toHaveProperty('idempotencyFingerprint')
  })

  trackedIt('charges a retried credit request exactly once in the customer ledger', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const first = await saleService.createSale(input)
    const replay = await saleService.createSale(input)
    const rows = await ledgerRows(context)

    expect(String(replay._id)).toBe(String(first._id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'purchase', status: 'active', amountPkr: 5000 })
    expect(String(rows[0].saleId)).toBe(String(first._id))
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(5000)
    expect(await itemStock(context.item._id)).toBe(90)
  })

  trackedIt('replays a cash request without another stock effect or customer ledger purchase', async () => {
    const context = await createContext()
    const input = cashSaleInput(context)
    const first = await saleService.createSale(input)
    const replay = await saleService.createSale(input)

    expect(String(replay._id)).toBe(String(first._id))
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(1)
    expect((await persistedSale(first._id)).inventoryMovements).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await ledgerRows(context)).toHaveLength(0)
  })

  trackedIt('returns HTTP 409 for reuse of a key with a different quantity and preserves the original', async () => {
    const context = await createContext()
    const body = saleRequestBody(context)
    const first = await saleRequest(context, { body })
    expect(first.status).toBe(201)
    const before = await tenantState(context)

    const conflict = await saleRequest(context, { body: { ...body, quantityKg: 20 } })

    expect(conflict).toEqual({
      status: 409, body: { message: 'Idempotency key was already used for a different sale request.' },
    })
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt.each([
    ['unit price', { unitPrice: 600 }],
    ['business date', { businessDate: '2026-10-03' }],
    ['payment method', { paymentMethod: 'cash' }],
    ['status', { status: 'pending' }],
    ['notes', { notes: 'Changed request' }],
    ['customer name', { customerName: 'Changed name' }],
    ['customer', { customer: new mongoose.Types.ObjectId() }],
    ['stock location', { stockLocationId: new mongoose.Types.ObjectId().toHexString() }],
    ['tea type', { teaType: 'black' }],
  ])('rejects a changed %s under an existing key before any accounting mutation', async (field, changes) => {
    const context = await createContext()
    const input = saleInput(context)
    await saleService.createSale(input)
    const before = await tenantState(context)

    await expect(saleService.createSale({ ...input, ...changes }))
      .rejects.toThrow('Idempotency key was already used for a different sale request')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('allows the same key in different shops and returns only the scoped sale', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 11 Shop' })
    const key = 'shared-opaque-key'
    const input = saleInput(context, { idempotencyKey: key })
    const otherInput = saleInput(other, { idempotencyKey: key })
    const first = await saleService.createSale(input)
    const second = await saleService.createSale(otherInput)
    const otherBefore = await tenantState(other)

    expect(String(first._id)).not.toBe(String(second._id))
    expect(String((await saleService.createSale(input))._id)).toBe(String(first._id))
    await expect(saleService.createSale({ ...input, customer: other.customer._id }))
      .rejects.toThrow('different sale request')
    await expect(saleService.updateSale({
      shop: context.shop._id, saleId: second._id, quantityKg: 20, createdBy: context.user._id,
    })).rejects.toThrow('Sale not found')
    await expect(saleService.voidSale({
      shop: context.shop._id, saleId: second._id, voidedBy: context.user._id, voidReason: 'Wrong tenant',
    })).rejects.toThrow('Sale not found')
    expect(await saleService.getSale({ shop: context.shop._id, saleId: second._id })).toBeNull()
    expect(await tenantState(other)).toEqual(otherBefore)
    expect(await itemStock(context.item._id)).toBe(90)
    expect(await itemStock(other.item._id)).toBe(90)
    expect(await ledgerRows(context)).toHaveLength(1)
    expect(await ledgerRows(other)).toHaveLength(1)
  })

  trackedIt.each(['cash', 'credit'])('resolves simultaneous same-key %s requests as one accounting transaction', async paymentMethod => {
    const context = await createContext({ stockKg: 10 })
    const input = saleInput(context, { paymentMethod })
    const [first, second] = await integrationLifecycle.all('same-key createSale operation', [
      () => saleService.createSale(input),
      () => saleService.createSale({ ...input }),
    ])

    expect(String(first._id)).toBe(String(second._id))
    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(1)
    expect((await persistedSale(first._id)).inventoryMovements).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(0)
    expect(await ledgerRows(context)).toHaveLength(paymentMethod === 'credit' ? 1 : 0)
    expect(await customerLedgerService.getCurrentBalance({
      shop: context.shop._id, customer: context.customer._id,
    })).toBe(paymentMethod === 'credit' ? 5000 : 0)
  })

  trackedIt('handles simultaneous different-item payloads under one key without a duplicate-key HTTP 500', async () => {
    const context = await createContext()
    const secondItem = await Item.create({
      shop: context.shop._id, name: 'Concurrent second stock', teaType: 'Green Tea', stockKg: 100, lowStockThreshold: 0,
    })
    const body = saleRequestBody(context)
    const responses = await Promise.all([
      saleRequest(context, { body }),
      saleRequest(context, { body: { ...body, stockLocationId: String(secondItem._id) } }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect(responses.find(response => response.status === 409).body).toEqual({
      message: 'Idempotency key was already used for a different sale request.',
    })
    const winner = responses.find(response => response.status === 201).body.sale
    expect(await Sale.countDocuments({})).toBe(1)
    expect((await persistedSale(winner._id)).inventoryMovements).toHaveLength(1)
    expect(await ledgerRows(context)).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(winner.stockLocationId === String(context.item._id) ? 90 : 100)
    expect(await itemStock(secondItem._id)).toBe(winner.stockLocationId === String(secondItem._id) ? 90 : 100)
  })

  trackedIt('rolls back a failed create key with all accounting writes and lets the same key succeed on retry', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const itemFindOne = vi.spyOn(Item, 'findOne')
    const itemFindOneAndUpdate = vi.spyOn(Item, 'findOneAndUpdate')
    const createPurchase = customerLedgerService.createPurchase
    const failure = vi.spyOn(customerLedgerService, 'createPurchase').mockImplementationOnce(async (data, options) => {
      await createPurchase(data, options)
      expect(await Sale.countDocuments({ shop: context.shop._id, idempotencyKey: input.idempotencyKey })
        .session(options.session)).toBe(1)
      throw new Error('Failure after real ledger insert')
    })

    await expect(saleService.createSale(input)).rejects.toThrow('Failure after real ledger insert')
    const failedStockReads = transactionQueryCalls(itemFindOne)
    const failedStockMutations = transactionQueryCalls(itemFindOneAndUpdate)
    expect(failedStockReads).toHaveLength(1)
    expect(failedStockMutations).toHaveLength(1)
    expect(failedStockReads[0].session).toBe(failedStockMutations[0].session)
    expect(failedStockReads[0].order).toBeLessThan(failedStockMutations[0].order)
    expect(await Sale.countDocuments({})).toBe(0)
    expect(await CustomerLedgerTransaction.countDocuments({})).toBe(0)
    expect(await itemStock(context.item._id)).toBe(100)
    failure.mockRestore()
    itemFindOne.mockClear()
    itemFindOneAndUpdate.mockClear()

    const sale = await saleService.createSale(input)
    const retryStockReads = transactionQueryCalls(itemFindOne)
    const retryStockMutations = transactionQueryCalls(itemFindOneAndUpdate)
    expect(retryStockReads).toHaveLength(1)
    expect(retryStockMutations).toHaveLength(1)
    expect(retryStockReads[0].session).not.toBe(failedStockReads[0].session)
    expect(retryStockReads[0].session).toBe(retryStockMutations[0].session)
    expect(retryStockReads[0].order).toBeLessThan(retryStockMutations[0].order)
    const replay = await saleService.createSale(input)
    expect(transactionQueryCalls(itemFindOne)).toHaveLength(1)
    expect(transactionQueryCalls(itemFindOneAndUpdate)).toHaveLength(1)
    expect(String(replay._id)).toBe(String(sale._id))
    const persistedSales = await Sale.find({ shop: context.shop._id, idempotencyKey: input.idempotencyKey }).lean()
    expect(persistedSales).toHaveLength(1)
    expect(String(persistedSales[0]._id)).toBe(String(sale._id))
    expect(persistedSales[0].inventoryMovements).toHaveLength(1)
    expect(await ledgerRows(context)).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(90)
  })

  trackedIt('does not recreate a voided sale when its original create key is retried', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const sale = await saleService.createSale(input)
    expect(String((await saleService.createSale(input))._id)).toBe(String(sale._id))
    await saleService.voidSale({
      shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancel once',
    })
    const before = await tenantState(context)

    const replay = await saleService.createSale(input)

    expect(String(replay._id)).toBe(String(sale._id))
    expect(replay.status).toBe('voided')
    expect(replay.inventoryMovements).toHaveLength(2)
    expect(await Sale.countDocuments({})).toBe(1)
    expect(await ledgerRows(context, { status: 'active' })).toHaveLength(0)
    expect(await ledgerRows(context, { status: 'voided' })).toHaveLength(1)
    expect(await itemStock(context.item._id)).toBe(100)
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('compares retries to the original create fingerprint even after the sale is edited', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const sale = await saleService.createSale(input)
    await saleService.updateSale({
      shop: context.shop._id, saleId: sale._id, quantityKg: 14, createdBy: context.user._id,
    })
    const before = await tenantState(context)

    const replay = await saleService.createSale(input)

    expect(String(replay._id)).toBe(String(sale._id))
    expect(replay.quantityKg).toBe(14)
    expect(await tenantState(context)).toEqual(before)
    await expect(saleService.createSale({ ...input, quantityKg: 14 })).rejects.toThrow('different sale request')
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('replays a completed request even when current stock or customer status would reject a new sale', async () => {
    const context = await createContext({ stockKg: 10 })
    const input = saleInput(context)
    const sale = await saleService.createSale(input)
    await Item.updateOne({ _id: context.item._id }, { status: 'inactive' })
    await Customer.updateOne({ _id: context.customer._id }, { status: 'inactive' })
    const before = await tenantState(context)

    expect(String((await saleService.createSale(input))._id)).toBe(String(sale._id))
    expect(await tenantState(context)).toEqual(before)
    await User.updateOne({ _id: context.user._id }, { status: 'inactive' })
    await expect(saleService.createSale(input)).rejects.toThrow('Operator not found')
  })

  trackedIt('verifies the real partial unique index and rejects a raw duplicate insert at the database boundary', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const sale = await saleService.createSale(input)
    const indexes = await Sale.collection.listIndexes().toArray()
    const index = indexes.find(candidate => candidate.name === 'sale_shop_idempotency_key_unique')
    expect(index).toMatchObject({
      key: { shop: 1, idempotencyKey: 1 }, unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    })
    const stored = await Sale.collection.findOne({ _id: sale._id })
    expect(stored.idempotencyKey).toBe(input.idempotencyKey)
    expect(stored.idempotencyFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const before = await tenantState(context)

    await expect(Sale.collection.insertOne({ ...stored, _id: new mongoose.Types.ObjectId() }))
      .rejects.toMatchObject({ code: 11000, keyPattern: { shop: 1, idempotencyKey: 1 } })
    expect(await tenantState(context)).toEqual(before)
  })

  trackedIt('allows multiple historical sales without keys under the actual unique index', async () => {
    const context = await createContext()
    const first = await createLegacySale(context)
    const second = await createLegacySale(context)

    expect(await Sale.countDocuments({ shop: context.shop._id })).toBe(2)
    for (const sale of [first, second]) {
      const stored = await Sale.collection.findOne({ _id: sale._id })
      expect(stored).not.toHaveProperty('idempotencyKey')
      expect(stored).not.toHaveProperty('idempotencyFingerprint')
      expect((await saleService.getSale({ shop: context.shop._id, saleId: sale._id })).totalAmount).toBe(5000)
    }
    expect(await itemStock(context.item._id)).toBe(100)
  })

  trackedIt('normalizes keys, optional defaults, notes and ObjectId case without changing the fingerprint', async () => {
    const context = await createContext()
    const input = saleInput(context, { idempotencyKey: '  normalized-key  ', notes: '  Note  ' })
    delete input.status
    const sale = await saleService.createSale(input)
    const replay = await saleService.createSale({
      ...input, idempotencyKey: 'normalized-key', status: 'completed', notes: 'Note',
      customer: String(input.customer).toUpperCase(), stockLocationId: input.stockLocationId.toUpperCase(),
      totalAmount: 1, amountPkr: 1,
    })
    expect(String(replay._id)).toBe(String(sale._id))
    expect(await Sale.countDocuments({})).toBe(1)
    expect((await Sale.collection.findOne({ _id: sale._id })).idempotencyKey).toBe('normalized-key')
  })

  trackedIt('treats different opaque key case as independent legitimate sales', async () => {
    const context = await createContext()
    const input = saleInput(context, { idempotencyKey: 'Opaque-Key' })
    const first = await saleService.createSale(input)
    const second = await saleService.createSale({ ...input, idempotencyKey: 'opaque-key' })
    expect(String(first._id)).not.toBe(String(second._id))
    expect(await Sale.countDocuments({})).toBe(2)
    expect(await ledgerRows(context)).toHaveLength(2)
    expect(await itemStock(context.item._id)).toBe(80)
  })

  trackedIt('normalizes the HTTP customer alias and replays for another authenticated operator in the same shop', async () => {
    const context = await createContext()
    const editor = await User.create({
      shop: context.shop._id, name: 'Same shop operator', email: 'same-shop@phase11.test', role: 'staff', status: 'active',
    })
    const body = saleRequestBody(context)
    const first = await saleRequest(context, { body })
    const { customerId, ...aliasBody } = body
    const replay = await saleRequest({ ...context, user: editor }, {
      body: { ...aliasBody, customer: customerId },
    })
    expect(replay).toEqual(first)
    expect(replay.body.sale.createdBy).toBe(String(context.user._id))
    expect(await Sale.countDocuments({})).toBe(1)
    expect(await ledgerRows(context)).toHaveLength(1)
  })

  trackedIt('returns the existing HTTP response envelope and hides idempotency metadata on create, replay and reads', async () => {
    const context = await createContext()
    const body = saleRequestBody(context)
    const first = await saleRequest(context, { body })
    const replay = await saleRequest(context, { body })
    expect(first.status).toBe(201)
    expect(replay).toEqual(first)
    expect(Object.keys(first.body)).toEqual(['sale'])
    expect(first.body.sale).not.toHaveProperty('idempotencyKey')
    expect(first.body.sale).not.toHaveProperty('idempotencyFingerprint')
    expect(first.body).not.toHaveProperty('session')
    const read = await saleRequest(context, { method: 'GET', path: `/api/v1/sales/${first.body.sale._id}` })
    expect(read.status).toBe(200)
    expect(read.body.sale).not.toHaveProperty('idempotencyFingerprint')
    const list = await saleRequest(context, { method: 'GET' })
    expect(list.body.sales).toHaveLength(1)
    expect(list.body.sales[0]).not.toHaveProperty('idempotencyKey')
    expect(list.body.sales[0]).not.toHaveProperty('idempotencyFingerprint')
  })

  trackedIt.each([
    ['missing', undefined], ['empty', ''], ['whitespace', '   '], ['number', 123],
    ['null', null], ['overlong', 'x'.repeat(129)],
  ])('rejects a %s create key through Zod and leaves the database untouched', async (label, key) => {
    const context = await createContext()
    const body = saleRequestBody(context, { idempotencyKey: key })
    const response = await saleRequest(context, { body })
    expect(response.status).toBe(400)
    expect(response.body.issues.some(issue => issue.path === 'idempotencyKey')).toBe(true)
    expect(await Sale.countDocuments({})).toBe(0)
    expect(await ledgerRows(context)).toHaveLength(0)
    expect(await itemStock(context.item._id)).toBe(100)
  })

  trackedIt('requires a key at the service boundary as well as the HTTP boundary', async () => {
    const context = await createContext()
    const input = saleInput(context)
    delete input.idempotencyKey
    await expect(saleService.createSale(input)).rejects.toThrow('Idempotency key is required')
    expect(await Sale.countDocuments({})).toBe(0)
    expect(await itemStock(context.item._id)).toBe(100)
  })

  trackedIt('enforces authenticated shop/operator scope and prevents foreign API access using a shared key', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Other Phase 11 Shop' })
    const key = 'http-shared-key'
    const otherResponse = await saleRequest(other, { body: saleRequestBody(other, { idempotencyKey: key }) })
    expect(otherResponse.status).toBe(201)
    const otherBefore = await tenantState(other)
    const body = saleRequestBody(context, { idempotencyKey: key })
    const unauthenticated = await saleRequest(context, { body, authenticated: false })
    expect(unauthenticated.status).toBe(401)
    const spoofed = await saleRequest(context, {
      body: { ...body, shop: String(other.shop._id), createdBy: String(other.user._id), operator: String(other.user._id) },
    })
    expect(spoofed.status).toBe(400)
    const local = await saleRequest(context, { body, tokenShop: other.shop._id })
    expect(local.status).toBe(201)
    expect(local.body.sale.shop).toBe(String(context.shop._id))
    expect(local.body.sale.createdBy).toBe(String(context.user._id))
    expect(local.body.sale._id).not.toBe(otherResponse.body.sale._id)
    const foreignPath = `/api/v1/sales/${otherResponse.body.sale._id}`
    expect((await saleRequest(context, { method: 'GET', path: foreignPath })).status).toBe(404)
    expect((await saleRequest(context, { method: 'PATCH', path: foreignPath, body: { quantityKg: 20 } })).status).toBe(404)
    expect((await saleRequest(context, { method: 'PATCH', path: `${foreignPath}/void`, body: { reason: 'Wrong tenant' } })).status).toBe(404)
    expect(await tenantState(other)).toEqual(otherBefore)
  })

  trackedIt('rejects attempts to change create idempotency metadata through the edit API', async () => {
    const context = await createContext()
    const input = saleInput(context)
    const sale = await saleService.createSale(input)
    const response = await saleRequest(context, {
      method: 'PATCH', path: `/api/v1/sales/${sale._id}`, body: { idempotencyKey: 'replacement-key' },
    })
    expect(response.status).toBe(400)
    const stored = await Sale.collection.findOne({ _id: sale._id })
    expect(stored.idempotencyKey).toBe(input.idempotencyKey)
    expect(await Sale.countDocuments({})).toBe(1)
  })

  trackedIt('rejects direct purchases for missing, foreign, mismatched, cash, and voided Sales', async () => {
    const context = await createContext()
    const other = await createContext({ shopName: 'Foreign sale owner' })
    const localCash = await saleService.createSale(cashSaleInput(context))
    const foreign = await saleService.createSale(saleInput(other))
    const localCredit = await saleService.createSale(saleInput(context))
    const secondCustomer = await Customer.create({ shop: context.shop._id, name: 'Second customer', status: 'active' })
    const missing = new mongoose.Types.ObjectId()

    await expect(customerLedgerService.createPurchase(purchaseForSale(context, localCredit, { saleId: missing })))
      .rejects.toThrow('Sale not found')
    await expect(customerLedgerService.createPurchase(purchaseForSale(context, foreign)))
      .rejects.toThrow('Sale not found')
    await expect(customerLedgerService.createPurchase(purchaseForSale(context, localCredit, { customer: secondCustomer._id })))
      .rejects.toThrow('Sale customer does not match')
    await expect(customerLedgerService.createPurchase(purchaseForSale(context, localCash)))
      .rejects.toThrow('not a credit sale')
    await saleService.voidSale({ shop: context.shop._id, saleId: localCredit._id, voidedBy: context.user._id, voidReason: 'Cancelled' })
    await expect(customerLedgerService.createPurchase(purchaseForSale(context, localCredit)))
      .rejects.toThrow('Voided Sale')
    expect(await CustomerLedgerTransaction.countDocuments({ shop: context.shop._id, status: 'active', type: 'purchase' })).toBe(0)
  })

  trackedIt('enforces one active purchase per Sale at the real index and allows a voided predecessor', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const original = (await ledgerRows(context))[0]
    const indexes = await CustomerLedgerTransaction.collection.indexes()
    expect(indexes.find(index => index.name === ACTIVE_SALE_PURCHASE_INDEX_NAME)).toMatchObject({
      key: { saleId: 1 }, unique: true,
      partialFilterExpression: { type: 'purchase', status: 'active', saleId: { $type: 'objectId' } },
    })
    await expect(customerLedgerService.createPurchase(purchaseForSale(context, sale)))
      .rejects.toThrow('already has an active')
    const duplicate = { ...purchaseForSale(context, sale), type: 'purchase', status: 'active', amountPkr: 5000 }
    await expect(CustomerLedgerTransaction.create(duplicate)).rejects.toMatchObject({ code: 11000 })

    await CustomerLedgerTransaction.updateOne({ _id: original._id }, { $set: {
      status: 'voided', voidedAt: new Date(), voidedBy: context.user._id, voidReason: 'Historical correction',
    } })
    const replacement = await customerLedgerService.createPurchase(purchaseForSale(context, sale))
    expect(String(replacement.saleId)).toBe(String(sale._id))
    expect(await ledgerRows(context, { status: 'active', type: 'purchase' })).toHaveLength(1)
    expect(await ledgerRows(context, { status: 'voided', type: 'purchase' })).toHaveLength(1)
    await expect(CustomerLedgerTransaction.create({ ...duplicate, shop: new mongoose.Types.ObjectId() }))
      .rejects.toMatchObject({ code: 11000 })
  })

  trackedIt('rejects direct void of a Sale charge while Sale void still restores stock and clears debt', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const charge = (await ledgerRows(context))[0]
    const response = await ledgerRequest(context, {
      method: 'PATCH', path: `/transactions/${charge._id}/void`, body: { reason: 'Direct correction' },
    })
    expect(response.status).toBe(409)
    expect(await itemStock(context.item._id)).toBe(90)
    expect((await persistedSale(sale._id)).status).toBe('completed')
    expect((await ledgerRows(context))[0].status).toBe('active')

    await saleService.voidSale({ shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancelled' })
    expect(await itemStock(context.item._id)).toBe(100)
    expect((await ledgerRows(context))[0].status).toBe('voided')
    expect(await customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id })).toBe(0)
  })

  trackedIt('keeps an identical repeated Sale edit from adding history or replacing its charge', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const edit = { shop: context.shop._id, saleId: sale._id, quantityKg: 14, createdBy: context.user._id }
    await saleService.updateSale(edit)
    const before = await tenantState(context)
    const repeated = await saleService.updateSale(edit)
    expect(repeated.quantityKg).toBe(14)
    expect(await tenantState(context)).toEqual(before)
    expect((await persistedSale(sale._id)).editHistory).toHaveLength(1)
    expect(await ledgerRows(context, { status: 'active', type: 'purchase' })).toHaveLength(1)
    expect(await ledgerRows(context, { status: 'voided', type: 'purchase' })).toHaveLength(1)
  })

  trackedIt('rejects a Sale edit or void when its active credit charge is already missing', async () => {
    const context = await createContext()
    const sale = await saleService.createSale(saleInput(context))
    const charge = (await ledgerRows(context))[0]
    await CustomerLedgerTransaction.updateOne({ _id: charge._id }, { $set: {
      status: 'voided', voidedAt: new Date(), voidedBy: context.user._id, voidReason: 'Legacy bad mutation',
    } })
    const before = await tenantState(context)
    await expect(saleService.updateSale({ shop: context.shop._id, saleId: sale._id, quantityKg: 12, createdBy: context.user._id }))
      .rejects.toThrow('missing its active ledger charge')
    await expect(saleService.voidSale({ shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Cancel' }))
      .rejects.toThrow('missing its active ledger charge')
    expect(await tenantState(context)).toEqual(before)
  })

  describe('accounting cancellation guards', () => {
    let context
    let sale
    let purchase

    beforeEach(async () => {
      context = await createContext()
      context.item.stockKg = 90
      await context.item.save()
      sale = await Sale.create({
        ...saleInput(context), totalAmount: 5000, amountPaid: 0, ledgerRecorded: true,
        productName: context.item.name,
        inventoryMovements: [{
          item: context.item._id, type: 'sale_decrease', quantityKg: 10,
          stockBeforeKg: 100, stockAfterKg: 90, createdBy: context.user._id, reason: 'Sale created',
        }],
      })
      purchase = await CustomerLedgerTransaction.create({
        ...purchaseForSale(context, sale), type: 'purchase', amountPkr: 5000, status: 'active',
        productName: context.item.name,
      })
    })

    function cancellation() {
      return { shop: context.shop._id, saleId: sale._id, voidedBy: context.user._id, voidReason: 'Customer cancelled' }
    }

    function laterPayment(amountPkr) {
      return {
        shop: context.shop._id, customer: context.customer._id, createdBy: context.user._id,
        businessDate: '2026-10-03', amountPkr, paymentMethod: 'cash',
      }
    }

    trackedIt('cancels unpaid debt with one reversal, one stock restoration, and no duplicate effects', async () => {
      const now = new Date('2026-10-07T06:00:00Z')
      const voided = await saleService.voidSale(cancellation(), { now })
      const [rows, stockKg, balance, stored] = await integrationLifecycle.all('cancellation verification', [
        () => ledgerRows(context), () => itemStock(context.item._id),
        () => customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id }),
        () => persistedSale(sale._id),
      ])
      expect(voided).toMatchObject({ status: 'voided', voidedAt: now, voidReason: 'Customer cancelled' })
      expect(String(voided.voidedBy)).toBe(String(context.user._id))
      expect(rows).toHaveLength(2)
      expect(rows.find(row => row.type === 'purchase')).toMatchObject({ status: 'active', amountPkr: 5000 })
      const reversal = rows.find(row => row.type === 'return')
      expect(reversal).toMatchObject({ amountPkr: 5000, status: 'active', businessDate: '2026-10-07' })
      expect(String(reversal.reversalOf)).toBe(String(purchase._id))
      expect(String(reversal.createdBy)).toBe(String(context.user._id))
      expect(stockKg).toBe(100)
      expect(balance).toBe(0)
      expect(stored.inventoryMovements).toHaveLength(2)
      const before = await tenantState(context)
      await expect(saleService.voidSale(cancellation())).rejects.toThrow('already voided')
      expect(await tenantState(context)).toEqual(before)
    })

    trackedIt.each([2000, 5000])('rejects cancellation after a later PKR %s payment with unchanged persisted state', async amountPkr => {
      await customerLedgerService.createPayment(laterPayment(amountPkr))
      const before = await tenantState(context)
      await expect(saleService.voidSale(cancellation())).rejects.toThrow('Resolve later payments or ledger activity before cancelling this sale')
      const [after, balance] = await integrationLifecycle.all('rejected cancellation verification', [
        () => tenantState(context),
        () => customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id }),
      ])
      expect(after).toEqual(before)
      expect(balance).toBe(5000 - amountPkr)
    })

    trackedIt('rejects the same paid-debt cancellation through the legacy charge-void path', async () => {
      await Sale.updateOne({ _id: sale._id }, { $set: { ledgerRecorded: false } })
      await customerLedgerService.createPayment(laterPayment(5000))
      const before = await tenantState(context)
      await expect(saleService.voidSale(cancellation())).rejects.toThrow('negative customer balance')
      expect(await tenantState(context)).toEqual(before)
    })

    trackedIt('retains the established Sale-linked receipt reversal without manufacturing customer credit', async () => {
      await Sale.updateOne({ _id: sale._id }, { $set: { amountPaid: 1000 } })
      const receipt = await CustomerLedgerTransaction.create({
        ...laterPayment(1000), saleId: sale._id, type: 'payment', status: 'active',
      })
      await saleService.voidSale(cancellation())
      const [rows, balance] = await integrationLifecycle.all('receipt reversal verification', [
        () => ledgerRows(context),
        () => customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id }),
      ])
      expect(rows).toHaveLength(4)
      const reversal = rows.find(row => row.type === 'adjustment')
      expect(reversal.amountPkr).toBe(1000)
      expect(String(reversal.reversalOf)).toBe(String(receipt._id))
      expect(balance).toBe(0)
    })

    trackedIt('rolls back new reversal rows and customer revision when stock restoration fails', async () => {
      await Item.updateOne({ _id: context.item._id }, { $set: { status: 'inactive' } })
      const before = await tenantState(context)
      await expect(saleService.voidSale(cancellation())).rejects.toThrow('Stock location not found')
      expect(await tenantState(context)).toEqual(before)
    })

    trackedIt('serializes cancellation and a simultaneous full payment without negative balance', async () => {
      const results = await Promise.allSettled([
        saleService.voidSale(cancellation()),
        customerLedgerService.createPayment(laterPayment(5000)),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const [stored, rows, stockKg, balance] = await integrationLifecycle.all('cancellation race verification', [
        () => persistedSale(sale._id), () => ledgerRows(context), () => itemStock(context.item._id),
        () => customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id }),
      ])
      expect(balance).toBe(0)
      expect(rows.filter(row => row.type === 'return')).toHaveLength(stored.status === 'voided' ? 1 : 0)
      expect(rows.filter(row => row.type === 'payment')).toHaveLength(stored.status === 'voided' ? 0 : 1)
      expect(stockKg).toBe(stored.status === 'voided' ? 100 : 90)
    })

    trackedIt('serializes simultaneous opening balances at the real customer revision boundary', async () => {
      const opening = { ...laterPayment(1000), businessDate: '2026-10-01' }
      delete opening.paymentMethod
      const results = await Promise.allSettled([
        customerLedgerService.createOpeningBalance(opening),
        customerLedgerService.createOpeningBalance(opening),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(result => result.status === 'rejected').reason.message).toContain('already has an active opening balance')
      const rows = await ledgerRows(context, { type: 'opening_balance', status: 'active' })
      expect(rows).toHaveLength(1)
      expect(await customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id })).toBe(6000)
    })

    trackedIt('serializes simultaneous adjustment and payment against committed ledger state', async () => {
      const results = await Promise.allSettled([
        customerLedgerService.createPayment(laterPayment(3000)),
        customerLedgerService.createAdjustment({
          shop: context.shop._id, customer: context.customer._id, createdBy: context.user._id,
          businessDate: '2026-10-03', amountPkr: -3000, reason: 'Debt correction',
        }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(await customerLedgerService.getCurrentBalance({ shop: context.shop._id, customer: context.customer._id })).toBe(2000)
      expect(await ledgerRows(context)).toHaveLength(2)
    })
  })
})

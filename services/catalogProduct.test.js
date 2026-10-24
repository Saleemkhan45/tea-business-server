import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), manager: vi.fn(), region: vi.fn(), stock: vi.fn(), audit: vi.fn() }))
vi.mock('../models/Item.js', () => ({ Item: { init: vi.fn(), create: db.create, findOne: db.find } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.manager } }))
vi.mock('../models/Region.js', () => ({ Region: { findOne: db.region } }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { init: vi.fn(), create: db.stock } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { init: vi.fn(), create: db.audit } }))
import { createProduct } from './regionalInventoryService.js'
const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', regionId = '507f1f77bcf86cd799439003'
const input = { shop, actor, name: 'Special Green Tea', teaType: 'Other', sellingPrice: 950, idempotencyKey: 'catalog-1' }
const opening = { ...input, openingQuantityKg: 200, receivingRegionId: regionId, openingStockConfirmed: true }
let state, region, failStock, failAudit
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => String(row[key]) === String(value))
const query = value => ({ session() { return this }, select() { return this }, lean: async () => structuredClone(value), then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } })
beforeEach(() => {
  vi.clearAllMocks(); state = { products: [], stocks: [], audits: [] }; failStock = false; failAudit = false
  region = { _id: regionId, shop, status: 'active' }
  db.manager.mockImplementation(() => query({ _id: actor }))
  db.region.mockImplementation(filter => query(matches(region, filter) ? region : null))
  db.find.mockImplementation(filter => query(state.products.find(row => matches(row, filter)) ?? null))
  db.create.mockImplementation(async (value, options) => {
    const fields = Array.isArray(value) ? value[0] : value
    if (state.products.some(product => product.shop === fields.shop && product.name === fields.name)) throw Object.assign(new Error('duplicate'), { code: 11000 })
    if (Array.isArray(value)) expect(options.session).toBeTruthy()
    const row = { _id: '507f1f77bcf86cd799439004', ...structuredClone(fields) }; state.products.push(row)
    return Array.isArray(value) ? [{ ...row, toObject: () => structuredClone(row) }] : row
  })
  db.stock.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); if (failStock) throw new Error('stock failed'); state.stocks.push(value); return [value] })
  db.audit.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); if (failAudit) throw new Error('audit failed'); state.audits.push(value); return [value] })
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ endSession: vi.fn(), withTransaction: async callback => {
    const before = structuredClone(state)
    try { return await callback() } catch (error) { state = before; throw error }
  } })
})
afterEach(() => vi.restoreAllMocks())
describe('catalog creation and opening stock (offline simulated transactions)', () => {
  it('persists custom price, creates only a definition at zero stock and hides retry metadata', async () => {
    const result = await createProduct(input)
    expect(result).toMatchObject({ name: input.name, teaType: 'Other', sellingPrice: 950, stockKg: 0, status: 'active' })
    expect(result).not.toHaveProperty('catalogCreationKey'); expect(result).not.toHaveProperty('catalogFingerprint')
    expect(state.stocks).toEqual([]); expect(state.audits).toEqual([])
  })
  it.each(['Green Tea', 'Black Tea', 'Jasmine Tea', 'Herbal Blend'])('preserves %s catalog-only creation for older callers', async teaType => {
    await createProduct({ shop, actor, name: 'Tea', teaType, stockKg: 500, status: 'inactive' })
    expect(state.products[0]).toMatchObject({ stockKg: 0, status: 'inactive', teaType })
    expect(state.stocks).toEqual([])
  })
  it('commits stock only to the selected shop region with immutable opening audit details', async () => {
    await createProduct(opening)
    expect(state.products[0].stockKg).toBe(0)
    expect(state.stocks).toEqual([expect.objectContaining({ shop, region: regionId, quantityGrams: 200000 })])
    expect(state.audits).toEqual([expect.objectContaining({ shop, region: regionId, type: 'opening_stock', quantityGrams: 200000, createdBy: actor, businessDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), reference: state.products[0]._id, balances: [{ region: regionId, beforeGrams: 0, afterGrams: 200000 }] })])
  })
  it.each([-1, 0.0001, Infinity, NaN, '1'])('rejects unsupported stock %s before writing', async openingQuantityKg => {
    await expect(createProduct({ ...opening, openingQuantityKg })).rejects.toThrow()
    expect(db.create).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, -1, 1.5, Infinity, NaN])('rejects unsupported custom price %s', async sellingPrice => {
    await expect(createProduct({ ...input, sellingPrice })).rejects.toThrow()
    expect(db.create).not.toHaveBeenCalled()
  })
  it('rejects missing/foreign/inactive receiving regions, missing confirmation and inactive product stock', async () => {
    for (const patch of [{ receivingRegionId: undefined }, { openingStockConfirmed: false }, { status: 'inactive' }, { idempotencyKey: undefined }]) {
      await expect(createProduct({ ...opening, ...patch })).rejects.toThrow()
    }
    region.shop = actor; await expect(createProduct(opening)).rejects.toThrow('unavailable')
    region.shop = shop; region.status = 'inactive'; await expect(createProduct(opening)).rejects.toThrow('unavailable')
    expect(state).toEqual({ products: [], stocks: [], audits: [] })
  })
  it.each(['stock', 'audit'])('rolls back the product and all stock when %s fails, then permits the same-key retry', async failure => {
    failStock = failure === 'stock'; failAudit = failure === 'audit'
    await expect(createProduct(opening)).rejects.toThrow('failed')
    expect(state).toEqual({ products: [], stocks: [], audits: [] })
    failStock = false; failAudit = false; await createProduct(opening)
    expect(state.products).toHaveLength(1); expect(state.stocks).toHaveLength(1); expect(state.audits).toHaveLength(1)
  })
  it('replays committed creation without adding stock twice and rejects changed intent', async () => {
    const first = await createProduct(opening), retry = await createProduct(opening)
    expect(retry).toEqual(first)
    expect(state.products).toHaveLength(1); expect(state.stocks).toHaveLength(1); expect(state.audits).toHaveLength(1)
    await expect(createProduct({ ...opening, openingQuantityKg: 201 })).rejects.toThrow('different product')
    await expect(createProduct({ ...opening, receivingRegionId: actor })).rejects.toThrow('different product')
  })
  it('rejects duplicate shop product names without appending stock to an existing product', async () => {
    await createProduct(input)
    await expect(createProduct({ ...opening, idempotencyKey: 'another-key' })).rejects.toMatchObject({ code: 11000 })
    expect(state.products).toHaveLength(1); expect(state.stocks).toEqual([]); expect(state.audits).toEqual([])
  })
  it('checks current manager authorization even on replay and scopes replay to the authenticated shop', async () => {
    await createProduct(opening)
    db.manager.mockImplementationOnce(() => query(null))
    await expect(createProduct(opening)).rejects.toThrow('owner or admin')
    await createProduct({ ...input, shop: actor })
    expect(state.products).toHaveLength(2)
  })
  it.each(['', '   ', 'a'.repeat(161)])('rejects invalid product names before writing', async name => {
    await expect(createProduct({ ...input, name })).rejects.toThrow('Product name')
    expect(db.create).not.toHaveBeenCalled()
  })
})

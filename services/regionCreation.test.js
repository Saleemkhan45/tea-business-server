import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ region: vi.fn(), create: vi.fn(), edit: vi.fn(), product: vi.fn(), actor: vi.fn(), stock: vi.fn(), remove: vi.fn(), audit: vi.fn(), auditExists: vi.fn(), sale: vi.fn(), purchase: vi.fn() }))
vi.mock('../models/Region.js', () => ({ Region: { init: vi.fn(), findOne: db.region, create: db.create, findOneAndUpdate: db.edit } }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { init: vi.fn(), create: db.stock, findOneAndDelete: db.remove } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { init: vi.fn(), create: db.audit, exists: db.auditExists } }))
vi.mock('../models/Item.js', () => ({ Item: { findOne: db.product } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.actor } }))
vi.mock('../models/Sale.js', () => ({ Sale: { exists: db.sale } }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { exists: db.purchase } }))
import { createRegion, removeUnusedAssignment, updateRegion } from './regionalInventoryService.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', regionId = '507f1f77bcf86cd799439003'
const productIds = Array.from({ length: 20 }, (_, index) => (100 + index).toString(16).padStart(24, '0'))
const input = { shop, actor, name: 'Islamabad', idempotencyKey: 'region-create-1', openingStockConfirmed: true }
let state, products, failAudit, failStock, history
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => String(row[key]) === String(value))
const query = value => ({ session() { return this }, select() { return this }, lean: async () => structuredClone(value), then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } })
beforeEach(() => {
  vi.clearAllMocks(); failAudit = false; failStock = false; history = ''
  state = { regions: [], stocks: [], audits: [] }
  products = productIds.map(_id => ({ _id, shop, status: 'active', stockKg: 0 }))
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ endSession: vi.fn(), withTransaction: async callback => {
    const before = structuredClone(state)
    try { return await callback() } catch (error) { state = before; throw error }
  } })
  db.actor.mockImplementation(() => query({ _id: actor }))
  db.region.mockImplementation(filter => query(state.regions.find(row => matches(row, filter)) ?? null))
  db.product.mockImplementation(filter => query(products.find(row => matches(row, filter)) ?? null))
  db.create.mockImplementation(async ([value], options) => {
    expect(options.session).toBeTruthy()
    const row = { _id: regionId, ...structuredClone(value) }; state.regions.push(row)
    return [{ ...row, toObject: () => structuredClone(row) }]
  })
  db.stock.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); if (failStock) throw new Error('Stock failed'); state.stocks.push({ _id: 'stock', ...value }); return [value] })
  db.audit.mockImplementation(async ([value], options) => { expect(options.session).toBeTruthy(); if (failAudit) throw new Error('Audit failed'); state.audits.push(value); return [value] })
  db.edit.mockImplementation((filter, update) => { const row = state.regions.find(value => matches(value, filter)); if (row) Object.assign(row, update.$set); return query(row) })
  db.remove.mockImplementation((filter, options) => { expect(options.session).toBeTruthy(); const index = state.stocks.findIndex(row => matches(row, filter)); return query(index < 0 ? null : state.stocks.splice(index, 1)[0]) })
  db.auditExists.mockImplementation(() => query(history === 'audit' ? {} : null))
  db.sale.mockImplementation(() => query(history === 'sale' ? {} : null))
  db.purchase.mockImplementation(() => query(history === 'purchase' ? {} : null))
})
afterEach(() => vi.restoreAllMocks())

describe('atomic region opening stock (offline simulated transactions)', () => {
  it.each([0, 1, 20])('creates a region with %s catalog assignments in one transaction', async count => {
    const openingProducts = productIds.slice(0, count).map((itemId, index) => ({ itemId, quantityKg: index + 0.001 }))
    const result = await createRegion({ ...input, openingProducts })
    expect(result).toMatchObject({ name: 'Islamabad', createdBy: actor })
    expect(result).not.toHaveProperty('fingerprint'); expect(result).not.toHaveProperty('idempotencyKey')
    expect(state.stocks).toHaveLength(count); expect(state.audits).toHaveLength(count)
    expect(state.stocks.map(row => row.quantityGrams)).toEqual(openingProducts.map(row => Math.round(row.quantityKg * 1000)))
    expect(state.audits.every(row => row.type === 'opening_stock' && row.createdBy === actor && row.balances[0].beforeGrams === 0)).toBe(true)
    expect(db.purchase).not.toHaveBeenCalled()
  })
  it('assigns zero stock without inventing a stock movement or touching legacy inventory', async () => {
    products[0].stockKg = 999
    await createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 0 }] })
    expect(state.stocks[0].quantityGrams).toBe(0); expect(state.audits).toEqual([]); expect(products[0].stockKg).toBe(999)
  })
  it('saves per-product overrides atomically and binds them to creation idempotency', async () => {
    const request = { ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2, sellingPriceOverride: 850, lowStockThresholdOverride: 0 }] }
    await createRegion(request)
    expect(state.stocks[0]).toMatchObject({ sellingPriceOverride: 850, lowStockThresholdOverride: 0, configurationHistory: [expect.objectContaining({ createdBy: actor, afterPrice: 850 })] })
    await createRegion(request)
    await expect(createRegion({ ...request, openingProducts: [{ ...request.openingProducts[0], sellingPriceOverride: 900 }] })).rejects.toThrow('different region')
    failAudit = true
    state = { regions: [], stocks: [], audits: [] }
    await expect(createRegion(request)).rejects.toThrow('failed')
    expect(state.stocks).toEqual([])
  })
  it('replays exactly once and rejects a changed creation intent', async () => {
    const request = { ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2 }] }
    await createRegion(request); await createRegion(request)
    expect(state.regions).toHaveLength(1); expect(state.stocks).toHaveLength(1); expect(state.audits).toHaveLength(1)
    await expect(createRegion({ ...request, name: 'Peshawar' })).rejects.toThrow('different region')
  })
  it('resolves a concurrent same-key winner even when the unique name index reports the collision', async () => {
    let winner
    db.region.mockImplementation(() => query(winner ?? null))
    db.create.mockImplementationOnce(async ([value]) => {
      winner = { _id: regionId, ...value }
      throw Object.assign(new Error('Duplicate name'), { code: 11000, keyPattern: { shop: 1, nameKey: 1 } })
    })
    await expect(createRegion(input)).resolves.toMatchObject({ _id: regionId, name: 'Islamabad' })
    expect(db.stock).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled()
  })
  it.each(['audit', 'stock'])('rolls back the region and all stock if %s creation fails', async failure => {
    failAudit = failure === 'audit'; failStock = failure === 'stock'
    await expect(createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2 }] })).rejects.toThrow('failed')
    expect(state).toEqual({ regions: [], stocks: [], audits: [] })
  })
  it('rejects foreign products and legacy opening-stock duplication before creating records', async () => {
    products[0].shop = actor
    const request = { ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2 }] }
    await expect(createRegion(request)).rejects.toThrow('belong to this shop')
    products[0].shop = shop; products[0].stockKg = 9
    await expect(createRegion(request)).rejects.toThrow('legacy unallocated stock')
    expect(state.regions).toEqual([])
  })
  it.each([-1, 0.0001, Infinity, NaN])('rejects invalid quantity %s before writing', async quantityKg => {
    await expect(createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg }] })).rejects.toThrow()
    expect(db.create).not.toHaveBeenCalled()
  })
  it('rejects duplicates, over 20 products, missing keys and unconfirmed nonzero stock', async () => {
    const row = { itemId: productIds[0], quantityKg: 1 }
    for (const request of [
      { ...input, openingProducts: [row, row] },
      { ...input, openingProducts: Array(21).fill(row) },
      { ...input, idempotencyKey: undefined, openingProducts: [row] },
      { ...input, openingStockConfirmed: false, openingProducts: [row] },
    ]) await expect(createRegion(request)).rejects.toThrow()
    expect(db.create).not.toHaveBeenCalled()
  })
  it('edits region information without touching stock or opening history and rejects stock in PATCH', async () => {
    await createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2 }] })
    const before = structuredClone(state)
    await updateRegion({ shop, actor, regionId, name: 'New region name' })
    expect(state.stocks).toEqual(before.stocks); expect(state.audits).toEqual(before.audits)
    await expect(updateRegion({ shop, actor, regionId, openingProducts: [] })).rejects.toThrow()
  })
  it('removes an unused zero-stock assignment', async () => {
    await createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 0 }] })
    await expect(removeUnusedAssignment({ shop, actor, regionId, itemId: productIds[0] })).resolves.toEqual({ removed: true })
    expect(state.stocks).toEqual([])
  })
  it.each(['audit', 'sale', 'purchase'])('retains zero-stock assignments with %s history', async kind => {
    await createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 0 }] }); history = kind
    await expect(removeUnusedAssignment({ shop, actor, regionId, itemId: productIds[0] })).rejects.toThrow('business history')
    expect(state.stocks).toHaveLength(1)
  })
  it('rejects removing stock or a foreign shop assignment', async () => {
    await createRegion({ ...input, openingProducts: [{ itemId: productIds[0], quantityKg: 2 }] })
    await expect(removeUnusedAssignment({ shop, actor, regionId, itemId: productIds[0] })).rejects.toThrow('zero-stock')
    await expect(removeUnusedAssignment({ shop: actor, actor, regionId, itemId: productIds[0] })).rejects.toThrow('not found')
    expect(state.stocks).toHaveLength(1)
  })
})

import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ stocks: vi.fn(), stock: vi.fn(), update: vi.fn(), products: vi.fn(), product: vi.fn(), regions: vi.fn(), region: vi.fn(), actor: vi.fn() }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { find: db.stocks, findOne: db.stock, findOneAndUpdate: db.update } }))
vi.mock('../models/Item.js', () => ({ Item: { find: db.products, findOne: db.product } }))
vi.mock('../models/Region.js', () => ({ Region: { find: db.regions, findOne: db.region } }))
vi.mock('../models/User.js', () => ({ User: { exists: db.actor, findOne: db.actor } }))
import { effectiveRegionalSettings, listInventory, updateRegionalSettings } from './regionalInventoryService.js'
import { getEntryOptions } from './saleService.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', regionId = '507f1f77bcf86cd799439003', other = '507f1f77bcf86cd799439004', itemId = '507f1f77bcf86cd799439005'
let stocks, catalog, allowed
const query = value => ({ session() { return this }, select() { return this }, sort() { return this }, lean: async () => structuredClone(value), then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } })
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => String(row[key]) === String(value))
beforeEach(() => {
  vi.clearAllMocks(); allowed = true
  stocks = [{ _id: 'stock1', shop, region: regionId, item: itemId, quantityGrams: 500000 }, { _id: 'stock2', shop, region: other, item: itemId, quantityGrams: 200000 }]
  catalog = { _id: itemId, shop, name: 'Green Tea', teaType: 'Green Tea', status: 'active', sellingPrice: 800, lowStockThreshold: 100 }
  const regions = [{ _id: regionId, shop, name: 'Islamabad', status: 'active' }, { _id: other, shop, name: 'Peshawar', status: 'active' }]
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ endSession: vi.fn(), withTransaction: async callback => callback() })
  db.actor.mockImplementation(() => query(allowed ? { _id: actor, name: 'Admin', role: 'admin' } : null))
  db.stocks.mockImplementation(filter => query(stocks.filter(row => matches(row, filter))))
  db.stock.mockImplementation(filter => query(stocks.find(row => matches(row, filter)) ?? null))
  db.products.mockImplementation(filter => query(matches(catalog, filter) ? [catalog] : []))
  db.product.mockImplementation(filter => query(matches(catalog, filter) ? catalog : null))
  db.regions.mockImplementation(filter => query(regions.filter(row => matches(row, filter))))
  db.region.mockImplementation(filter => query(regions.find(row => matches(row, filter)) ?? null))
  db.update.mockImplementation((filter, change, options) => {
    expect(options.session).toBeTruthy()
    const row = stocks.find(value => matches(value, filter))
    if (!row) return query(null)
    Object.assign(row, change.$set); row.configurationHistory ??= []; row.configurationHistory.push(change.$push.configurationHistory)
    return query(row)
  })
})
afterEach(() => vi.restoreAllMocks())

describe('regional product configuration (offline)', () => {
  it('inherits real defaults and keeps missing values explicitly unconfigured', () => {
    expect(effectiveRegionalSettings({}, catalog)).toMatchObject({ sellingPrice: 800, lowStockThreshold: 100, sellingPriceOverride: null })
    expect(effectiveRegionalSettings({}, {})).toMatchObject({ sellingPrice: null, lowStockThreshold: null, catalogSellingPrice: null })
  })
  it('keeps missing catalog defaults unset in sale entry options', async () => {
    delete catalog.sellingPrice; delete catalog.lowStockThreshold
    const options = await getEntryOptions({ shop, userId: actor, regionId })
    expect(options.items[0]).toMatchObject({ sellingPrice: null, lowStockThreshold: null })
  })
  it('keeps regional overrides independent, preserves stock/catalog and supplies the effective sale price', async () => {
    await updateRegionalSettings({ shop, actor, regionId, itemId, sellingPriceOverride: 850, lowStockThresholdOverride: 50 })
    const inventory = await listInventory({ shop })
    expect(inventory.map(row => [row.sellingPrice, row.lowStockThreshold])).toEqual([[850, 50], [800, 100]])
    expect(stocks.map(row => row.quantityGrams)).toEqual([500000, 200000]); expect(catalog.sellingPrice).toBe(800)
    const saleOptions = await getEntryOptions({ shop, userId: actor, regionId })
    expect(saleOptions.items[0]).toMatchObject({ sellingPrice: 850, lowStockThreshold: 50, availableKg: 500 })
    expect(stocks[0].configurationHistory[0]).toMatchObject({ createdBy: actor, beforePrice: null, afterPrice: 850 })
  })
  it('accepts zero threshold, resets to live catalog defaults and avoids duplicate audit on unchanged replay', async () => {
    const request = { shop, actor, regionId, itemId, sellingPriceOverride: 850, lowStockThresholdOverride: 0 }
    await updateRegionalSettings(request); await updateRegionalSettings(request)
    expect(stocks[0].configurationHistory).toHaveLength(1)
    catalog.sellingPrice = 900
    const reset = await updateRegionalSettings({ shop, actor, regionId, itemId, sellingPriceOverride: null, lowStockThresholdOverride: null })
    expect(reset).toMatchObject({ sellingPrice: 900, lowStockThreshold: 100, sellingPriceOverride: null })
    expect(stocks[0].configurationHistory).toHaveLength(2)
  })
  it.each([0, -1, 1.5, Infinity, NaN])('rejects unsupported regional price %s', async sellingPriceOverride => {
    await expect(updateRegionalSettings({ shop, actor, regionId, itemId, sellingPriceOverride })).rejects.toThrow()
    expect(db.update).not.toHaveBeenCalled()
  })
  it.each([-1, 0.0001, Infinity, NaN])('rejects invalid alert quantity %s', async lowStockThresholdOverride => {
    await expect(updateRegionalSettings({ shop, actor, regionId, itemId, lowStockThresholdOverride })).rejects.toThrow()
    expect(db.update).not.toHaveBeenCalled()
  })
  it('rejects foreign scope, staff changes and stock quantities in configuration requests', async () => {
    await expect(updateRegionalSettings({ shop: other, actor, regionId, itemId, sellingPriceOverride: 850 })).rejects.toThrow('not found')
    allowed = false
    await expect(updateRegionalSettings({ shop, actor, regionId, itemId, sellingPriceOverride: 850 })).rejects.toThrow('owner or admin')
    await expect(updateRegionalSettings({ shop, actor, regionId, itemId, quantityGrams: 0 })).rejects.toThrow()
    expect(db.update).not.toHaveBeenCalled()
  })
})

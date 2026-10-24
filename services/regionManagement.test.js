import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ actor: vi.fn(), create: vi.fn(), update: vi.fn(), stock: vi.fn() }))
vi.mock('../models/User.js', () => ({ User: { exists: db.actor } }))
vi.mock('../models/Region.js', () => ({ Region: { init: vi.fn(), create: db.create, findOneAndUpdate: db.update } }))
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { init: vi.fn(), findOneAndUpdate: db.stock } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { init: vi.fn() } }))
import { createRegion, updateRegion } from './regionalInventoryService.js'
import { regionInputSchema } from '../schemas/regionalSchemas.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', regionId = '507f1f77bcf86cd799439003'
let regions
const query = value => ({ session() { return this }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } })
beforeEach(() => {
  vi.clearAllMocks(); regions = []
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ endSession: vi.fn(), withTransaction: async callback => callback() })
  db.actor.mockImplementation(() => query(true))
  db.create.mockImplementation(async ([row], options) => {
    expect(options.session).toBeTruthy()
    if (regions.some(region => region.shop === row.shop && region.nameKey === row.nameKey)) throw Object.assign(new Error('Duplicate'), { code: 11000 })
    const value = { _id: regionId, ...row }; regions.push(value); return [{ ...value, toObject: () => ({ ...value }) }]
  })
  db.update.mockImplementation(async (filter, changes) => {
    const row = regions.find(row => row.shop === filter.shop && row._id === filter._id)
    if (!row) return null
    Object.assign(row, changes.$set); return row
  })
})
afterEach(() => vi.restoreAllMocks())
describe('region management offline contracts', () => {
  it('creates trimmed shop-owned metadata and prevents same-shop case-insensitive duplicates', async () => {
    expect(await createRegion({ shop, actor, name: ' Islamabad ', phone: '+92 300 1234567', description: 'Main depot', address: 'Market', status: 'active' })).toMatchObject({ name: 'Islamabad', nameKey: 'islamabad', createdBy: actor, shop })
    await expect(createRegion({ shop, actor, name: 'ISLAMABAD' })).rejects.toMatchObject({ code: 11000 })
    await expect(createRegion({ shop: actor, actor, name: 'Islamabad' })).resolves.toBeTruthy()
  })
  it('edits metadata and deactivates without touching stock, sales or purchase history', async () => {
    await createRegion({ shop, actor, name: 'Islamabad' })
    expect(await updateRegion({ shop, actor, regionId, city: 'Islamabad City', status: 'inactive' })).toMatchObject({ name: 'Islamabad', city: 'Islamabad City', status: 'inactive', updatedBy: actor })
    expect(db.stock).not.toHaveBeenCalled()
    await expect(updateRegion({ shop: actor, actor, regionId, status: 'active' })).rejects.toThrow('Region not found')
  })
  it('rejects staff management and unknown fields rather than accepting stock or tenant overrides', async () => {
    db.actor.mockImplementation(() => query(null))
    await expect(createRegion({ shop, actor, name: 'Region' })).rejects.toThrow('owner or admin')
    expect(regionInputSchema.safeParse({ name: 'Region', stockKg: 100 }).success).toBe(false)
    expect(regionInputSchema.safeParse({ name: '', phone: 'not a phone' }).success).toBe(false)
    expect(db.create).not.toHaveBeenCalled()
  })
})

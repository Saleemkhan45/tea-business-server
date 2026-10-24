import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { RegionalStock } from './RegionalStock.js'
import { Region } from './Region.js'
import { RegionalStockOperation } from './RegionalStockOperation.js'
const id = () => new mongoose.Types.ObjectId()
describe('offline regional schemas', () => {
  it('validates nullable regional overrides without changing quantity precision', async () => {
    const base = { shop: id(), region: id(), item: id(), quantityGrams: 1000 }
    for (const settings of [{ sellingPriceOverride: null, lowStockThresholdOverride: null }, { sellingPriceOverride: 850, lowStockThresholdOverride: 0 }, { lowStockThresholdOverride: 0.125 }]) {
      await expect(new RegionalStock({ ...base, ...settings }).validate()).resolves.toBeUndefined()
    }
    for (const settings of [{ sellingPriceOverride: 0 }, { sellingPriceOverride: 1.5 }, { lowStockThresholdOverride: -1 }, { lowStockThresholdOverride: 0.0001 }]) {
      await expect(new RegionalStock({ ...base, ...settings }).validate()).rejects.toThrow()
    }
  })
  it('defines a unique shop/region/product identity', () => {
    expect(RegionalStock.schema.indexes()).toEqual(expect.arrayContaining([[{ shop: 1, region: 1, item: 1 }, expect.objectContaining({ unique: true })]]))
  })
  it('requires nonnegative integer grams', async () => {
    for (const quantityGrams of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      const stock = new RegionalStock({ shop: id(), region: id(), item: id(), quantityGrams })
      await expect(stock.validate()).rejects.toThrow()
    }
    await expect(new RegionalStock({ shop: id(), region: id(), item: id(), quantityGrams: 0 }).validate()).resolves.toBeUndefined()
  })
  it('requires stock scope and audited operators without opening a connection', async () => {
    await expect(new RegionalStock({}).validate()).rejects.toThrow()
    await expect(new Region({ shop: id(), name: 'Islamabad', nameKey: 'islamabad' }).validate()).rejects.toThrow('createdBy')
    await expect(new RegionalStockOperation({ shop: id(), type: 'transfer' }).validate()).rejects.toThrow()
    expect(mongoose.connection.readyState).toBe(0)
  })
  it('defines tenant scoped operation idempotency', () => {
    expect(RegionalStockOperation.schema.indexes()).toEqual(expect.arrayContaining([[{ shop: 1, idempotencyKey: 1 }, expect.objectContaining({ unique: true })]]))
  })
  it('defines partial region creation idempotency and accepts distinct opening-stock audits', async () => {
    expect(Region.schema.indexes()).toEqual(expect.arrayContaining([[{ shop: 1, idempotencyKey: 1 }, expect.objectContaining({ unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } })]]))
    await expect(new RegionalStockOperation({ shop: id(), region: id(), item: id(), createdBy: id(), type: 'opening_stock', quantityGrams: 1000, idempotencyKey: 'opening-test', fingerprint: 'digest', reason: 'Authorized opening balance', balances: [{ region: id(), beforeGrams: 0, afterGrams: 1000 }] }).validate()).resolves.toBeUndefined()
  })
})

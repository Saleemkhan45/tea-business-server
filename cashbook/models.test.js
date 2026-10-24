import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { CashState, CashEntry, CashSource, CashClosing } from '../models/CashBook.js'

const shop = new mongoose.Types.ObjectId(), actor = new mongoose.Types.ObjectId()
describe('cash persistence invariants without a database connection', () => {
  it('never creates collections or indexes implicitly', () => {
    for (const model of [CashState, CashEntry, CashSource, CashClosing]) {
      expect(model.schema.options.autoCreate).toBe(false)
      expect(model.schema.options.autoIndex).toBe(false)
    }
    expect(mongoose.connection.readyState).toBe(0)
  })
  it('rejects unsafe, fractional and negative account balances', async () => {
    for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      const state = new CashState({ shop, initializedBy: actor, openingDate: '2026-10-21', shopBalance: value, homeBalance: 0 })
      await expect(state.validate()).rejects.toThrow()
    }
    const source = new CashSource({ shop, source: 'supplier-payment', value: -500 })
    await expect(source.validate()).resolves.toBeUndefined()
  })
  it('accepts whole-PKR two-account transfers and rejects invalid ledger amounts/types', async () => {
    const valid = { shop, createdBy: actor, sequence: 1, key: 'key', fingerprint: 'digest', businessDate: '2026-10-21', type: 'shop_to_home', shopDelta: -100, homeDelta: 100, shopBalance: 900, homeBalance: 100, description: 'Verified transfer' }
    await expect(new CashEntry(valid).validate()).resolves.toBeUndefined()
    for (const override of [{ shopDelta: 1.1 }, { shopBalance: -1 }, { type: 'invented_revenue' }]) await expect(new CashEntry({ ...valid, ...override }).validate()).rejects.toThrow()
    expect(CashEntry.schema.path('shopDelta').options.immutable).toBe(true)
    expect(CashClosing.schema.path('difference').options.immutable).toBe(true)
  })
})

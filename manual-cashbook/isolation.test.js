import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { ManualCashDay, ManualCashRevision } from '../models/ManualCashDay.js'

describe('manual persistence and financial isolation', () => {
  it('has no financial source imports and no automatic hooks in source services', () => {
    const service = readFileSync(new URL('./service.js', import.meta.url), 'utf8')
    expect(service).not.toMatch(/from ['"].*(Sale|Purchase|CustomerLedger|Inventory|regional)/)
    for (const file of ['saleService', 'purchaseService', 'customerLedgerService']) {
      const source = readFileSync(new URL(`../services/${file}.js`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/cashbook|CashBook|syncCashSource|syncSaleCash|ManualCashDay/)
    }
    const routes = readFileSync(new URL('../routes/index.js', import.meta.url), 'utf8')
    expect(routes).toContain("from '../manual-cashbook/routes.js'")
    expect(routes).not.toContain("from '../cashbook/routes.js'")
  })
  it('never creates collections/indexes or connects at startup', () => {
    for (const model of [ManualCashDay, ManualCashRevision]) {
      expect(model.schema.options.autoIndex).toBe(false); expect(model.schema.options.autoCreate).toBe(false)
    }
    expect(ManualCashDay.schema.indexes()).toContainEqual([{ shop: 1, businessDate: 1 }, { unique: true }])
    expect(ManualCashDay.schema.indexes()).toHaveLength(1)
    expect(ManualCashRevision.schema.indexes()).toEqual([
      [{ shop: 1, key: 1 }, { unique: true }],
      [{ shop: 1, record: 1, revision: 1 }, { unique: true }],
    ])
    expect(mongoose.connection.readyState).toBe(0)
  })
  it('rejects inconsistent derived values and fractional stored amounts without database calls', async () => {
    const id = new mongoose.Types.ObjectId()
    const valid = { shop: id, businessDate: '2026-10-21', shopCashAmount: 7000, bossAddedAmount: 3000, totalCollected: 10000, takenHomeAmount: 8000, remainingCash: 2000, enteredBy: id, lastUpdatedBy: id }
    await expect(new ManualCashDay(valid).validate()).resolves.toBeUndefined()
    await expect(new ManualCashDay({ ...valid, totalCollected: 1 }).validate()).rejects.toThrow()
    await expect(new ManualCashDay({ ...valid, takenHomeAmount: 1.5 }).validate()).rejects.toThrow()
    const { takenHomeAmount, remainingCash, ...simplified } = valid
    const current = new ManualCashDay(simplified)
    await expect(current.validate()).resolves.toBeUndefined()
    expect(current.takenHomeAmount).toBeUndefined()
    expect(current.remainingCash).toBeUndefined()
    expect(current.status).toBe('active')
    // A simplified correction does not recalculate retained legacy withdrawal fields.
    const legacy = new ManualCashDay({ ...valid, shopCashAmount: 1000, bossAddedAmount: 0, totalCollected: 1000 })
    await expect(legacy.validate()).resolves.toBeUndefined()
    expect(legacy.remainingCash).toBe(2000)
    expect(ManualCashDay.schema.path('enteredBy').options.immutable).toBe(true)
    expect(ManualCashRevision.schema.path('next').options.immutable).toBe(true)
  })
  it('validates void/replacement audit snapshots offline while retaining append-only safeguards', async () => {
    const id = new mongoose.Types.ObjectId()
    const values = { shopCashAmount: 20000, bossAddedAmount: 4000, totalCollected: 24000, notes: 'Manual' }
    const audit = { shop: id, record: id, businessDate: '2026-10-22', revision: 1, action: 'void', key: 'operation', fingerprint: 'fingerprint', reason: 'Wrong manual count', modifiedBy: id,
      previous: { ...values, status: 'active' }, next: { ...values, status: 'voided', voidedBy: id, voidedAt: new Date(), voidReason: 'Wrong manual count' } }
    await expect(new ManualCashRevision(audit).validate()).resolves.toBeUndefined()
    await expect(new ManualCashRevision({ ...audit, action: 'replace', revision: 2, previous: audit.next, next: audit.previous }).validate()).resolves.toBeUndefined()
    await expect(new ManualCashRevision({ ...audit, action: 'erase' }).validate()).rejects.toThrow()
    expect(ManualCashRevision.schema.path('previous').options.immutable).toBe(true)
    expect(ManualCashRevision.schema.path('next').options.immutable).toBe(true)
  })
})

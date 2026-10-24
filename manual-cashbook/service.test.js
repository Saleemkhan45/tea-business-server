import mongoose from 'mongoose'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ day: {}, audit: {}, user: vi.fn(), shop: vi.fn() }))
vi.mock('../models/ManualCashDay.js', () => ({ ManualCashDay: db.day, ManualCashRevision: db.audit }))
vi.mock('../models/User.js', () => ({ User: { exists: db.user } }))
vi.mock('../models/Shop.js', () => ({ Shop: { exists: db.shop } }))
import { saveDay, getByDate, overview, history, details, status, requireManualCashIndexes, voidDay, replaceDay } from './service.js'

const shop = '507f1f77bcf86cd799439001', actor = '507f1f77bcf86cd799439002', otherShop = '507f1f77bcf86cd799439003'
let store, tail, allowed, failAudit
const clone = value => JSON.parse(JSON.stringify(value))
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !value._bsontype) return Object.entries(value).every(([op, bound]) => op === '$ne' ? row[key] !== bound : op === '$in' ? bound.includes(row[key]) : op === '$gte' ? row[key] >= bound : op === '$lte' ? row[key] <= bound : false)
    return String(row[key]) === String(value)
  })
}
function query(value) {
  return { session() { return this }, populate() { return this }, select() { return this },
    sort(order) { if (Array.isArray(value)) value.sort((a, b) => { for (const [key, sign] of Object.entries(order)) { if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * sign } return 0 }); return this },
    skip(count) { value = value.slice(count); return this }, limit(count) { value = value.slice(0, count); return this },
    lean: async () => clone(value), then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T10:00:00Z')); vi.clearAllMocks()
  store = { days: [], revisions: [] }; tail = Promise.resolve(); allowed = true; failAudit = false
  for (const [model, name, indexes] of [[db.day, 'days', [{ shop: 1, businessDate: 1 }]], [db.audit, 'revisions', [{ shop: 1, key: 1 }, { shop: 1, record: 1, revision: 1 }]]]) {
    model.schema = { indexes: () => indexes.map(key => [key, { unique: true }]) }
    model.collection = { listIndexes: () => ({ toArray: async () => indexes.map(key => ({ key, unique: true })) }) }
    model.findOne = vi.fn(filter => query(store[name].find(row => matches(row, filter)) ?? null))
    model.exists = vi.fn(filter => query(store[name].find(row => matches(row, filter)) ?? null))
    model.find = vi.fn(filter => query(store[name].filter(row => matches(row, filter)).map(row => clone(row))))
    model.countDocuments = vi.fn(filter => query(store[name].filter(row => matches(row, filter)).length))
    model.create = vi.fn(async (rows, options) => {
      expect(options.session).toBeTruthy()
      if (name === 'revisions' && failAudit) throw new Error('Audit unavailable')
      return rows.map(row => {
        const created = { _id: new mongoose.Types.ObjectId().toHexString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...clone(row) }
        store[name].push(created); return clone(created)
      })
    })
  }
  db.day.findOneAndUpdate = vi.fn((filter, change, options) => {
    expect(options.session).toBeTruthy()
    const row = store.days.find(row => matches(row, filter))
    if (row) { Object.assign(row, clone(change.$set)); row.revision += change.$inc.revision; row.updatedAt = new Date().toISOString() }
    return query(row ?? null)
  })
  db.day.aggregate = vi.fn(pipeline => {
    const rows = store.days.filter(row => matches(row, pipeline[0].$match))
    const summary = { recordedDays: rows.length, shopCashAmount: 0, bossAddedAmount: 0, totalCollected: 0 }
    for (const row of rows) for (const key of ['shopCashAmount', 'bossAddedAmount', 'totalCollected']) summary[key] += row[key]
    return query(rows.length ? [summary] : [])
  })
  db.user.mockImplementation(filter => query(allowed && filter.shop === shop ? { _id: actor } : null))
  db.shop.mockImplementation(filter => query(filter._id === shop ? { _id: shop } : null))
  vi.spyOn(mongoose, 'startSession').mockImplementation(async () => ({ endSession: vi.fn(), withTransaction: async callback => {
    const beforeTurn = tail; let release; tail = new Promise(resolve => { release = resolve }); await beforeTurn
    const before = clone(store)
    try { return await callback() } catch (error) { store = before; throw error } finally { release() }
  } }))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const input = (extra = {}) => ({ key: 'create-1', businessDate: '2026-10-21', shopCashAmount: 7000, bossAddedAmount: 3000, notes: '', ...extra })

describe('manual daily history transactions, simulated storage only', () => {
  it('corrects 20000 to 25000 in the same daily slot with a 29000 total and immutable prior audit', async () => {
    const original = await saveDay(shop, actor, input({ shopCashAmount: 20000, bossAddedAmount: 4000 }))
    const firstAudit = clone(store.revisions[0])
    const correction = { key: 'verified-count', expectedRevision: 0, shopCashAmount: 25000, bossAddedAmount: 4000, reason: 'Recounted shop cash', notes: '' }
    const result = await saveDay(shop, actor, correction, original.record._id)
    expect(result).toMatchObject({ postedRevision: 1, replayed: false, record: { _id: original.record._id, totalCollected: 29000, revision: 1, enteredBy: actor, lastUpdatedBy: actor } })
    expect(store.days).toHaveLength(1)
    expect(store.revisions[0]).toEqual(firstAudit)
    expect(store.revisions[1]).toMatchObject({ action: 'correct', modifiedBy: actor, reason: correction.reason, previous: { shopCashAmount: 20000, totalCollected: 24000 }, next: { shopCashAmount: 25000, totalCollected: 29000 } })
    expect((await getByDate(shop, original.record.businessDate)).record.totalCollected).toBe(29000)
    expect((await history(shop, { from: '2026-10-01', to: '2026-10-21' })).summary.totalCollected).toBe(29000)
    await saveDay(shop, actor, correction, original.record._id)
    expect(store.revisions).toHaveLength(2)
  })
  it('voids without erasing values, audits the actor/reason and excludes the day from every active read', async () => {
    const first = await saveDay(shop, actor, input())
    const result = await voidDay(shop, actor, { key: 'void-1', expectedRevision: 0, reason: 'Duplicate manual count' }, first.record._id)
    expect(result.record).toMatchObject({ status: 'voided', revision: 1, shopCashAmount: 7000, bossAddedAmount: 3000, totalCollected: 10000, voidedBy: actor, voidReason: 'Duplicate manual count' })
    expect(result.record.voidedAt).toBeTruthy()
    expect(store.days).toHaveLength(1)
    expect(store.revisions[1]).toMatchObject({ action: 'void', previous: { status: 'active', totalCollected: 10000 }, next: { status: 'voided', totalCollected: 10000 }, modifiedBy: actor })
    expect(await getByDate(shop, '2026-10-21')).toMatchObject({ record: null, voidedRecord: { _id: first.record._id } })
    expect((await overview(shop)).today.record).toBeNull()
    expect(await history(shop, { from: '2026-10-01', to: '2026-10-21' })).toMatchObject({ rows: [], total: 0, summary: { totalCollected: 0, recordedDays: 0 } })
    expect((await details(shop, first.record._id)).audit).toHaveLength(2)
  })
  it('preserves other dates and shops in period totals when one day is voided', async () => {
    const first = await saveDay(shop, actor, input())
    await saveDay(shop, actor, input({ key: 'yesterday', businessDate: '2026-10-20', shopCashAmount: 20000, bossAddedAmount: 4000 }))
    await voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Wrong manual figures' }, first.record._id)
    expect((await history(shop, { from: '2026-10-01', to: '2026-10-21' })).summary).toMatchObject({ recordedDays: 1, totalCollected: 24000 })
    expect((await overview(shop)).yesterday.record.totalCollected).toBe(24000)
  })
  it('replays the same void key, rejects a second deletion and prevents stale corrections', async () => {
    const first = await saveDay(shop, actor, input())
    const command = { key: 'void', expectedRevision: 0, reason: 'Invalid count' }
    await voidDay(shop, actor, command, first.record._id)
    expect((await voidDay(shop, actor, command, first.record._id)).replayed).toBe(true)
    await expect(voidDay(shop, actor, { ...command, key: 'again', expectedRevision: 1 }, first.record._id)).rejects.toMatchObject({ code: 'MANUAL_CASH_ALREADY_VOIDED' })
    await expect(saveDay(shop, actor, { ...input(), key: 'stale', expectedRevision: 0, reason: 'Old correction' }, first.record._id)).rejects.toMatchObject({ statusCode: 409 })
    expect(store.revisions).toHaveLength(2)
  })
  it('replaces a voided day in the same unique slot and keeps the complete audit chain', async () => {
    const first = await saveDay(shop, actor, input())
    const command = { key: 'void', expectedRevision: 0, reason: 'Wrong daily count' }
    await voidDay(shop, actor, command, first.record._id)
    await expect(saveDay(shop, actor, input({ key: 'new-create' }))).rejects.toMatchObject({ code: 'MANUAL_CASH_DAY_EXISTS' })
    const replacement = { key: 'replace', expectedRevision: 1, reason: 'Recounted approved amounts', shopCashAmount: 20000, bossAddedAmount: 4000, notes: 'Verified' }
    const result = await replaceDay(shop, actor, replacement, first.record._id)
    expect(result.record).toMatchObject({ _id: first.record._id, status: 'active', revision: 2, totalCollected: 24000, voidedAt: null, voidedBy: null, enteredBy: actor })
    expect(store.days).toHaveLength(1)
    expect(store.revisions.map(row => row.action)).toEqual(['create', 'void', 'replace'])
    expect(store.revisions[2]).toMatchObject({ previous: { status: 'voided', totalCollected: 10000 }, next: { status: 'active', totalCollected: 24000 } })
    expect((await history(shop, { from: '2026-10-01', to: '2026-10-21' })).summary.totalCollected).toBe(24000)
    // A late retry reports the originally applied revision and the current state; it never voids twice.
    expect(await voidDay(shop, actor, command, first.record._id)).toMatchObject({ replayed: true, postedRevision: 1, record: { status: 'active', revision: 2 } })
    expect((await replaceDay(shop, actor, replacement, first.record._id)).replayed).toBe(true)
    await expect(replaceDay(shop, actor, { ...replacement, key: 'bad-replace', expectedRevision: 2 }, first.record._id)).rejects.toMatchObject({ code: 'MANUAL_CASH_CONFLICT' })
  })
  it('rolls back void and replacement when audit persistence fails', async () => {
    const first = await saveDay(shop, actor, input()), before = clone(store)
    failAudit = true
    await expect(voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Manual mistake' }, first.record._id)).rejects.toThrow('Audit unavailable')
    expect(store).toEqual(before)
    failAudit = false
    await voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Manual mistake' }, first.record._id)
    const voided = clone(store); failAudit = true
    await expect(replaceDay(shop, actor, { ...input(), key: 'replace', expectedRevision: 1, reason: 'Recounted manual cash' }, first.record._id)).rejects.toThrow('Audit unavailable')
    expect(store).toEqual(voided)
  })
  it('permits only one concurrent void/correction and requires a nonempty reason', async () => {
    const first = await saveDay(shop, actor, input())
    await expect(voidDay(shop, actor, { key: 'bad', expectedRevision: 0, reason: ' ' }, first.record._id)).rejects.toThrow('reason')
    const result = await Promise.allSettled([
      voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Void manual error' }, first.record._id),
      saveDay(shop, actor, { ...input(), key: 'correct', expectedRevision: 0, reason: 'Correct manual error' }, first.record._id),
    ])
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(store.revisions).toHaveLength(2)
  })
  it('enforces operator authorization and shop isolation for void/replacement', async () => {
    const first = await saveDay(shop, actor, input())
    allowed = false
    await expect(voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Denied attempt' }, first.record._id)).rejects.toMatchObject({ statusCode: 403 })
    allowed = true
    store.days[0].shop = otherShop
    await expect(voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Foreign record' }, first.record._id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(replaceDay(shop, actor, { ...input(), key: 'replace', expectedRevision: 0, reason: 'Foreign record' }, first.record._id)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('treats legacy status-less rows as active and retains historical optional fields on void', async () => {
    const first = await saveDay(shop, actor, input())
    delete store.days[0].status
    Object.assign(store.days[0], { takenHomeAmount: 20, remainingCash: 9980 })
    expect((await history(shop, { from: '2026-10-01', to: '2026-10-21' })).total).toBe(1)
    await voidDay(shop, actor, { key: 'void', expectedRevision: 0, reason: 'Legacy record error' }, first.record._id)
    expect(store.revisions[1]).toMatchObject({ previous: { status: 'active', takenHomeAmount: 20, remainingCash: 9980 }, next: { takenHomeAmount: 20, remainingCash: 9980 } })
  })
  it('acknowledges 20000 + 4000 as 24000, reads back the exact business date and includes it in history', async () => {
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    const result = await saveDay(shop, actor, input({ businessDate: '2026-10-22', shopCashAmount: 20000, bossAddedAmount: 4000 }))
    expect(result.record).toMatchObject({ shopCashAmount: 20000, bossAddedAmount: 4000, totalCollected: 24000, enteredBy: actor })
    expect((await getByDate(shop, '2026-10-22')).record._id).toBe(result.record._id)
    expect((await history(shop, { from: '2026-10-01', to: '2026-10-22' })).summary).toMatchObject({ recordedDays: 1, shopCashAmount: 20000, bossAddedAmount: 4000, totalCollected: 24000 })
    await expect(saveDay(shop, actor, input({ key: 'different', businessDate: '2026-10-22' }))).rejects.toMatchObject({ statusCode: 409, code: 'MANUAL_CASH_DAY_EXISTS' })
  })
  it('provides owner setup findings separately from ordinary readiness and permission errors', async () => {
    db.day.collection.listIndexes = () => ({ toArray: async () => { throw Object.assign(new Error('missing'), { code: 26 }) } })
    expect(await status(false)).not.toHaveProperty('setup')
    expect(await status(true)).toMatchObject({ ready: false, setup: { reason: 'collection_missing' } })
    db.day.collection.listIndexes = () => ({ toArray: async () => { throw Object.assign(new Error('permission'), { code: 13 }) } })
    await expect(status()).rejects.toMatchObject({ code: 'MANUAL_CASH_PERMISSION_REQUIRED' })
  })
  it('saves independent inputs and server-derived totals with a creation audit', async () => {
    const result = await saveDay(shop, actor, input({ totalCollected: 1 }))
    expect(result.record).toMatchObject({ shopCashAmount: 7000, bossAddedAmount: 3000, totalCollected: 10000, enteredBy: actor, revision: 0 })
    expect(store.revisions[0]).toMatchObject({ action: 'create', previous: null, next: { totalCollected: 10000 }, modifiedBy: actor })
    expect(store.days).toHaveLength(1)
  })
  it('stores explicit zeros and distinguishes no daily record from zero', async () => {
    expect(await getByDate(shop, '2026-10-21')).toEqual({ date: '2026-10-21', record: null })
    await saveDay(shop, actor, input({ shopCashAmount: 0, bossAddedAmount: 0 }))
    expect((await getByDate(shop, '2026-10-21')).record).toMatchObject({ totalCollected: 0 })
  })
  it('replays identical requests but rejects changed-key payloads and a second finalized day', async () => {
    const first = await saveDay(shop, actor, input()), repeated = await saveDay(shop, actor, input())
    expect(repeated.replayed).toBe(true); expect(repeated.record._id).toBe(first.record._id)
    expect(store.revisions).toHaveLength(1)
    await expect(saveDay(shop, actor, input({ shopCashAmount: 1 }))).rejects.toMatchObject({ statusCode: 409 })
    await expect(saveDay(shop, actor, input({ key: 'other-key' }))).rejects.toThrow('already exists')
  })
  it('allows one winner for concurrent same-date commands and replays concurrent same-key commands', async () => {
    const result = await Promise.allSettled([saveDay(shop, actor, input()), saveDay(shop, actor, input({ key: 'other-key' }))])
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(store.days).toHaveLength(1); expect(store.revisions).toHaveLength(1)
    await Promise.all([saveDay(shop, actor, input()), saveDay(shop, actor, input())])
    expect(store.revisions).toHaveLength(1)
  })
  it('corrects by expected revision, preserves prior values/operator/date, and audits the reason', async () => {
    const first = await saveDay(shop, actor, input())
    const change = { key: 'correction', expectedRevision: 0, shopCashAmount: 7000, bossAddedAmount: 3000, notes: 'Corrected count', reason: 'Corrected manual count' }
    const corrected = await saveDay(shop, actor, change, first.record._id)
    expect(corrected.record).toMatchObject({ totalCollected: 10000, enteredBy: actor, revision: 1, businessDate: '2026-10-21' })
    expect(store.revisions[1]).toMatchObject({ previous: { notes: '' }, next: { notes: 'Corrected count' }, reason: change.reason, modifiedBy: actor })
    await saveDay(shop, actor, change, first.record._id)
    expect(store.revisions).toHaveLength(2)
    await expect(saveDay(shop, actor, { ...change, key: 'stale' }, first.record._id)).rejects.toThrow('another operator')
    expect((await details(shop, first.record._id)).audit.map(row => row.revision)).toEqual([1, 0])
  })
  it('prevents concurrent correction overwrites', async () => {
    const first = await saveDay(shop, actor, input())
    const change = { expectedRevision: 0, shopCashAmount: 7000, bossAddedAmount: 3000, notes: '', reason: 'Verified correction' }
    const results = await Promise.allSettled(['a', 'b'].map(key => saveDay(shop, actor, { ...change, key }, first.record._id)))
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(store.days[0].revision).toBe(1); expect(store.revisions).toHaveLength(2)
  })
  it('rolls back creation and correction when audit persistence fails', async () => {
    failAudit = true; await expect(saveDay(shop, actor, input())).rejects.toThrow('Audit unavailable')
    expect(store.days).toEqual([])
    failAudit = false; const first = await saveDay(shop, actor, input()); const before = clone(store)
    failAudit = true
    await expect(saveDay(shop, actor, { ...input(), key: 'edit', expectedRevision: 0, reason: 'Corrected cash count' }, first.record._id)).rejects.toThrow('Audit unavailable')
    expect(store).toEqual(before)
  })
  it('uses shop-scoped reads and owner/admin authorization; foreign IDs cannot be corrected', async () => {
    const first = await saveDay(shop, actor, input()); allowed = false
    await expect(saveDay(shop, actor, input({ key: 'denied' }))).rejects.toMatchObject({ statusCode: 403 })
    allowed = true
    await expect(details(otherShop, first.record._id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await getByDate(otherShop, '2026-10-21')).record).toBeNull()
    expect((await history(otherShop, { from: '2026-10-01', to: '2026-10-21' })).total).toBe(0)
  })
  it('does not carry yesterday into today across Karachi midnight', async () => {
    await saveDay(shop, actor, input())
    vi.setSystemTime(new Date('2026-10-21T19:00:00Z'))
    const empty = await overview(shop)
    expect(empty.today).toEqual({ date: '2026-10-22', record: null }); expect(empty.yesterday.record.totalCollected).toBe(10000)
    await saveDay(shop, actor, input({ key: 'tomorrow', businessDate: '2026-10-22', bossAddedAmount: 0 }))
    expect((await overview(shop)).today.record).toMatchObject({ shopCashAmount: 7000, totalCollected: 7000 })
  })
  it('summarizes recorded days only and paginates monthly history', async () => {
    await saveDay(shop, actor, input({ businessDate: '2026-10-19', key: 'earlier' }))
    const first = await saveDay(shop, actor, input())
    await saveDay(shop, actor, { ...input(), key: 'correct-today', expectedRevision: 0, shopCashAmount: 5000, bossAddedAmount: 0, reason: 'Corrected manual cash' }, first.record._id)
    const result = await history(shop, { from: '2026-10-01', to: '2026-10-21', page: 2, limit: 1 })
    expect(result.rows).toHaveLength(1); expect(result.rows[0].businessDate).toBe('2026-10-19')
    expect(result.summary).toEqual({ recordedDays: 2, shopCashAmount: 12000, bossAddedAmount: 3000, totalCollected: 15000, averageDailyCollection: 7500 })
    expect(result.summary).not.toHaveProperty('remainingCash')
    expect((await history(shop, { from: '2026-10-20', to: '2026-10-20' })).summary).toMatchObject({ recordedDays: 0, averageDailyCollection: null })
  })
  it('preserves deprecated legacy values during a simplified correction and keeps both snapshots', async () => {
    const first = await saveDay(shop, actor, input())
    Object.assign(store.days[0], { takenHomeAmount: 8000, remainingCash: 2000 })
    const corrected = await saveDay(shop, actor, { key: 'legacy-fix', expectedRevision: 0, shopCashAmount: 1000, bossAddedAmount: 0, notes: '', reason: 'Verified simplified cash count' }, first.record._id)
    expect(corrected.record).toMatchObject({ totalCollected: 1000, takenHomeAmount: 8000, remainingCash: 2000 })
    expect(store.revisions[1].previous).toMatchObject({ totalCollected: 10000, takenHomeAmount: 8000, remainingCash: 2000 })
    expect(store.revisions[1].next).toMatchObject({ totalCollected: 1000, takenHomeAmount: 8000, remainingCash: 2000 })
  })
  it('reads yesterday as a one-day history range', async () => {
    await saveDay(shop, actor, input({ businessDate: '2026-10-20', key: 'yesterday' }))
    await saveDay(shop, actor, input())
    expect((await history(shop, { from: '2026-10-20', to: '2026-10-20' })).summary).toMatchObject({ recordedDays: 1, totalCollected: 10000 })
  })
  it('distinguishes missing collections from an unreachable database without writing', async () => {
    db.day.collection.listIndexes = () => ({ toArray: async () => { throw Object.assign(new Error('missing'), { code: 26 }) } })
    expect(await status()).toMatchObject({ ready: false })
    db.day.collection.listIndexes = () => ({ toArray: async () => { throw new Error('network unavailable') } })
    await expect(status()).rejects.toMatchObject({ code: 'MANUAL_CASH_UNAVAILABLE', statusCode: 503 })
    expect(store.days).toHaveLength(0)
  })
  it('fails closed without approved full unique indexes, regardless of the old automatic feature flag', async () => {
    vi.stubEnv('CASH_BOOK_ENABLED', 'true')
    try {
      db.day.collection.listIndexes = () => ({ toArray: async () => [] })
      expect(await status()).toMatchObject({ ready: false, mode: 'manual_daily' })
      await expect(saveDay(shop, actor, input())).rejects.toMatchObject({ statusCode: 503, code: 'MANUAL_CASH_SETUP_REQUIRED' })
      expect(store.days).toHaveLength(0)
      db.day.collection.listIndexes = () => ({ toArray: async () => [{ key: { shop: 1, businessDate: 1 }, unique: true, sparse: true }] })
      await expect(requireManualCashIndexes()).rejects.toMatchObject({ statusCode: 503 })
    } finally { vi.unstubAllEnvs() }
  })
})

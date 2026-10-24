import { beforeEach, expect, it, vi } from 'vitest'
import { applyManualCashSetup, inspectManualCashSetup, validateSetupApproval } from './setup.js'
import { inspectIndexes } from './indexReadiness.js'
import { manualCashIndexPlan } from './index-plan.js'

let db, collections, writes
const approved = { MANUAL_CASH_SETUP_ALLOW_READS: 'true', MANUAL_CASH_SETUP_ALLOW_WRITES: 'true', MANUAL_CASH_SETUP_DATABASE: 'offline_manual_cash_fixture', MANUAL_CASH_SETUP_APPROVAL: 'offline test only' }
beforeEach(() => {
  collections = new Map(); writes = []
  db = {
    databaseName: approved.MANUAL_CASH_SETUP_DATABASE,
    admin: () => ({ command: async () => ({ setName: 'offline-replica' }) }),
    listCollections: ({ name }) => ({ toArray: async () => collections.has(name) ? [{ name, type: 'collection', options: collections.get(name).options ?? {} }] : [] }),
    createCollection: vi.fn(async name => { writes.push(['collection', name]); collections.set(name, { indexes: [{ key: { _id: 1 }, unique: true }], count: 0, invalid: 0, duplicates: 0 }) }),
    collection: name => ({
      listIndexes: () => ({ toArray: async () => collections.get(name).indexes }),
      countDocuments: async filter => filter.$expr ? collections.get(name).invalid : collections.get(name).count,
      aggregate: () => ({ toArray: async () => collections.get(name).duplicates ? [{ groups: collections.get(name).duplicates }] : [] }),
      createIndex: async (key, options) => { writes.push(['index', name, key]); collections.get(name).indexes.push({ key, ...options }) },
    }),
  }
})
it('requires explicit approval for the exact database before applying', async () => {
  expect(() => validateSetupApproval({}, 'test', false)).toThrow('Explicit read approval')
  expect(() => validateSetupApproval(approved, 'test', true)).toThrow('exact configured database')
  await expect(applyManualCashSetup(db, { ...approved, MANUAL_CASH_SETUP_ALLOW_WRITES: 'false' })).rejects.toThrow('owner write approval')
  expect(writes).toEqual([])
})
it('reports missing collections and exactly three indexes without writing', async () => {
  const report = await inspectManualCashSetup(db)
  expect(report.ready).toBe(false)
  expect(report.collections.map(item => item.name)).toEqual(['manualcashdays', 'manualcashrevisions'])
  expect(report.collections.flatMap(item => item.missingIndexes)).toHaveLength(3)
  expect(writes).toEqual([])
})
it('creates only missing collections and required indexes and safely repeats', async () => {
  expect((await applyManualCashSetup(db, approved)).ready).toBe(true)
  expect(writes.filter(([kind]) => kind === 'collection')).toHaveLength(2)
  expect(writes.filter(([kind]) => kind === 'index')).toHaveLength(3)
  writes.length = 0
  expect((await applyManualCashSetup(db, approved)).ready).toBe(true)
  expect(writes).toEqual([])
})
it.each(['duplicates', 'invalid', 'validator', 'ttl', 'unique', 'nonunique'])('stops without writes for existing %s conflicts', async problem => {
  for (const plan of manualCashIndexPlan) collections.set(plan.collection, { indexes: plan.indexes, count: 1, invalid: 0, duplicates: 0 })
  const day = collections.get('manualcashdays')
  if (problem === 'duplicates') day.duplicates = 1
  if (problem === 'invalid') day.invalid = 1
  if (problem === 'validator') day.options = { validator: { old: 'required' } }
  if (problem === 'ttl') day.indexes = [...day.indexes, { key: { createdAt: 1 }, expireAfterSeconds: 100 }]
  if (problem === 'unique') day.indexes = [...day.indexes, { key: { shop: 1 }, unique: true }]
  if (problem === 'nonunique') day.indexes = [{ key: { shop: 1, businessDate: 1 } }]
  const report = await applyManualCashSetup(db, approved)
  expect(report.blockers.length).toBeGreaterThan(0)
  expect(report.applied).toBe(false); expect(writes).toEqual([])
})
it('requires transaction support', async () => {
  db.admin = () => ({ command: async () => ({ isWritablePrimary: true }) })
  expect((await applyManualCashSetup(db, approved)).blockers).toContain('A transaction-capable replica set or mongos is required.')
  expect(writes).toEqual([])
})
it('accepts compatible index names but rejects sparse/partial/collated constraints', () => {
  const required = manualCashIndexPlan[0].indexes
  expect(inspectIndexes([{ ...required[0], name: 'existing_owner_index' }], required).missing).toEqual([])
  for (const options of [{ sparse: true }, { partialFilterExpression: { active: true } }, { collation: { locale: 'en', strength: 2 } }]) expect(inspectIndexes([{ ...required[0], ...options }], required).conflicts).toHaveLength(1)
})
it('stops on permission errors without cleanup writes', async () => {
  db.listCollections = () => ({ toArray: async () => { throw Object.assign(new Error('offline permission denied'), { code: 13 }) } })
  await expect(applyManualCashSetup(db, approved)).rejects.toMatchObject({ code: 13 })
  expect(writes).toEqual([])
})

import mongoose from 'mongoose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIntegrationLifecycle } from './integrationLifecycle.js'
import {
  acquireValidationLease, assertEmptyValidationDatabase, assertTestWriteAuthorization, connectTestDatabase,
  createFixtureOwnership, DEFAULT_TEST_MONGODB_URI, getTestMongoUri,
  ownedFixtureCleanupOperations, teardownIntegrationRun, trackFixtureInsertions, verifyAndReleaseValidationLease,
} from './mongoTestDatabase.js'

const databaseName = 'tea_business_dashboard_phase10_test'

function authorizedEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SALES_INTEGRATION_ALLOW_WRITES: 'true',
    SALES_INTEGRATION_MONGODB_URI: DEFAULT_TEST_MONGODB_URI,
    SALES_INTEGRATION_APPROVED_DATABASE: databaseName,
    SALES_INTEGRATION_APPROVED_HOSTS: '127.0.0.1:27018',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/tea_business_dashboard',
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('integration database isolation', () => {
  it('uses the dedicated replica-set test URI independently of the application URI', () => {
    expect(getTestMongoUri(authorizedEnvironment({ MONGODB_URI: 'mongodb://localhost/tea_business_dashboard' })))
      .toBe(DEFAULT_TEST_MONGODB_URI)
  })

  it.each(['tea_business_dashboard', 'production_test', 'test', 'tea_business_dashboard_phase9', 'latest'])
    ('rejects unsafe database name %s before connecting', name => {
      expect(() => getTestMongoUri(authorizedEnvironment({ SALES_INTEGRATION_MONGODB_URI: `mongodb://localhost/${name}` })))
        .toThrow('dedicated')
    })

  it('rejects production mode even with a test database name', () => {
    expect(() => getTestMongoUri(authorizedEnvironment({ NODE_ENV: 'production' }))).toThrow('NODE_ENV=production')
  })

  it('rejects reuse of the application database even if its name looks like a test database', () => {
    expect(() => getTestMongoUri(authorizedEnvironment({
      MONGODB_URI: 'mongodb://localhost/tea_business_dashboard_phase10_test',
    }))).toThrow('application database')
  })
})

describe('fail-closed integration authorization', () => {
  const invalidConfigurations = [
    ['missing authorization', { SALES_INTEGRATION_ALLOW_WRITES: undefined }, 'ALLOW_WRITES'],
    ['missing integration URI', { SALES_INTEGRATION_MONGODB_URI: undefined }, 'explicit SALES_INTEGRATION_MONGODB_URI'],
    ['empty integration URI', { SALES_INTEGRATION_MONGODB_URI: ' ' }, 'explicit SALES_INTEGRATION_MONGODB_URI'],
    ['missing database name', { SALES_INTEGRATION_MONGODB_URI: 'mongodb://127.0.0.1:27018/' }, 'explicit database name'],
    ['query-only database name', { SALES_INTEGRATION_MONGODB_URI: `mongodb://127.0.0.1:27018/?dbName=${databaseName}` }, 'explicit database name'],
    ['missing approved database', { SALES_INTEGRATION_APPROVED_DATABASE: undefined }, 'APPROVED_DATABASE'],
    ['incorrect approved database', { SALES_INTEGRATION_APPROVED_DATABASE: 'tea_business_dashboard_other_test' }, 'approved validation target'],
    ['production environment', { NODE_ENV: 'production' }, 'NODE_ENV=production'],
    ['application database', { MONGODB_URI: DEFAULT_TEST_MONGODB_URI }, 'application database'],
    ['missing application database configuration', { MONGODB_URI: undefined }, 'exclude the application database'],
    ['missing approved hosts', { SALES_INTEGRATION_APPROVED_HOSTS: undefined }, 'APPROVED_HOSTS'],
    ['incorrect approved hosts', { SALES_INTEGRATION_APPROVED_HOSTS: 'other.invalid:27018' }, 'approved validation target'],
    ['empty approved host entry', { SALES_INTEGRATION_APPROVED_HOSTS: '127.0.0.1:27018,' }, 'APPROVED_HOSTS'],
    ['duplicate approved host entries', { SALES_INTEGRATION_APPROVED_HOSTS: '127.0.0.1:27018,127.0.0.1:27018' }, 'APPROVED_HOSTS'],
    ['invalid integration URI', { SALES_INTEGRATION_MONGODB_URI: 'not-a-mongodb-uri' }, 'valid MongoDB URI'],
    ['unacknowledged URI write concern', {
      SALES_INTEGRATION_MONGODB_URI: `mongodb://127.0.0.1:27018/${databaseName}?w=0`,
    }, 'acknowledged writes'],
    ...['false', 'TRUE', '1', '', true].map(flag => [`invalid authorization flag ${String(flag)}`, { SALES_INTEGRATION_ALLOW_WRITES: flag }, 'ALLOW_WRITES']),
    ...['admin', 'local', 'config', 'test'].map(name => [
      `forbidden system database ${name}`,
      { SALES_INTEGRATION_MONGODB_URI: `mongodb://127.0.0.1:27018/${name}`, SALES_INTEGRATION_APPROVED_DATABASE: name },
      'system database',
    ]),
  ]

  it.each(invalidConfigurations)('rejects %s before connection or probe work', async (label, overrides, message) => {
    const connect = vi.spyOn(mongoose, 'connect').mockRejectedValue(new Error('Unexpected connection invocation'))
    const startSession = vi.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Unexpected probe invocation'))
    await expect(connectTestDatabase(DEFAULT_TEST_MONGODB_URI, authorizedEnvironment(overrides))).rejects.toThrow(message)
    expect(connect).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('requires all approvals even when the explicit URI equals the local default', () => {
    expect(() => getTestMongoUri({ SALES_INTEGRATION_MONGODB_URI: DEFAULT_TEST_MONGODB_URI })).toThrow('ALLOW_WRITES')
  })

  it('rejects a caller URI that differs from the authorized configuration', async () => {
    const connect = vi.spyOn(mongoose, 'connect').mockRejectedValue(new Error('Unexpected connection invocation'))
    await expect(connectTestDatabase(`mongodb://127.0.0.1:27018/${databaseName}`, authorizedEnvironment()))
      .rejects.toThrow('authorized configuration')
    expect(connect).not.toHaveBeenCalled()
  })

  it('rejects an unexpected connected database before write authorization succeeds', () => {
    expect(() => assertTestWriteAuthorization(DEFAULT_TEST_MONGODB_URI, 'tea_business_dashboard_other_test', authorizedEnvironment()))
      .toThrow('Connected database')
  })

  it('accepts exactly approved multi-host targets without resolving or connecting', () => {
    const uri = `mongodb://a.invalid:27017,b.invalid:27017/${databaseName}?replicaSet=validation`
    expect(getTestMongoUri(authorizedEnvironment({
      SALES_INTEGRATION_MONGODB_URI: uri, SALES_INTEGRATION_APPROVED_HOSTS: 'b.invalid:27017,a.invalid:27017',
    }))).toBe(uri)
  })

  it('parses an explicitly approved SRV target without DNS or connection calls', () => {
    const uri = `mongodb+srv://validation.invalid/${databaseName}`
    expect(getTestMongoUri(authorizedEnvironment({
      SALES_INTEGRATION_MONGODB_URI: uri, SALES_INTEGRATION_APPROVED_HOSTS: 'validation.invalid',
    }))).toBe(uri)
  })

  it('redacts failed setup errors without preserving a private cause', async () => {
    const uri = `mongodb://offline-user:offline-password@127.0.0.1:27018/${databaseName}`
    vi.spyOn(mongoose, 'connect').mockRejectedValue(new Error(`offline-user offline-password ${uri}`))
    const error = await connectTestDatabase(uri, authorizedEnvironment({ SALES_INTEGRATION_MONGODB_URI: uri })).catch(error => error)
    expect(error.message).not.toContain('offline-user')
    expect(error.message).not.toContain('offline-password')
    expect(error.message).not.toContain(uri)
    expect(error.cause).toBeUndefined()
  })

  it('rejects a nonempty connected database before starting any probe', async () => {
    const previousDatabase = mongoose.connection.db
    const database = {
      databaseName,
      listCollections: () => ({ toArray: async () => [{ name: 'unrelated_records' }] }),
      collection: () => ({ findOne: async () => ({ _id: new mongoose.Types.ObjectId() }), countDocuments: async () => 1 }),
    }
    const connect = vi.spyOn(mongoose, 'connect').mockResolvedValue(undefined)
    const startSession = vi.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Unexpected probe invocation'))
    mongoose.connection.db = database
    try {
      await expect(connectTestDatabase(DEFAULT_TEST_MONGODB_URI, authorizedEnvironment())).rejects.toThrow('existing records')
      expect(connect).toHaveBeenCalledWith(DEFAULT_TEST_MONGODB_URI, {
        serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false,
      })
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      mongoose.connection.db = previousDatabase
    }
  })
})

describe('non-destructive validation preflight', () => {
  it('refuses existing data, including collections outside the fixture model list', async () => {
    const findOne = vi.fn().mockResolvedValue({ _id: new mongoose.Types.ObjectId() })
    const deleteMany = vi.fn()
    const database = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'unrelated_records' }] })),
      collection: vi.fn(() => ({ findOne, countDocuments: async () => 1, deleteMany })),
    }
    await expect(assertEmptyValidationDatabase(database)).rejects.toThrow('existing records')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('accepts empty existing collections without deleting or creating anything', async () => {
    const findOne = vi.fn().mockResolvedValue(null)
    const database = {
      listCollections: () => ({ toArray: async () => [{ name: 'sales' }, { name: '__sales_transaction_probe' }] }),
      collection: () => ({ findOne }),
    }
    await expect(assertEmptyValidationDatabase(database)).resolves.toBeUndefined()
    expect(findOne).toHaveBeenCalledTimes(2)
  })
})

describe('upsert fixture ownership', () => {
  function fakeModel() {
    return {
      modelName: 'NotificationSettings',
      collection: {
        insertOne: vi.fn(), insertMany: vi.fn(), updateOne: vi.fn(), findOneAndUpdate: vi.fn(),
        bulkWrite: vi.fn(), updateMany: vi.fn(), replaceOne: vi.fn(), findOneAndReplace: vi.fn(),
      },
    }
  }

  it('records updateOne inserts but never matched rows, forwarding the session and result', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const insertedId = new mongoose.Types.ObjectId()
    const session = { offline: true }
    const options = { upsert: true, session }
    const inserted = { acknowledged: true, upsertedCount: 1, upsertedId: insertedId }
    const matched = { acknowledged: true, upsertedCount: 0, upsertedId: null, matchedCount: 1 }
    model.collection.updateOne.mockResolvedValueOnce(inserted).mockResolvedValueOnce(matched)
    const original = model.collection.updateOne
    trackFixtureInsertions([model], ownership, () => {})
    expect(await model.collection.updateOne({ user: 1 }, { $set: { enabled: true } }, options)).toBe(inserted)
    expect(await model.collection.updateOne({ user: 1 }, { $set: { enabled: false } }, options)).toBe(matched)
    expect(original).toHaveBeenCalledWith({ user: 1 }, { $set: { enabled: true } }, options)
    expect(original.mock.contexts[0]).toBe(model.collection)
    expect(ownership.deletionFilter(model.modelName)).toEqual({ _id: { $in: [insertedId] } })
  })

  it('uses findOneAndUpdate metadata to distinguish insert from match and preserves caller shape', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const insertedId = new mongoose.Types.ObjectId()
    const session = { offline: true }
    const options = { upsert: true, session }
    const inserted = { value: { _id: insertedId }, lastErrorObject: { updatedExisting: false, upserted: insertedId } }
    const matched = { value: { _id: insertedId }, lastErrorObject: { updatedExisting: true } }
    model.collection.findOneAndUpdate.mockResolvedValueOnce(inserted).mockResolvedValueOnce(matched)
    const original = model.collection.findOneAndUpdate
    trackFixtureInsertions([model], ownership, () => {})
    expect(await model.collection.findOneAndUpdate({ user: 1 }, { $set: { enabled: true } }, options)).toBe(inserted.value)
    expect(await model.collection.findOneAndUpdate({ user: 1 }, { $set: { enabled: false } }, { ...options, includeResultMetadata: true })).toBe(matched)
    expect(original.mock.calls[0][2]).toEqual({ ...options, includeResultMetadata: true })
    expect(options).toEqual({ upsert: true, session })
    expect(ownership.deletionFilter(model.modelName)).toEqual({ _id: { $in: [insertedId] } })
  })

  it('maps multiple bulk upserts and inserts to the originating operations', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const ids = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId())
    const operations = [
      { updateOne: { filter: { user: 1 }, update: { $set: { enabled: true } }, upsert: true } },
      { updateOne: { filter: { user: 2 }, update: { $set: { enabled: true } }, upsert: true } },
      { insertOne: { document: { _id: ids[2] } } },
      { replaceOne: { filter: { user: 3 }, replacement: { user: 3 }, upsert: true } },
    ]
    const result = { ok: 1, insertedCount: 1, insertedIds: { 2: ids[2] }, upsertedCount: 2, upsertedIds: { 0: ids[0], 3: ids[1] } }
    model.collection.bulkWrite.mockResolvedValue(result)
    const original = model.collection.bulkWrite
    const options = { session: { offline: true }, ordered: false }
    trackFixtureInsertions([model], ownership, () => {})
    expect(await model.collection.bulkWrite(operations, options)).toBe(result)
    expect(original).toHaveBeenCalledWith(operations, options)
    expect(ownership.deletionFilter(model.modelName)._id.$in.map(String).sort()).toEqual(ids.map(String).sort())
  })

  it('records completed bulk writes from a driver partial-write error and rethrows it', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    const error = Object.assign(new Error('partial write'), {
      name: 'MongoBulkWriteError', result: { ok: 1, insertedCount: 0, insertedIds: {}, upsertedCount: 1, upsertedIds: { 0: id } },
    })
    model.collection.bulkWrite.mockRejectedValue(error)
    trackFixtureInsertions([model], ownership, () => {})
    await expect(model.collection.bulkWrite([{ updateOne: { upsert: true } }])).rejects.toBe(error)
    expect(ownership.deletionFilter(model.modelName)._id.$in).toEqual([id])
    expect(ownership.uncertain).toBe(false)
  })

  it('records acknowledged insertMany IDs from a driver partial-write error', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    const error = Object.assign(new Error('partial insert'), {
      name: 'MongoBulkWriteError', result: { ok: 1, insertedCount: 1, insertedIds: { 0: id }, upsertedCount: 0, upsertedIds: {} },
    })
    model.collection.insertMany.mockRejectedValue(error)
    trackFixtureInsertions([model], ownership, () => {})
    await expect(model.collection.insertMany([{ _id: id }, { _id: new mongoose.Types.ObjectId() }])).rejects.toBe(error)
    expect(ownership.deletionFilter(model.modelName)._id.$in).toEqual([id])
    expect(ownership.uncertain).toBe(false)
  })

  it('fails closed for missing IDs, ambiguous metadata and unsupported upsert APIs', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    model.collection.updateOne.mockResolvedValue({ acknowledged: true, upsertedCount: 1 })
    model.collection.findOneAndUpdate.mockResolvedValue({ value: { _id: new mongoose.Types.ObjectId() } })
    model.collection.bulkWrite.mockResolvedValue({ ok: 1, insertedCount: 0, insertedIds: {}, upsertedCount: 1, upsertedIds: {} })
    const updateMany = model.collection.updateMany
    const replaceOne = model.collection.replaceOne
    const findOneAndReplace = model.collection.findOneAndReplace
    trackFixtureInsertions([model], ownership, () => {})
    await expect(model.collection.updateOne({}, {}, { upsert: true })).rejects.toThrow('inserted ID')
    await expect(model.collection.findOneAndUpdate({}, {}, { upsert: true })).rejects.toThrow('metadata is ambiguous')
    await expect(model.collection.bulkWrite([{ updateOne: { upsert: true } }])).rejects.toThrow('count is ambiguous')
    await expect(model.collection.updateMany({}, {}, { upsert: true })).rejects.toThrow('unsupported')
    await expect(model.collection.replaceOne({}, {}, { upsert: true })).rejects.toThrow('unsupported')
    await expect(model.collection.findOneAndReplace({}, {}, { upsert: true })).rejects.toThrow('unsupported')
    await expect(model.collection.updateOne({}, {}, { upsert: true, writeConcern: { w: 0 } })).rejects.toThrow('Unacknowledged')
    expect(updateMany).not.toHaveBeenCalled()
    expect(replaceOne).not.toHaveBeenCalled()
    expect(findOneAndReplace).not.toHaveBeenCalled()
    expect(ownership.deletionFilter(model.modelName)).toBeNull()
  })

  it('keeps ownership uncertainty after a caught upsert error and later successful write', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const knownId = new mongoose.Types.ObjectId()
    model.collection.updateOne
      .mockResolvedValueOnce({ acknowledged: true, upsertedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: true, upsertedCount: 1, upsertedId: knownId })
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.updateOne({}, {}, { upsert: true })).rejects.toThrow('valid inserted ID')
    expect(ownership.uncertain).toBe(true)
    await model.collection.updateOne({}, {}, { upsert: true })
    expect(ownership.deletionFilter(model.modelName)._id.$in).toEqual([knownId])
    expect(() => ownership.assertCertain()).toThrow('validation lease retained')
  })

  it('retains known bulk IDs when an acknowledged partial result omits another ID', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    const operations = [
      { insertOne: { document: { _id: ids[0] } } },
      { updateOne: { upsert: true } },
      { updateOne: { upsert: true } },
    ]
    const error = Object.assign(new Error('partial bulk write'), {
      name: 'MongoBulkWriteError',
      result: { ok: 1, insertedCount: 1, insertedIds: { 0: ids[0] }, upsertedCount: 2, upsertedIds: { 1: ids[1] } },
    })
    model.collection.bulkWrite.mockRejectedValue(error)
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.bulkWrite(operations)).rejects.toBe(error)
    expect(ownership.deletionFilter(model.modelName)._id.$in).toEqual(ids)
    expect(ownership.uncertain).toBe(true)
  })

  it('marks incomplete successful insertMany results while retaining returned IDs', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    model.collection.insertMany.mockResolvedValue({ acknowledged: true, insertedCount: 2, insertedIds: { 0: id } })
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.insertMany([{ _id: id }, { _id: new mongoose.Types.ObjectId() }]))
      .rejects.toThrow('count is ambiguous')
    expect(ownership.deletionFilter(model.modelName)._id.$in).toEqual([id])
    expect(ownership.uncertain).toBe(true)
  })

  it('marks missing findOneAndUpdate metadata as uncertain', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    model.collection.findOneAndUpdate.mockResolvedValue({ value: { _id: new mongoose.Types.ObjectId() } })
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.findOneAndUpdate({}, {}, { upsert: true })).rejects.toThrow('metadata is ambiguous')
    expect(ownership.uncertain).toBe(true)
  })

  it('marks a partial bulk-write error without a result as uncertain', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const error = Object.assign(new Error('partial write without IDs'), { name: 'MongoBulkWriteError' })
    model.collection.bulkWrite.mockRejectedValue(error)
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.bulkWrite([{ updateOne: { upsert: true } }])).rejects.toBe(error)
    expect(ownership.uncertain).toBe(true)
  })

  it('marks write-result uncertainty but not definite rejection or pre-write blocking', async () => {
    const model = fakeModel()
    const ownership = createFixtureOwnership()
    const duplicate = Object.assign(new Error('Duplicate key'), { code: 11000 })
    model.collection.insertOne.mockRejectedValueOnce(duplicate)
      .mockRejectedValueOnce(Object.assign(new Error('Connection lost'), { name: 'MongoNetworkError' }))
    trackFixtureInsertions([model], ownership, () => {})

    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toBe(duplicate)
    await expect(model.collection.updateMany({}, {}, { upsert: true })).rejects.toThrow('unsupported')
    expect(ownership.uncertain).toBe(false)
    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow('Connection lost')
    expect(ownership.uncertain).toBe(true)
  })

  it('intercepts model-level updateOne, findOneAndUpdate and bulkWrite calls offline', async () => {
    const isolated = new mongoose.Mongoose()
    const schema = new isolated.Schema({ user: String, enabled: Boolean }, { autoCreate: false, autoIndex: false })
    const Model = isolated.model('OfflineUpsert', schema)
    const ownership = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    const update = vi.spyOn(Model.collection, 'updateOne').mockResolvedValue({ acknowledged: true, upsertedCount: 1, upsertedId: id })
    const find = vi.spyOn(Model.collection, 'findOneAndUpdate').mockResolvedValue({ value: { _id: id, user: 'a' }, lastErrorObject: { updatedExisting: true } })
    const bulk = vi.spyOn(Model.collection, 'bulkWrite').mockResolvedValue({ ok: 1, insertedCount: 0, insertedIds: {}, upsertedCount: 0, upsertedIds: {} })
    const stop = trackFixtureInsertions([Model], ownership, () => {})
    try {
      await Model.updateOne({ user: 'a' }, { $set: { enabled: true } }, { upsert: true })
      await Model.findOneAndUpdate({ user: 'a' }, { $set: { enabled: false } }, { upsert: true, returnDocument: 'after' })
      await Model.bulkWrite([{ updateOne: { filter: { user: 'a' }, update: { $set: { enabled: true } }, upsert: true } }])
      expect(update).toHaveBeenCalledTimes(1)
      expect(find.mock.calls[0][2].includeResultMetadata).toBe(true)
      expect(bulk).toHaveBeenCalledTimes(1)
      expect(ownership.deletionFilter('OfflineUpsert')._id.$in).toEqual([id])
    } finally {
      stop()
    }
  })
})

describe('exclusive validation lease', () => {
  function fakeDatabase() {
    const rows = new Map()
    const leaseCollection = {
      insertOne: vi.fn(async document => {
        if (rows.has(document._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
        rows.set(document._id, document)
        return { acknowledged: true, insertedId: document._id }
      }),
      deleteOne: vi.fn(async filter => {
        const row = rows.get(filter._id)
        if (row?.runId !== filter.runId || row.databaseName !== filter.databaseName) return { acknowledged: true, deletedCount: 0 }
        rows.delete(filter._id)
        return { acknowledged: true, deletedCount: 1 }
      }),
      findOne: vi.fn(async filter => filter._id?.$ne ? null : rows.get(filter._id ?? 'exclusive_run') ?? null),
      countDocuments: vi.fn(async () => rows.size),
    }
    return {
      databaseName, rows, leaseCollection,
      listCollections: () => ({ toArray: async () => rows.size ? [{ name: '__sales_integration_lease' }] : [] }),
      collection: () => leaseCollection,
    }
  }

  it('permits one competing runner and rejects the second before fixture writes', async () => {
    const database = fakeDatabase()
    const uri = DEFAULT_TEST_MONGODB_URI
    const owners = [createFixtureOwnership(), createFixtureOwnership()]
    const attempts = await Promise.allSettled(owners.map(async owner => {
      await assertEmptyValidationDatabase(database)
      return acquireValidationLease(database, uri, owner, authorizedEnvironment())
    }))
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(attempts.find(attempt => attempt.status === 'rejected').reason.message).toContain('already leased')
    expect(database.rows.size).toBe(1)
    await expect(assertEmptyValidationDatabase(database)).rejects.toThrow('existing records')
    const winner = attempts.findIndex(attempt => attempt.status === 'fulfilled')
    await verifyAndReleaseValidationLease(database, attempts[winner].value, owners[winner])
    expect(database.rows.size).toBe(0)
  })

  it('releases only the bound owner even if the lease descriptor changes', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    const originalRunId = lease.runId
    lease.runId = createFixtureOwnership().runId
    await lease.release()
    expect(database.rows.size).toBe(0)
    expect(database.leaseCollection.deleteOne.mock.calls[0][0]).toEqual({ _id: 'exclusive_run', databaseName, runId: originalRunId })
    await expect(lease.release()).rejects.toThrow('already been released')
  })

  it('does not release a lease whose stored owner has changed', async () => {
    const database = fakeDatabase()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, createFixtureOwnership(), authorizedEnvironment())
    database.rows.get('exclusive_run').runId = createFixtureOwnership().runId
    await expect(lease.release()).rejects.toThrow('did not match its owner')
    expect(database.rows.size).toBe(1)
  })

  it('blocks direct lease release after ownership becomes uncertain', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    ownership.markUncertain()
    await expect(lease.release()).rejects.toThrow('validation lease retained')
    expect(database.leaseCollection.deleteOne).not.toHaveBeenCalled()
    expect(database.rows.size).toBe(1)
  })

  it('rejects invalid lease ownership before writing', async () => {
    const database = fakeDatabase()
    await expect(acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, { runId: 'shared' }, authorizedEnvironment()))
      .rejects.toThrow('run UUID')
    expect(database.leaseCollection.insertOne).not.toHaveBeenCalled()
  })

  it('reports residual collection counts without deleting documents or releasing the lease', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    const ownedId = new mongoose.Types.ObjectId()
    ownership.record('Sale', [ownedId])
    const model = { modelName: 'Sale', deleteMany: vi.fn().mockResolvedValue({ acknowledged: true }) }
    for (const operation of ownedFixtureCleanupOperations([model], ownership, () => {})) await operation()
    expect(model.deleteMany).toHaveBeenCalledWith({ _id: { $in: [ownedId] } })
    const unrelated = { findOne: vi.fn().mockResolvedValue({ _id: new mongoose.Types.ObjectId() }), countDocuments: vi.fn().mockResolvedValue(2), deleteMany: vi.fn() }
    database.listCollections = () => ({ toArray: async () => [{ name: '__sales_integration_lease' }, { name: 'unexpected_rows' }] })
    database.collection = name => name === '__sales_integration_lease' ? database.leaseCollection : unrelated
    await expect(verifyAndReleaseValidationLease(database, lease, ownership)).rejects.toThrow('unexpected_rows: 2')
    expect(unrelated.deleteMany).not.toHaveBeenCalled()
    expect(database.leaseCollection.deleteOne).not.toHaveBeenCalled()
  })

  it('keeps the lease after a caught ownership error while teardown drains, cleans and disconnects', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    const knownId = new mongoose.Types.ObjectId()
    const model = {
      modelName: 'Sale',
      collection: { insertOne: vi.fn().mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({ acknowledged: true, insertedId: knownId }) },
      deleteMany: vi.fn().mockResolvedValue({ acknowledged: true }),
    }
    const stopTracking = trackFixtureInsertions([model], ownership, () => {})
    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow('valid inserted ID')
    await model.collection.insertOne({ _id: knownId })
    expect(ownership.uncertain).toBe(true)

    const lifecycle = createIntegrationLifecycle()
    const pending = lifecycle.begin('unfinished callback')
    const order = []
    const cleanup = vi.fn(async () => {
      order.push('cleanup')
      for (const operation of ownedFixtureCleanupOperations([model], ownership, () => {})) await operation()
    })
    const disconnect = vi.fn(async () => { order.push('disconnect') })
    const teardown = teardownIntegrationRun({
      lifecycle,
      shutdownHttp: async () => { order.push('HTTP shutdown') },
      cleanup,
      database: () => database,
      lease,
      ownership,
      authorize: () => {},
      disconnect,
      stopTracking,
    })
    await Promise.resolve()
    expect(cleanup).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    pending.complete()

    await expect(teardown).rejects.toThrow('validation lease retained')
    expect(order).toEqual(['HTTP shutdown', 'cleanup', 'disconnect'])
    expect(model.deleteMany).toHaveBeenCalledWith({ _id: { $in: [knownId] } })
    expect(ownership.deletionFilter('Sale')).toBeNull()
    expect(ownership.uncertain).toBe(true)
    expect(database.leaseCollection.findOne).toHaveBeenCalledWith({ _id: 'exclusive_run' }, expect.any(Object))
    expect(database.leaseCollection.deleteOne).not.toHaveBeenCalled()
    expect(database.rows.size).toBe(1)
    expect(lease.active).toBe(true)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('releases the lease and disconnects after normal teardown', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    const lifecycle = createIntegrationLifecycle()
    const disconnect = vi.fn()
    await teardownIntegrationRun({
      lifecycle, shutdownHttp: async () => {}, cleanup: async () => {}, database: () => database,
      lease, ownership, authorize: () => {}, disconnect, stopTracking: () => {},
    })
    expect(database.rows.size).toBe(0)
    expect(lease.active).toBe(false)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not disconnect or release while lifecycle work remains unresolved', async () => {
    const database = fakeDatabase()
    const ownership = createFixtureOwnership()
    const lease = await acquireValidationLease(database, DEFAULT_TEST_MONGODB_URI, ownership, authorizedEnvironment())
    const lifecycle = { drainAndGuard: vi.fn().mockRejectedValue(new Error('Unresolved lifecycle work')) }
    const disconnect = vi.fn()
    await expect(teardownIntegrationRun({
      lifecycle, shutdownHttp: async () => {}, cleanup: async () => {}, database: () => database,
      lease, ownership, authorize: () => {}, disconnect, stopTracking: () => {},
    })).rejects.toThrow('Unresolved lifecycle work')
    expect(disconnect).not.toHaveBeenCalled()
    expect(database.leaseCollection.deleteOne).not.toHaveBeenCalled()
    expect(database.rows.size).toBe(1)
  })
})

describe('owned fixture cleanup', () => {
  const modelNames = ['Shop', 'User', 'Customer', 'Item', 'Sale', 'CustomerLedgerTransaction', 'Notification', 'NotificationRead', 'NotificationSettings']

  function modelWithDocuments(modelName, existing = []) {
    const documents = new Map(existing.map(document => [String(document._id), document]))
    return {
      modelName,
      documents,
      collection: {
        insertOne: vi.fn(async document => {
          documents.set(String(document._id), document)
          return { acknowledged: true, insertedId: document._id }
        }),
        insertMany: vi.fn(async entries => {
          const insertedIds = {}
          entries.forEach((document, index) => {
            documents.set(String(document._id), document)
            insertedIds[index] = document._id
          })
          return { acknowledged: true, insertedCount: entries.length, insertedIds }
        }),
      },
      deleteMany: vi.fn(async filter => {
        for (const id of filter._id.$in) documents.delete(String(id))
        return { acknowledged: true }
      }),
    }
  }

  it.each(modelNames)('deletes only acknowledged current-run %s IDs, preserving unrelated records', async modelName => {
    const unrelated = { _id: new mongoose.Types.ObjectId() }
    const owned = { _id: new mongoose.Types.ObjectId() }
    const model = modelWithDocuments(modelName, [unrelated])
    const ownership = createFixtureOwnership()
    const authorize = vi.fn()
    const originalInsert = model.collection.insertOne
    const stop = trackFixtureInsertions([model], ownership, authorize)
    await model.collection.insertOne(owned)
    const operations = ownedFixtureCleanupOperations([model], ownership, authorize)
    await Promise.all(operations.map(operation => operation()))
    expect(model.deleteMany).toHaveBeenCalledWith({ _id: { $in: [owned._id] } })
    expect([...model.documents.values()]).toEqual([unrelated])
    expect(ownership.deletionFilter(modelName)).toBeNull()
    stop()
    expect(model.collection.insertOne).toBe(originalInsert)
  })

  it('does not delete from a collection with no recorded ownership', () => {
    const model = modelWithDocuments('NotificationSettings')
    expect(ownedFixtureCleanupOperations([model], createFixtureOwnership(), () => {})).toEqual([])
    expect(model.deleteMany).not.toHaveBeenCalled()
  })

  it('records acknowledged batch inserts by their returned IDs', async () => {
    const model = modelWithDocuments('Sale')
    const ownership = createFixtureOwnership()
    trackFixtureInsertions([model], ownership, () => {})
    const documents = [{ _id: new mongoose.Types.ObjectId() }, { _id: new mongoose.Types.ObjectId() }]
    await model.collection.insertMany(documents)
    expect(ownership.deletionFilter('Sale')).toEqual({ _id: { $in: documents.map(document => document._id) } })
  })

  it('forwards insertion context, document, session options and result unchanged', async () => {
    const model = modelWithDocuments('CustomerLedgerTransaction')
    const document = { _id: new mongoose.Types.ObjectId() }
    const options = { session: { testSession: true } }
    const result = { acknowledged: true, insertedId: document._id }
    const original = model.collection.insertOne.mockResolvedValue(result)
    const track = vi.fn((label, operation) => operation())
    trackFixtureInsertions([model], createFixtureOwnership(), () => {}, track)
    expect(await model.collection.insertOne(document, options)).toBe(result)
    expect(original).toHaveBeenCalledWith(document, options)
    expect(original.mock.contexts[0]).toBe(model.collection)
    expect(track).toHaveBeenCalledWith('fixture insert: CustomerLedgerTransaction.insertOne', expect.any(Function))
  })

  it('distinguishes a definite rejection from an unacknowledged insert result', async () => {
    const model = modelWithDocuments('Sale')
    const ownership = createFixtureOwnership()
    model.collection.insertOne.mockRejectedValueOnce(new Error('Insert failed')).mockResolvedValueOnce({ acknowledged: false })
    trackFixtureInsertions([model], ownership, () => {})
    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow('Insert failed')
    expect(ownership.uncertain).toBe(false)
    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow('not acknowledged')
    expect(ownership.uncertain).toBe(true)
    expect(ownership.deletionFilter('Sale')).toBeNull()
  })

  it('retains ownership after failed or unacknowledged deletion', async () => {
    const model = modelWithDocuments('Item')
    const ownership = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    ownership.record('Item', [id])
    model.deleteMany.mockRejectedValueOnce(new Error('Deletion failed')).mockResolvedValueOnce({ acknowledged: false })
    for (const expectedError of ['Deletion failed', 'not acknowledged']) {
      const [operation] = ownedFixtureCleanupOperations([model], ownership, () => {})
      await expect(operation()).rejects.toThrow(expectedError)
      expect(ownership.deletionFilter('Item')).toEqual({ _id: { $in: [id] } })
    }
  })

  it('rejects insertion and cleanup when authorization is missing', async () => {
    const model = modelWithDocuments('Shop')
    const ownership = createFixtureOwnership()
    const authorize = () => { throw new Error('Write authorization missing') }
    const insert = model.collection.insertOne
    trackFixtureInsertions([model], ownership, authorize)
    await expect(model.collection.insertOne({ _id: new mongoose.Types.ObjectId() })).rejects.toThrow('authorization missing')
    expect(insert).not.toHaveBeenCalled()
    expect(() => ownedFixtureCleanupOperations([model], ownership, authorize)).toThrow('authorization missing')
    expect(model.deleteMany).not.toHaveBeenCalled()
  })

  it('rechecks authorization when a prepared cleanup operation executes', async () => {
    const model = modelWithDocuments('Customer')
    const ownership = createFixtureOwnership()
    ownership.record('Customer', [new mongoose.Types.ObjectId()])
    const authorize = vi.fn()
    const [operation] = ownedFixtureCleanupOperations([model], ownership, authorize)
    authorize.mockImplementation(() => { throw new Error('Authorization revoked') })
    await expect(operation()).rejects.toThrow('Authorization revoked')
    expect(model.deleteMany).not.toHaveBeenCalled()
  })

  it('keeps ownership separate for distinct runs and rejects invalid IDs', () => {
    const first = createFixtureOwnership()
    const second = createFixtureOwnership()
    const id = new mongoose.Types.ObjectId()
    first.record('Sale', [id])
    expect(first.runId).not.toBe(second.runId)
    expect(second.deletionFilter('Sale')).toBeNull()
    expect(() => first.record('Sale', ['invalid'])).toThrow('valid inserted document IDs')
  })
})

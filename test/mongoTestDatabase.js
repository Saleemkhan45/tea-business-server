import { randomUUID } from 'node:crypto'
import { ConnectionString } from 'mongodb-connection-string-url'
import mongoose from 'mongoose'
import { redactDatabaseMessage } from '../utils/databaseDiagnostics.js'

export const DEFAULT_TEST_MONGODB_URI =
  'mongodb://127.0.0.1:27018/tea_business_dashboard_phase10_test?replicaSet=sales-test-rs&directConnection=true'
const LEASE_COLLECTION = '__sales_integration_lease'
const LEASE_ID = 'exclusive_run'

export function assertTestDatabaseName(name) {
  if (['admin', 'local', 'config', 'test'].includes(name)) {
    throw new Error('Integration tests require a dedicated validation database, not a system database.')
  }
  if (!/^tea_business_dashboard_(?:[a-z0-9]+_)*test$/.test(name)) {
    throw new Error('Integration tests require a dedicated tea_business_dashboard_*_test database.')
  }
}

function parseDatabaseTarget(uri, label) {
  let parsed
  let databaseName
  let writeConcern
  try {
    parsed = new ConnectionString(uri)
    databaseName = decodeURIComponent(parsed.pathname.slice(1))
    const driverOptions = new mongoose.mongo.MongoClient(uri).options
    const driverDatabaseName = driverOptions.dbName
    writeConcern = driverOptions.writeConcern
    if (databaseName && databaseName !== driverDatabaseName) throw new Error()
  } catch {
    throw new Error(`${label} must be a valid MongoDB URI with an unambiguous database target.`)
  }
  if (!databaseName) throw new Error(`${label} must contain an explicit database name.`)
  return { databaseName, hosts: parsed.hosts.map(host => host.toLowerCase()).sort(), writeConcern }
}

export function getTestMongoUri(environment = process.env) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Integration tests cannot run with NODE_ENV=production.')
  }
  if (environment.SALES_INTEGRATION_ALLOW_WRITES !== 'true') {
    throw new Error('Integration test writes require SALES_INTEGRATION_ALLOW_WRITES=true.')
  }
  const uri = environment.SALES_INTEGRATION_MONGODB_URI?.trim()
  if (!uri) throw new Error('An explicit SALES_INTEGRATION_MONGODB_URI is required; there is no fallback.')
  const { databaseName, hosts, writeConcern } = parseDatabaseTarget(uri, 'Integration URI')
  assertTestDatabaseName(databaseName)
  if (writeConcern?.w === 0) throw new Error('Integration tests require acknowledged writes.')

  const approvedDatabase = environment.SALES_INTEGRATION_APPROVED_DATABASE
  if (!approvedDatabase) throw new Error('SALES_INTEGRATION_APPROVED_DATABASE is required.')
  assertTestDatabaseName(approvedDatabase)
  if (databaseName !== approvedDatabase) throw new Error('Integration database does not match the approved validation target.')

  const approvedHosts = environment.SALES_INTEGRATION_APPROVED_HOSTS?.split(',').map(host => host.trim().toLowerCase()).sort()
  if (!approvedHosts?.length || approvedHosts.some(host => !host)
    || new Set(approvedHosts).size !== approvedHosts.length) {
    throw new Error('SALES_INTEGRATION_APPROVED_HOSTS must explicitly list the approved validation hosts.')
  }
  if (hosts.length !== approvedHosts.length || hosts.some((host, index) => host !== approvedHosts[index])) {
    throw new Error('Integration hosts do not match the approved validation target.')
  }

  const applicationUri = environment.MONGODB_URI?.trim()
  if (!applicationUri) throw new Error('MONGODB_URI is required to exclude the application database.')
  const applicationDatabase = parseDatabaseTarget(applicationUri, 'Application URI').databaseName
  if (databaseName === applicationDatabase) throw new Error('Integration tests cannot use the application database name.')
  return uri
}

export function assertTestWriteAuthorization(uri, databaseName, environment = process.env) {
  if (uri !== getTestMongoUri(environment)) throw new Error('Integration URI does not match the authorized configuration.')
  const approvedDatabase = environment.SALES_INTEGRATION_APPROVED_DATABASE
  if (databaseName !== undefined && databaseName !== approvedDatabase) {
    throw new Error('Connected database does not match the approved validation target.')
  }
  return approvedDatabase
}

export async function assertEmptyValidationDatabase(database, lease) {
  const collections = await database.listCollections({}, { nameOnly: true }).toArray()
  if (lease) {
    if (database.databaseName !== lease.databaseName || !lease.active) {
      throw new Error('Validation lease does not belong to the connected database.')
    }
    const owner = await database.collection(LEASE_COLLECTION).findOne({ _id: LEASE_ID }, { projection: { runId: 1, databaseName: 1 } })
    if (owner?.runId !== lease.runId || owner.databaseName !== lease.databaseName) {
      throw new Error('Validation lease ownership is missing or has changed.')
    }
  }
  const residual = []
  for (const { name } of collections) {
    const filter = lease && name === LEASE_COLLECTION ? { _id: { $ne: LEASE_ID } } : {}
    const collection = database.collection(name)
    if (await collection.findOne(filter, { projection: { _id: 1 } })) {
      residual.push(`${name}: ${await collection.countDocuments(filter)}`)
    }
  }
  if (residual.length) throw new Error(`Validation database contains existing records (${residual.join(', ')}); automatic deletion is refused.`)
}

export async function verifyAndReleaseValidationLease(database, lease, ownership) {
  await assertEmptyValidationDatabase(database, lease)
  if (ownership?.runId !== lease.runId || typeof ownership.assertCertain !== 'function') {
    throw new Error('Fixture ownership does not match the validation lease; manual review is required.')
  }
  ownership.assertCertain()
  await lease.release()
}

export async function teardownIntegrationRun({
  lifecycle, shutdownHttp, cleanup, database, lease, ownership, authorize, disconnect, stopTracking,
}) {
  let drained = false
  let failure
  try {
    await lifecycle.drainAndGuard('afterAll HTTP shutdown', 5000)
    await shutdownHttp()
    await cleanup()
    await lifecycle.drainAndGuard('MongoDB disconnection', 5000)
    drained = true
    if (lease?.active) {
      authorize()
      await verifyAndReleaseValidationLease(database(), lease, ownership)
    }
  } catch (error) {
    failure = error
  } finally {
    if (!drained) {
      try {
        await lifecycle.drainAndGuard('MongoDB disconnection after teardown failure', 5000)
        drained = true
      } catch {
        // Retain the connection while active work has not quiesced.
      }
    }
    if (drained) {
      try {
        await disconnect()
      } catch (error) {
        failure ??= error
      } finally {
        try {
          stopTracking()
        } catch (error) {
          failure ??= error
        }
      }
    }
  }
  if (failure) throw failure
}

export async function acquireValidationLease(database, uri, ownership, environment = process.env) {
  const databaseName = assertTestWriteAuthorization(uri, database.databaseName, environment)
  if (typeof ownership?.runId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownership.runId)) {
    throw new Error('A unique fixture run UUID is required for the validation lease.')
  }
  const collection = database.collection(LEASE_COLLECTION)
  let result
  try {
    result = await collection.insertOne({ _id: LEASE_ID, databaseName, runId: ownership.runId, acquiredAt: new Date() })
  } catch (error) {
    if (error?.code === 11000) throw new Error('Validation database is already leased by another run.')
    throw error
  }
  if (result?.acknowledged !== true || result.insertedId !== LEASE_ID) {
    throw new Error('Validation lease acquisition was not acknowledged; administrator review is required.')
  }
  const runId = ownership.runId
  const lease = { databaseName, runId, active: true }
  lease.release = async () => {
    if (!lease.active) throw new Error('Validation lease has already been released.')
    assertTestWriteAuthorization(uri, database.databaseName, environment)
    ownership.assertCertain()
    const deletion = await collection.deleteOne({ _id: LEASE_ID, databaseName, runId })
    if (deletion?.acknowledged !== true || deletion.deletedCount !== 1) {
      throw new Error('Validation lease release did not match its owner; administrator review is required.')
    }
    lease.active = false
  }
  return lease
}

export async function connectTestDatabase(uri, environment = process.env, ownership = createFixtureOwnership()) {
  assertTestWriteAuthorization(uri, undefined, environment)
  try {
    // Check existing data before any automatic collection/index initialization.
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false })
    const database = mongoose.connection.db
    const authorize = () => assertTestWriteAuthorization(uri, database.databaseName, environment)
    authorize()
    await assertEmptyValidationDatabase(database)
    const hello = await database.admin().command({ hello: 1 })
    if (!hello.setName || !hello.isWritablePrimary) {
      throw new Error('Integration tests require a writable MongoDB replica set.')
    }
    const lease = await acquireValidationLease(database, uri, ownership, environment)

    const probe = database.collection('__sales_transaction_probe')
    const session = await mongoose.startSession()
    const id = new mongoose.Types.ObjectId()
    try {
      await session.withTransaction(async () => {
        authorize()
        await probe.insertOne({ _id: id }, { session })
      })
      if (!await probe.findOne({ _id: id })) throw new Error('MongoDB transaction probe did not commit.')
    } finally {
      try {
        await session.endSession()
      } finally {
        authorize()
        await probe.deleteOne({ _id: id })
      }
    }

    const { version } = await database.admin().command({ buildInfo: 1 })
    console.info(`MongoDB ${version}; replica set ${hello.setName}; database ${database.databaseName}; transaction probe committed.`)
    return lease
  } catch (error) {
    // Do not retain the original error/cause, which may carry the private URI.
    throw new Error(redactDatabaseMessage(error?.message, uri))
  }
}

export function createFixtureOwnership() {
  const records = new Map()
  let uncertain = false
  return {
    runId: randomUUID(),
    get uncertain() { return uncertain },
    markUncertain() { uncertain = true },
    assertCertain() {
      if (uncertain) throw new Error('Fixture ownership is uncertain; validation lease retained for manual review.')
    },
    record(modelName, ids) {
      if (!modelName || !ids.every(id => mongoose.isValidObjectId(id))) {
        throw new Error('Fixture ownership requires a model name and valid inserted document IDs.')
      }
      const owned = records.get(modelName) ?? new Map()
      for (const id of ids) owned.set(String(id), id)
      records.set(modelName, owned)
    },
    deletionFilter(modelName) {
      const ids = [...(records.get(modelName)?.values() ?? [])]
      return ids.length ? { _id: { $in: ids } } : null
    },
    forget(modelName, ids) {
      for (const id of ids) records.get(modelName)?.delete(String(id))
    },
  }
}

function throwUncertain(ownership, message) {
  ownership.markUncertain()
  throw new Error(message)
}

function requireOwnedId(id, operation, ownership) {
  if (!mongoose.isValidObjectId(id)) {
    throwUncertain(ownership, `${operation} did not return a valid inserted ID; fixture ownership is uncertain.`)
  }
  return id
}

function recordBulkResult(result, operations, ownership, modelName) {
  if (!Array.isArray(operations)) throwUncertain(ownership, 'Bulk write operations are ambiguous; fixture ownership is uncertain.')
  const inserted = Object.entries(result?.insertedIds ?? {})
  const upserted = Object.entries(result?.upsertedIds ?? {})
  const ids = []
  let invalidIndex = false
  let invalidId = false
  for (const [index, id] of inserted) {
    if (!/^(0|[1-9]\d*)$/.test(index) || operations[Number(index)]?.insertOne === undefined) {
      invalidIndex = true
    } else if (!mongoose.isValidObjectId(id)) {
      invalidId = true
    } else {
      ids.push(id)
    }
  }
  for (const [index, id] of upserted) {
    const operation = operations[Number(index)]
    if (!/^(0|[1-9]\d*)$/.test(index) || !operation ||
      !['updateOne', 'updateMany', 'replaceOne'].some(method => operation[method]?.upsert === true)) {
      invalidIndex = true
    } else if (!mongoose.isValidObjectId(id)) {
      invalidId = true
    } else {
      ids.push(id)
    }
  }
  if (ids.length) ownership.record(modelName, ids)
  const mayInsert = operations.some(operation => operation?.insertOne ||
    ['updateOne', 'updateMany', 'replaceOne'].some(method => operation?.[method]?.upsert === true))
  if (!mayInsert && !inserted.length && !upserted.length && !result?.insertedCount && !result?.upsertedCount) return
  if (invalidIndex) throwUncertain(ownership, 'Bulk write insert index is invalid; fixture ownership is uncertain.')
  if (invalidId) throwUncertain(ownership, 'Bulk write did not return a valid inserted ID; fixture ownership is uncertain.')
  if (inserted.length !== result?.insertedCount || upserted.length !== result?.upsertedCount) {
    throwUncertain(ownership, 'Bulk write inserted ID count is ambiguous; fixture ownership is uncertain.')
  }
  if (result?.ok !== 1) throwUncertain(ownership, 'Bulk write result is not acknowledged; fixture ownership is uncertain.')
}

function isIndeterminateWriteError(error) {
  return ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoWriteConcernError'].includes(error?.name)
}

export function trackFixtureInsertions(models, ownership, authorize, track = (label, operation) => operation()) {
  const restorations = []
  for (const model of models) {
    for (const method of ['insertOne', 'insertMany', 'updateOne', 'findOneAndUpdate', 'bulkWrite',
      'updateMany', 'replaceOne', 'findOneAndReplace']) {
      const original = model.collection[method]
      const wrapped = function (...args) {
        return track(`fixture insert: ${model.modelName}.${method}`, async () => {
          authorize()
          const options = method === 'bulkWrite' ? args[1] : method === 'insertOne' || method === 'insertMany' ? args[1] : args[2]
          const upsert = method === 'bulkWrite'
            ? args[0]?.some(operation => ['updateOne', 'updateMany', 'replaceOne'].some(key => operation[key]?.upsert === true))
            : options?.upsert === true
          const mayInsert = method === 'insertOne' || method === 'insertMany' || upsert ||
            (method === 'bulkWrite' && args[0]?.some(operation => operation?.insertOne !== undefined))
          if (options?.writeConcern?.w === 0 || options?.w === 0) {
            throw new Error('Unacknowledged fixture writes are unsupported in the validation harness.')
          }
          if (upsert && ['updateMany', 'replaceOne', 'findOneAndReplace'].includes(method)) {
            throw new Error(`${method} upserts are unsupported in the validation harness.`)
          }
          const callArgs = method === 'findOneAndUpdate' && upsert
            ? [args[0], args[1], { ...options, includeResultMetadata: true }]
            : args
          let result
          try {
            result = await original.apply(this, callArgs)
          } catch (error) {
            if (['bulkWrite', 'insertMany'].includes(method) && error?.name === 'MongoBulkWriteError' && error.result) {
              try {
                const operations = method === 'bulkWrite' ? args[0] : args[0].map(document => ({ insertOne: { document } }))
                recordBulkResult(error.result, operations, ownership, model.modelName)
              } catch {
                ownership.markUncertain()
              }
            } else if (mayInsert && (error?.name === 'MongoBulkWriteError' || isIndeterminateWriteError(error))) {
              ownership.markUncertain()
            }
            throw error
          }
          if (method === 'insertOne') {
            if (result?.acknowledged !== true) throwUncertain(ownership, 'Insert result is not acknowledged; fixture ownership is uncertain.')
            ownership.record(model.modelName, [requireOwnedId(result.insertedId, 'Insert', ownership)])
          } else if (method === 'insertMany') {
            recordBulkResult({
              ok: result?.acknowledged === true ? 1 : 0,
              insertedCount: result?.insertedCount,
              insertedIds: result?.insertedIds,
              upsertedCount: 0,
              upsertedIds: {},
            }, args[0].map(document => ({ insertOne: { document } })), ownership, model.modelName)
          } else if (method === 'updateOne' && upsert) {
            if (result?.acknowledged !== true || ![0, 1].includes(result.upsertedCount)) {
              throwUncertain(ownership, 'Update upsert result is ambiguous; fixture ownership is uncertain.')
            }
            if (result.upsertedCount === 1) ownership.record(model.modelName, [requireOwnedId(result.upsertedId, 'Update upsert', ownership)])
            else if (result.upsertedId != null) throwUncertain(ownership, 'Update upsert result is ambiguous; fixture ownership is uncertain.')
          } else if (method === 'findOneAndUpdate' && upsert) {
            const metadata = result?.lastErrorObject
            if (metadata?.updatedExisting === false) {
              ownership.record(model.modelName, [requireOwnedId(metadata.upserted, 'Find-and-update upsert', ownership)])
            } else if (metadata?.updatedExisting !== true || metadata.upserted != null) {
              throwUncertain(ownership, 'Find-and-update upsert metadata is ambiguous; fixture ownership is uncertain.')
            }
            return options?.includeResultMetadata === true ? result : result.value
          } else if (method === 'bulkWrite') {
            recordBulkResult(result, args[0], ownership, model.modelName)
          }
          return result
        })
      }
      model.collection[method] = wrapped
      restorations.push(() => { model.collection[method] = original })
    }
  }
  return () => restorations.forEach(restore => restore())
}

export function ownedFixtureCleanupOperations(models, ownership, authorize) {
  authorize()
  return models.flatMap(model => {
    const filter = ownership.deletionFilter(model.modelName)
    if (!filter) return []
    return [async () => {
      authorize()
      const result = await model.deleteMany(filter)
      if (result?.acknowledged !== true) throw new Error('Owned fixture deletion was not acknowledged; ownership is retained.')
      ownership.forget(model.modelName, filter._id.$in)
      return result
    }]
  })
}

import { manualCashIndexPlan } from './index-plan.js'
import { inspectIndexes } from './indexReadiness.js'
const safeNumber = field => ({ $convert: { input: `$${field}`, to: 'double', onError: -1, onNull: -1 } })
const validAmount = field => ({ $and: [{ $isNumber: `$${field}` }, { $gte: [safeNumber(field), 0] }, { $lte: [safeNumber(field), Number.MAX_SAFE_INTEGER] }, { $eq: [{ $mod: [safeNumber(field), 1] }, 0] }] })
function validDocument(collection) {
  const revision = collection === 'manualcashrevisions'
  const amounts = revision ? ['next.shopCashAmount', 'next.bossAddedAmount', 'next.totalCollected'] : ['shopCashAmount', 'bossAddedAmount', 'totalCollected']
  return { $and: [
    { $eq: [{ $type: '$shop' }, 'objectId'] }, { $eq: [{ $type: revision ? '$record' : '$enteredBy' }, 'objectId'] },
    { $eq: [{ $type: revision ? '$modifiedBy' : '$lastUpdatedBy' }, 'objectId'] }, validAmount('revision'),
    { $ne: [{ $dateFromString: { dateString: { $convert: { input: '$businessDate', to: 'string', onError: '', onNull: '' } }, format: '%Y-%m-%d', onError: null, onNull: null } }, null] },
    ...amounts.map(validAmount), { $eq: [safeNumber(amounts[2]), { $add: [safeNumber(amounts[0]), safeNumber(amounts[1])] }] },
    ...(revision ? [{ $in: ['$action', ['create', 'correct', 'void', 'replace']] }, { $eq: [{ $type: '$key' }, 'string'] }, { $eq: [{ $type: '$fingerprint' }, 'string'] }] : []),
  ] }
}
export async function inspectManualCashSetup(db) {
  const hello = await db.admin().command({ hello: 1 })
  const report = { database: db.databaseName, transactionCapable: Boolean(hello.setName || hello.msg === 'isdbgrid'), collections: [], blockers: [] }
  if (!report.transactionCapable) report.blockers.push('A transaction-capable replica set or mongos is required.')
  for (const plan of manualCashIndexPlan) {
    const metadata = (await db.listCollections({ name: plan.collection }, { nameOnly: false }).toArray())[0]
    const item = { name: plan.collection, exists: Boolean(metadata), missingIndexes: plan.indexes, documentCount: 0, invalidDocuments: 0, duplicateGroups: 0 }
    report.collections.push(item)
    if (!metadata) continue
    if (metadata.type !== 'collection' || metadata.options?.capped || metadata.options?.timeseries || metadata.options?.validator || metadata.options?.collation) report.blockers.push(`${plan.collection}: existing collection options require administrator review.`)
    const collection = db.collection(plan.collection)
    const indexes = inspectIndexes(await collection.listIndexes().toArray(), plan.indexes)
    item.missingIndexes = indexes.missing
    if (indexes.conflicts.length) report.blockers.push(`${plan.collection}: incompatible, additional unique, or TTL indexes require review; no index will be removed.`)
    item.documentCount = await collection.countDocuments({}, { maxTimeMS: 5000 })
    item.invalidDocuments = await collection.countDocuments({ $expr: { $not: [validDocument(plan.collection)] } }, { maxTimeMS: 5000 })
    for (const index of plan.indexes) {
      const groups = await collection.aggregate([{ $group: { _id: Object.fromEntries(Object.keys(index.key).map(key => [key, `$${key}`])), count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $count: 'groups' }], { maxTimeMS: 5000, allowDiskUse: false }).toArray()
      item.duplicateGroups += groups[0]?.groups ?? 0
    }
    if (item.invalidDocuments || item.duplicateGroups) report.blockers.push(`${plan.collection}: existing document or duplicate conflicts require review.`)
  }
  report.ready = !report.blockers.length && report.collections.every(item => item.exists && item.missingIndexes.length === 0)
  return report
}
export function validateSetupApproval(source, configuredDatabase, apply) {
  if (source.MANUAL_CASH_SETUP_ALLOW_READS !== 'true' || !source.MANUAL_CASH_SETUP_DATABASE || source.MANUAL_CASH_SETUP_DATABASE !== configuredDatabase) throw new Error('Explicit read approval and exact configured database confirmation are required.')
  if (apply && (source.MANUAL_CASH_SETUP_ALLOW_WRITES !== 'true' || !source.MANUAL_CASH_SETUP_APPROVAL?.trim())) throw new Error('Explicit owner write approval and an approval reference are required.')
}
export async function applyManualCashSetup(db, source) {
  validateSetupApproval(source, db.databaseName, true)
  let report = await inspectManualCashSetup(db)
  if (report.blockers.length) return { ...report, applied: false }
  for (const item of report.collections) {
    if (!item.exists) {
      try { await db.createCollection(item.name) } catch (error) { if (error.code !== 48) throw error }
    }
  }
  // Reinspect after namespace races before adding constraints. Never repair data or drop indexes.
  report = await inspectManualCashSetup(db)
  if (report.blockers.length) return { ...report, applied: false }
  for (const item of report.collections) for (const index of item.missingIndexes) {
    await db.collection(item.name).createIndex(index.key, { unique: true, name: Object.entries(index.key).map(([key, direction]) => `${key}_${direction}`).join('_') })
  }
  return { ...await inspectManualCashSetup(db), applied: true }
}

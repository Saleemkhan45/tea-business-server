import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import { ManualCashDay, ManualCashRevision } from '../models/ManualCashDay.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { getBusinessDate, previousBusinessDate } from '../utils/businessDay.js'
import { checkedSummary, manualAmounts, manualCashError, requireManualDate } from './policy.js'
import { inspectIndexes } from './indexReadiness.js'

const setupError = setup => Object.assign(manualCashError('Manual Cash Book needs approved collection/index setup before records can be read or saved.', 503, 'MANUAL_CASH_SETUP_REQUIRED'), { setup })
const snapshot = record => ({ ...Object.fromEntries(['shopCashAmount', 'bossAddedAmount', 'totalCollected', 'takenHomeAmount', 'remainingCash', 'notes'].map(key => [key, record[key]])), status: record.status ?? 'active', voidedBy: record.voidedBy?._id ?? record.voidedBy ?? null, voidedAt: record.voidedAt ?? null, voidReason: record.voidReason ?? '' })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const operatorPopulation = shop => ['enteredBy', 'lastUpdatedBy', 'voidedBy'].map(path => ({ path, select: 'name', match: { shop } }))
export async function requireManualCashIndexes() {
  for (const model of [ManualCashDay, ManualCashRevision]) {
    let indexes
    try { indexes = await model.collection.listIndexes().toArray() } catch (error) {
      if (error.code === 26 || error.codeName === 'NamespaceNotFound') throw setupError({ collection: model.collection.name, reason: 'collection_missing' })
      if (error.code === 13 || error.codeName === 'Unauthorized') throw manualCashError('Cash Book database permissions require administrator review.', 503, 'MANUAL_CASH_PERMISSION_REQUIRED')
      throw manualCashError('Cash Book database is unavailable. Please try again.', 503, 'MANUAL_CASH_UNAVAILABLE')
    }
    const check = inspectIndexes(indexes, model.schema.indexes().map(([key]) => ({ key, unique: true })))
    if (check.missing.length || check.conflicts.length) throw setupError({ collection: model.collection.name, reason: 'indexes_incompatible', missingIndexes: check.missing.map(index => index.key), conflictingIndexes: check.conflicts.length })
  }
}
export async function status(includeSetup = false) {
  try { await requireManualCashIndexes(); return { ready: true, mode: 'manual_daily', today: getBusinessDate() } }
  catch (error) { if (error.code !== 'MANUAL_CASH_SETUP_REQUIRED') throw error; return { ready: false, mode: 'manual_daily', today: getBusinessDate(), message: error.message, ...(includeSetup ? { setup: error.setup } : {}) } }
}
async function manager(shop, actor, session) {
  const user = await User.exists({ _id: actor, shop, status: 'active', role: { $in: ['owner', 'admin'] } }).session(session)
  if (!user) throw manualCashError('Only an authorized shop owner or admin can save or correct manual cash records.', 403)
  if (!await Shop.exists({ _id: shop, status: 'active' }).session(session)) throw manualCashError('Active shop not found.', 404)
}
async function transact(callback) {
  await requireManualCashIndexes()
  const session = await mongoose.startSession()
  try { return await session.withTransaction(() => callback(session)) } finally { await session.endSession() }
}
async function findRecord(shop, recordId, session) {
  const record = await ManualCashDay.findOne({ shop, _id: recordId }).populate(operatorPopulation(shop)).session(session ?? null).lean()
  if (!record) throw manualCashError('Manual cash record not found.', 404)
  return record
}
async function replay(shop, key, fingerprint, session) {
  const audit = await ManualCashRevision.findOne({ shop, key }).select('+fingerprint').session(session ?? null).lean()
  if (!audit) return null
  if (audit.fingerprint !== fingerprint) throw manualCashError('This request key was already used for different manual cash details.', 409)
  return { record: await findRecord(shop, audit.record, session), replayed: true, postedRevision: audit.revision }
}
export async function saveDay(shop, actor, input, recordId) {
  return changeDay(shop, actor, input, recordId, recordId ? 'correct' : 'create')
}
export const voidDay = (shop, actor, input, recordId) => changeDay(shop, actor, input, recordId, 'void')
export const replaceDay = (shop, actor, input, recordId) => changeDay(shop, actor, input, recordId, 'replace')
async function changeDay(shop, actor, input, recordId, action) {
  const fingerprint = digest({ action, actor: String(actor), recordId: recordId ?? null, ...input })
  const run = async session => {
    await manager(shop, actor, session)
    const prior = await replay(shop, input.key, fingerprint, session)
    if (prior) return prior
    const amounts = action === 'void' ? {} : manualAmounts(input), notes = input.notes ?? ''
    let record, previous = null
    if (recordId) {
      const existing = await findRecord(shop, recordId, session)
      if (existing.revision !== input.expectedRevision) throw manualCashError('This day was corrected by another operator. Reload the saved record before correcting it.', 409)
      if (typeof input.reason !== 'string' || input.reason.trim().length < 3) throw manualCashError('A correction reason is required.')
      if (existing.status === 'voided' && action !== 'replace') throw manualCashError('This cash record is already voided. Use an audited replacement for this date.', 409, 'MANUAL_CASH_ALREADY_VOIDED')
      if (action === 'replace' && existing.status !== 'voided') throw manualCashError('Only a voided record can be replaced. Reload the current record.', 409, 'MANUAL_CASH_CONFLICT')
      if (!Number.isSafeInteger(existing.revision + 1)) throw manualCashError('This record has reached its revision limit.', 409)
      previous = snapshot(existing)
      const changes = action === 'void'
        ? { status: 'voided', voidedBy: actor, voidedAt: new Date(), voidReason: input.reason.trim(), lastUpdatedBy: actor }
        : { ...amounts, notes, lastUpdatedBy: actor, ...(action === 'replace' ? { status: 'active', voidedBy: null, voidedAt: null, voidReason: '' } : {}) }
      record = await ManualCashDay.findOneAndUpdate({ _id: recordId, shop, revision: input.expectedRevision, status: action === 'replace' ? 'voided' : { $ne: 'voided' } },
        { $set: changes, $inc: { revision: 1 } }, { new: true, runValidators: true, session })
      if (!record) throw manualCashError('This cash record changed concurrently. Reload before correcting it.', 409)
    } else {
      requireManualDate(input.businessDate)
      if (await ManualCashDay.exists({ shop, businessDate: input.businessDate }).session(session)) throw manualCashError('A finalized cash record already exists for this date. Open it to make an audited correction.', 409, 'MANUAL_CASH_DAY_EXISTS')
      ;[record] = await ManualCashDay.create([{ shop, businessDate: input.businessDate, ...amounts, notes, enteredBy: actor, lastUpdatedBy: actor, revision: 0 }], { session })
    }
    await ManualCashRevision.create([{ shop, record: record._id, businessDate: record.businessDate, revision: record.revision, action,
      key: input.key, fingerprint, previous, next: snapshot(record), reason: recordId ? input.reason.trim() : 'Manual daily record finalized', modifiedBy: actor }], { session })
    return { record: await findRecord(shop, record._id, session), replayed: false, postedRevision: record.revision }
  }
  try { return await transact(run) }
  catch (error) {
    if (error.code !== 11000) throw error
    // Resolve same-key races after the losing transaction has rolled back.
    return transact(async session => {
      await manager(shop, actor, session)
      const prior = await replay(shop, input.key, fingerprint, session)
      if (prior) return prior
      throw manualCashError('A record or correction for this day was saved concurrently. Reload before continuing.', 409, recordId ? 'MANUAL_CASH_CONFLICT' : 'MANUAL_CASH_DAY_EXISTS')
    })
  }
}
export async function getByDate(shop, date) {
  requireManualDate(date); await requireManualCashIndexes()
  const record = await ManualCashDay.findOne({ shop, businessDate: date }).populate(operatorPopulation(shop)).lean()
  return record?.status === 'voided' ? { date, record: null, voidedRecord: record } : { date, record: record ?? null }
}
export async function overview(shop) {
  await requireManualCashIndexes()
  const today = getBusinessDate(), yesterday = previousBusinessDate(today)
  const records = await ManualCashDay.find({ shop, status: { $ne: 'voided' }, businessDate: { $in: [today, yesterday] } }).populate(operatorPopulation(shop)).lean()
  return { today: { date: today, record: records.find(row => row.businessDate === today) ?? null }, yesterday: { date: yesterday, record: records.find(row => row.businessDate === yesterday) ?? null } }
}
export async function history(shop, { from, to, page = 1, limit = 20 }) {
  requireManualDate(from); requireManualDate(to)
  if (from > to) throw manualCashError('End date must follow start date.')
  await requireManualCashIndexes()
  const filter = { shop, status: { $ne: 'voided' }, businessDate: { $gte: from, $lte: to } }
  const session = await mongoose.startSession()
  try { return await session.withTransaction(async () => {
    const rows = await ManualCashDay.find(filter).sort({ businessDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate(operatorPopulation(shop)).session(session).lean()
    const groups = await ManualCashDay.aggregate([{ $match: { ...filter, shop: new mongoose.Types.ObjectId(shop) } }, { $group: {
      _id: null, recordedDays: { $sum: 1 }, shopCashAmount: { $sum: '$shopCashAmount' }, bossAddedAmount: { $sum: '$bossAddedAmount' }, totalCollected: { $sum: '$totalCollected' },
    } }]).session(session)
    const summary = checkedSummary(groups[0])
    return { rows, summary, from, to, page, limit, total: summary.recordedDays }
  }, { readConcern: { level: 'snapshot' } }) } finally { await session.endSession() }
}
export async function details(shop, recordId, page = 1) {
  await requireManualCashIndexes()
  const session = await mongoose.startSession()
  try { return await session.withTransaction(async () => {
    const record = await findRecord(shop, recordId, session)
    const filter = { shop, record: recordId }
    const audit = await ManualCashRevision.find(filter).sort({ revision: -1 }).skip((page - 1) * 20).limit(20).populate({ path: 'modifiedBy', select: 'name', match: { shop } }).session(session).lean()
    return { record, audit, page, limit: 20, total: await ManualCashRevision.countDocuments(filter).session(session) }
  }, { readConcern: { level: 'snapshot' } }) } finally { await session.endSession() }
}

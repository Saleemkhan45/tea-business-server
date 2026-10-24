import mongoose from 'mongoose'
import { Customer } from '../models/Customer.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { CollectionSchedule, CollectionOccurrence } from '../models/CollectionSchedule.js'
import { balancePkr } from './customerLedgerCalculations.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { addDays, scheduledOn, nextCollectionDate, collectionState } from './collectionCalculations.js'
import { requireCollectionIndexes } from './collectionReadiness.js'

// Keep database identity and audit history out of the editable settings contract.
export function serializeSchedule(schedule) {
  if (!schedule) return null
  const { weekdays, expectedAmount, time, startDate, endDate, notes, status, revision } = schedule
  return { weekdays, expectedAmount, time, startDate, endDate, notes, status, revision,
    frequency: schedule.frequency ?? 'weekly', channels: schedule.channels ?? ['in_app'] }
}

async function transaction(operation) {
  const session = await mongoose.startSession()
  try { return await session.withTransaction(() => operation(session)) }
  finally { await session.endSession() }
}

async function claim(shop, customer, session) {
  const row = await Customer.findOneAndUpdate({ _id: customer, shop, status: 'active' },
    { $inc: { ledgerRevision: 1 } }, { session, new: true }).lean()
  if (!row) throw Object.assign(new Error('Active customer not found.'), { statusCode: 404 })
  return row
}

async function materialize(schedule, session, today) {
  if (!schedule) return
  const rows = await CustomerLedgerTransaction.find({ shop: schedule.shop, customer: schedule.customer }).session(session).lean()
  const start = schedule.generatedThrough ? addDays(schedule.generatedThrough, 1) : schedule.startDate
  {
    for (let date = start; date <= today; date = addDays(date, 1)) {
      if (!scheduledOn(schedule, date)) continue
      if (balancePkr(rows.filter(row => row.businessDate <= date)) <= 0) continue
      await CollectionOccurrence.updateOne({ shop: schedule.shop, schedule: schedule._id, scheduledDate: date },
        { $setOnInsert: { customer: schedule.customer, expectedAmount: schedule.expectedAmount,
          notes: schedule.notes, time: schedule.time, channels: schedule.channels ?? ['in_app'], scheduleRevision: schedule.revision } }, { upsert: true, session })
    }
  }
  if (!schedule.generatedThrough || schedule.generatedThrough < today) {
    await CollectionSchedule.updateOne({ _id: schedule._id, shop: schedule.shop }, { $set: { generatedThrough: today } }, { session })
  }
}

export async function syncCustomer(shop, customer, today = getBusinessDate()) {
  await requireCollectionIndexes()
  return transaction(async session => {
    await claim(shop, customer, session)
    const schedule = await CollectionSchedule.findOne({ shop, customer }).session(session).lean()
    await materialize(schedule, session, today)
  })
}

export async function saveSchedule(shop, customer, actor, input) {
  await requireCollectionIndexes()
  return transaction(async session => {
    await claim(shop, customer, session)
    const previous = await CollectionSchedule.findOne({ shop, customer }).session(session).lean()
    if (!previous && input.startDate < getBusinessDate()) throw Object.assign(new Error('New schedules must start today or later.'), { statusCode: 400 })
    if ((previous?.revision ?? 0) !== input.revision) throw Object.assign(new Error('Schedule changed. Reload before saving.'), { statusCode: 409 })
    await materialize(previous, session, getBusinessDate())
    const { revision, ...settings } = input
    const values = { ...settings, updatedBy: actor }
    const schedule = await CollectionSchedule.findOneAndUpdate({ shop, customer }, {
      $set: values, $inc: { revision: 1 }, $push: { history: values },
      $setOnInsert: { shop, customer },
    }, { session, new: true, upsert: true, runValidators: true }).lean()
    // Existing occurrences retain their original expected amount and audit snapshot.
    // Re-evaluate today under the saved settings, including same-day resume.
    // setOnInsert preserves any occurrence already generated under the old revision.
    await materialize({ ...schedule, generatedThrough: addDays(getBusinessDate(), -1) }, session, getBusinessDate())
    return serializeSchedule(schedule)
  })
}

export async function getSchedule(shop, customer) {
  if (!await Customer.exists({ _id: customer, shop })) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 })
  const schedule = await CollectionSchedule.findOne({ shop, customer }).lean()
  let nextDate = nextCollectionDate(schedule)
  if (schedule && nextDate) {
    const [ledger, occurrences] = await Promise.all([
      CustomerLedgerTransaction.find({ shop, customer }).lean(),
      CollectionOccurrence.find({ shop, customer, scheduledDate: nextDate }).lean(),
    ])
    const balance = balancePkr(ledger)
    if (balance <= 0) nextDate = null
    else if (occurrences.some(row => ['collected', 'cleared', 'acknowledged'].includes(collectionState(row, ledger, balance).status))) {
      nextDate = nextCollectionDate(schedule, addDays(nextDate, 1))
    }
  }
  return { schedule: serializeSchedule(schedule), nextCollectionDate: nextDate }
}

export async function listCollections(shop, { from, to, customer, status, search, page = 1, limit = 25 }) {
  const occurrences = await CollectionOccurrence.find({ shop, scheduledDate: { $gte: from, $lte: to },
    ...(customer ? { customer } : {}) }).sort({ scheduledDate: 1, _id: 1 }).lean()
  const schedules = await CollectionSchedule.find({ shop, ...(customer ? { customer } : {}) }).lean()
  const today = getBusinessDate()
  for (const schedule of schedules) {
    for (let date = from > today ? from : addDays(today, 1); date <= to; date = addDays(date, 1)) {
      if (scheduledOn(schedule, date)) occurrences.push({ _id: `upcoming:${schedule._id}:${date}`,
        customer: schedule.customer, scheduledDate: date, expectedAmount: schedule.expectedAmount,
        notes: schedule.notes, time: schedule.time, projected: true })
    }
  }
  occurrences.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || String(a._id).localeCompare(String(b._id)))
  const ids = [...new Set(occurrences.map(row => String(row.customer)))]
  const [customers, ledger] = await Promise.all([
    Customer.find({ shop, _id: { $in: ids } }).select('name phone status').lean(),
    CustomerLedgerTransaction.find({ shop, customer: { $in: ids } }).lean(),
  ])
  const rows = occurrences.flatMap(row => {
    const owner = customers.find(value => String(value._id) === String(row.customer))
    if (!owner) return []
    const transactions = ledger.filter(value => String(value.customer) === String(row.customer))
    const balance = balancePkr(transactions)
    const lastPayment = transactions.filter(value => value.type === 'payment' && value.status === 'active')
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate) || new Date(b.createdAt) - new Date(a.createdAt) || String(b._id).localeCompare(String(a._id)))[0]
    if (row.projected && (balance <= 0 || owner.status !== 'active')) return []
    return [{ ...row, id: String(row._id), customerId: String(row.customer), customerName: owner.name,
      phone: owner.phone, balance, lastPaymentDate: lastPayment?.businessDate ?? null,
      lastPaymentAmount: lastPayment?.amountPkr ?? null, ...collectionState(row, transactions, balance) }]
  }).filter(row => (!search || row.customerName.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    && (!status || (status === 'pending' ? ['due', 'overdue', 'partial'].includes(row.status) : row.status === status)))
  return { rows: rows.slice((page - 1) * limit, page * limit), total: rows.length,
    totals: rows.reduce((sum, row) => ({ expected: sum.expected + row.expectedAmount,
      received: sum.received + row.receivedAmount, unpaid: sum.unpaid + row.unpaidAmount,
      collected: sum.collected + Number(row.status === 'collected'), partial: sum.partial + Number(row.status === 'partial'),
      overdue: sum.overdue + Number(row.status === 'overdue') }), { expected: 0, received: 0, unpaid: 0, collected: 0, partial: 0, overdue: 0 }) }
}

export async function syncShop(shop) {
  const customers = await Customer.find({ shop, status: 'active' }).select('_id').lean()
  const schedules = await CollectionSchedule.find({ shop, customer: { $in: customers.map(row => row._id) } }).select('customer').lean()
  for (const row of schedules) await syncCustomer(shop, row.customer)
}

export async function acknowledgeCollection(shop, occurrenceId, actor, notes) {
  return transaction(async session => {
    const occurrence = await CollectionOccurrence.findOne({ _id: occurrenceId, shop }).session(session).lean()
    if (!occurrence) throw Object.assign(new Error('Collection not found.'), { statusCode: 404 })
    await claim(shop, occurrence.customer, session)
    return CollectionOccurrence.findOneAndUpdate({ _id: occurrenceId, shop, acknowledgedAt: { $exists: false } },
      { $set: { acknowledgedAt: new Date(), acknowledgedBy: actor, acknowledgmentNotes: notes } },
      { session, new: true }).lean()
  })
}

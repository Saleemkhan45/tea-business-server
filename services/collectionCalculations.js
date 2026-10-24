import { getBusinessDate } from '../utils/businessDay.js'
import { orderedTransactions, transactionImpactPkr } from './customerLedgerCalculations.js'

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function scheduledOn(schedule, date) {
  return schedule.status === 'active' && date >= schedule.startDate
    && (!schedule.endDate || date <= schedule.endDate)
    && (schedule.frequency === 'one_time' ? date === schedule.startDate
      : schedule.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
}

export function reminderInstant(occurrence) {
  return new Date(`${occurrence.scheduledDate}T${occurrence.time || '00:00'}:00+05:00`)
}

export function nextCollectionDate(schedule, today = getBusinessDate()) {
  if (!schedule || schedule.status !== 'active') return null
  const start = schedule.startDate > today ? schedule.startDate : today
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(start, offset)
    if (scheduledOn(schedule, date)) return date
  }
  return null
}

export function collectionState(occurrence, transactions, balance, today = getBusinessDate()) {
  const payments = transactions.filter(row => row.type === 'payment' && row.status === 'active'
    && String(row.collectionOccurrence) === String(occurrence._id))
  const receivedAmount = payments.reduce((sum, row) => {
    const value = sum + row.amountPkr
    if (!Number.isSafeInteger(value)) throw new RangeError('Collection receipts exceed safe PKR limits.')
    return value
  }, 0)
  let runningBalance = 0
  let clearedSince = false
  for (const row of orderedTransactions(transactions)) {
    const impact = transactionImpactPkr(row)
    runningBalance += impact
    if (impact < 0 && runningBalance === 0 && row.businessDate >= occurrence.scheduledDate && row.businessDate <= today) clearedSince = true
  }
  const unpaidAmount = Math.max(0, occurrence.expectedAmount - receivedAmount)
  const status = receivedAmount >= occurrence.expectedAmount ? 'collected'
    : balance <= 0 || clearedSince ? 'cleared' : occurrence.acknowledgedAt ? 'acknowledged' : receivedAmount > 0 ? 'partial'
      : occurrence.scheduledDate < today ? 'overdue' : occurrence.scheduledDate === today ? 'due' : 'upcoming'
  return { receivedAmount, unpaidAmount, status, paymentIds: payments.map(row => String(row._id)) }
}

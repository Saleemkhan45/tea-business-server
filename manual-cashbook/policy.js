import { getBusinessDate } from '../utils/businessDay.js'

export const manualCashError = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) })
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function manualAmounts({ shopCashAmount, bossAddedAmount }) {
  for (const amount of [shopCashAmount, bossAddedAmount]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw manualCashError('Enter non-negative safe whole PKR amounts.')
  }
  const totalCollected = shopCashAmount + bossAddedAmount
  if (!Number.isSafeInteger(totalCollected)) throw manualCashError('Total collected exceeds the safe whole PKR limit.')
  return { shopCashAmount, bossAddedAmount, totalCollected }
}
export function requireManualDate(date, now) {
  if (!validDate(date) || date > getBusinessDate(now)) throw manualCashError('Choose a valid Asia/Karachi business date no later than today.')
  return date
}
export function checkedSummary(group = {}) {
  const result = Object.fromEntries(['shopCashAmount', 'bossAddedAmount', 'totalCollected', 'recordedDays'].map(key => [key, group[key] ?? 0]))
  for (const amount of Object.values(result)) if (!Number.isSafeInteger(amount) || amount < 0) throw manualCashError('The selected period exceeds the safe reporting limit. Select a smaller date range.', 409)
  return { ...result, averageDailyCollection: result.recordedDays ? result.totalCollected / result.recordedDays : null }
}

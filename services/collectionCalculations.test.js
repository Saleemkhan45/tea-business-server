import { describe, expect, it } from 'vitest'
import { addDays, scheduledOn, nextCollectionDate, collectionState } from './collectionCalculations.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { balancePkr } from './customerLedgerCalculations.js'

const schedule = { weekdays: [3, 5], status: 'active', startDate: '2026-10-01', endDate: '' }
const occurrence = { _id: 'occurrence', expectedAmount: 2000, scheduledDate: '2026-10-21' }
const opening = { _id: 'opening', type: 'opening_balance', amountPkr: 20000, status: 'active', businessDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z' }
const payment = { _id: 'payment', type: 'payment', amountPkr: 1000, status: 'active', collectionOccurrence: 'occurrence', businessDate: '2026-10-21', createdAt: '2026-10-21T00:00:00Z' }
describe('weekly collection business dates', () => {
  it.each([['2026-10-21', true], ['2026-10-23', true], ['2026-10-22', false], ['2026-10-25', false]])('Wednesday and Friday: %s', (date, expected) => {
    expect(scheduledOn(schedule, date)).toBe(expected)
  })
  it('supports Sunday and Monday and computes the next occurrence', () => {
    const value = { ...schedule, weekdays: [0, 1] }
    expect(scheduledOn(value, '2026-10-25')).toBe(true)
    expect(scheduledOn(value, '2026-10-26')).toBe(true)
    expect(nextCollectionDate(value, '2026-10-23')).toBe('2026-10-25')
  })
  it('handles multiple days, start/end dates and Thursday schedules', () => {
    expect(nextCollectionDate({ ...schedule, weekdays: [4], startDate: '2026-10-23' }, '2026-10-20')).toBe('2026-10-29')
    expect(nextCollectionDate({ ...schedule, endDate: '2026-10-20' }, '2026-10-20')).toBeNull()
    expect(nextCollectionDate({ ...schedule, weekdays: [0, 1, 2, 3, 4, 5, 6] }, '2026-10-20')).toBe('2026-10-20')
  })
  it('pauses, disables and resumes', () => {
    for (const status of ['paused', 'disabled']) expect(nextCollectionDate({ ...schedule, status }, '2026-10-20')).toBeNull()
    expect(nextCollectionDate(schedule, '2026-10-20')).toBe('2026-10-21')
  })
  it('uses Karachi midnight independently of the host timezone', () => {
    expect(getBusinessDate(new Date('2026-10-20T18:59:59Z'))).toBe('2026-10-20')
    expect(getBusinessDate(new Date('2026-10-20T19:00:00Z'))).toBe('2026-10-21')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
})
describe('non-financial collection tracking', () => {
  it('marks due, upcoming and missed dates without changing the ledger', () => {
    const rows = [opening]
    expect(collectionState(occurrence, rows, 20000, '2026-10-21').status).toBe('due')
    expect(collectionState(occurrence, rows, 20000, '2026-10-20').status).toBe('upcoming')
    expect(collectionState(occurrence, rows, 20000, '2026-10-22').status).toBe('overdue')
    expect(balancePkr(rows)).toBe(20000)
    expect(rows).toEqual([opening])
  })
  it('counts only linked active payments, with no additional debt for a shortfall', () => {
    const rows = [opening, payment, { ...payment, collectionOccurrence: 'another', amountPkr: 500 }]
    expect(collectionState(occurrence, rows, balancePkr(rows), '2026-10-21')).toMatchObject({ status: 'partial', receivedAmount: 1000, unpaidAmount: 1000, paymentIds: ['payment'] })
    expect(balancePkr(rows)).toBe(18500)
  })
  it('completes collections and marks cleared balances', () => {
    expect(collectionState(occurrence, [{ ...payment, amountPkr: 2000 }], 18000).status).toBe('collected')
    expect(collectionState(occurrence, [], 0).status).toBe('cleared')
  })
  it('restores collection status on reversal without deleting history', () => {
    const rows = [opening, { ...payment, amountPkr: 2000, status: 'voided' }]
    expect(balancePkr(rows)).toBe(20000)
    expect(collectionState(occurrence, rows, balancePkr(rows), '2026-10-22')).toMatchObject({ status: 'overdue', receivedAmount: 0 })
    expect(rows).toHaveLength(2)
  })
})

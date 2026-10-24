import { describe, expect, it } from 'vitest'
import { checkedSummary, manualAmounts, requireManualDate, validDate } from './policy.js'

describe('independent manual daily cash calculations', () => {
  it.each([[7000, 3000, 10000], [7000, 0, 7000], [0, 3000, 3000], [0, 0, 0]])('adds %i + %i = %i without subtraction', (shopCashAmount, bossAddedAmount, totalCollected) => {
    expect(manualAmounts({ shopCashAmount, bossAddedAmount })).toEqual({ shopCashAmount, bossAddedAmount, totalCollected })
  })
  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '7000', null, undefined])('rejects invalid whole PKR %s in either input', amount => {
    expect(() => manualAmounts({ shopCashAmount: amount, bossAddedAmount: 0 })).toThrow()
    expect(() => manualAmounts({ shopCashAmount: 0, bossAddedAmount: amount })).toThrow()
  })
  it('rejects unsafe addition without rounding and never trusts client totals', () => {
    expect(() => manualAmounts({ shopCashAmount: Number.MAX_SAFE_INTEGER, bossAddedAmount: 1 })).toThrow('safe')
    expect(manualAmounts({ shopCashAmount: 7000, bossAddedAmount: 3000, totalCollected: 1, takenHomeAmount: 8000 }).totalCollected).toBe(10000)
  })
  it('validates real dates and Karachi midnight while supporting historical entries', () => {
    expect(validDate('2026-02-30')).toBe(false); expect(validDate('2024-02-29')).toBe(true)
    expect(requireManualDate('2025-01-01', new Date('2026-10-21T18:59:59Z'))).toBe('2025-01-01')
    expect(() => requireManualDate('2026-10-22', new Date('2026-10-21T18:59:59Z'))).toThrow()
    expect(requireManualDate('2026-10-22', new Date('2026-10-21T19:00:00Z'))).toBe('2026-10-22')
  })
  it('summarizes saved days only, excludes legacy withdrawals and rejects unsafe totals', () => {
    expect(checkedSummary()).toMatchObject({ recordedDays: 0, averageDailyCollection: null })
    expect(checkedSummary({ recordedDays: 2, totalCollected: 15001, takenHomeAmount: 9000 })).toMatchObject({ averageDailyCollection: 7500.5 })
    expect(checkedSummary({ takenHomeAmount: 9000 })).not.toHaveProperty('takenHomeAmount')
    expect(() => checkedSummary({ totalCollected: Number.MAX_SAFE_INTEGER + 1 })).toThrow('smaller date range')
  })
})

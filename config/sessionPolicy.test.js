import { expect, it } from 'vitest'
import { readSessionPolicy } from './sessionPolicy.js'
it('centrally configures the 30-day sliding and 180-day maximum policy', () => {
  expect(readSessionPolicy({})).toMatchObject({ shortMs: 8 * 3600000, slidingMs: 30 * 86400000, absoluteMs: 180 * 86400000, renewalMs: 86400000 })
  expect(readSessionPolicy({ SESSION_SLIDING_DAYS: '14', SESSION_ABSOLUTE_DAYS: '90', SESSION_RENEWAL_HOURS: '12' }).slidingMs).toBe(14 * 86400000)
})
it('rejects unsafe or contradictory duration configuration', () => {
  for (const value of ['0', '', '-1', '1.5', 'NaN', '99999']) expect(() => readSessionPolicy({ SESSION_SLIDING_DAYS: value })).toThrow()
  expect(() => readSessionPolicy({ SESSION_SLIDING_DAYS: '90', SESSION_ABSOLUTE_DAYS: '30' })).toThrow()
  expect(() => readSessionPolicy({ SESSION_SLIDING_DAYS: '1', SESSION_RENEWAL_HOURS: '24' })).toThrow()
})

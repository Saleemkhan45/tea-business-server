import { expect, it } from 'vitest'
import { AuthSession } from './AuthSession.js'
it('retains token uniqueness and expires records using the authoritative persisted expiry', () => {
  expect(AuthSession.schema.indexes()).toEqual(expect.arrayContaining([
    [expect.objectContaining({ tokenHash: 1 }), expect.objectContaining({ unique: true })],
    [expect.objectContaining({ expiresAt: 1 }), expect.objectContaining({ expireAfterSeconds: 0 })],
  ]))
  expect(AuthSession.schema.path('persistent').defaultValue).toBe(false)
})

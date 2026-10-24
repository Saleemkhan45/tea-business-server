import { expect, it } from 'vitest'
import { setupFailureDetails } from './manual-cash-setup.js'

it.each([
  [{ code: 13 }, 'DATABASE_PERMISSION_DENIED'],
  [{ code: 11000 }, 'DUPLICATE_INDEX_CONFLICT'],
  [{ code: 'ENOTFOUND' }, 'DATABASE_DNS_FAILED'],
  [{ code: 'ECONNREFUSED', syscall: 'querySrv' }, 'DATABASE_DNS_FAILED'],
  [{ cause: { code: 'ETIMEDOUT' } }, 'DATABASE_CONNECTION_FAILED'],
  [{ name: 'MongoServerSelectionError' }, 'DATABASE_CONNECTION_FAILED'],
  [{}, 'SETUP_STOPPED'],
])('reports safe setup failure categories without driver secrets: %j', (details, code) => {
  const result = setupFailureDetails({ ...details, message: 'mongodb+srv://private:password@private-host/business' })
  expect(result.code).toBe(code)
  expect(JSON.stringify(result)).not.toMatch(/private|password|mongodb\+srv/)
})

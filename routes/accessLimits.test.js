import { afterAll, beforeAll, expect, it, vi } from 'vitest'
vi.mock('../services/authService.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, login: vi.fn(async () => { throw new actual.AuthError('Invalid credentials.') }), authenticate: vi.fn(async () => ({ user: { id: 'operator', shopId: 'shop', role: 'owner' }, session: { csrfToken: 'csrf' } })), sessionToken: () => ({ token: 'fixture', cookieAuth: true }) }
})
vi.mock('../services/actionAuthorization.js', async importOriginal => ({ ...await importOriginal(), issueApproval: vi.fn(async () => { throw Object.assign(new Error('Password rejected.'), { statusCode: 403 }) }) }))
import { createApp } from '../app.js'
import { env } from '../config/env.js'
let server, origin
beforeAll(async () => { server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}` })
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
it('keeps ordinary authenticated reference reads outside mutation/password budgets', async () => {
  const responses = await Promise.all(Array.from({ length: 150 }, () => fetch(origin + '/api/v1/regional/product-options')))
  expect(responses.every(response => response.status === 200)).toBe(true)
})
it('still limits password guessing with explicit Retry-After', async () => {
  let response
  for (let i = 0; i < 21; i++) response = await fetch(origin + '/api/v1/auth/authorize', { method: 'POST', headers: { Origin: env.clientOrigin, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong', method: 'POST', path: '/api/v1/sales', payload: {} }) })
  expect(response.status).toBe(429); expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
})

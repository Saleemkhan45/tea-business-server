import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { databaseFailure, diagnosticRoute, diagnostic } from '../utils/safeDiagnostics.js'
let server, origin, ready = true, probe = true
const log = vi.spyOn(console, 'info').mockImplementation(() => {})
beforeAll(async () => { server = createApp({ databaseReady: () => ready, databaseProbe: async () => { if (probe === 'throw') throw new Error('private detail'); return probe } }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}` })
afterAll(async () => { await new Promise(resolve => server.close(resolve)); log.mockRestore() })
it('fails readiness on an unreachable dependency and recovers without process restart', async () => {
  for (const value of [false, 'throw']) {
    probe = value
    const response = await fetch(origin + '/api/v1/ready')
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(await response.json()).toEqual({ ready: false })
    expect((await fetch(origin + '/api/v1/health')).status).toBe(200)
  }
  probe = true
  expect((await fetch(origin + '/api/v1/ready')).status).toBe(200)
})
it('generates trace IDs and logs templates without queries, cookies, body or supplied IDs', async () => {
  log.mockClear()
  const response = await fetch(origin + '/api/v1/ready?password=private-password', { headers: { 'X-Request-ID': 'private-cookie', Cookie: 'private-session-cookie' } })
  const id = response.headers.get('X-Request-ID')
  expect(id).toMatch(/^[a-f\d-]{36}$/)
  await response.text()
  const events = log.mock.calls.map(([value]) => JSON.parse(value))
  const event = events.find(row => row.requestId === id)
  expect(event).toMatchObject({ event: 'request.completed', status: 200, method: 'GET', route: '/api/v1/ready', code: 'HTTP_RESPONSE' })
  expect(event.durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(events)).not.toMatch(/private-password|private-cookie|private-session-cookie/)
  expect(diagnosticRoute({ baseUrl: '/api/v1/customers/secret-customer', route: { path: '/payments/:paymentId' } })).toBe('/api/v1/customers/payments/:paymentId')
  diagnostic('test', { password: 'private-password', route: '/bad?token=private-cookie' })
  expect(log.mock.calls.at(-1)[0]).not.toMatch(/private-/)
})
it('classifies temporary driver and pool failures without treating duplicate-key conflicts as outages', () => {
  for (const name of ['MongoNetworkTimeoutError', 'MongoWaitQueueTimeoutError', 'MongoOperationTimeoutError', 'MongoServerSelectionError']) expect(databaseFailure({ name })).toBe(true)
  expect(databaseFailure({ name: 'MongoServerError', code: 50 })).toBe(true)
  expect(databaseFailure({ name: 'MongoServerError', code: 11000 })).toBe(false)
})

import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ getDashboard: vi.fn() }))
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('../services/dashboardService.js', () => service)
vi.mock('../services/authService.js', () => ({ authenticate: auth.authenticate, sessionToken: headers => ({ token: headers.cookie, cookieAuth: true }), AuthError: class extends Error {} }))
import { salesRoutes } from './salesRoutes.js'
let server, base
beforeAll(async () => {
  const app = express(); app.use('/sales', salesRoutes)
  app.use((error, req, res, next) => res.status(500).json({ message: 'Unavailable' }))
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/sales/dashboard`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.clearAllMocks()
  auth.authenticate.mockResolvedValue({ user: { id: 'operator', shopId: '507f1f77bcf86cd799439001', role: 'staff' }, session: { csrfToken: 'offline-token' } })
  service.getDashboard.mockResolvedValue({ from: '2026-10-16', to: '2026-10-16', regionId: null, products: [] })
})
describe('dashboard authenticated read route (offline)', () => {
  it('uses authenticated shop scope and validated dates/region with cookie authentication', async () => {
    const response = await fetch(`${base}?from=2026-10-10&to=2026-10-16&regionId=507f1f77bcf86cd799439002`, { headers: { Cookie: 'offline' } })
    expect(response.status).toBe(200)
    expect(service.getDashboard).toHaveBeenCalledWith({ shop: '507f1f77bcf86cd799439001', from: '2026-10-10', to: '2026-10-16', regionId: '507f1f77bcf86cd799439002' })
  })
  it.each(['?shop=507f1f77bcf86cd799439099', '?limit=999', '?from=2026-02-30&to=2026-03-01', '?from=2026-10-16', '?regionId=bad', '?from=2026-10-17&to=2026-10-16'])('rejects invalid or unauthorized query fields %s', async query => {
    expect((await fetch(base + query, { headers: { Cookie: 'offline' } })).status).toBe(400)
    expect(service.getDashboard).not.toHaveBeenCalled()
  })
  it('fails closed when authentication cannot be verified', async () => {
    auth.authenticate.mockRejectedValue(new Error('Unavailable'))
    expect((await fetch(base)).status).toBe(503)
    expect(service.getDashboard).not.toHaveBeenCalled()
  })
  it('returns an error instead of an empty result when aggregation fails', async () => {
    service.getDashboard.mockRejectedValue(new Error('Private database text'))
    const response = await fetch(base, { headers: { Cookie: 'offline' } })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('Private database text')
  })
})



// Route-contract fixtures assume a consumed approval; real enforcement is covered in authRoutes/actionAuthorization tests.
vi.mock('../services/actionAuthorization.js', async importOriginal => ({ ...await importOriginal(), consumeApproval: vi.fn(async () => {}) }))
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
const service = vi.hoisted(() => ({ listRegions: vi.fn(), createRegion: vi.fn(), updateRegion: vi.fn(), listProducts: vi.fn(), createProduct: vi.fn(), listInventory: vi.fn(), assignProduct: vi.fn(), removeUnusedAssignment: vi.fn(), updateRegionalSettings: vi.fn(), regionHistory: vi.fn(), recordStockOperation: vi.fn() }))
const reports = vi.hoisted(() => ({ regionalOverview: vi.fn(), regionReport: vi.fn() }))
vi.mock('../services/regionalReportService.js', () => reports)
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('../services/regionalInventoryService.js', () => service)
vi.mock('../services/authService.js', () => ({ authenticate: auth.authenticate, sessionToken: headers => ({ token: headers.cookie, cookieAuth: true }), AuthError: class extends Error {} }))
import { regionalInventoryRoutes } from './regionalInventoryRoutes.js'
import { AuthError } from '../services/authService.js'
let server, base
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/regional', regionalInventoryRoutes)
  app.use((error, req, res, next) => res.status(500).json({ message: 'Unavailable' }))
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/regional`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.resetAllMocks()
  auth.authenticate.mockResolvedValue({ user: { id: 'operator', shopId: 'authorized-shop', role: 'admin' }, session: { csrfToken: 'offline-token' } })
  for (const fn of Object.values(service)) fn.mockResolvedValue([])
  reports.regionalOverview.mockResolvedValue({ regions: [] }); reports.regionReport.mockResolvedValue({})
})
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'offline-cookie', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token', ...headers }, body: JSON.stringify(body) })
describe('regional API offline authentication and scope', () => {
  it('scopes regional configuration updates and enforces CSRF', async () => {
    const url = `${base}/regions/r1/products/p1`
    const body = JSON.stringify({ shop: 'foreign', actor: 'forged', sellingPriceOverride: 850 })
    expect((await fetch(url, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json', Cookie: 'offline', Origin: env.clientOrigin } })).status).toBe(403)
    expect(service.updateRegionalSettings).not.toHaveBeenCalled()
    expect((await fetch(url, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json', Cookie: 'offline', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token' } })).status).toBe(200)
    expect(service.updateRegionalSettings).toHaveBeenCalledWith({ shop: 'authorized-shop', actor: 'operator', regionId: 'r1', itemId: 'p1', sellingPriceOverride: 850 })
  })
  it('requires CSRF and authenticated scope for unused assignment removal', async () => {
    const url = `${base}/regions/r1/products/p1?shop=foreign`
    expect((await fetch(url, { method: 'DELETE', headers: { Cookie: 'offline', Origin: env.clientOrigin } })).status).toBe(403)
    expect(service.removeUnusedAssignment).not.toHaveBeenCalled()
    expect((await fetch(url, { method: 'DELETE', headers: { Cookie: 'offline', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token' } })).status).toBe(200)
    expect(service.removeUnusedAssignment).toHaveBeenCalledWith({ shop: 'authorized-shop', actor: 'operator', regionId: 'r1', itemId: 'p1' })
  })
  it('keeps region updates scoped and does not expose a hard-delete endpoint', async () => {
    const headers = { 'Content-Type': 'application/json', Cookie: 'offline', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token' }
    const response = await fetch(`${base}/regions/r1`, { method: 'PATCH', headers, body: JSON.stringify({ shop: 'foreign', actor: 'forged', status: 'inactive' }) })
    expect(response.status).toBe(200)
    expect(service.updateRegion).toHaveBeenCalledWith({ shop: 'authorized-shop', actor: 'operator', regionId: 'r1', status: 'inactive' })
    expect((await fetch(`${base}/regions/r1`, { method: 'DELETE', headers })).status).toBe(404)
  })
  it('scopes dated region reports and never accepts a financial query shop override', async () => {
    expect((await fetch(`${base}/regions/r1/report?shop=foreign&from=2026-10-01&to=2026-10-15`, { headers: { Cookie: 'offline' } })).status).toBe(200)
    expect(reports.regionReport).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', regionId: 'r1', from: '2026-10-01', to: '2026-10-15' }))
  })
  it('forces authenticated shop and actor over body-supplied scope', async () => {
    const body = { shop: 'foreign-shop', actor: 'forged-operator', name: 'Islamabad' }
    expect((await post('/regions', body)).status).toBe(201)
    expect(service.createRegion).toHaveBeenCalledWith({ ...body, shop: 'authorized-shop', actor: 'operator' })
  })
  it('forces stock-operation scope and preserves explicit intent', async () => {
    const body = { shop: 'foreign', actor: 'forged', regionId: 'r1', destinationId: 'r2', type: 'transfer', idempotencyKey: 'frozen' }
    expect((await post('/stock-operations', body)).status).toBe(201)
    expect(service.recordStockOperation).toHaveBeenCalledWith({ ...body, shop: 'authorized-shop', actor: 'operator' })
  })
  it('ignores shop query injection on reads', async () => {
    expect((await fetch(`${base}/inventory?shop=foreign&regionId=r1`, { headers: { Cookie: 'offline' } })).status).toBe(200)
    expect(service.listInventory).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', regionId: 'r1' }))
  })
  it('rejects missing CSRF tokens before performing a write', async () => {
    expect((await post('/stock-operations', {}, { 'X-CSRF-Token': '' })).status).toBe(403)
    expect(service.recordStockOperation).not.toHaveBeenCalled()
  })
  it('rejects untrusted write origins', async () => {
    expect((await post('/regions', {}, { Origin: 'https://untrusted.invalid' })).status).toBe(403)
    expect(service.createRegion).not.toHaveBeenCalled()
  })
  it('fails closed when authentication is unavailable', async () => {
    auth.authenticate.mockRejectedValue(new Error('Unavailable'))
    expect((await fetch(`${base}/regions`)).status).toBe(503)
    expect(service.listRegions).not.toHaveBeenCalled()
  })
  it('maps authorization and duplicate errors without database details', async () => {
    service.recordStockOperation.mockRejectedValue(Object.assign(new Error('Only an owner or admin can manage regional stock.'), { statusCode: 403 }))
    expect((await post('/stock-operations', {})).status).toBe(403)
    service.createRegion.mockRejectedValue(Object.assign(new Error('private DB index'), { code: 11000 }))
    const result = await post('/regions', {})
    expect(result.status).toBe(409); expect(JSON.stringify(await result.json())).not.toContain('private DB')
  })
})

it('returns supported category metadata and protects catalog writes with authenticated scope and CSRF', async () => {
  const response = await fetch(`${base}/product-options`, { headers: { Cookie: 'offline' } })
  expect(response.status).toBe(200)
  expect((await response.json()).categories).toEqual(['Green Tea', 'Black Tea', 'Jasmine Tea', 'Herbal Blend', 'Other'])
  auth.authenticate.mockRejectedValueOnce(new AuthError('Sign in required.'))
  expect((await fetch(`${base}/product-options`)).status).toBe(401)
  const body = { name: 'Special Tea', teaType: 'Other', shop: 'foreign', actor: 'forged', sellingPrice: 950, openingQuantityKg: 200, receivingRegionId: 'r1', idempotencyKey: 'catalog' }
  expect((await post('/products', body)).status).toBe(201)
  expect(service.createProduct).toHaveBeenCalledWith({ ...body, shop: 'authorized-shop', actor: 'operator' })
  expect((await fetch(`${base}/products`, { method: 'POST', headers: { Cookie: 'offline', Origin: env.clientOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(403)
})

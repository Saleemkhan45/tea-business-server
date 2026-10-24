import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ sales: vi.fn(), ledger: vi.fn(), inventory: vi.fn() }))
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('../models/Sale.js', async original => ({ ...await original(), Sale: { aggregate: db.sales } }))
vi.mock('../models/CustomerLedgerTransaction.js', async original => ({ ...await original(), CustomerLedgerTransaction: { aggregate: db.ledger, collection: { name: 'customerledgertransactions' } } }))
vi.mock('../services/dashboardStockService.js', () => ({ dashboardStockKg: db.inventory }))
vi.mock('../services/authService.js', () => ({ authenticate: auth.authenticate, sessionToken: headers => ({ token: headers.cookie, cookieAuth: true }), AuthError: class extends Error {} }))

import { salesRoutes } from './salesRoutes.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { saleParamSchema } from '../schemas/salesSchemas.js'
import { getBusinessDate } from '../utils/businessDay.js'

const shop = '507f1f77bcf86cd799439001', region = '507f1f77bcf86cd799439002'
const query = '?from=2026-10-18&to=2026-10-18'
let server, base

beforeAll(async () => {
  const app = express()
  app.use('/api/v1/sales', salesRoutes)
  // Reproduce the pre-dashboard router without starting the real server or MongoDB.
  const oldRouter = express.Router()
  oldRouter.use(requireAuth)
  oldRouter.get('/:saleId', validate(saleParamSchema, 'params'), (req, res) => res.json({}))
  app.use('/old-api/sales', oldRouter)
  app.use((error, req, res, next) => res.status(error.statusCode ?? 500).json({ message: 'Dashboard read failed.' }))
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.clearAllMocks()
  auth.authenticate.mockResolvedValue({ user: { id: 'operator', shopId: shop, role: 'staff' }, session: { csrfToken: 'offline' } })
  db.sales.mockResolvedValue([{ totals: [], daily: [], categories: [], recentSales: [] }])
  db.ledger.mockResolvedValue([{ balances: [], payments: [] }])
  db.inventory.mockResolvedValue(0)
})
const read = path => fetch(`${base}${path}`, { headers: { Cookie: 'offline' } })

describe('dashboard route + real reporting service contract (offline model mocks)', () => {
  it.each(['', `&regionId=${region}`])('returns HTTP 200 for the exact same-day request and optional region %s', async selection => {
    const response = await read(`/api/v1/sales/dashboard${query}${selection}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('server-timing')).toMatch(/^dashboard;dur=/)
    const body = await response.json()
    expect(body).toMatchObject({ from: '2026-10-18', to: '2026-10-18', regionId: selection ? region : null,
      metrics: { orders: 0, salesPkr: 0, averageOrderPkr: 0, creditSalesPkr: 0, stockKg: 0 },
      daily: [{ date: '2026-10-18', salesPkr: 0 }], categories: [], recentSales: [],
      khata: { outstandingPkr: 0, customers: 0, paymentsTodayPkr: 0 } })
    const match = db.sales.mock.calls[0][0][0].$match
    expect(String(match.shop)).toBe(shop)
    expect(match.businessDate).toEqual({ $gte: '2026-10-18', $lte: '2026-10-18' })
    expect(match.status).toEqual({ $in: ['completed', 'pending'] })
    if (selection) expect(String(match.sellingRegion)).toBe(region)
    else expect(match).not.toHaveProperty('sellingRegion')
  })
  it('defaults missing dates to the Karachi business day', async () => {
    const today = getBusinessDate()
    const response = await read('/api/v1/sales/dashboard')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ from: today, to: today })
    expect(getBusinessDate(new Date('2026-10-17T18:59:59.999Z'))).toBe('2026-10-17')
    expect(getBusinessDate(new Date('2026-10-17T19:00:00.000Z'))).toBe('2026-10-18')
  })
  it('retains real totals and current stock when optional historical sale fields are absent', async () => {
    db.sales.mockResolvedValue([{ totals: [{ orders: 1, salesPkr: 100, creditSalesPkr: 0 }], daily: [{ _id: '2026-10-18', salesPkr: 100 }], categories: [{ _id: 'Not recorded', orders: 1 }], recentSales: [{ _id: 'legacy-sale', businessDate: '2026-10-18', totalAmount: 100, status: 'completed' }] }])
    db.inventory.mockResolvedValue(68)
    const response = await read(`/api/v1/sales/dashboard${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ metrics: { orders: 1, salesPkr: 100, averageOrderPkr: 100, stockKg: 68 }, recentSales: [{ _id: 'legacy-sale' }] })
  })
  it.each(['?from=2026-02-30&to=2026-03-01', '?from=2026-10-18', '?from=2026-10-19&to=2026-10-18', `${query}&regionId=bad`, `${query}&shop=${region}`])('rejects actual invalid input before querying models: %s', async suffix => {
    expect((await read(`/api/v1/sales/dashboard${suffix}`)).status).toBe(400)
    expect(db.sales).not.toHaveBeenCalled()
    expect(db.inventory).not.toHaveBeenCalled()
    expect(db.ledger).not.toHaveBeenCalled()
  })
  it('reproduces HTTP 400 when a running router lacks the dashboard route', async () => {
    const response = await read(`/old-api/sales/dashboard${query}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ message: 'Validation failed.', issues: [{ path: 'saleId', message: 'Invalid ID.' }] })
    expect(db.sales).not.toHaveBeenCalled()
  })
  it.each(['sales', 'ledger', 'inventory'])('returns a genuine error when the %s read fails', async source => {
    db[source].mockRejectedValue(new Error('Private database diagnostic'))
    const response = await read(`/api/v1/sales/dashboard${query}`)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('Private database diagnostic')
  })
})

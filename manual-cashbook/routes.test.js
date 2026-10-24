// Route-contract fixtures assume a consumed approval; real enforcement is covered in authRoutes/actionAuthorization tests.
vi.mock('../services/actionAuthorization.js', async importOriginal => ({ ...await importOriginal(), consumeApproval: vi.fn(async () => {}) }))
import express from 'express'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), status: vi.fn(), overview: vi.fn(), byDate: vi.fn(), history: vi.fn(), details: vi.fn(), save: vi.fn(), void: vi.fn(), replace: vi.fn() }))
vi.mock('../services/authService.js', () => ({ AuthError: class extends Error {}, authenticate: mocks.auth, sessionToken: headers => ({ token: headers.cookie, cookieAuth: true }) }))
vi.mock('./service.js', () => ({ status: mocks.status, overview: mocks.overview, getByDate: mocks.byDate, history: mocks.history, details: mocks.details, saveDay: mocks.save, voidDay: mocks.void, replaceDay: mocks.replace }))
import { manualCashRoutes } from './routes.js'
import { AuthError } from '../services/authService.js'
import { getClientOrigins } from '../config/clientOrigins.js'
import { env } from '../config/env.js'
let server, base
const key = '123e4567-e89b-42d3-a456-426614174000', recordId = '507f1f77bcf86cd799439001'
const input = { key, businessDate: '2026-10-21', shopCashAmount: 7000, bossAddedAmount: 3000 }
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/cashbook', manualCashRoutes)
  app.use((error, req, res, next) => res.status(error.statusCode ?? 500).json({ message: error.message }))
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/cashbook`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'operator', shopId: 'own-shop', role: 'owner' }, session: { csrfToken: 'test-csrf' } })
  mocks.byDate.mockImplementation(async (shop, date) => ({ date, record: null }))
  mocks.status.mockResolvedValue({ ready: false, mode: 'manual_daily' })
  mocks.history.mockResolvedValue({ rows: [] }); mocks.save.mockResolvedValue({ postedRevision: 0, record: { businessDate: input.businessDate } })
})
function write(path, body = input, method = 'POST', headers = {}) {
  return fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: 'test', origin: getClientOrigins(env)[0], 'x-csrf-token': 'test-csrf', ...headers }, body: JSON.stringify(body) })
}
describe('manual daily routes, real auth/CSRF middleware with mocked authentication/storage', () => {
  it.each([400, 404, 409, 500])('returns correction service HTTP %s without acknowledging a save', async statusCode => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error(statusCode === 409 ? 'This day was corrected by another operator. Reload the saved record before correcting it.' : 'Offline correction failure'), { statusCode }))
    const correction = { key, expectedRevision: 0, shopCashAmount: 25000, bossAddedAmount: 4000, reason: 'Recounted shop cash' }
    const response = await write(`/records/${recordId}`, correction, 'PATCH')
    expect(response.status).toBe(statusCode)
    expect(await response.json()).not.toHaveProperty('record')
  })
  it('rejects an expired correction session before storage is called', async () => {
    mocks.auth.mockRejectedValueOnce(new AuthError('Sign in again'))
    const response = await write(`/records/${recordId}`, { key, expectedRevision: 0, shopCashAmount: 25000, bossAddedAmount: 4000, reason: 'Recounted cash' }, 'PATCH')
    expect(response.status).toBe(401)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('authorizes audited void/replacement, derives scope and rejects unsupported fields or missing reasons', async () => {
    mocks.void.mockResolvedValue({ postedRevision: 1 })
    mocks.replace.mockResolvedValue({ postedRevision: 2 })
    const command = { key, expectedRevision: 0, reason: 'Wrong manual amount' }
    expect((await write(`/records/${recordId}/void`, command)).status).toBe(200)
    expect(mocks.void).toHaveBeenCalledWith('own-shop', 'operator', command, recordId)
    for (const extra of [{ reason: '' }, { expectedRevision: -1 }, { shop: 'other' }, { voidedBy: 'other' }, { totalCollected: 0 }]) expect((await write(`/records/${recordId}/void`, { ...command, ...extra })).status).toBe(400)
    expect((await write(`/records/${recordId}/void`, command, 'POST', { 'x-csrf-token': '' })).status).toBe(403)
    const replacement = { ...command, expectedRevision: 1, shopCashAmount: 20000, bossAddedAmount: 4000 }
    expect((await write(`/records/${recordId}/replace`, replacement)).status).toBe(200)
    expect(mocks.replace).toHaveBeenCalledWith('own-shop', 'operator', { ...replacement, notes: '' }, recordId)
    mocks.auth.mockResolvedValue({ user: { id: 'staff', shopId: 'own-shop', role: 'staff' }, session: { csrfToken: 'test-csrf' } })
    expect((await write(`/records/${recordId}/void`, command)).status).toBe(403)
    expect((await write(`/records/${recordId}/replace`, replacement)).status).toBe(403)
  })
  it('preserves duplicate-day and permission error codes for truthful client recovery', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('A record already exists for this day.'), { statusCode: 409, code: 'MANUAL_CASH_DAY_EXISTS' }))
    const response = await write('/records')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'MANUAL_CASH_DAY_EXISTS' })
    mocks.status.mockRejectedValueOnce(Object.assign(new Error('Review database access.'), { statusCode: 503, code: 'MANUAL_CASH_PERMISSION_REQUIRED' }))
    expect(await (await fetch(`${base}/status`)).json()).toMatchObject({ code: 'MANUAL_CASH_PERMISSION_REQUIRED' })
  })
  it('requires authentication and retains staff restrictions', async () => {
    mocks.auth.mockRejectedValueOnce(new AuthError('Sign in'))
    expect((await fetch(`${base}/status`)).status).toBe(401)
    mocks.auth.mockResolvedValue({ user: { id: 'staff', shopId: 'own-shop', role: 'staff' }, session: { csrfToken: 'test-csrf' } })
    expect((await fetch(`${base}/records`)).status).toBe(403)
    expect((await write('/records')).status).toBe(403); expect(mocks.save).not.toHaveBeenCalled()
  })
  it('requires a trusted origin and CSRF for daily entries and corrections', async () => {
    expect((await write('/records', input, 'POST', { 'x-csrf-token': '' })).status).toBe(403)
    expect((await write(`/records/${recordId}`, input, 'PATCH', { origin: 'https://foreign.invalid' })).status).toBe(403)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('derives operator/shop scope only from authentication and rejects client-computed amounts', async () => {
    expect((await write('/records')).status).toBe(200)
    expect(mocks.save).toHaveBeenCalledWith('own-shop', 'operator', { ...input, notes: '' })
    for (const extra of [{ shop: 'foreign' }, { enteredBy: 'foreign' }, { totalCollected: 1 }, { remainingCash: 100 }, { takenHomeAmount: 0 }]) expect((await write('/records', { ...input, ...extra })).status).toBe(400)
    expect((await fetch(`${base}/records?shop=foreign`)).status).toBe(400)
  })
  it('validates nonnegative whole PKR, dates and stable request keys', async () => {
    for (const bad of [{ shopCashAmount: -1 }, { bossAddedAmount: 1.5 }, { key: '' }, { businessDate: '2026-02-30' }]) expect((await write('/records', { ...input, ...bad })).status).toBe(400)
    expect((await fetch(`${base}/records?page=0`)).status).toBe(400)
    expect((await fetch(`${base}/records?limit=51`)).status).toBe(400)
    expect((await fetch(`${base}/records?from=2026-10-21&to=2026-10-20`)).status).toBe(400)
  })
  it('requires expected revision and reason for correction, forbidding date/operator replacement', async () => {
    const { businessDate, ...values } = input
    expect((await write(`/records/${recordId}`, values, 'PATCH')).status).toBe(400)
    const correction = { ...values, expectedRevision: 0, reason: 'Verified manual correction' }
    expect((await write(`/records/${recordId}`, correction, 'PATCH')).status).toBe(200)
    expect(mocks.save).toHaveBeenCalledWith('own-shop', 'operator', { ...correction, notes: '' }, recordId)
    expect((await write(`/records/${recordId}`, { ...correction, businessDate }, 'PATCH')).status).toBe(400)
  })
  it('returns explicit missing-day data and shop-scoped historical filters', async () => {
    const response = await fetch(`${base}/records/by-date/2026-10-20`)
    expect(await response.json()).toEqual({ date: '2026-10-20', record: null })
    expect(mocks.byDate).toHaveBeenCalledWith('own-shop', '2026-10-20')
    await fetch(`${base}/records?from=2026-10-01&to=2026-10-20&page=2`)
    expect(mocks.history).toHaveBeenCalledWith('own-shop', { from: '2026-10-01', to: '2026-10-20', page: 2, limit: 20 })
  })
  it('distinguishes setup readiness from network/permission errors and retires old posting routes', async () => {
    mocks.overview.mockRejectedValueOnce(Object.assign(new Error('Indexes need approved setup'), { statusCode: 503, code: 'MANUAL_CASH_SETUP_REQUIRED' }))
    const response = await fetch(`${base}/overview`)
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'MANUAL_CASH_SETUP_REQUIRED' })
    expect((await write('/opening')).status).toBe(404); expect((await write('/movements')).status).toBe(404)
    expect((await write(`/records/${recordId}`, input, 'DELETE')).status).toBe(404)
  })
})

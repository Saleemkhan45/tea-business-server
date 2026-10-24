// Route-contract fixtures assume a consumed approval; real enforcement is covered in authRoutes/actionAuthorization tests.
vi.mock('../services/actionAuthorization.js', async importOriginal => ({ ...await importOriginal(), consumeApproval: vi.fn(async () => {}) }))
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
const service = vi.hoisted(() => ({ createPurchase: vi.fn(), listPurchases: vi.fn(), receivePurchase: vi.fn(), payPurchase: vi.fn(), voidPurchase: vi.fn(), purchaseOptions: vi.fn(), createSupplier: vi.fn() }))
const suppliers = vi.hoisted(() => ({ listSuppliers: vi.fn(), saveSupplier: vi.fn(), supplierDetails: vi.fn(), reconcileSupplier: vi.fn() }))
vi.mock('../services/supplierService.js', () => suppliers)
const auth = vi.hoisted(() => ({ authenticate: vi.fn() }))
const profile = vi.hoisted(() => ({ details: vi.fn(), history: vi.fn() }))
vi.mock('../services/supplierProfileService.js', async original => ({ ...await original(), supplierProfile: profile.details, supplierHistory: profile.history }))
vi.mock('../services/purchaseService.js', () => service)
vi.mock('../services/authService.js', () => ({ authenticate: auth.authenticate, sessionToken: headers => ({ token: headers.cookie, cookieAuth: true }), AuthError: class extends Error {} }))
import { purchaseRoutes } from './purchaseRoutes.js'
let server, base
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/purchases', purchaseRoutes)
  app.use((error, req, res, next) => res.status(500).json({ message: 'Unavailable' }))
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/purchases`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => { vi.resetAllMocks(); auth.authenticate.mockResolvedValue({ user: { id: 'operator', shopId: 'authorized-shop', role: 'admin' }, session: { csrfToken: 'offline-token' } }); for (const fn of Object.values(service)) fn.mockResolvedValue([]) })
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'offline', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token', ...headers }, body: JSON.stringify(body) })
describe('purchase routes offline scope and security', () => {
  it('serves bounded supplier profile tabs using authenticated ownership and validated filters', async () => {
    profile.details.mockResolvedValue({ supplier: { name: 'Stored supplier' } }); profile.history.mockResolvedValue({ rows: [], total: 0 })
    const supplierId = '507f1f77bcf86cd799439001'
    expect((await fetch(`${base}/suppliers/${supplierId}/profile`, { headers: { Cookie: 'offline' } })).status).toBe(200)
    expect(profile.details).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', supplierId }))
    expect((await fetch(`${base}/suppliers/${supplierId}/history?tab=purchases&page=2&limit=10`, { headers: { Cookie: 'offline' } })).status).toBe(200)
    expect(profile.history).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', supplierId, tab: 'purchases', page: 2, limit: 10 }))
    for (const query of ['tab=purchases&limit=999', 'tab=secret', 'tab=purchases&shop=foreign']) expect((await fetch(`${base}/suppliers/${supplierId}/history?${query}`, { headers: { Cookie: 'offline' } })).status).toBe(400)
  })
  it('uses authenticated scope for purchase and payment writes', async () => {
    const body = { shop: 'foreign', actor: 'forged', supplier: 'supplier', idempotencyKey: 'intent' }
    expect((await post('', body)).status).toBe(201)
    expect(service.createPurchase).toHaveBeenCalledWith({ ...body, shop: 'authorized-shop', actor: 'operator' })
    expect((await post('/purchase/payments', body)).status).toBe(201)
    expect(service.payPurchase).toHaveBeenCalledWith({ ...body, shop: 'authorized-shop', actor: 'operator', purchaseId: 'purchase' })
  })
  it('does not accept arbitrary receipt fields or a foreign query shop', async () => {
    await post('/purchase/receive', { shop: 'foreign', actor: 'forged', quantityKg: 999 })
    expect(service.receivePurchase).toHaveBeenCalledWith({ shop: 'authorized-shop', actor: 'operator', purchaseId: 'purchase' })
    await fetch(`${base}?shop=foreign&regionId=region`, { headers: { Cookie: 'offline' } })
    expect(service.listPurchases).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', regionId: 'region' }))
  })
  it('rejects missing CSRF, untrusted origins and unavailable authentication before writes', async () => {
    expect((await post('', {}, { 'X-CSRF-Token': '' })).status).toBe(403)
    expect((await post('', {}, { Origin: 'https://untrusted.invalid' })).status).toBe(403)
    auth.authenticate.mockRejectedValue(new Error('Unavailable'))
    expect((await post('', {})).status).toBe(503)
    expect(service.createPurchase).not.toHaveBeenCalled()
  })
  it('preserves permission and conflict responses without exposing database details', async () => {
    service.voidPurchase.mockRejectedValue(Object.assign(new Error('Supplier refund required.'), { statusCode: 409 }))
    expect((await post('/purchase/void', { reason: 'Return' })).status).toBe(409)
    service.createPurchase.mockRejectedValue(Object.assign(new Error('Private index text'), { code: 11000 }))
    const response = await post('', {}); expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain('Private index')
  })
})


describe('supplier routes offline security', () => {
  it('uses authenticated shop for directory, details, creation and edits', async () => {
    suppliers.listSuppliers.mockResolvedValue({ suppliers: [] }); suppliers.supplierDetails.mockResolvedValue({ supplier: {} }); suppliers.saveSupplier.mockResolvedValue({ _id: 'supplier' })
    await fetch(`${base}/suppliers?shop=foreign&search=tea`, { headers: { Cookie: 'offline' } })
    expect(suppliers.listSuppliers).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', search: 'tea' }))
    await fetch(`${base}/suppliers/supplier?shop=foreign`, { headers: { Cookie: 'offline' } })
    expect(suppliers.supplierDetails).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', supplierId: 'supplier' }))
    await post('/suppliers', { name: 'S', shop: 'foreign', actor: 'forged', supplierId: 'injected' })
    expect(suppliers.saveSupplier).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', actor: 'operator', supplierId: undefined }))
    const response = await fetch(`${base}/suppliers/supplier`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: 'offline', Origin: env.clientOrigin, 'X-CSRF-Token': 'offline-token' }, body: JSON.stringify({ name: 'Changed', revision: 2, shop: 'foreign', actor: 'forged' }) })
    expect(response.status).toBe(200)
    expect(suppliers.saveSupplier).toHaveBeenLastCalledWith(expect.objectContaining({ supplierId: 'supplier', revision: 2, shop: 'authorized-shop', actor: 'operator' }))
  })
  it('rejects supplier writes without CSRF and unauthenticated reads', async () => {
    expect((await post('/suppliers', { name: 'S' }, { 'X-CSRF-Token': '' })).status).toBe(403)
    expect(suppliers.saveSupplier).not.toHaveBeenCalled()
    auth.authenticate.mockRejectedValue(new Error('Unavailable'))
    expect((await fetch(`${base}/suppliers`, { headers: { Cookie: 'offline' } })).status).toBe(503)
    expect(suppliers.listSuppliers).not.toHaveBeenCalled()
  })
  it('keeps supplier duplicates and key conflicts specific without leaking driver details', async () => {
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('A supplier with this name already exists.'), { statusCode: 409, code: 'SUPPLIER_ALREADY_EXISTS', existingSupplierId: 'existing' }))
    const duplicate = await post('/suppliers', { name: 'S' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ code: 'SUPPLIER_ALREADY_EXISTS', message: 'A supplier with this name already exists.', existingSupplierId: 'existing' })
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('Request key conflict.'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' }))
    expect(await (await post('/suppliers', { name: 'S' })).json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('Private index and credential details'), { code: 11000 }))
    const response = await post('/suppliers', { name: 'S' })
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'SUPPLIER_SAVE_FAILED' })
    expect(JSON.stringify(body)).not.toMatch(/Private|purchase operation|credential|index/)
  })
  it('returns supplier validation and unavailable database errors separately', async () => {
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('Invalid'), { name: 'ZodError', issues: [{ path: ['productOfferings'], message: 'Duplicate offerings' }] }))
    const validation = await post('/suppliers', {})
    expect(validation.status).toBe(400)
    expect(await validation.json()).toMatchObject({ code: 'SUPPLIER_VALIDATION_FAILED', issues: [{ path: 'productOfferings', message: 'Duplicate offerings' }] })
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('Private server address'), { name: 'MongoServerSelectionError' }))
    const unavailable = await post('/suppliers', {})
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' })
    suppliers.saveSupplier.mockRejectedValueOnce(Object.assign(new Error('Saving could not be confirmed.'), { statusCode: 503, code: 'SUPPLIER_SAVE_FAILED', outcomeUncertain: true }))
    expect(await (await post('/suppliers', {})).json()).toMatchObject({ outcomeUncertain: true, code: 'SUPPLIER_SAVE_FAILED' })
  })
  it('scopes read-only reconciliation to the authenticated shop', async () => {
    suppliers.reconcileSupplier.mockResolvedValue({ status: 'unconfirmed' })
    const response = await fetch(`${base}/suppliers/reconcile?shop=foreign&creationIdempotencyKey=request-key`, { headers: { Cookie: 'offline' } })
    expect(response.status).toBe(200)
    expect(suppliers.reconcileSupplier).toHaveBeenCalledWith(expect.objectContaining({ shop: 'authorized-shop', creationIdempotencyKey: 'request-key' }))
    expect(suppliers.saveSupplier).not.toHaveBeenCalled()
  })
})


import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const rateStores = vi.hoisted(() => [])
vi.mock('express-rate-limit', async importOriginal => {
  const original = await importOriginal()
  return { ...original, rateLimit: options => {
    const store = new original.MemoryStore()
    rateStores.push(store)
    return original.rateLimit({ ...options, store })
  } }
})
const db = vi.hoisted(() => ({ userFind: vi.fn(), userById: vi.fn(), userUpdate: vi.fn(), shopFind: vi.fn(), sessionFind: vi.fn(), sessionCreate: vi.fn(), sessionUpdate: vi.fn(), sessionConsume: vi.fn(), customerProfile: vi.fn(), entryOptions: vi.fn() }))
vi.mock('../models/User.js', () => ({ User: { findOne: db.userFind, findById: db.userById, updateOne: db.userUpdate, collection: { indexes: async () => [{ key: { email: 1 }, unique: true }] } } }))
const mail = vi.hoisted(() => ({ send: vi.fn(), available: true }))
vi.mock('../services/securityEmail.js', () => ({ emailDeliveryConfigured: () => mail.available, sendSecurityEmail: mail.send }))
vi.mock('../models/Shop.js', () => ({ Shop: { findOne: db.shopFind } }))
vi.mock('../models/AuthSession.js', () => ({ AuthSession: { findOne: db.sessionFind, create: db.sessionCreate, updateOne: db.sessionUpdate, findOneAndUpdate: db.sessionConsume } }))
vi.mock('../services/customerDirectoryService.js', () => ({ getCustomerById: db.customerProfile }))
vi.mock('../services/saleService.js', () => ({ getEntryOptions: db.entryOptions }))
import { createApp } from '../app.js'
import { env } from '../config/env.js'
import { hashPassword } from '../utils/passwords.js'
import { Item } from '../models/Item.js'
import { ITEM_TEA_TYPES } from '../constants/teaCategories.js'

const userId = '507f1f77bcf86cd799439011'
const shopId = '507f1f77bcf86cd799439012'
const customerId = '507f1f77bcf86cd799439013'
const password = 'offline-test-password-only'
let user
let sessions
let server
let baseUrl
let passwordHash
function query(result) { return { select() { return this }, lean: async () => result } }
async function signIn(body = { email: 'owner@example.invalid', password }, origin = env.clientOrigin) {
  return fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
}
async function signedSession() {
  const response = await signIn()
  expect(response.status).toBe(200)
  return { cookie: response.headers.get('set-cookie').split(';')[0], body: await response.json() }
}
beforeAll(async () => {
  passwordHash = await hashPassword(password)
  server = createApp().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)); vi.restoreAllMocks() })
beforeEach(() => {
  vi.clearAllMocks()
  rateStores.forEach(store => store.resetAll())
  mail.available = true
  mail.send.mockResolvedValue(undefined)
  user = { _id: userId, shop: shopId, name: 'Shop Owner', email: 'owner@example.invalid', passwordHash, role: 'owner', status: 'active' }
  sessions = new Map()
  db.userFind.mockImplementation(filter => query((filter.email ? filter.email === user.email : String(filter._id) === userId) && (!filter.shop || String(filter.shop) === String(user.shop)) ? user : null))
  db.userById.mockImplementation(id => query(id === userId ? user : null))
  db.shopFind.mockImplementation(filter => query(String(filter._id) === shopId ? { _id: shopId, name: 'Approved Shop', status: 'active' } : null))
  db.sessionCreate.mockImplementation(async data => { const session = { _id: 'session-1', revokedAt: null, ...data }; sessions.set(data.tokenHash, session); return session })
  db.sessionFind.mockImplementation(filter => {
    const session = sessions.get(filter.tokenHash)
    return query(session && session.revokedAt === null && session.expiresAt > filter.expiresAt.$gt ? structuredClone(session) : null)
  })
  db.sessionUpdate.mockImplementation(async (_filter, update) => {
    sessions.forEach(session => { if (update.$push?.approvals) session.approvals = [...session.approvals ?? [], ...update.$push.approvals.$each].slice(-32); else session.revokedAt = new Date() })
    return { matchedCount: 1 }
  })
  db.sessionConsume.mockImplementation((filter, update) => {
    if (!filter.approvals) {
      const session = [...sessions.values()].find(row => row._id === filter._id && !row.revokedAt)
      if (session && session.expiresAt.getTime() === filter.expiresAt.getTime()) {
        // Emulate the atomic expiration comparison used by renewal.
        Object.assign(session, update.$set)
        return query(structuredClone(session))
      }
      return query(null)
    }
    const session = [...sessions.values()].find(row => row._id === filter._id && !row.revokedAt)
    const match = filter.approvals.$elemMatch
    const grant = session?.approvals?.find(row => row.tokenHash === match.tokenHash && row.actionHash === match.actionHash && !row.usedAt && row.expiresAt > match.expiresAt.$gt)
    const previous = grant ? structuredClone(session) : null
    if (grant) grant.usedAt = new Date()
    return query(previous)
  })
  db.userUpdate.mockImplementation(async (filter, update) => {
    if (filter.passwordHash !== user.passwordHash) return { modifiedCount: 0 }
    Object.assign(user, update.$set); user.authVersion = (user.authVersion ?? 0) + 1
    if (!update.$inc?.authVersion) user.authVersion -= 1
    for (const key of Object.keys(update.$unset ?? {})) delete user[key]
    user.securityEvents = [...user.securityEvents ?? [], update.$push.securityEvents]
    return { modifiedCount: 1 }
  })
  db.customerProfile.mockResolvedValue({ id: customerId, name: 'Customer' })
  db.entryOptions.mockResolvedValue({ operator: { id: userId, name: user.name }, items: [] })
})

describe('offline authentication routes', () => {
  it('creates trusted-device cookies with 30-day persistence and restores without another login', async () => {
    const response = await signIn({ email: user.email, password, trustedDevice: true })
    expect(response.status).toBe(200)
    const session = await response.json()
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/Max-Age=259\d{4}/)
    expect(Date.parse(session.expiresAt) - Date.parse(session.serverTime)).toBeGreaterThan(29 * 86400000)
    expect(session.persistent).toBe(true)
    expect(Date.parse(session.absoluteExpiresAt) - Date.parse(session.serverTime)).toBeGreaterThan(179 * 86400000)
    const restored = await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie.split(';')[0] } })
    expect(restored.status).toBe(200)
    expect(restored.headers.get('set-cookie')).toBeNull()
    expect((await restored.json()).user.id).toBe(userId)
  })
  it('rejects invalid CSRF and expired sessions without attempting renewal', async () => {
    const { cookie, body } = await signedSession()
    const endpoint = `${baseUrl}/api/v1/auth/session/renew`
    expect((await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect(db.sessionConsume).not.toHaveBeenCalled()
    sessions.forEach(session => { session.expiresAt = new Date(0) })
    expect((await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
  })
  it('persists an eligible renewal before sending matching cookie and session expirations', async () => {
    const response = await signIn({ email: user.email, password, trustedDevice: true })
    const body = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0]
    sessions.forEach(session => { session.lastRenewedAt = new Date(Date.now() - 2 * 86400000) })
    const renewed = await fetch(`${baseUrl}/api/v1/auth/session/renew`, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' }, body: '{}' })
    expect(renewed.status).toBe(200)
    const result = await renewed.json()
    expect(result.absoluteExpiresAt).toBe(body.absoluteExpiresAt)
    expect(new Date([...sessions.values()][0].expiresAt).toISOString()).toBe(result.expiresAt)
    expect(renewed.headers.get('set-cookie')).toContain('HttpOnly')
    expect(db.sessionConsume).toHaveBeenCalledTimes(1)
  })
  it.each(['owner', 'admin'])('validates %s email changes, requires CSRF, revokes old sessions and accepts the new login', async role => {
    user.role = role
    const { cookie, body } = await signedSession()
    const path = `${baseUrl}/api/v1/auth/change-email`
    const headers = { Cookie: cookie, Origin: env.clientOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrfToken }
    mail.available = false
    const payload = { currentPassword: password, newEmail: 'NEW@example.invalid', confirmNewEmail: ' new@example.invalid ' }
    expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ ...payload, userId: 'forged-account', shopId: 'foreign-shop' }) })).status).toBe(400)
    expect((await fetch(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body: JSON.stringify(payload) })).status).toBe(403)
    expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ ...payload, newEmail: 'invalid' }) })).status).toBe(400)
    expect(db.userUpdate).not.toHaveBeenCalled()
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(payload) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ changed: true, signInRequired: true })
    expect(mail.send).not.toHaveBeenCalled()
    expect(user.emailVerifiedAt).toBeUndefined()
    expect(user._id).toBe(userId)
    expect(user.shop).toBe(shopId)
    expect(user.role).toBe(role)
    expect(user.email).toBe('new@example.invalid')
    expect(user.passwordHash).toBe(passwordHash)
    expect(user.securityEvents.at(-1).action).toBe('email_changed_direct')
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await signIn()).status).toBe(401)
    expect((await signIn({ email: user.email, password })).status).toBe(200)
  })
  it('keeps new database-backed sessions valid across process signing-key changes', async () => {
    const { cookie } = await signedSession(), previous = env.jwtSecret
    try {
      expect(cookie).toContain('v2_')
      env.jwtSecret = 'another-process-key-used-only-in-offline-test'
      expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status).toBe(200)
    } finally { env.jwtSecret = previous }
  })
  it('allows trusted viewing only behind the configured peer/secret and keeps copied cookies private', async () => {
    const previous = { ...env }
    try {
      Object.assign(env, { trustedStaffEnabled: true, trustedStaffShop: shopId, trustedStaffUser: userId, trustedProxySecret: 's'.repeat(48), trustedProxyAddresses: ['127.0.0.1'], trustedStaffResources: ['customers'] })
      expect((await fetch(`${baseUrl}/api/v1/auth/staff-session`, { method: 'POST', headers: { Origin: env.clientOrigin } })).status).toBe(403)
      const response = await fetch(`${baseUrl}/api/v1/auth/staff-session`, { method: 'POST', headers: { Origin: env.clientOrigin, 'X-Tea-Trusted-Boundary': 's'.repeat(48) } })
      expect(response.status).toBe(200)
      const cookie = response.headers.get('set-cookie').split(';')[0]
      const headers = { Cookie: cookie, 'X-Tea-Trusted-Boundary': 's'.repeat(48) }
      expect((await response.json()).accessMode).toBe('trusted-view')
      expect((await fetch(`${baseUrl}/api/v1/customers/${customerId}`, { headers })).status).toBe(200)
      expect((await fetch(`${baseUrl}/api/v1/customers/${customerId}`, { headers: { Cookie: cookie } })).status).toBe(403)
      expect((await fetch(`${baseUrl}/api/v1/sales`, { headers })).status).toBe(403)
    } finally { Object.assign(env, previous) }
  })
  it.each(['owner', 'admin'])('persists %s password changes, rejects mismatch, and revokes old sessions', async role => {
    user.role = role
    const { cookie, body } = await signedSession()
    const headers = { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' }
    const path = `${baseUrl}/api/v1/auth/change-password`
    expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ currentPassword: password, newPassword: 'new offline passphrase', confirmPassword: 'mismatch password' }) })).status).toBe(400)
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ currentPassword: password, newPassword: 'new offline passphrase', confirmPassword: 'new offline passphrase' }) })
    expect(response.status).toBe(200); expect((await response.json()).changed).toBe(true)
    expect(user.securityEvents[0].action).toBe('password_changed')
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await signIn()).status).toBe(401)
    expect((await signIn({ email: user.email, password: 'new offline passphrase' })).status).toBe(200)
  })
  it('protects delivery configuration and simulated tests with shop roles and existing CSRF', async () => {
    expect((await fetch(`${baseUrl}/api/v1/whatsapp/conversations`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/v1/notifications/collections/capabilities`)).status).toBe(401)
    const { cookie, body } = await signedSession()
    expect((await fetch(`${baseUrl}/api/v1/whatsapp/conversations/${customerId}/reply`, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin } })).status).toBe(403)
    const endpoint = `${baseUrl}/api/v1/notifications/collections/test`
    expect((await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin } })).status).toBe(403)
    const approval = await fetch(`${baseUrl}/api/v1/auth/authorize`, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, method: 'POST', path: '/api/v1/notifications/collections/test', payload: {} }) }).then(response => response.json())
    const simulation = await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken, 'X-Action-Authorization': approval.token, 'Content-Type': 'application/json' }, body: '{}' })
    expect(simulation.status).toBe(200)
    expect((await simulation.json()).status).toBe('simulated')
    user.role = 'staff'
    expect((await fetch(`${baseUrl}/api/v1/whatsapp/integration`, { headers: { Cookie: cookie } })).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/v1/notifications/collections/settings`, { headers: { Cookie: cookie } })).status).toBe(403)
  })
  it('logs in with a verified password, sets an HttpOnly cookie and never exposes credentials or JWT', async () => {
    const response = await signIn({ email: ' OWNER@example.invalid ', password })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await response.json()
    expect(result.user).toMatchObject({ id: userId, name: 'Shop Owner', shopId })
    expect(result).not.toHaveProperty('token')
    expect(result.user).not.toHaveProperty('passwordHash')
    expect(db.sessionCreate).toHaveBeenCalledWith(expect.objectContaining({ user: userId, shop: shopId, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
  })

  it.each([
    { email: 'owner@example.invalid', password: 'wrong-password' },
    { email: 'missing@example.invalid', password },
  ])('uses the same invalid-credentials response without creating a session: %j', async credentials => {
    const response = await signIn(credentials)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Incorrect email or password.' })
    expect(db.sessionCreate).not.toHaveBeenCalled()
  })

  it('does not grant login to an existing demo user without a password hash', async () => {
    user.passwordHash = undefined
    expect((await signIn()).status).toBe(401)
    expect(db.sessionCreate).not.toHaveBeenCalled()
  })

  it('rejects inactive users and inactive shops', async () => {
    user.status = 'inactive'
    expect((await signIn()).status).toBe(401)
    user.status = 'active'
    db.shopFind.mockImplementation(() => query(null))
    expect((await signIn()).status).toBe(401)
  })

  it('requires a trusted origin and valid login fields', async () => {
    expect((await signIn(undefined, 'https://attacker.invalid')).status).toBe(403)
    expect((await signIn({ email: 'invalid', password: '' })).status).toBe(400)
    expect(db.sessionCreate).not.toHaveBeenCalled()
  })

  it('restores a valid session and protects customer and inventory-option requests with current shop ownership', async () => {
    const { cookie } = await signedSession()
    const headers = { Cookie: cookie }
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/v1/customers/${customerId}`, { headers })).status).toBe(200)
    expect(db.customerProfile).toHaveBeenCalledWith({ customerId, shop: shopId })
    expect((await fetch(`${baseUrl}/api/v1/sales/entry-options`, { headers })).status).toBe(200)
    expect(db.entryOptions).toHaveBeenCalledWith({ shop: shopId, userId })
    user.shop = '507f1f77bcf86cd799439099'
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers })).status).toBe(401)
  })

  it('rejects unauthenticated customer, sales and inventory-option requests before their services run', async () => {
    for (const path of [`customers/${customerId}`, 'sales', 'sales/entry-options']) expect((await fetch(`${baseUrl}/api/v1/${path}`)).status).toBe(401)
    expect(db.customerProfile).not.toHaveBeenCalled()
    expect(db.entryOptions).not.toHaveBeenCalled()
  })

  it('revokes the session on logout so copying the old cookie or bearer token cannot reuse it', async () => {
    const { cookie, body } = await signedSession()
    const headers = { Cookie: cookie, Origin: env.clientOrigin, 'X-CSRF-Token': body.csrfToken }
    const response = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${cookie.slice(cookie.indexOf('=') + 1)}` } })).status).toBe(401)
  })

  it('rejects unsafe cookie requests without both the CSRF token and trusted Origin', async () => {
    const { cookie, body } = await signedSession()
    expect((await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: env.clientOrigin } })).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'X-CSRF-Token': body.csrfToken } })).status).toBe(403)
    expect(db.sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects expired JWTs even when a session record exists, and rejects legacy demo tokens', async () => {
    const expired = jwt.sign({ sub: userId, jti: 'expired' }, env.jwtSecret, { issuer: 'tea-business-api', audience: 'tea-business-dashboard', expiresIn: -1 })
    sessions.set(createHash('sha256').update(expired).digest('hex'), { user: userId, shop: shopId, expiresAt: new Date(Date.now() + 3600000), revokedAt: null })
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${expired}` } })).status).toBe(401)
    const legacy = jwt.sign({ sub: userId }, env.jwtSecret)
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${legacy}` } })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/v1/auth/demo-token`)).status).toBe(404)
  })

  it('rejects a session issued with an old credential version even if it was created after a password change', async () => {
    const { cookie } = await signedSession()
    user.authVersion = 1
    expect((await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('reports database failures as unavailable rather than expired sessions', async () => {
    const { cookie } = await signedSession()
    db.sessionFind.mockImplementation(() => { throw new Error('offline database failure') })
    const response = await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: 'Authentication is temporarily unavailable.' })
  })
})

it('serves supported Item categories through the complete authenticated API mount without catalog queries', async () => {
  const find = vi.spyOn(Item, 'find').mockImplementation(() => { throw new Error('Category metadata must not query catalog records') })
  try {
    const { cookie } = await signedSession()
    const response = await fetch(`${baseUrl}/api/v1/regional/product-options`, { headers: { Cookie: cookie, Origin: env.clientOrigin, Accept: 'application/json' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(env.clientOrigin)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect((await response.json()).categories).toEqual(ITEM_TEA_TYPES)
    expect(ITEM_TEA_TYPES).toEqual(Item.schema.path('teaType').enumValues)
    expect(ITEM_TEA_TYPES).toContain('Other')
    expect(find).not.toHaveBeenCalled()
    expect((await fetch(`${baseUrl}/api/v1/regional/product-options`)).status).toBe(401)
  } finally { find.mockRestore() }
})
it('demonstrates that OPTIONS 204 does not establish that the category GET route exists', async () => {
  const missing = `${baseUrl}/api/v1/regional/missing-product-options`
  const preflight = await fetch(missing, { method: 'OPTIONS', headers: { Origin: env.clientOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type' } })
  expect(preflight.status).toBe(204)
  const { cookie } = await signedSession()
  expect((await fetch(missing, { headers: { Cookie: cookie, Origin: env.clientOrigin } })).status).toBe(404)
})

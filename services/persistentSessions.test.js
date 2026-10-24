import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), renew: vi.fn(), user: vi.fn(), shop: vi.fn() }))
vi.mock('../models/AuthSession.js', () => ({ AuthSession: { create: db.create, findOne: db.find, findOneAndUpdate: db.renew } }))
vi.mock('../models/User.js', () => ({ User: { findById: db.user } }))
vi.mock('../models/Shop.js', () => ({ Shop: { findOne: db.shop } }))
import { authenticate, createSession, renewSession, setSessionCookie, tokenHash } from './authService.js'
import { sessionPolicy } from '../config/sessionPolicy.js'
import { env } from '../config/env.js'
const day = 86400000
const start = Date.UTC(2026, 9, 22)
const query = result => ({ select() { return this }, lean: async () => structuredClone(result) })
let rows, owner
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start)
  rows = new Map()
  owner = { _id: 'owner', shop: 'shop', name: 'Owner', email: 'offline@example.invalid', role: 'owner', status: 'active', authVersion: 1 }
  db.create.mockImplementation(async row => { rows.set(row.tokenHash, { ...row, _id: 'session', revokedAt: null }); return row })
  db.find.mockImplementation(filter => {
    const row = rows.get(filter.tokenHash)
    return query(row && !row.revokedAt && row.expiresAt > filter.expiresAt.$gt ? row : null)
  })
  db.user.mockImplementation(() => query(owner))
  db.shop.mockImplementation(() => query({ _id: 'shop', name: 'Offline Shop' }))
  db.renew.mockImplementation((filter, update) => {
    const row = rows.get(filter.tokenHash)
    if (!row || row.revokedAt || row.expiresAt.getTime() !== filter.expiresAt.getTime() || row.absoluteExpiresAt <= filter.absoluteExpiresAt.$gt) return query(null)
    Object.assign(row, update.$set)
    return query(row)
  })
})
afterEach(() => vi.useRealTimers())
const create = trusted => createSession(owner, { name: 'Offline Shop' }, 'individual', trusted)
describe('persistent Mongo-backed session lifecycle, offline fixtures', () => {
  it('uses explicit opt-in and matching persistent cookie/database expiry without exposing the token', async () => {
    const { token, session } = await create(true)
    expect(session.persistent).toBe(true)
    expect(Date.parse(session.expiresAt) - start).toBe(sessionPolicy.slidingMs)
    expect(Date.parse(session.absoluteExpiresAt) - start).toBe(sessionPolicy.absoluteMs)
    const row = rows.get(tokenHash(token))
    expect(row.tokenHash).not.toBe(token); expect(JSON.stringify(session)).not.toContain(token)
    const response = { cookie: vi.fn() }
    setSessionCookie(response, token, session)
    expect(response.cookie).toHaveBeenCalledWith(env.cookieName, token, expect.objectContaining({ httpOnly: true, path: '/', maxAge: sessionPolicy.slidingMs, expires: row.expiresAt }))
    expect((await authenticate(token)).user.id).toBe('owner')
  })
  it('keeps standard and trusted-view sessions short and never silently upgrades legacy sessions', async () => {
    const { token, session } = await create(false)
    expect(Date.parse(session.expiresAt) - start).toBe(sessionPolicy.shortMs)
    expect(session.persistent).toBe(false)
    const row = rows.get(tokenHash(token)); delete row.persistent; delete row.absoluteExpiresAt; delete row.lastRenewedAt
    await renewSession(token, row)
    expect(db.renew).not.toHaveBeenCalled()
    const viewing = await createSession(owner, { name: 'Shop' }, 'trusted-view', true)
    expect(viewing.session.persistent).toBe(false)
  })
  it('survives a process signing-key change because new sessions are stored by opaque token hash', async () => {
    const { token } = await create(true)
    const previous = env.jwtSecret
    try { env.jwtSecret = ''; expect((await authenticate(token)).user.id).toBe('owner') }
    finally { env.jwtSecret = previous }
  })
  it('renews an eligible session with a throttled, acknowledged database write', async () => {
    const { token } = await create(true)
    let current = (await authenticate(token)).session
    await renewSession(token, current); expect(db.renew).not.toHaveBeenCalled()
    vi.setSystemTime(start + 2 * day)
    current = await renewSession(token, current)
    expect(current.expiresAt.getTime()).toBe(start + 2 * day + sessionPolicy.slidingMs)
    expect(current.absoluteExpiresAt.getTime()).toBe(start + sessionPolicy.absoluteMs)
    await renewSession(token, current); expect(db.renew).toHaveBeenCalledTimes(1)
    expect(rows.get(tokenHash(token)).expiresAt).toEqual(current.expiresAt)
  })
  it('caps every extension at the absolute limit and rejects expired records even before TTL deletion', async () => {
    const { token } = await create(true)
    const row = rows.get(tokenHash(token))
    row.expiresAt = new Date(start + sessionPolicy.absoluteMs)
    vi.setSystemTime(start + sessionPolicy.absoluteMs - day)
    const renewed = await renewSession(token, (await authenticate(token)).session)
    expect(renewed.expiresAt.getTime()).toBe(start + sessionPolicy.absoluteMs)
    vi.setSystemTime(start + sessionPolicy.absoluteMs)
    await expect(authenticate(token)).rejects.toMatchObject({ statusCode: 401 })
    row.expiresAt = new Date(Date.now() + day)
    await expect(authenticate(token)).rejects.toMatchObject({ statusCode: 401 })
  })
  it('does not revive a concurrently revoked session and safely handles simultaneous renewals', async () => {
    const { token } = await create(true)
    const snapshot = (await authenticate(token)).session
    vi.setSystemTime(start + 2 * day)
    const renewed = await Promise.all([renewSession(token, snapshot), renewSession(token, snapshot)])
    expect(renewed[0].expiresAt).toEqual(renewed[1].expiresAt)
    rows.get(tokenHash(token)).revokedAt = new Date()
    await expect(renewSession(token, snapshot)).rejects.toMatchObject({ statusCode: 401 })
  })
  it('rejects changed credentials, disabled accounts, and tenant mismatches', async () => {
    const { token } = await create(true)
    owner.authVersion++
    await expect(authenticate(token)).rejects.toMatchObject({ statusCode: 401 })
    owner.authVersion--; owner.shop = 'another-shop'
    await expect(authenticate(token)).rejects.toMatchObject({ statusCode: 401 })
    owner.shop = 'shop'; owner.status = 'inactive'
    await expect(authenticate(token)).rejects.toMatchObject({ statusCode: 401 })
  })
  it('does not claim renewal or change cookie expiry after a database write failure', async () => {
    const { token } = await create(true)
    const snapshot = (await authenticate(token)).session
    vi.setSystemTime(start + 2 * day)
    db.renew.mockImplementationOnce(() => { throw new Error('offline database failure') })
    await expect(renewSession(token, snapshot)).rejects.toThrow('offline database failure')
    expect(rows.get(tokenHash(token)).expiresAt).toEqual(snapshot.expiresAt)
  })
})

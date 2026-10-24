import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), indexes: vi.fn(), sessions: vi.fn(), revoke: vi.fn(), verify: vi.fn(), send: vi.fn(), available: true }))
vi.mock('../models/User.js', () => ({ User: { findOne: db.find, updateOne: db.update, collection: { indexes: db.indexes } } }))
vi.mock('../models/AuthSession.js', () => ({ AuthSession: { find: db.sessions, updateMany: db.revoke } }))
vi.mock('../utils/passwords.js', () => ({ verifyPassword: db.verify }))
vi.mock('./securityEmail.js', () => ({ emailDeliveryConfigured: () => db.available, sendSecurityEmail: db.send }))
import { changeSignInEmail, beginEmailChange, verifyEmailChange, getAccount, signOutOtherSessions, updateAccountName, revokeDeviceSession } from './accountSecurity.js'
import { hashToken } from './actionAuthorization.js'
import { env } from '../config/env.js'
const query = value => ({ select() { return this }, lean: async () => value })
let user, req
const body = { currentPassword: 'offline passphrase', newEmail: ' NEW@example.invalid ' }
beforeEach(() => {
  vi.clearAllMocks(); db.available = true
  user = { _id: 'owner', shop: 'shop', email: 'old@example.invalid', passwordHash: 'secret-hash', authVersion: 2, name: 'Owner', role: 'owner', status: 'active' }
  req = { user: { id: 'owner', shopId: 'shop', role: 'owner' }, auth: { session: { _id: 'current', accessMode: 'individual' } }, app: { get: () => undefined } }
  db.find.mockImplementation(filter => query(filter.email ? null : user))
  db.verify.mockResolvedValue(true); db.indexes.mockResolvedValue([{ key: { email: 1 }, unique: true }])
  db.send.mockResolvedValue(undefined); db.revoke.mockResolvedValue({ modifiedCount: 2 })
  db.update.mockImplementation(async (_filter, update) => {
    Object.assign(user, update.$set)
    for (const field of Object.keys(update.$unset ?? {})) delete user[field]
    if (update.$inc?.authVersion) user.authVersion += update.$inc.authVersion
    return { modifiedCount: 1 }
  })
})
async function begin() {
  const result = await beginEmailChange(req, body)
  return { result, token: db.send.mock.calls[0][0].text.match(/#([a-f\d]{64})/)[1] }
}
describe('offline verified email and session security', () => {
  it('resends through password confirmation, replacing the previous token without changing login or sessions', async () => {
    const first = await begin()
    await beginEmailChange(req, body)
    const latestToken = db.send.mock.calls[1][0].text.match(/#([a-f\d]{64})/)[1]
    expect(latestToken).not.toBe(first.token)
    expect(db.verify).toHaveBeenCalledTimes(2)
    expect(user).toMatchObject({ email: 'old@example.invalid', authVersion: 2, passwordHash: 'secret-hash', role: 'owner', shop: 'shop' })
    expect(db.revoke).not.toHaveBeenCalled()
    await expect(verifyEmailChange(req, { token: first.token, currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 400 })
    expect(await verifyEmailChange(req, { token: latestToken, currentPassword: 'pass' })).toMatchObject({ changed: true, email: 'new@example.invalid' })
  })
  it('allows an individually authenticated admin to update only their own verified email', async () => {
    req.user.role = 'admin'; user.role = 'admin'
    const room = vi.fn(() => ({ disconnectSockets: vi.fn() })); req.app.get = () => ({ in: room })
    const { token } = await begin()
    const result = await verifyEmailChange(req, { token, currentPassword: 'pass' })
    expect(result).toMatchObject({ changed: true, email: 'new@example.invalid' })
    expect(user).toMatchObject({ _id: 'owner', shop: 'shop', role: 'admin', passwordHash: 'secret-hash' })
    expect(db.update.mock.calls[1][0]).toMatchObject({ _id: 'owner', shop: 'shop', role: 'admin' })
    expect(db.update.mock.calls[1][1].$set).not.toHaveProperty('role')
    expect(room).toHaveBeenCalledWith('user:owner')
  })
  it('rejects unchanged addresses after normalization without sending mail or writing', async () => {
    await expect(beginEmailChange(req, { ...body, newEmail: ' OLD@EXAMPLE.INVALID ' })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.send).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled()
  })
  it('requires HTTPS verification links in production before persisting a token', async () => {
    const previous = { nodeEnv: env.nodeEnv, clientOrigin: env.clientOrigin }
    try {
      Object.assign(env, { nodeEnv: 'production', clientOrigin: 'http://offline.example.invalid' })
      await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 503 })
      expect(db.update).not.toHaveBeenCalled(); expect(db.send).not.toHaveBeenCalled()
    } finally { Object.assign(env, previous) }
  })
  it('does not deliver when a credential-guarded pending write loses a race', async () => {
    db.update.mockResolvedValueOnce({ modifiedCount: 0 })
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.send).not.toHaveBeenCalled()
  })
  it('admits only one concurrent token consumption and preserves account, password, role and shop', async () => {
    const { token } = await begin()
    const original = { _id: user._id, passwordHash: user.passwordHash, role: user.role, shop: user.shop }
    db.find.mockImplementation(filter => query(filter.email ? null : structuredClone(user)))
    const events = []
    db.update.mockImplementation(async (filter, update) => {
      if (filter.authVersion !== user.authVersion || filter['pendingEmailChange.tokenHash'] !== user.pendingEmailChange?.tokenHash) return { modifiedCount: 0 }
      Object.assign(user, update.$set); delete user.pendingEmailChange; user.authVersion += update.$inc.authVersion; events.push(update.$push.securityEvents)
      return { modifiedCount: 1 }
    })
    const results = await Promise.allSettled([verifyEmailChange(req, { token, currentPassword: 'pass' }), verifyEmailChange(req, { token, currentPassword: 'pass' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(user).toMatchObject({ ...original, email: 'new@example.invalid', authVersion: 3 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'email_changed', previousEmail: 'old@example.invalid', nextEmail: 'new@example.invalid', actor: 'owner' })
    expect(results.find(result => result.status === 'fulfilled').value.email).toBe('new@example.invalid')
  })
  it('revokes a selected other device using an opaque, current-session-bound handle', async () => {
    db.sessions.mockReturnValue(query([{ _id: 'other' }, { _id: 'current' }]))
    req.auth.session.csrfToken = 'offline-csrf'
    await expect(revokeDeviceSession(req, { currentPassword: 'pass', handle: hashToken('wrong:other') })).rejects.toMatchObject({ statusCode: 404 })
    await expect(revokeDeviceSession(req, { currentPassword: 'pass', handle: hashToken('offline-csrf:current') })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.revoke).not.toHaveBeenCalled()
    expect(await revokeDeviceSession(req, { currentPassword: 'pass', handle: hashToken('offline-csrf:other') })).toEqual({ revoked: true })
    expect(db.revoke).toHaveBeenCalledWith(expect.objectContaining({ _id: 'other', user: 'owner', shop: 'shop' }), expect.anything())
  })
  it('updates only the confirmed owner name without changing credentials or financial data', async () => {
    expect(await updateAccountName(req, { name: 'Updated Owner', currentPassword: 'pass' })).toEqual({ changed: true })
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ _id: 'owner', shop: 'shop', authVersion: 2 }), {
      $set: { name: 'Updated Owner' }, $push: { securityEvents: expect.objectContaining({ action: 'profile_updated', actor: 'owner' }) },
    })
    expect(user.email).toBe('old@example.invalid'); expect(user.authVersion).toBe(2)
  })
  it('keeps the old email and stores only a hashed, expiring token until verified', async () => {
    const { result, token } = await begin()
    expect(result.pending).toBe(true); expect(result).not.toHaveProperty('token')
    expect(user.email).toBe('old@example.invalid')
    expect(user.pendingEmailChange).toMatchObject({ email: 'new@example.invalid', tokenHash: hashToken(token), authVersion: 2 })
    expect(user.pendingEmailChange.tokenHash).not.toBe(token)
    expect(user.pendingEmailChange.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60000)
    expect(await verifyEmailChange(req, { token, currentPassword: body.currentPassword })).toMatchObject({ changed: true, signInRequired: true })
    expect(user.email).toBe('new@example.invalid'); expect(user.emailVerifiedAt).toBeInstanceOf(Date)
    expect(user.authVersion).toBe(3); expect(user.pendingEmailChange).toBeUndefined()
    await expect(verifyEmailChange(req, { token, currentPassword: body.currentPassword })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.send.mock.calls[1][0].to).toBe('old@example.invalid')
  })
  it('rejects unavailable delivery, wrong passwords and non-owner identities without writes', async () => {
    db.available = false
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 503 })
    db.available = true; db.verify.mockResolvedValue(false)
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 403 })
    db.verify.mockResolvedValue(true); req.auth.session.accessMode = 'trusted-view'
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 403 })
    req.auth.session.accessMode = 'individual'; req.user.role = 'staff'
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 403 })
    expect(db.update).not.toHaveBeenCalled(); expect(db.send).not.toHaveBeenCalled()
  })
  it('requires the deployed unique index and handles duplicate addresses without overwriting users', async () => {
    db.indexes.mockResolvedValueOnce([])
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 503 })
    db.find.mockImplementation(filter => query(filter.email ? { _id: 'another' } : user))
    await expect(beginEmailChange(req, body)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('rejects expired, wrong and credential-invalidated tokens before writes', async () => {
    const { token } = await begin(); db.update.mockClear()
    await expect(verifyEmailChange(req, { token: '0'.repeat(64), currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 400 })
    user.pendingEmailChange.expiresAt = new Date(0)
    await expect(verifyEmailChange(req, { token, currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 400 })
    user.pendingEmailChange.expiresAt = new Date(Date.now() + 60000); user.authVersion++
    await expect(verifyEmailChange(req, { token, currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('guards atomic consumption and rejects a duplicate or concurrent save', async () => {
    const { token } = await begin()
    db.update.mockRejectedValueOnce(Object.assign(new Error('private db message'), { code: 11000 }))
    await expect(verifyEmailChange(req, { token, currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 409 })
    db.update.mockResolvedValueOnce({ modifiedCount: 0 })
    await expect(verifyEmailChange(req, { token, currentPassword: 'pass' })).rejects.toMatchObject({ statusCode: 409 })
    expect(db.update).toHaveBeenLastCalledWith(expect.objectContaining({ shop: 'shop', authVersion: 2, 'pendingEmailChange.tokenHash': hashToken(token) }), expect.objectContaining({ $unset: { pendingEmailChange: 1 } }))
    expect(user.email).toBe('old@example.invalid')
  })
  it('does not send after failed database saves and clears pending changes after delivery failures', async () => {
    db.update.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(begin()).rejects.toThrow('db unavailable'); expect(db.send).not.toHaveBeenCalled()
    db.send.mockRejectedValueOnce(new Error('mail unavailable'))
    await expect(begin()).rejects.toThrow('mail unavailable')
    expect(user.pendingEmailChange).toBeUndefined(); expect(user.email).toBe('old@example.invalid')
  })
  it('returns safe account details and scopes sessions to the account and shop', async () => {
    db.sessions.mockReturnValue(query([{ _id: 'current', authVersion: 2, expiresAt: new Date() }, { _id: 'old', authVersion: 1 }]))
    const result = await getAccount(req)
    expect(result.sessions).toHaveLength(1); expect(result.sessions[0].current).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-hash'); expect(JSON.stringify(result)).not.toContain('"_id"')
    expect(db.sessions).toHaveBeenCalledWith(expect.objectContaining({ user: 'owner', shop: 'shop', revokedAt: null }))
  })
  it('revokes other sessions and approvals while preserving the current session', async () => {
    expect(await signOutOtherSessions(req, { currentPassword: 'pass' })).toEqual({ revoked: 2 })
    expect(db.revoke).toHaveBeenCalledWith({ _id: { $ne: 'current' }, user: 'owner', shop: 'shop', revokedAt: null }, expect.objectContaining({ $unset: { approvals: 1 } }))
  })
})


describe('direct sign-in email changes, isolated database mocks', () => {
  const direct = { ...body, confirmNewEmail: 'new@example.invalid' }
  it('updates the same account atomically without any provider or false verification', async () => {
    db.available = false
    user.emailVerifiedAt = new Date()
    user.pendingEmailChange = { email: 'stale@example.invalid' }
    expect(await changeSignInEmail(req, direct)).toEqual({ changed: true, signInRequired: true, email: 'new@example.invalid' })
    expect(user).toMatchObject({ _id: 'owner', shop: 'shop', role: 'owner', status: 'active', passwordHash: 'secret-hash', authVersion: 3 })
    expect(user.emailVerifiedAt).toBeUndefined()
    expect(user.pendingEmailChange).toBeUndefined()
    expect(db.send).not.toHaveBeenCalled()
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ _id: 'owner', shop: 'shop', email: 'old@example.invalid', authVersion: 2, passwordHash: 'secret-hash' }), expect.objectContaining({
      $set: { email: 'new@example.invalid' },
      $push: { securityEvents: expect.objectContaining({ action: 'email_changed_direct', previousEmail: 'old@example.invalid', nextEmail: 'new@example.invalid' }) },
    }), { runValidators: true })
  })
  it.each([
    { newEmail: '' }, { confirmNewEmail: '' }, { newEmail: 'invalid' },
    { confirmNewEmail: 'another@example.invalid' }, { currentPassword: '' },
    { newEmail: 'old@example.invalid', confirmNewEmail: 'OLD@example.invalid' },
    { userId: 'another-user' }, { shopId: 'another-shop' }, { newEmail: {} },
  ])('rejects malformed, conflicting or forged input %j', async patch => {
    await expect(changeSignInEmail(req, { ...direct, ...patch })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('requires the current password and an individual privileged account', async () => {
    db.verify.mockResolvedValueOnce(false)
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 403 })
    req.auth.session.accessMode = 'trusted-view'
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 403 })
    req.auth.session.accessMode = 'individual'; req.user.role = 'staff'
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 403 })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('requires the deployed unique index and rejects occupied emails', async () => {
    db.indexes.mockResolvedValueOnce([])
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 503 })
    db.find.mockImplementation(filter => query(filter.email ? { _id: 'another' } : user))
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.update).not.toHaveBeenCalled()
  })
  it('handles duplicate-key races, stale credentials and failed saves without reporting success', async () => {
    db.update.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 409 })
    db.update.mockResolvedValueOnce({ modifiedCount: 0 })
    await expect(changeSignInEmail(req, direct)).rejects.toMatchObject({ statusCode: 409 })
    db.update.mockRejectedValueOnce(new Error('offline database unavailable'))
    await expect(changeSignInEmail(req, direct)).rejects.toThrow('offline database unavailable')
    expect(user.email).toBe('old@example.invalid'); expect(user.authVersion).toBe(2)
  })
  it('admits one concurrent change using the credential version guard', async () => {
    db.find.mockImplementation(filter => query(filter.email ? null : structuredClone(user)))
    db.update.mockImplementation(async (filter, update) => {
      if (filter.authVersion !== user.authVersion) return { modifiedCount: 0 }
      Object.assign(user, update.$set); user.authVersion++
      return { modifiedCount: 1 }
    })
    const results = await Promise.allSettled([changeSignInEmail(req, direct), changeSignInEmail(req, direct)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(row => row.status === 'rejected').reason.statusCode).toBe(409)
  })
})

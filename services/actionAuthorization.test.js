import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ userFind: vi.fn(), userUpdate: vi.fn(), update: vi.fn(), consume: vi.fn(), verify: vi.fn(), hash: vi.fn() }))
vi.mock('../models/User.js', () => ({ User: { findOne: db.userFind, updateOne: db.userUpdate } }))
vi.mock('../models/AuthSession.js', () => ({ AuthSession: { updateOne: db.update, findOneAndUpdate: db.consume } }))
vi.mock('../utils/passwords.js', () => ({ verifyPassword: db.verify, hashPassword: db.hash }))
import { actionHash, consumeApproval, issueApproval, changePassword, trustedBoundary, trustedReadAllowed } from './actionAuthorization.js'
import { env } from '../config/env.js'
const operator = { _id: '507f1f77bcf86cd799439011', shop: '507f1f77bcf86cd799439012', role: 'owner', status: 'active', authVersion: 3, passwordHash: 'salted-hash', email: 'owner@example.invalid' }
const query = result => ({ select() { return this }, lean: async () => result })
let req, grant
beforeEach(() => {
  vi.clearAllMocks()
  req = { user: { id: operator._id, shopId: operator.shop, role: 'owner' }, auth: { session: { _id: 'session', accessMode: 'individual' } }, method: 'POST', originalUrl: '/api/v1/sales', get: () => '', body: { idempotencyKey: 'stable-key', amount: 10 }, app: { get: () => undefined } }
  db.userFind.mockReturnValue(query(operator)); db.verify.mockResolvedValue(true); db.hash.mockResolvedValue('new-salted-hash'); db.userUpdate.mockResolvedValue({ modifiedCount: 1 })
  grant = undefined
  db.update.mockImplementation(async (_filter, update) => { grant = update.$push.approvals.$each[0]; return { matchedCount: 1 } })
  db.consume.mockImplementation(filter => {
    const match = filter.approvals.$elemMatch
    const valid = grant && !grant.usedAt && grant.tokenHash === match.tokenHash && grant.actionHash === match.actionHash && grant.expiresAt > match.expiresAt.$gt
    const result = valid ? { approvals: [{ ...grant }] } : null
    if (valid) grant.usedAt = new Date()
    return query(result)
  })
})
async function approve() {
  const result = await issueApproval(req, { password: 'private', method: req.method, path: req.originalUrl, payload: req.body })
  req.get = () => result.token
  return result
}
describe('single-action password authorization, isolated fixtures', () => {
  it('allows an individually signed-in admin to change their own password without changing privileges', async () => {
    req.user.role = 'admin'
    const room = vi.fn(() => ({ disconnectSockets: vi.fn() })); req.app.get = () => ({ in: room })
    db.userFind.mockReturnValue(query({ ...operator, role: 'admin' }))
    await expect(changePassword(req, { currentPassword: 'old private password', newPassword: 'new private password' })).resolves.toMatchObject({ changed: true, signInRequired: true })
    expect(db.userFind).toHaveBeenCalledWith({ _id: operator._id, shop: operator.shop, status: 'active' })
    expect(db.userUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: operator._id, shop: operator.shop, role: 'admin' }), expect.anything())
    expect(db.userUpdate.mock.calls[0][1].$set).not.toHaveProperty('role')
    expect(room).toHaveBeenCalledWith(`user:${operator._id}`)
  })
  it('requires approval and never runs a mutation with only a session', async () => { await expect(consumeApproval(req)).rejects.toMatchObject({ statusCode: 403 }); expect(db.consume).not.toHaveBeenCalled() })
  it('rejects an incorrect password before storing an approval', async () => { db.verify.mockResolvedValue(false); await expect(approve()).rejects.toMatchObject({ code: 'INCORRECT_PASSWORD' }); expect(db.update).not.toHaveBeenCalled() })
  it('binds canonical payload, method and exact query path', () => {
    expect(actionHash('POST', '/a', { b: 2, a: 1 })).toBe(actionHash('POST', '/a', { a: 1, b: 2 }))
    expect(new Set([actionHash('POST', '/a', {}), actionHash('PATCH', '/a', {}), actionHash('POST', '/b', {}), actionHash('POST', '/a', { amount: 1 })]).size).toBe(4)
  })
  it('stores only a token hash, consumes atomically and rejects reuse', async () => {
    const result = await approve(); expect(grant.tokenHash).not.toBe(result.token)
    await consumeApproval(req); expect(req.user.id).toBe(operator._id)
    await expect(consumeApproval(req)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('allows only one of simultaneous attempts', async () => { await approve(); const results = await Promise.allSettled([consumeApproval(req), consumeApproval(req)]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1) })
  it('rejects a changed body, wrong endpoint, expiry and changed account version', async () => {
    await approve(); req.body.amount = 11; await expect(consumeApproval(req)).rejects.toThrow(); req.body.amount = 10
    req.originalUrl = '/api/v1/purchases'; await expect(consumeApproval(req)).rejects.toThrow(); req.originalUrl = '/api/v1/sales'
    grant.expiresAt = new Date(0); await expect(consumeApproval(req)).rejects.toThrow()
    await approve(); db.userFind.mockReturnValue(query({ ...operator, authVersion: 4 })); await expect(consumeApproval(req)).rejects.toThrow('revoked')
  })
  it('requires the individual operator in the same shop for a shared viewing session', async () => {
    req.auth.session.accessMode = 'trusted-view'
    await issueApproval(req, { email: operator.email, password: 'private', method: 'POST', path: req.originalUrl, payload: req.body })
    expect(db.userFind).toHaveBeenCalledWith({ shop: operator.shop, email: operator.email, status: 'active' })
  })
  it('rejects a shared-view approval without an individual email before looking up any account', async () => {
    req.auth.session.accessMode = 'trusted-view'
    await expect(issueApproval(req, { password: 'private', method: 'POST', path: req.originalUrl, payload: req.body })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.userFind).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled()
  })
  it('changes owner password and audit atomically while incrementing revocation version', async () => {
    expect(await changePassword(req, { currentPassword: 'old', newPassword: 'a new long passphrase' })).toEqual({ changed: true, signInRequired: true })
    expect(db.userUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: operator._id, passwordHash: operator.passwordHash }), expect.objectContaining({ $inc: { authVersion: 1 }, $push: { securityEvents: expect.objectContaining({ action: 'password_changed', actor: operator._id }) } }))
  })
  it('rejects shared viewers, staff, wrong passwords and concurrent password changes', async () => {
    req.auth.session.accessMode = 'trusted-view'; await expect(changePassword(req, {})).rejects.toThrow()
    req.auth.session.accessMode = 'individual'; req.user.role = 'staff'; await expect(changePassword(req, {})).rejects.toThrow()
    req.user.role = 'owner'; db.verify.mockResolvedValue(false); await expect(changePassword(req, {})).rejects.toThrow('incorrect')
    db.verify.mockResolvedValue(true); db.userUpdate.mockResolvedValue({ modifiedCount: 0 }); await expect(changePassword(req, { currentPassword: 'old', newPassword: 'different password' })).rejects.toMatchObject({ statusCode: 409 })
  })
  it('requires both an approved immediate peer and a secret, with explicit read resources', () => {
    const saved = { ...env }
    try {
      Object.assign(env, { trustedStaffEnabled: true, trustedProxySecret: 's'.repeat(48), trustedProxyAddresses: ['127.0.0.1'], trustedStaffResources: ['sales'] })
      const request = { socket: { remoteAddress: '127.0.0.1' }, get: () => 's'.repeat(48), originalUrl: '/api/v1/sales/dashboard' }
      expect(trustedBoundary(request)).toBe(true); expect(trustedReadAllowed(request)).toBe(true)
      request.originalUrl = '/api/v1/customers'; expect(trustedReadAllowed(request)).toBe(false)
      request.socket.remoteAddress = '203.0.113.1'; expect(trustedBoundary(request)).toBe(false)
      request.socket.remoteAddress = '127.0.0.1'; request.get = () => 'wrong'; expect(trustedBoundary(request)).toBe(false)
      env.trustedStaffEnabled = false; expect(trustedBoundary(request)).toBe(false)
    } finally { Object.assign(env, saved) }
  })
})

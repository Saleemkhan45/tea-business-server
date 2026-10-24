import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AuthSession } from '../models/AuthSession.js'
import { User } from '../models/User.js'
import { verifyPassword, hashPassword } from '../utils/passwords.js'
import { env } from '../config/env.js'
import { diagnostic } from '../utils/safeDiagnostics.js'

const fail = (message, statusCode = 403, code = 'ACTION_AUTHORIZATION_REQUIRED') => Object.assign(new Error(message), { statusCode, code })
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const actionHash = (method, path, body) => createHash('sha256').update(JSON.stringify([method.toUpperCase(), path, canonical(body ?? null)])).digest('hex')
export const hashToken = token => createHash('sha256').update(token).digest('hex')
export function trustedBoundary(req) {
  const supplied = Buffer.from(req.get('x-tea-trusted-boundary') ?? '')
  const secret = Buffer.from(env.trustedProxySecret)
  const secureHop = req.socket.encrypted === true || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  return env.trustedStaffEnabled && secureHop && secret.length >= 32 && env.trustedProxyAddresses.includes(req.socket.remoteAddress)
    && supplied.length === secret.length && timingSafeEqual(supplied, secret)
}
export function trustedReadAllowed(req) {
  const resource = req.originalUrl.split('?')[0].split('/')[3]
  return resource === 'auth' || env.trustedStaffResources.includes(resource)
}
export async function issueApproval(req, { password, email, method, path, payload }) {
  if (req.auth.session.accessMode === 'trusted-view' && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) throw fail('Enter the individual operator email before authorizing a change.', 400)
  const user = await User.findOne(req.auth.session.accessMode === 'trusted-view'
    ? { shop: req.user.shopId, email: email?.trim().toLowerCase(), status: 'active' }
    : { _id: req.user.id, shop: req.user.shopId, status: 'active' }).select('+passwordHash +authVersion').lean()
  if (!await verifyPassword(password, user?.passwordHash) || !user) throw fail('Password authorization failed.', 403, 'INCORRECT_PASSWORD')
  if (!/^\/api\/v1\/(customers|sales|regional|purchases|cashbook|collections|notifications|whatsapp)(\/|\?|$)/.test(path) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw fail('This action cannot be authorized.', 400)
  const token = randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + 60000)
  const saved = await AuthSession.updateOne({ _id: req.auth.session._id, revokedAt: null, expiresAt: { $gt: new Date() } }, {
    $push: { approvals: { $each: [{ tokenHash: hashToken(token), actionHash: actionHash(method, path, payload), operator: user._id, authVersion: user.authVersion ?? 0, expiresAt, usedAt: null }], $slice: -32 } },
  })
  if (saved.matchedCount !== 1) throw fail('Session expired. Sign in again.', 401)
  diagnostic('authorization.issued')
  return { token, expiresAt: expiresAt.toISOString() }
}
export async function consumeApproval(req) {
  const token = req.get('x-action-authorization') ?? ''
  if (!/^[a-f\d]{64}$/.test(token)) throw fail('Authorize this change with your password.')
  const match = { tokenHash: hashToken(token), actionHash: actionHash(req.method, req.originalUrl, req.body), expiresAt: { $gt: new Date() }, usedAt: null }
  // Atomic consume across API processes; even failed downstream writes require a new approval.
  const session = await AuthSession.findOneAndUpdate({ _id: req.auth.session._id, revokedAt: null, approvals: { $elemMatch: match } }, { $set: { 'approvals.$.usedAt': new Date() } }, { new: false }).select('+approvals').lean()
  const grant = session?.approvals?.find(value => value.tokenHash === match.tokenHash && !value.usedAt)
  if (!grant) throw fail('Authorization expired or was already used. Confirm the action again.')
  const operator = await User.findOne({ _id: grant.operator, shop: req.user.shopId, status: 'active' }).select('+authVersion').lean()
  if (!operator || (operator.authVersion ?? 0) !== grant.authVersion) throw fail('Authorization was revoked. Confirm the action again.')
  // Business services receive the verified individual, never a shared viewing identity.
  req.user = { id: String(operator._id), shopId: String(operator.shop), role: operator.role, name: operator.name, email: operator.email }
  diagnostic('authorization.consumed')
}
export async function changePassword(req, { currentPassword, newPassword }) {
  if (req.auth.session.accessMode === 'trusted-view' || !['owner', 'admin'].includes(req.user.role)) throw fail('Sign in individually as an owner or admin to change your own password.')
  const user = await User.findOne({ _id: req.user.id, shop: req.user.shopId, status: 'active' }).select('+passwordHash +authVersion').lean()
  if (!user || !['owner', 'admin'].includes(user.role) || !await verifyPassword(currentPassword, user.passwordHash)) throw fail('Current password is incorrect.', 403, 'INCORRECT_PASSWORD')
  if (newPassword === currentPassword) throw fail('Choose a different new password.', 400)
  const passwordHash = await hashPassword(newPassword)
  const result = await User.updateOne({ _id: user._id, shop: user.shop, role: user.role, passwordHash: user.passwordHash, authVersion: user.authVersion ?? { $in: [null, 0] }, status: 'active' }, {
    $set: { passwordHash, passwordChangedAt: new Date() }, $unset: { pendingEmailChange: 1 }, $inc: { authVersion: 1 }, $push: { securityEvents: { action: 'password_changed', actor: user._id, at: new Date() } },
  })
  if (result.modifiedCount !== 1) throw fail('The account changed. Sign in again before retrying.', 409)
  // authVersion invalidates all old sessions/grants, including ones on other API instances.
  req.app.get('io')?.in(`user:${user._id}`).disconnectSockets(true)
  diagnostic('password.changed')
  return { changed: true, signInRequired: true }
}


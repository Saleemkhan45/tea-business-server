import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { AuthSession } from '../models/AuthSession.js'
import { verifyPassword } from '../utils/passwords.js'
import { sessionPolicy } from '../config/sessionPolicy.js'

export const SESSION_DURATION_MS = sessionPolicy.shortMs
const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'tea-business-api', audience: 'tea-business-dashboard' }
export class AuthError extends Error {
  constructor(message = 'Invalid or expired session.') { super(message); this.statusCode = 401 }
}
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex') }
export function cookieOptions() {
  return { httpOnly: true, secure: env.nodeEnv === 'production', sameSite: env.cookieSameSite, path: '/' }
}
export function sessionToken(headers) {
  const cookie = (headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${env.cookieName}=`))
  if (cookie) return { token: cookie.slice(env.cookieName.length + 1), cookieAuth: true }
  const bearer = headers.authorization
  return { token: bearer?.startsWith('Bearer ') ? bearer.slice(7) : null, cookieAuth: false }
}
function publicUser(user, shop) {
  return { id: String(user._id), name: user.name, email: user.email, role: user.role, shopId: String(user.shop), shopName: shop.name }
}

export async function login({ email, password, trustedDevice = false }) {
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash +authVersion').lean()
  const passwordValid = await verifyPassword(password, user?.passwordHash)
  if (!passwordValid || !user || user.status !== 'active') throw new AuthError('Incorrect email or password.')
  const shop = await Shop.findOne({ _id: user.shop, status: 'active' }).lean()
  if (!shop) throw new AuthError('Incorrect email or password.')
  return createSession(user, shop, 'individual', trustedDevice)
}

export async function createSession(user, shop, accessMode = 'individual', trustedDevice = false) {
  // MongoDB is authoritative. Opaque sessions survive process restarts and do not
  // depend on a runtime-generated signing key. Configured keys only support legacy JWTs.
  const token = `v2_${randomBytes(32).toString('hex')}`
  const now = new Date()
  const persistent = accessMode === 'individual' && trustedDevice === true
  const absoluteExpiresAt = new Date(now.getTime() + (persistent ? sessionPolicy.absoluteMs : sessionPolicy.shortMs))
  const expiresAt = new Date(Math.min(absoluteExpiresAt.getTime(), now.getTime() + (persistent ? sessionPolicy.slidingMs : sessionPolicy.shortMs)))
  const csrfToken = randomBytes(32).toString('hex')
  await AuthSession.create({ tokenHash: tokenHash(token), user: user._id, shop: user.shop, csrfToken, expiresAt, absoluteExpiresAt, persistent, lastRenewedAt: now, authVersion: user.authVersion ?? 0, accessMode })
  return { token, session: { user: publicUser(user, shop), ...sessionDetails({ csrfToken, expiresAt, absoluteExpiresAt, persistent, accessMode }) } }
}

export function sessionDetails(session) {
  return { csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString(), absoluteExpiresAt: (session.absoluteExpiresAt ?? session.expiresAt).toISOString(), persistent: session.persistent === true, accessMode: session.accessMode ?? 'individual', authorizationRequired: true, serverTime: new Date().toISOString() }
}

export function setSessionCookie(res, token, session) {
  res.cookie(env.cookieName, token, { ...cookieOptions(), expires: new Date(session.expiresAt), maxAge: Math.max(0, new Date(session.expiresAt).getTime() - Date.now()) })
}

export async function renewSession(token, session) {
  const now = new Date()
  if (!session.persistent || session.accessMode === 'trusted-view' || !session.absoluteExpiresAt || !session.lastRenewedAt) return session
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) throw new AuthError()
  if (now.getTime() - session.lastRenewedAt.getTime() < sessionPolicy.renewalMs) return session
  const expiresAt = new Date(Math.min(now.getTime() + sessionPolicy.slidingMs, session.absoluteExpiresAt.getTime()))
  const updated = await AuthSession.findOneAndUpdate({ _id: session._id, tokenHash: tokenHash(token), user: session.user, shop: session.shop, revokedAt: null, authVersion: session.authVersion ?? 0, expiresAt: session.expiresAt, absoluteExpiresAt: { $gt: now } }, { $set: { expiresAt, lastRenewedAt: now } }, { new: true }).select('+csrfToken').lean()
  if (updated) return updated
  // A concurrent renewal may win. Reauthenticate instead of reviving a revoked session.
  return (await authenticate(token)).session
}

export async function authenticate(token) {
  if (!token) throw new AuthError('Authentication required.')
  let payload
  if (!/^v2_[a-f\d]{64}$/.test(token)) {
    if (!env.jwtSecret) throw new AuthError()
    try { payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], issuer: JWT_OPTIONS.issuer, audience: JWT_OPTIONS.audience }) }
    catch { throw new AuthError() }
    if (!payload.sub || !payload.jti) throw new AuthError()
  }
  const session = await AuthSession.findOne({ tokenHash: tokenHash(token), revokedAt: null, expiresAt: { $gt: new Date() } }).select('+csrfToken').lean()
  if (!session || (session.absoluteExpiresAt && session.absoluteExpiresAt <= new Date()) || (payload && String(session.user) !== payload.sub)) throw new AuthError()
  const user = await User.findById(String(session.user)).select('_id name email shop role status +authVersion').lean()
  if (!user || user.status !== 'active' || String(user.shop) !== String(session.shop)) throw new AuthError()
  if ((user.authVersion ?? 0) !== (session.authVersion ?? 0)) throw new AuthError()
  const shop = await Shop.findOne({ _id: user.shop, status: 'active' }).lean()
  if (!shop) throw new AuthError()
  return { session, user: publicUser(user, shop) }
}

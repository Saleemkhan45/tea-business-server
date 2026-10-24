import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../config/env.js'
import { AuthSession } from '../models/AuthSession.js'
import { cookieOptions, login, createSession, sessionDetails, setSessionCookie, renewSession } from '../services/authService.js'
import { User } from '../models/User.js'
import { Shop } from '../models/Shop.js'
import { issueApproval, changePassword, trustedBoundary } from '../services/actionAuthorization.js'
import { changeSignInEmail, directEmailChangeSchema, verifyEmailChange, getAccount, signOutOtherSessions, updateAccountName, revokeDeviceSession } from '../services/accountSecurity.js'
import { requireAuth, requireTrustedOrigin } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

export const authRoutes = express.Router()
authRoutes.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many login attempts. Try again later.' } })
const staffLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many viewing session requests. Retry shortly.' } })
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256), trustedDevice: z.boolean().optional() }).strict()
authRoutes.post('/login', loginLimit, requireTrustedOrigin, (req, res, next) => {
  if (!req.is('application/json')) return res.status(415).json({ message: 'Login requires a JSON request.' })
  next()
}, validate(loginSchema), async (req, res, next) => {
  try {
    const result = await login(req.body)
    setSessionCookie(res, result.token, result.session)
    res.json(result.session)
  } catch (error) { next(error) }
})
async function restoreOrRenew(req, res, next) {
  try {
    const session = await renewSession(req.auth.token, req.auth.session)
    // An older non-renewing response must not overwrite a concurrent renewal's cookie.
    if (req.auth.cookieAuth && session !== req.auth.session) setSessionCookie(res, req.auth.token, session)
    res.json({ user: req.auth.user, ...sessionDetails(session) })
  } catch (error) { next(error) }
}
authRoutes.get('/session', requireAuth, restoreOrRenew)
authRoutes.post('/session/renew', requireAuth, requireTrustedOrigin, validate(z.object({}).strict()), restoreOrRenew)
authRoutes.post('/staff-session', staffLimit, requireTrustedOrigin, async (req, res, next) => {
  if (!trustedBoundary(req)) return res.status(403).json({ message: 'Trusted staff viewing is not available from this connection.' })
  try {
    if (!/^[a-f\d]{24}$/i.test(env.trustedStaffShop) || !/^[a-f\d]{24}$/i.test(env.trustedStaffUser) || !env.trustedStaffResources.length) return res.status(503).json({ message: 'Trusted viewing configuration is incomplete.' })
    const user = await User.findOne({ _id: env.trustedStaffUser, shop: env.trustedStaffShop, status: 'active' }).select('+authVersion').lean()
    const shop = await Shop.findOne({ _id: env.trustedStaffShop, status: 'active' }).lean()
    if (!user || !shop) return res.status(403).json({ message: 'Trusted viewing is not configured for an active shop account.' })
    const result = await createSession(user, shop, 'trusted-view')
    setSessionCookie(res, result.token, result.session)
    res.json(result.session)
  } catch (error) { next(error) }
})
const authorizationLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { message: 'Too many password attempts. Wait before trying again.' } })
const authorizationBurstLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many authorization requests. Retry shortly.' } })
const passwordChangeLimit = rateLimit({ windowMs: 15 * 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many password change attempts. Try again later.' } })
authRoutes.post('/authorize', requireAuth, requireTrustedOrigin, authorizationBurstLimit, authorizationLimit, validate(z.object({ password: z.string().min(1).max(256), email: z.string().email().max(254).optional(), method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().max(2048), payload: z.unknown().optional() }).strict()), async (req, res, next) => {
  try { res.json(await issueApproval(req, req.body)) } catch (error) { next(error) }
})
authRoutes.post('/change-password', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256), confirmPassword: z.string().min(12).max(256) }).strict().refine(value => value.newPassword === value.confirmPassword, 'New passwords must match.')), async (req, res, next) => {
  try { const result = await changePassword(req, req.body); res.clearCookie(env.cookieName, cookieOptions()).json(result) } catch (error) { next(error) }
})

authRoutes.post('/change-email', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(directEmailChangeSchema), async (req, res, next) => {
  try { const result = await changeSignInEmail(req, req.body); res.clearCookie(env.cookieName, cookieOptions()).json(result) } catch (error) { next(error) }
})

authRoutes.post('/verify-email', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(z.object({ token: z.string().regex(/^[a-f\d]{64}$/), currentPassword: z.string().min(1).max(256) }).strict()), async (req, res, next) => {
  try { const result = await verifyEmailChange(req, req.body); res.clearCookie(env.cookieName, cookieOptions()).json(result) } catch (error) { next(error) }
})
authRoutes.get('/account', requireAuth, async (req, res, next) => {
  try { res.json(await getAccount(req)) } catch (error) { next(error) }
})
authRoutes.patch('/account', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(z.object({ name: z.string().trim().min(1).max(100), currentPassword: z.string().min(1).max(256) }).strict()), async (req, res, next) => {
  try { res.json(await updateAccountName(req, req.body)) } catch (error) { next(error) }
})
authRoutes.post('/sessions/revoke-others', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(z.object({ currentPassword: z.string().min(1).max(256) }).strict()), async (req, res, next) => {
  try { res.json(await signOutOtherSessions(req, req.body)) } catch (error) { next(error) }
})
authRoutes.post('/sessions/revoke', requireAuth, requireTrustedOrigin, passwordChangeLimit, validate(z.object({ currentPassword: z.string().min(1).max(256), handle: z.string().regex(/^[a-f\d]{64}$/) }).strict()), async (req, res, next) => {
  try { res.json(await revokeDeviceSession(req, req.body)) } catch (error) { next(error) }
})
authRoutes.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await AuthSession.updateOne({ _id: req.auth.session._id, user: req.user.id }, { $set: { revokedAt: new Date() } })
    req.app.get('io')?.in(`session:${req.auth.session._id}`).disconnectSockets(true)
    res.clearCookie(env.cookieName, cookieOptions())
    res.status(204).end()
  } catch (error) { next(error) }
})

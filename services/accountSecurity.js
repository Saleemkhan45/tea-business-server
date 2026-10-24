import { randomBytes } from 'node:crypto'
import { User } from '../models/User.js'
import { AuthSession } from '../models/AuthSession.js'
import { verifyPassword } from '../utils/passwords.js'
import { hashToken } from './actionAuthorization.js'
import { emailDeliveryConfigured, sendSecurityEmail } from './securityEmail.js'
import { env } from '../config/env.js'
import { diagnostic } from '../utils/safeDiagnostics.js'
import { emailChangeVerification } from './securityEmailTemplates.js'
import { z } from 'zod'

export const directEmailChangeSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email().max(254),
  confirmNewEmail: z.string().trim().toLowerCase().email().max(254),
  currentPassword: z.string().min(1, 'Please enter your current password.').max(256),
}).strict().refine(value => value.newEmail === value.confirmNewEmail, 'New email addresses do not match.')

export async function changeSignInEmail(req, body) {
  requireIndividualAccount(req)
  const parsed = directEmailChangeSchema.safeParse(body)
  if (!parsed.success) throw fail(parsed.error.issues[0].message, 400)
  const { newEmail: email, currentPassword } = parsed.data
  const user = await confirmedAccount(req, currentPassword)
  if (email === user.email.trim().toLowerCase()) throw fail('Choose a different sign-in email.', 400)
  await uniqueEmailReady()
  if (await User.findOne({ email }).select('_id').lean()) throw fail('This email is already in use. Choose another email.', 409)
  let saved
  try {
    // One atomic credential-guarded write persists identity, audit and revocation together.
    saved = await User.updateOne({ ...credentialGuard(user), email: user.email }, {
      $set: { email }, $unset: { pendingEmailChange: 1, emailVerifiedAt: 1 }, $inc: { authVersion: 1 },
      $push: { securityEvents: { action: 'email_changed_direct', actor: user._id, at: new Date(), previousEmail: user.email, nextEmail: email } },
    }, { runValidators: true })
  } catch (error) {
    if (error.code === 11000) throw fail('This email is already in use. Choose another email.', 409)
    throw error
  }
  if (saved.modifiedCount !== 1) throw fail('The account changed. Sign in again before retrying.', 409)
  req.app.get('io')?.in(`user:${user._id}`).disconnectSockets(true)
  return { changed: true, signInRequired: true, email }
}

const fail = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode })
export function requireIndividualAccount(req) {
  if (req.auth.session.accessMode === 'trusted-view' || !['owner', 'admin'].includes(req.user.role)) throw fail('Sign in individually as an owner or admin to manage your own account security.')
}
export async function confirmedAccount(req, password) {
  requireIndividualAccount(req)
  const user = await User.findOne({ _id: req.user.id, shop: req.user.shopId, status: 'active' }).select('+passwordHash +authVersion +pendingEmailChange').lean()
  if (!user || !['owner', 'admin'].includes(user.role) || !await verifyPassword(password, user.passwordHash)) throw fail('Current password is incorrect.')
  return user
}
export const credentialGuard = user => ({ _id: user._id, shop: user.shop, role: user.role, status: 'active', passwordHash: user.passwordHash, authVersion: user.authVersion ?? { $in: [null, 0] } })
async function uniqueEmailReady() {
  // Production autoIndex is disabled: never rely on an undeployed uniqueness constraint.
  const indexes = await User.collection.indexes()
  if (!indexes.some(index => index.unique === true && index.key.email === 1 && Object.keys(index.key).length === 1 && !index.partialFilterExpression && !index.sparse && (!index.collation || index.collation.locale === 'simple'))) throw fail('Account email setup requires administrator review.', 503)
}
export async function beginEmailChange(req, { currentPassword, newEmail }) {
  const user = await confirmedAccount(req, currentPassword)
  const email = newEmail.trim().toLowerCase()
  if (email === user.email.trim().toLowerCase()) throw fail('Choose a different sign-in email.', 400)
  if (!emailDeliveryConfigured()) throw fail('Email delivery is not configured. Contact the owner; your current sign-in email is unchanged.', 503)
  const verificationUrl = new URL('/verify-email', env.clientOrigin)
  if (env.nodeEnv === 'production' && verificationUrl.protocol !== 'https:') throw fail('Secure email verification is not configured. Contact your deployment administrator.', 503)
  await uniqueEmailReady()
  if (await User.findOne({ email }).select('_id').lean()) throw fail('This email cannot be used. Choose another email.', 409)
  const token = randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  verificationUrl.hash = token
  const expiresAt = new Date(Date.now() + 15 * 60000)
  const pendingEmailChange = { email, tokenHash, expiresAt, authVersion: user.authVersion ?? 0 }
  const saved = await User.updateOne(credentialGuard(user), { $set: { pendingEmailChange }, $push: { securityEvents: { action: 'email_change_requested', actor: user._id, at: new Date() } } })
  if (saved.modifiedCount !== 1) throw fail('The account changed. Sign in again before retrying.', 409)
  try {
    await sendSecurityEmail({ to: email, ...emailChangeVerification({ email, url: verificationUrl.href }) })
  } catch (error) {
    await User.updateOne({ _id: user._id, shop: user.shop, 'pendingEmailChange.tokenHash': tokenHash }, { $unset: { pendingEmailChange: 1 } }).catch(() => {})
    throw error
  }
  return { pending: true, expiresAt: expiresAt.toISOString(), message: 'The email provider accepted your verification message. Check your new inbox and spam folder; delivery is not yet confirmed. Your current email stays active until verification.' }
}
export async function verifyEmailChange(req, { token, currentPassword }) {
  const user = await confirmedAccount(req, currentPassword)
  const oldEmail = user.email
  const pending = user.pendingEmailChange
  if (!pending || pending.tokenHash !== hashToken(token) || pending.expiresAt <= new Date() || pending.authVersion !== (user.authVersion ?? 0)) throw fail('Verification link is invalid, expired, or already used. Request a new link in Settings.', 400)
  await uniqueEmailReady()
  let saved
  try {
    saved = await User.updateOne({ ...credentialGuard(user), 'pendingEmailChange.tokenHash': pending.tokenHash, 'pendingEmailChange.email': pending.email, 'pendingEmailChange.authVersion': pending.authVersion, 'pendingEmailChange.expiresAt': { $gt: new Date() } }, {
      $set: { email: pending.email, emailVerifiedAt: new Date() }, $unset: { pendingEmailChange: 1 }, $inc: { authVersion: 1 },
      $push: { securityEvents: { action: 'email_changed', actor: user._id, at: new Date(), previousEmail: oldEmail, nextEmail: pending.email } },
    })
  } catch (error) {
    if (error.code === 11000) throw fail('This email cannot be used. Request another email in Settings.', 409)
    throw error
  }
  if (saved.modifiedCount !== 1) throw fail('Verification link was used or the account changed. Sign in again.', 409)
  req.app.get('io')?.in(`user:${user._id}`).disconnectSockets(true)
  let notificationSent = false
  try {
    await sendSecurityEmail({ to: oldEmail, subject: 'Your Tea Business sign-in email changed', text: 'Your sign-in email was changed after password and email verification. If this was not you, contact your shop owner or deployment administrator immediately.' })
    notificationSent = true
  } catch { diagnostic('email.change.notification.failed') }
  return { changed: true, signInRequired: true, email: pending.email, notificationSent }
}
export async function getAccount(req) {
  requireIndividualAccount(req)
  const user = await User.findOne({ _id: req.user.id, shop: req.user.shopId, status: 'active' }).select('name email role status updatedAt passwordChangedAt emailVerifiedAt +authVersion +pendingEmailChange').lean()
  if (!user) throw fail('Account unavailable.', 401)
  const now = new Date()
  const sessions = await AuthSession.find({ user: user._id, shop: req.user.shopId, revokedAt: null, expiresAt: { $gt: now } }).select('_id createdAt expiresAt authVersion accessMode persistent absoluteExpiresAt').lean()
  return {
    name: user.name, email: user.email, role: user.role, status: user.status,
    updatedAt: user.updatedAt ?? null,
    passwordChangedAt: user.passwordChangedAt ?? null, emailVerifiedAt: user.emailVerifiedAt ?? null,
    pendingEmail: user.pendingEmailChange?.expiresAt > now ? { email: user.pendingEmailChange.email, expiresAt: user.pendingEmailChange.expiresAt } : null,
    emailChangeAvailable: true,
    sessions: sessions.filter(row => (row.authVersion ?? 0) === (user.authVersion ?? 0) && (!row.absoluteExpiresAt || row.absoluteExpiresAt > now)).map(row => ({ current: String(row._id) === String(req.auth.session._id), handle: hashToken(`${req.auth.session.csrfToken}:${row._id}`), createdAt: row.createdAt, expiresAt: row.expiresAt, absoluteExpiresAt: row.absoluteExpiresAt ?? row.expiresAt, persistent: row.persistent === true, accessMode: row.accessMode ?? 'individual' })),
  }
}
export async function signOutOtherSessions(req, { currentPassword }) {
  const user = await confirmedAccount(req, currentPassword)
  // Keep the current cookie valid; invalidate every other session and its approvals.
  const result = await AuthSession.updateMany({ _id: { $ne: req.auth.session._id }, user: user._id, shop: req.user.shopId, revokedAt: null }, { $set: { revokedAt: new Date() }, $unset: { approvals: 1 } })
  await User.updateOne({ _id: user._id, shop: req.user.shopId }, { $push: { securityEvents: { action: 'other_sessions_revoked', actor: user._id, at: new Date() } } })
  req.app.get('io')?.in(`user:${user._id}`).except(`session:${req.auth.session._id}`).disconnectSockets(true)
  return { revoked: result.modifiedCount }
}

export async function updateAccountName(req, { name, currentPassword }) {
  const user = await confirmedAccount(req, currentPassword)
  if (name === user.name) return { changed: false }
  const result = await User.updateOne(credentialGuard(user), { $set: { name }, $push: { securityEvents: { action: 'profile_updated', actor: user._id, at: new Date() } } })
  if (result.modifiedCount !== 1) throw fail('The account changed. Refresh before retrying.', 409)
  return { changed: true }
}

export async function revokeDeviceSession(req, { currentPassword, handle }) {
  const user = await confirmedAccount(req, currentPassword)
  const sessions = await AuthSession.find({ user: user._id, shop: req.user.shopId, revokedAt: null, expiresAt: { $gt: new Date() } }).select('_id').lean()
  const target = sessions.find(row => String(row._id) !== String(req.auth.session._id) && hashToken(`${req.auth.session.csrfToken}:${row._id}`) === handle)
  if (!target) throw fail('Session is no longer available. Refresh the session list.', 404)
  await AuthSession.updateMany({ _id: target._id, user: user._id, shop: req.user.shopId, revokedAt: null }, { $set: { revokedAt: new Date() }, $unset: { approvals: 1 } })
  await User.updateOne({ _id: user._id, shop: user.shop }, { $push: { securityEvents: { action: 'device_session_revoked', actor: user._id, at: new Date() } } })
  req.app.get('io')?.in(`session:${target._id}`).disconnectSockets(true)
  return { revoked: true }
}

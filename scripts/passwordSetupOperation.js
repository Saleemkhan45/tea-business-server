import mongoose from 'mongoose'

export const SETUP_PROTOCOL = 'tea-password-setup-v1'
const SAFE_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult', 'RetryableWriteError', 'NoWritesPerformed']
const SAFE_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ValidationError', 'CastError', 'MongoServerError', 'MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoOperationTimeoutError', 'MongoParseError', 'MongooseError', 'PasswordSetupError'])
const SAFE_CODES = new Set(['WRITE_AUTH_REQUIRED', 'DATABASE_MISMATCH', 'INVALID_SHOP_ID', 'INVALID_USER_EMAIL', 'PASSWORD_INPUT_REQUIRED', 'PASSWORD_POLICY_FAILED', 'TARGET_NOT_FOUND', 'TARGET_CHANGED', 'SESSION_INTERFACE_INVALID', 'COMMIT_NOT_CONFIRMED', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EACCES', 'EPERM', 'ENOENT', 'EIO'])
const CONFIGURATION_CODES = new Map([
  ['MONGODB_URI is required. Check server/.env', 'MONGODB_URI_REQUIRED'],
  ['JWT_SECRET is required in production.', 'JWT_SECRET_REQUIRED'],
  ['JWT_SECRET must contain at least 32 characters in production.', 'JWT_SECRET_INVALID'],
  ['CLIENT_ORIGIN must be the exact HTTPS frontend origin in production.', 'CLIENT_ORIGIN_INVALID'],
  ['SESSION_COOKIE_SAMESITE must be lax, strict or none.', 'COOKIE_POLICY_INVALID'],
  ['SameSite=None requires HTTPS production cookies.', 'COOKIE_POLICY_INVALID'],
  ['DNS_SERVERS must contain comma-separated DNS server IP addresses.', 'DNS_POLICY_INVALID'],
])

export class PasswordSetupError extends Error {
  constructor(code, message) { super(message); this.name = 'PasswordSetupError'; this.code = code }
}
export function safeError(error) {
  const numericCode = Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 2147483647
  return {
    name: SAFE_NAMES.has(error?.name) ? error.name : 'Error',
    code: numericCode || SAFE_CODES.has(error?.code) ? error.code : CONFIGURATION_CODES.get(error?.message) ?? 'UNCLASSIFIED',
    labels: SAFE_LABELS.filter(label => Array.isArray(error?.errorLabels) && error.errorLabels.includes(label)),
  }
}
export function setupExitCode(report) {
  return report?.outcome === 'confirmed_success' ? 0 : report?.outcome === 'confirmed_failure_before_commit' ? 1 : 2
}
export function startupFailure(error) {
  return { protocol: SETUP_PROTOCOL, outcome: 'confirmed_failure_before_commit', stage: 'validation', code: 'SETUP_FAILED', error: safeError(error), commitAttempted: false, commitConfirmed: false, cleanupWarnings: [] }
}
export function uncertainFailure(error) {
  return { ...startupFailure(error), outcome: 'uncertain_commit', stage: 'commit', commitAttempted: null }
}
export function validateSetupAuthorization(settings, database) {
  if (settings.AUTH_SETUP_ALLOW_WRITES !== 'true') throw new PasswordSetupError('WRITE_AUTH_REQUIRED', 'Explicit AUTH_SETUP_ALLOW_WRITES=true authorization is required.')
  if (!settings.AUTH_SETUP_APPROVED_DATABASE || settings.AUTH_SETUP_APPROVED_DATABASE !== database) throw new PasswordSetupError('DATABASE_MISMATCH', 'Configured database does not match the approved database.')
  if (!mongoose.isValidObjectId(settings.AUTH_SETUP_APPROVED_SHOP_ID)) throw new PasswordSetupError('INVALID_SHOP_ID', 'An approved shop ID is required.')
  const email = settings.AUTH_SETUP_USER_EMAIL?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PasswordSetupError('INVALID_USER_EMAIL', 'An existing user email is required.')
  return { shop: settings.AUTH_SETUP_APPROVED_SHOP_ID, email }
}

export async function runPasswordSetup(settings, operations) {
  let stage = 'validation'
  let session
  let originalCommit
  let connectionAttempted = false
  let commitAttempted = false
  let commitConfirmed = false
  let commitError
  let failure
  const cleanupWarnings = []
  try {
    const target = validateSetupAuthorization(settings, operations.databaseName())
    if (operations.isTTY) throw new PasswordSetupError('PASSWORD_INPUT_REQUIRED', 'Hidden stdin password input is required.')
    const password = await operations.readPassword()
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new PasswordSetupError('PASSWORD_POLICY_FAILED', 'Password length is invalid.')
    const passwordHash = await operations.hashPassword(password)
    stage = 'connection'
    connectionAttempted = true
    await operations.connect()
    session = await operations.startSession()
    if (typeof session.commitTransaction !== 'function' || typeof session.withTransaction !== 'function') throw new PasswordSetupError('SESSION_INTERFACE_INVALID', 'Transaction session is unavailable.')
    originalCommit = session.commitTransaction
    // Observe the driver's existing commit/retry path without issuing additional commits.
    session.commitTransaction = async (...args) => {
      stage = 'commit'
      commitAttempted = true
      try {
        const result = await originalCommit.apply(session, args)
        commitConfirmed = true
        return result
      } catch (error) {
        const diagnostic = safeError(error)
        commitError = { ...diagnostic, labels: SAFE_LABELS.filter(label => diagnostic.labels.includes(label) || commitError?.labels.includes(label)) }
        throw error
      }
    }
    await session.withTransaction(async () => {
      stage = 'transaction_read'
      const user = await operations.findUser(target, session)
      const shop = await operations.findShop(target, session)
      if (!user || !shop) throw new PasswordSetupError('TARGET_NOT_FOUND', 'The approved active user and shop were not found.')
      stage = 'transaction_write'
      const updated = await operations.updateUser(target, user, passwordHash, session)
      if (updated.matchedCount !== 1) throw new PasswordSetupError('TARGET_CHANGED', 'The approved user changed.')
      await operations.revokeSessions(target, user, session)
      stage = 'commit'
    })
    if (!commitConfirmed) throw new PasswordSetupError('COMMIT_NOT_CONFIRMED', 'Commit acknowledgement is unavailable.')
  } catch (error) { failure = { stage, error: safeError(error) } }
  finally {
    if (session && originalCommit) {
      try { session.commitTransaction = originalCommit }
      catch (error) { cleanupWarnings.push({ stage: 'cleanup', operation: 'restore_commit', error: safeError(error) }) }
    }
    if (session) {
      try { await session.endSession() }
      catch (error) { cleanupWarnings.push({ stage: 'cleanup', operation: 'end_session', error: safeError(error) }) }
    }
    if (connectionAttempted) {
      try { await operations.disconnect() }
      catch (error) { cleanupWarnings.push({ stage: 'cleanup', operation: 'disconnect', error: safeError(error) }) }
    }
  }
  const uncertain = !commitConfirmed && (commitAttempted || failure?.error.labels.includes('UnknownTransactionCommitResult') || failure?.error.code === 'COMMIT_NOT_CONFIRMED')
  return {
    protocol: SETUP_PROTOCOL,
    outcome: commitConfirmed ? 'confirmed_success' : uncertain ? 'uncertain_commit' : 'confirmed_failure_before_commit',
    stage: failure?.stage ?? (cleanupWarnings.length ? 'cleanup' : 'commit'),
    code: commitConfirmed ? 'SETUP_COMMITTED' : 'SETUP_FAILED',
    ...(failure ? { error: failure.error } : {}),
    ...(commitError ? { commitError } : {}),
    commitAttempted,
    commitConfirmed,
    cleanupWarnings,
  }
}

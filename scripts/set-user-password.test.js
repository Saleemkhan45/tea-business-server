import { describe, expect, it, vi } from 'vitest'
import { validateSetupAuthorization } from './set-user-password.js'
import { runPasswordSetup, safeError, setupExitCode, startupFailure, uncertainFailure } from './passwordSetupOperation.js'
describe('password setup authorization without database access', () => {
  const settings = { AUTH_SETUP_ALLOW_WRITES: 'true', AUTH_SETUP_APPROVED_DATABASE: 'approved_database', AUTH_SETUP_APPROVED_SHOP_ID: '507f1f77bcf86cd799439011', AUTH_SETUP_USER_EMAIL: ' Owner@example.invalid ' }
  it('requires explicit write authorization and an exact database match', () => {
    expect(() => validateSetupAuthorization({ ...settings, AUTH_SETUP_ALLOW_WRITES: 'false' }, 'approved_database')).toThrow('authorization')
    expect(() => validateSetupAuthorization(settings, 'different_database')).toThrow('approved database')
  })
  it('requires the existing shop and user identity', () => {
    expect(() => validateSetupAuthorization({ ...settings, AUTH_SETUP_APPROVED_SHOP_ID: 'invalid' }, 'approved_database')).toThrow('shop ID')
    expect(() => validateSetupAuthorization({ ...settings, AUTH_SETUP_USER_EMAIL: '' }, 'approved_database')).toThrow('user email')
    expect(validateSetupAuthorization(settings, 'approved_database')).toEqual({ shop: settings.AUTH_SETUP_APPROVED_SHOP_ID, email: 'owner@example.invalid' })
  })
})

const authorized = { AUTH_SETUP_ALLOW_WRITES: 'true', AUTH_SETUP_APPROVED_DATABASE: 'approved_database', AUTH_SETUP_APPROVED_SHOP_ID: '507f1f77bcf86cd799439011', AUTH_SETUP_USER_EMAIL: 'owner@example.invalid' }
function harness() {
  const session = {
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn(),
  }
  session.withTransaction.mockImplementation(async callback => { await callback(); await session.commitTransaction() })
  const operations = {
    databaseName: vi.fn(() => 'approved_database'), isTTY: false,
    readPassword: vi.fn(() => 'offline-only-test-input'),
    hashPassword: vi.fn().mockResolvedValue('redaction-only-test-value'),
    connect: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(session),
    findUser: vi.fn().mockResolvedValue({ _id: 'offline-user' }),
    findShop: vi.fn().mockResolvedValue({ _id: authorized.AUTH_SETUP_APPROVED_SHOP_ID }),
    updateUser: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    revokeSessions: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
  return { operations, session }
}
function failure(code, labels = []) {
  return Object.assign(new Error('private-marker: account, input and connection data must never appear'), { name: 'MongoServerError', code, errorLabels: labels })
}

describe('password setup outcomes with fully mocked persistence', () => {
  it.each([
    ['AUTH_SETUP_ALLOW_WRITES', 'false', 'WRITE_AUTH_REQUIRED'],
    ['AUTH_SETUP_APPROVED_DATABASE', 'different_database', 'DATABASE_MISMATCH'],
    ['AUTH_SETUP_APPROVED_SHOP_ID', 'invalid', 'INVALID_SHOP_ID'],
    ['AUTH_SETUP_USER_EMAIL', '', 'INVALID_USER_EMAIL'],
  ])('fails before connection when %s is invalid', async (field, value, code) => {
    const { operations } = harness()
    const report = await runPasswordSetup({ ...authorized, [field]: value }, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_failure_before_commit', stage: 'validation', error: { code }, commitAttempted: false })
    expect(operations.connect).not.toHaveBeenCalled()
    expect(operations.readPassword).not.toHaveBeenCalled()
    expect(setupExitCode(report)).toBe(1)
  })

  it.each(['', 'short', 'x'.repeat(257)])('rejects an invalid password length before connection', async input => {
    const { operations } = harness()
    operations.readPassword.mockReturnValue(input)
    const report = await runPasswordSetup(authorized, operations)
    expect(report.error.code).toBe('PASSWORD_POLICY_FAILED')
    expect(operations.hashPassword).not.toHaveBeenCalled()
    expect(operations.connect).not.toHaveBeenCalled()
  })

  it('rejects terminal password input without connecting', async () => {
    const { operations } = harness()
    operations.isTTY = true
    const report = await runPasswordSetup(authorized, operations)
    expect(report.error.code).toBe('PASSWORD_INPUT_REQUIRED')
    expect(operations.connect).not.toHaveBeenCalled()
  })

  it('reports a safe connection error and still attempts disconnection', async () => {
    const { operations } = harness()
    operations.connect.mockRejectedValue(failure('ECONNREFUSED'))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_failure_before_commit', stage: 'connection', error: { code: 'ECONNREFUSED' } })
    expect(operations.startSession).not.toHaveBeenCalled()
    expect(operations.disconnect).toHaveBeenCalledOnce()
    expect(JSON.stringify(report)).not.toContain('private-marker')
  })

  it.each(['findUser', 'findShop'])('rejects a missing approved target returned by %s without writing', async method => {
    const { operations, session } = harness()
    operations[method].mockResolvedValue(null)
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_failure_before_commit', stage: 'transaction_read', error: { code: 'TARGET_NOT_FOUND' } })
    expect(operations.updateUser).not.toHaveBeenCalled()
    expect(session.commitTransaction).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('reports a transaction read failure without leaking server messages', async () => {
    const { operations } = harness()
    operations.findUser.mockRejectedValue(failure(13))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ stage: 'transaction_read', error: { code: 13 }, outcome: 'confirmed_failure_before_commit' })
    expect(JSON.stringify(report)).not.toContain('private-marker')
  })

  it.each(['updateUser', 'revokeSessions'])('reports a %s failure before any commit', async method => {
    const { operations, session } = harness()
    operations[method].mockRejectedValue(failure(13, ['TransientTransactionError']))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ stage: 'transaction_write', outcome: 'confirmed_failure_before_commit', error: { code: 13, labels: ['TransientTransactionError'] } })
    expect(session.commitTransaction).not.toHaveBeenCalled()
  })

  it('rejects a changed approved account instead of proceeding to session revocation', async () => {
    const { operations } = harness()
    operations.updateUser.mockResolvedValue({ matchedCount: 0 })
    const report = await runPasswordSetup(authorized, operations)
    expect(report.error.code).toBe('TARGET_CHANGED')
    expect(operations.revokeSessions).not.toHaveBeenCalled()
  })

  it('confirms success only after the driver acknowledges commit and restores the original commit method', async () => {
    const { operations, session } = harness()
    const original = session.commitTransaction
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_success', stage: 'commit', commitAttempted: true, commitConfirmed: true })
    expect(setupExitCode(report)).toBe(0)
    expect(session.commitTransaction).toBe(original)
    expect(original).toHaveBeenCalledOnce()
    expect(operations.findUser).toHaveBeenCalledWith({ shop: authorized.AUTH_SETUP_APPROVED_SHOP_ID, email: authorized.AUTH_SETUP_USER_EMAIL }, session)
  })

  it.each([{ labels: ['UnknownTransactionCommitResult'] }, { labels: [] }])('keeps a failed commit uncertain with labels %j', async ({ labels }) => {
    const { operations, session } = harness()
    session.commitTransaction.mockRejectedValue(failure(91, labels))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'uncertain_commit', stage: 'commit', commitConfirmed: false, commitAttempted: true, error: { code: 91, labels } })
    expect(setupExitCode(report)).toBe(2)
    expect(operations.updateUser).toHaveBeenCalledOnce()
  })

  it('does not downgrade earlier commit uncertainty when a later callback read fails', async () => {
    const { operations, session } = harness()
    operations.findUser.mockResolvedValueOnce({ _id: 'offline-user' }).mockResolvedValueOnce(null)
    session.commitTransaction.mockRejectedValue(failure(91, ['UnknownTransactionCommitResult']))
    session.withTransaction.mockImplementation(async callback => {
      await callback()
      try { await session.commitTransaction() } catch { /* Simulate the driver continuing after a commit error. */ }
      await callback()
    })
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'uncertain_commit', stage: 'transaction_read', commitError: { labels: ['UnknownTransactionCommitResult'] } })
  })

  it('retains an unknown-commit label after a later unlabeled commit error', async () => {
    const { operations, session } = harness()
    session.commitTransaction.mockRejectedValueOnce(failure(91, ['UnknownTransactionCommitResult'])).mockRejectedValueOnce(failure(13))
    session.withTransaction.mockImplementation(async callback => {
      await callback()
      try { await session.commitTransaction() } catch { await session.commitTransaction() }
    })
    const report = await runPasswordSetup(authorized, operations)
    expect(report.outcome).toBe('uncertain_commit')
    expect(report.commitError).toMatchObject({ code: 13, labels: ['UnknownTransactionCommitResult'] })
  })

  it('recognizes an acknowledged driver commit retry without issuing extra writes', async () => {
    const { operations, session } = harness()
    session.commitTransaction.mockRejectedValueOnce(failure(91, ['UnknownTransactionCommitResult'])).mockResolvedValueOnce(undefined)
    session.withTransaction.mockImplementation(async callback => {
      await callback()
      try { await session.commitTransaction() } catch { await session.commitTransaction() }
    })
    const report = await runPasswordSetup(authorized, operations)
    expect(report.outcome).toBe('confirmed_success')
    expect(operations.updateUser).toHaveBeenCalledOnce()
  })

  it('does not claim success when withTransaction returns without an observed commit acknowledgement', async () => {
    const { operations, session } = harness()
    session.withTransaction.mockImplementation(async callback => callback())
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'uncertain_commit', error: { code: 'COMMIT_NOT_CONFIRMED' } })
  })

  it('retains confirmed success when both cleanup operations fail and attempts both', async () => {
    const { operations, session } = harness()
    session.endSession.mockRejectedValue(failure('EIO'))
    operations.disconnect.mockRejectedValue(failure('ECONNRESET'))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_success', stage: 'cleanup', commitConfirmed: true })
    expect(setupExitCode(report)).toBe(0)
    expect(report.cleanupWarnings.map(warning => warning.operation)).toEqual(['end_session', 'disconnect'])
    expect(operations.disconnect).toHaveBeenCalledOnce()
  })

  it('retains the original transaction error when cleanup also fails', async () => {
    const { operations, session } = harness()
    operations.updateUser.mockRejectedValue(failure(13))
    session.endSession.mockRejectedValue(failure('EIO'))
    const report = await runPasswordSetup(authorized, operations)
    expect(report).toMatchObject({ outcome: 'confirmed_failure_before_commit', stage: 'transaction_write', error: { code: 13 } })
    expect(report.cleanupWarnings).toHaveLength(1)
    expect(operations.disconnect).toHaveBeenCalledOnce()
  })

  it('does not turn an unknown commit into success when cleanup succeeds or fails', async () => {
    const { operations, session } = harness()
    session.commitTransaction.mockRejectedValue(failure(91, ['UnknownTransactionCommitResult']))
    operations.disconnect.mockRejectedValue(failure('EIO'))
    const report = await runPasswordSetup(authorized, operations)
    expect(report.outcome).toBe('uncertain_commit')
    expect(report.error.code).toBe(91)
    expect(report.cleanupWarnings).toHaveLength(1)
  })

  it('preserves a confirmed commit even if the driver subsequently reports an error', async () => {
    const { operations, session } = harness()
    session.withTransaction.mockImplementation(async callback => { await callback(); await session.commitTransaction(); throw failure('EIO') })
    const report = await runPasswordSetup(authorized, operations)
    expect(report.outcome).toBe('confirmed_success')
    expect(report.error.code).toBe('EIO')
  })
})

describe('sanitized diagnostic allowlist', () => {
  it.each([
    ['MONGODB_URI is required. Check server/.env', 'MONGODB_URI_REQUIRED'],
    ['JWT_SECRET is required in production.', 'JWT_SECRET_REQUIRED'],
    ['CLIENT_ORIGIN must be the exact HTTPS frontend origin in production.', 'CLIENT_ORIGIN_INVALID'],
  ])('maps a known startup configuration failure to %s without echoing values', (message, code) => {
    expect(startupFailure(new Error(message))).toMatchObject({ stage: 'validation', error: { code } })
  })
  it('drops free-form messages, causes, stack traces, unknown names, codes and labels', () => {
    const report = safeError({ name: 'private-marker', code: 'private-marker', errorLabels: ['private-marker', 'UnknownTransactionCommitResult'], message: 'private-marker', stack: 'private-marker', cause: 'private-marker' })
    expect(report).toEqual({ name: 'Error', code: 'UNCLASSIFIED', labels: ['UnknownTransactionCommitResult'] })
    expect(JSON.stringify(report)).not.toContain('private-marker')
  })
  it.each([-1, Infinity, NaN, 1.5, 2147483648])('rejects unsafe numeric error code %s', code => {
    expect(safeError({ code }).code).toBe('UNCLASSIFIED')
  })
  it('keeps startup failures separate from unexpected operation failures', () => {
    expect(startupFailure(failure('ENOENT')).outcome).toBe('confirmed_failure_before_commit')
    expect(uncertainFailure(failure('EIO')).outcome).toBe('uncertain_commit')
    expect(setupExitCode({})).toBe(2)
  })
})

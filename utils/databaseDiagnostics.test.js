import { describe, expect, it } from 'vitest'
import { logDatabaseError, redactDatabaseMessage } from './databaseDiagnostics.js'

const sampleUri = 'mongodb://SAMPLE_USER:SAMPLE%40PASSWORD@sample.invalid/tea_business_dashboard'

describe('database error redaction', () => {
  it('redacts standard, SRV, and case-insensitive URIs anywhere in a message', () => {
    expect(redactDatabaseMessage('Failed "mongodb://OTHER_USER:OTHER_PASSWORD@sample.invalid/db" or mongodb+srv://other.invalid/db and MONGODB://another.invalid/db'))
      .toBe('Failed "[redacted-uri]" or [redacted-uri] and [redacted-uri]')
  })

  it('redacts the complete configured URI even when it contains whitespace or quotes', () => {
    const malformed = 'mongodb://SAMPLE_USER:SAMPLE PASSWORD"@sample.invalid/db'
    expect(redactDatabaseMessage(`Invalid ${malformed}`, malformed)).toBe('Invalid [redacted-uri]')
  })

  it('redacts encoded and decoded credentials repeated outside the URI', () => {
    const output = redactDatabaseMessage(`Invalid ${sampleUri}; user SAMPLE_USER, password SAMPLE%40PASSWORD or SAMPLE@PASSWORD`, sampleUri)
    expect(output).not.toContain('SAMPLE_USER')
    expect(output).not.toContain('SAMPLE%40PASSWORD')
    expect(output).not.toContain('SAMPLE@PASSWORD')
    expect(output).toContain('[redacted-uri]')
  })

  it('preserves actionable DNS and authentication errors', () => {
    expect(redactDatabaseMessage('querySrv ECONNREFUSED _mongodb._tcp.sample.invalid', sampleUri))
      .toBe('querySrv ECONNREFUSED _mongodb._tcp.sample.invalid')
    expect(redactDatabaseMessage('bad auth : Authentication failed.', sampleUri))
      .toBe('bad auth : Authentication failed.')
  })

  it('logs nested network fields and per-server errors without secrets', () => {
    const output = []
    const cause = Object.assign(new Error('connect ENOTFOUND sample.invalid'), {
      code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'sample.invalid',
    })
    const error = Object.assign(new Error(`Selection failed for ${sampleUri}`), {
      name: 'MongooseServerSelectionError',
      reason: { servers: new Map([
        ['sample.invalid:27017', { error: Object.assign(new Error(`Cannot connect to ${sampleUri}`), { cause }) }],
        ['other.invalid:27017', { error: null }],
      ]) },
    })
    cause.cause = cause
    logDatabaseError(error, sampleUri, line => output.push(line))
    const text = output.join('\n')
    expect(text).toContain('name: MongooseServerSelectionError')
    expect(text).toContain('server: sample.invalid:27017')
    expect(text).toContain('cause.code: ENOTFOUND')
    expect(text).toContain('cause.syscall: getaddrinfo')
    expect(text).toContain('cause.hostname: sample.invalid')
    expect(text).toContain('message: no error recorded')
    expect(text).not.toContain('mongodb://')
    expect(text).not.toContain('SAMPLE_USER')
    expect(text).not.toContain('SAMPLE%40PASSWORD')
  })
})

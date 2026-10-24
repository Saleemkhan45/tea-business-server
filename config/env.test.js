import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { configure, setServers } = vi.hoisted(() => ({ configure: vi.fn(), setServers: vi.fn() }))
vi.mock('dotenv', () => ({ default: { config: configure } }))
vi.mock('node:dns', () => ({ default: { setServers } }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('MONGODB_URI', 'mongodb://sample.invalid/tea_business_dashboard')
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('JWT_SECRET', '')
  vi.stubEnv('DNS_SERVERS', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('database env configuration', () => {
  it('never generates a runtime signing secret for opaque development sessions', async () => {
    const { env } = await import('./env.js')
    expect(env.jwtSecret).toBe('')
  })
  it('uses secure cross-site cookies and exact origins in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JWT_SECRET', 'offline-only-test-secret-at-least-32-characters')
    vi.stubEnv('CLIENT_ORIGIN', 'https://dashboard.example.invalid')
    const { env } = await import('./env.js')
    expect(env).toMatchObject({ cookieName: '__Host-tea_business_session', cookieSameSite: 'none', allowDemoAuth: false })
  })

  it('rejects wildcard production origins and insecure SameSite=None settings', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JWT_SECRET', 'offline-only-test-secret-at-least-32-characters')
    vi.stubEnv('CLIENT_ORIGIN', 'https://*.example.invalid')
    await expect(import('./env.js')).rejects.toThrow('exact HTTPS')
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SESSION_COOKIE_SAMESITE', 'none')
    await expect(import('./env.js')).rejects.toThrow('HTTPS production')
  })
  it('loads the .env next to the server and leaves DNS unchanged by default', async () => {
    await import('./env.js')
    expect(configure).toHaveBeenCalledWith({
      path: path.resolve(fileURLToPath(new URL('../.env', import.meta.url))),
    })
    expect(setServers).not.toHaveBeenCalled()
  })

  it.each(['', '   '])('fails immediately for a missing or blank MongoDB URI', async value => {
    vi.stubEnv('MONGODB_URI', value)
    await expect(import('./env.js')).rejects.toThrow('MONGODB_URI is required. Check server/.env')
  })

  it('preserves the production JWT secret guard', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await expect(import('./env.js')).rejects.toThrow('JWT_SECRET is required in production.')
  })

  it('sets DNS servers only when explicitly configured', async () => {
    vi.stubEnv('DNS_SERVERS', ' 8.8.8.8, 1.1.1.1 ')
    await import('./env.js')
    expect(setServers).toHaveBeenCalledWith(['8.8.8.8', '1.1.1.1'])
  })

  it('rejects a DNS opt-in with no addresses', async () => {
    vi.stubEnv('DNS_SERVERS', ', ,')
    await expect(import('./env.js')).rejects.toThrow('DNS_SERVERS must contain comma-separated DNS server IP addresses.')
  })
})

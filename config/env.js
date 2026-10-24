import dns from 'node:dns'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.resolve(__dirname, '../.env')

dotenv.config({ path: envPath })

const isProduction = process.env.NODE_ENV === 'production'
const mongoUri = process.env.MONGODB_URI?.trim()

if (!mongoUri) {
  throw new Error('MONGODB_URI is required. Check server/.env')
}

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production.')
}
if (isProduction && process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters in production.')
if (isProduction) {
  let origin
  try { origin = new URL(process.env.CLIENT_ORIGIN) } catch { origin = null }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== process.env.CLIENT_ORIGIN || origin.hostname.includes('*')) {
    throw new Error('CLIENT_ORIGIN must be the exact HTTPS frontend origin in production.')
  }
}
const cookieSameSite = process.env.SESSION_COOKIE_SAMESITE ?? (isProduction ? 'none' : 'lax')
if (!['lax', 'strict', 'none'].includes(cookieSameSite)) throw new Error('SESSION_COOKIE_SAMESITE must be lax, strict or none.')
if (!isProduction && cookieSameSite === 'none') throw new Error('SameSite=None requires HTTPS production cookies.')

// Dev-only workaround for networks that block SRV DNS lookups; opt in explicitly.
if (process.env.DNS_SERVERS?.trim()) {
  const servers = process.env.DNS_SERVERS.split(',').map(server => server.trim()).filter(Boolean)
  try {
    if (!servers.length) throw new Error()
    dns.setServers(servers)
  } catch {
    throw new Error('DNS_SERVERS must contain comma-separated DNS server IP addresses.')
  }
}

export const env = {
  trustedStaffEnabled: process.env.TRUSTED_STAFF_VIEW_ENABLED === 'true',
  trustedStaffShop: process.env.TRUSTED_STAFF_SHOP_ID ?? '',
  trustedStaffUser: process.env.TRUSTED_STAFF_USER_ID ?? '',
  trustedProxySecret: process.env.TRUSTED_STAFF_PROXY_SECRET ?? '',
  trustedProxyAddresses: (process.env.TRUSTED_STAFF_PROXY_ADDRESSES ?? '').split(',').map(value => value.trim()).filter(Boolean),
  trustedStaffResources: (process.env.TRUSTED_STAFF_READ_RESOURCES ?? '').split(',').map(value => value.trim()).filter(Boolean),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUri,
  jwtSecret: process.env.JWT_SECRET?.trim() ?? '',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  allowDemoAuth: false,
  cookieName: isProduction ? '__Host-tea_business_session' : 'tea_business_session',
  cookieSameSite,
}

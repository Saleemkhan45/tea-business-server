import { pathToFileURL } from 'node:url'
import { manualCashIndexPlan } from '../manual-cashbook/index-plan.js'
import { applyManualCashSetup, inspectManualCashSetup, validateSetupApproval } from '../manual-cashbook/setup.js'

// Never print driver messages: they may include connection hosts or credentials.
export function setupFailureDetails(error) {
  const codes = [error?.code, error?.cause?.code]
  if (codes.includes(13)) return { code: 'DATABASE_PERMISSION_DENIED', message: 'The configured database account cannot perform the required inspection or setup.' }
  if (codes.includes(11000)) return { code: 'DUPLICATE_INDEX_CONFLICT', message: 'Existing duplicate keys blocked a unique index. Stop and review the existing data.' }
  if (codes.some(code => ['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'EREFUSED'].includes(code)) || (error?.syscall?.startsWith('query') && codes.includes('ECONNREFUSED'))) return { code: 'DATABASE_DNS_FAILED', message: 'MongoDB DNS lookup failed before database readiness could be inspected.' }
  if (codes.some(code => ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) || ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError'].includes(error?.name)) return { code: 'DATABASE_CONNECTION_FAILED', message: 'MongoDB could not be reached. Collection and index readiness remain unverified.' }
  return { code: 'SETUP_STOPPED', message: 'Review approval, target database, privileges, existing indexes/documents and transaction support before retrying.' }
}

async function main() {
  const mode = process.argv[2] ?? '--plan'
  if (mode === '--plan') return console.log(JSON.stringify({ mode: 'offline_plan_only', collections: manualCashIndexPlan }, null, 2))
  if (!['--inspect', '--apply'].includes(mode)) throw new Error('Use --plan, --inspect, or --apply.')
  // Reject unauthorized invocation before loading configuration or creating a client.
  validateSetupApproval(process.env, process.env.MANUAL_CASH_SETUP_DATABASE, mode === '--apply')
  const [{ env }, { MongoClient }] = await Promise.all([import('../config/env.js'), import('mongodb')])
  const client = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000 })
  validateSetupApproval(process.env, client.options.dbName, mode === '--apply')
  try {
    await client.connect()
    const db = client.db()
    const report = mode === '--apply' ? await applyManualCashSetup(db, process.env) : await inspectManualCashSetup(db)
    console.log(JSON.stringify({ mode, ...report }, null, 2))
    if (report.blockers.length || (mode === '--apply' && !report.ready)) process.exitCode = 1
  } finally { await client.close() }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(error => { console.error(JSON.stringify({ ...setupFailureDetails(error), cleanupWritesAttempted: false })); process.exitCode = 1 })
}

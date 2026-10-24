// Deployment cron entrypoint. Do not run against a database without authorization.
import { connectDatabase, disconnectDatabase } from '../config/db.js'
import { runDeliveryWorker } from './worker.js'
import { runCustomerMessaging } from '../whatsapp/worker.js'

if (process.env.REMINDER_WORKER_ENABLED !== 'true') {
  console.error('Reminder worker is disabled. Complete reviewed deployment before enabling it.')
  process.exitCode = 1
} else {
  try {
    await connectDatabase()
    const result = await runDeliveryWorker()
    if (result.failedClaims > 0) { console.error(`Reminder worker had ${result.failedClaims} failed claims; inspect queue leases.`); process.exitCode = 1 }
    const customerResult = await runCustomerMessaging()
    if (customerResult.failedClaims > 0) { console.error(`Customer messaging had ${customerResult.failedClaims} failed claims; inspect queue leases.`); process.exitCode = 1 }
  }
  catch { console.error('Reminder worker failed. Inspect safe delivery status codes.'); process.exitCode = 1 }
  finally { await disconnectDatabase() }
}

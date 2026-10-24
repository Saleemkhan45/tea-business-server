import cron from 'node-cron'
import { diagnostic } from '../utils/safeDiagnostics.js'
import { runCollectionReminderJob } from '../services/collectionNotifications.js'
import { getBusinessClock } from '../utils/businessDay.js'
import { evaluateSales, evaluateUnpaidCustomers } from '../services/notificationService.js'

export function startNotificationJobs() {
  const jobs = []
  jobs.push(cron.schedule('*/5 * * * *', () => {
    runCollectionReminderJob().catch(() => diagnostic('job.collections.failed'))
  }, { timezone: 'Asia/Karachi' }))

  jobs.push(cron.schedule('*/30 8-22 * * *', () => {
    evaluateSales().catch(() => diagnostic('job.sales.failed'))
  }, { timezone: 'Asia/Karachi' }))

  jobs.push(cron.schedule('* * * * *', () => {
    const cutoffTime = getBusinessClock()
    evaluateUnpaidCustomers({ cutoffTime }).catch(() => diagnostic('job.unpaid.failed'))
  }, { timezone: 'Asia/Karachi' }))

  return {
    stop() {
      jobs.forEach(job => job.stop())
    },
  }
}

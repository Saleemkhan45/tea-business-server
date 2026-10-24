import { CollectionSchedule, CollectionOccurrence } from '../models/CollectionSchedule.js'
import { Notification } from '../models/Notification.js'

let readiness
export function requireCollectionIndexes() {
  if (!readiness) readiness = verify().catch(error => { readiness = undefined; throw error })
  return readiness
}
async function verify() {
  try {
    const [schedules, occurrences, notifications] = await Promise.all([
      CollectionSchedule.collection.listIndexes().toArray(),
      CollectionOccurrence.collection.listIndexes().toArray(),
      Notification.collection.listIndexes().toArray(),
    ])
    if (!schedules.some(index => index.name === 'collection_schedule_customer_unique' && index.unique
      && JSON.stringify(index.key) === JSON.stringify({ shop: 1, customer: 1 }))
      || !occurrences.some(index => index.name === 'collection_occurrence_unique' && index.unique
        && JSON.stringify(index.key) === JSON.stringify({ shop: 1, schedule: 1, scheduledDate: 1 }))
      || !notifications.some(index => index.unique && !index.sparse && !index.partialFilterExpression
        && JSON.stringify(index.key) === JSON.stringify({ dedupeKey: 1 }))
      || notifications.some(index => index.key.createdAt && index.expireAfterSeconds !== undefined)
      || !notifications.some(index => index.key.expiresAt === 1 && index.expireAfterSeconds === 0)) throw new Error('Indexes are not ready.')
  } catch {
    throw Object.assign(new Error('Collection scheduling requires the reviewed index deployment. Contact the administrator.'), { statusCode: 503 })
  }
}

// Offline plan only. This file never loads .env, opens a connection, or creates an index.
import { ManualCashDay, ManualCashRevision } from '../models/ManualCashDay.js'

export const manualCashIndexPlan = [ManualCashDay, ManualCashRevision].map(model => ({
  collection: model.collection.name,
  indexes: model.schema.indexes().map(([key, options]) => ({ key, unique: Boolean(options.unique) })),
}))
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/index-plan.js')) process.stdout.write(`${JSON.stringify({ mode: 'offline_review_only', collections: manualCashIndexPlan }, null, 2)}\n`)

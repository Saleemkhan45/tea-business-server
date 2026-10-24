// Offline schema inspection only: no .env, connection, initialization or index writes.
import { Sale } from '../models/Sale.js'
import { RegionalStock } from '../models/RegionalStock.js'
import { CustomerLedgerTransaction } from '../models/CustomerLedgerTransaction.js'
import { manualCashIndexPlan } from '../manual-cashbook/index-plan.js'

export const dashboardIndexPlan = {
  mode: 'offline_review_only',
  declared: [Sale, RegionalStock, CustomerLedgerTransaction].map(model => ({ collection: model.collection.name, indexes: model.schema.indexes().map(([key, options]) => ({ key, ...options })) })),
  manualCash: manualCashIndexPlan,
  candidatesForAuthorizedExplain: [
    { collection: CustomerLedgerTransaction.collection.name, key: { shop: 1, reversalOf: 1, status: 1 }, reason: 'Shop-scoped active payment-reversal lookup in the dashboard facet. Candidate only; inspect deployed indexes and explain before approval.' },
    { collection: CustomerLedgerTransaction.collection.name, key: { shop: 1, status: 1, customer: 1 }, reason: 'Current positive ledger balances. Compare against existing shop-leading indexes and actual scan/working-set costs; do not add without evidence.' },
  ],
  notes: [
    'Existing Sale shop/businessDate and shop/sellingRegion/businessDate indexes match dashboard date/region filters.',
    'Existing RegionalStock shop/region/item uniqueness supports stock scope; joins use existing _id indexes and independently verify shop/status.',
    'No new schema index declaration is made, so this plan cannot trigger automatic production index creation.',
    'Actual deployed index presence, winning plans, docsExamined/keysExamined and Atlas latency remain unverified until authorized read-only inspection.',
  ],
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/dashboard-index-plan.js')) process.stdout.write(`${JSON.stringify(dashboardIndexPlan, null, 2)}\n`)

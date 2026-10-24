import * as customerLedgerService from '../services/customerLedgerService.js'
import { getBusinessDate } from '../utils/businessDay.js'
import {
  serializeLedger,
  serializeReminderCandidate,
  serializeSummary,
  serializeTransaction,
} from './customerLedgerResponse.js'

function scope(req) {
  return { shop: req.user.shopId, customer: req.params.customerId }
}

function referenceDate(req) {
  return req.query.referenceDate ?? getBusinessDate()
}

export async function getLedger(req, res) {
  const ledger = await customerLedgerService.getLedger(scope(req))
  res.json(serializeLedger(ledger, req.query))
}

export async function getSummary(req, res) {
  const summary = await customerLedgerService.getSummary({ ...scope(req), referenceDate: referenceDate(req) })
  res.json({ summary: serializeSummary(summary) })
}

export async function getDailyPayments(req, res) {
  const { from: startDate, to: endDate } = req.query
  const buckets = await customerLedgerService.getDailyPayments({ ...scope(req), startDate, endDate })
  res.json({ customerId: req.params.customerId, startDate, endDate, buckets })
}

export async function getPaymentInsights(req, res) {
  const { from: startDate, to: endDate } = req.query
  const insight = await customerLedgerService.getPaymentInsight({
    ...scope(req), startDate, endDate, referenceDate: referenceDate(req),
  })
  res.json({ customerId: req.params.customerId, startDate, endDate, insight })
}

export async function getPaymentCalendar(req, res) {
  const { from: startDate, to: endDate } = req.query
  const buckets = await customerLedgerService.getPaymentCalendar({ ...scope(req), startDate, endDate })
  res.json({ customerId: req.params.customerId, startDate, endDate, buckets })
}

export async function getReminderCandidate(req, res) {
  const candidate = await customerLedgerService.getReminderCandidate({
    ...scope(req), referenceDate: referenceDate(req), thresholdDays: req.query.thresholdDays,
  })
  res.json({ candidate: serializeReminderCandidate(candidate) })
}

export async function createPurchase(req, res) {
  const transaction = await customerLedgerService.createPurchase({
    ...req.body, ...scope(req), createdBy: req.user.id,
  })
  res.status(201).json({ transaction: serializeTransaction(transaction) })
}

export async function createPayment(req, res) {
  const transaction = await customerLedgerService.createPayment({
    ...req.body, ...scope(req), createdBy: req.user.id,
  })
  res.status(201).json({ transaction: serializeTransaction(transaction) })
}

export async function createOpeningBalance(req, res) {
  const transaction = await customerLedgerService.createOpeningBalance({
    ...req.body, ...scope(req), createdBy: req.user.id,
  })
  res.status(201).json({ transaction: serializeTransaction(transaction) })
}

export async function createAdjustment(req, res) {
  const transaction = await customerLedgerService.createAdjustment({
    ...req.body, ...scope(req), createdBy: req.user.id,
  })
  res.status(201).json({ transaction: serializeTransaction(transaction) })
}

export async function voidTransaction(req, res) {
  const transaction = await customerLedgerService.voidTransaction({
    ...scope(req),
    transactionId: req.params.transactionId,
    voidedBy: req.user.id,
    voidReason: req.body.reason,
  })
  res.json({ transaction: serializeTransaction(transaction) })
}

const NOT_FOUND = new Set(['Shop not found.', 'Customer not found.', 'Sale not found.', 'Customer ledger transaction not found.'])
const CONFLICT = new Set([
  'Customer idempotency key was already used for different customer details.',
  'Customer creation is already in progress. Retry with the same idempotency key.',
  'Payment idempotency key was already used for a different or voided payment.',
  'Sale-linked ledger transactions must be reversed through the Sale.',
  'Customer is inactive.',
  'Customer already has an active opening balance.',
  'Customer ledger transaction is already voided.',
  'Payment cannot exceed the active customer balance.',
  'Opening balance would leave a negative customer balance.',
  'Adjustment cannot create a negative customer balance.',
  'Ledger reversal would create a negative customer balance. Resolve later payments or ledger activity first.',
  'Sale customer does not match the ledger customer.',
  'Sale is not a credit sale.',
  'Voided Sale cannot receive a ledger charge.',
  'Ledger purchase details do not match the Sale.',
  'Sale already has an active customer ledger charge.',
  'Sale changed while adding its ledger charge. Retry the request.',
  'Sale-linked ledger charges must be voided through the Sale.',
])
const INVALID_INPUT = [
  /^Customer idempotency key is required/,
  /^Customer phone must be/,
  /^Opening balance must be/,
  /^Payment idempotency key is required/,
  /^Shop must be a valid ID\.$/,
  /^Customer must be a valid ID\.$/,
  /^Creator must be a valid ID\.$/,
  /^Sale ID must be a valid ID\.$/,
  /^Transaction must be a valid ID\.$/,
  /^Void operator must be a valid ID\.$/,
  /^Operator must be a valid ID\.$/,
  /^Business date must be/,
  /^Payment date range start must be/,
  /^Reminder threshold must be/,
  /^Notes must be/,
  /^Stock location ID is required/,
  /^Customer purchase tea type is invalid\.$/,
  /^Customer payment method is invalid\.$/,
  /^Quantity must be/,
  /^Quantity and rate must/,
  /^Rate per kilogram must be/,
  /^Payment amount must be/,
  /^Opening balance amount must be/,
  /^Adjustment amount must be/,
  /^Adjustment reason is required/,
  /^Void reason is required/,
]

export function mapCustomerLedgerError(error, req, res, next) {
  if (NOT_FOUND.has(error.message)) error.statusCode = 404
  else if (error.message === 'Operator not found.') error.statusCode = 403
  else if (CONFLICT.has(error.message)) error.statusCode = 409
  else if (INVALID_INPUT.some(pattern => pattern.test(error.message))) error.statusCode = 400
  next(error)
}

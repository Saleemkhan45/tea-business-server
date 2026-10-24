import * as saleService from '../services/saleService.js'
import { getBusinessDate } from '../utils/businessDay.js'

export async function getEntryOptions(req, res) {
  res.json(await saleService.getEntryOptions({ shop: req.user.shopId, userId: req.user.id, regionId: req.query.regionId }))
}

export async function getSalesSummary(req, res) {
  res.json({ summary: await saleService.getSalesSummary({ shop: req.user.shopId, date: req.query.from ?? getBusinessDate() }) })
}

function scope(req) {
  return { shop: req.user.shopId }
}

export async function listSales(req, res) {
  const sales = await saleService.listSales({ ...scope(req), ...req.query })
  res.json({ sales })
}

export async function getSale(req, res) {
  const sale = await saleService.getSale({ ...scope(req), saleId: req.params.saleId })
  if (!sale) return res.status(404).json({ message: 'Sale not found.' })
  res.json({ sale })
}

export async function createSale(req, res) {
  const sale = await saleService.createSale({
    ...req.body,
    ...scope(req),
    customer: req.body.customerId ?? req.body.customer,
    createdBy: req.user.id,
  })
  res.status(201).json({ sale })
}

export async function updateSale(req, res) {
  const sale = await saleService.updateSale({
    ...req.body,
    ...scope(req),
    saleId: req.params.saleId,
    customer: req.body.customerId ?? req.body.customer,
    createdBy: req.user.id,
  })
  res.json({ sale })
}

export async function voidSale(req, res) {
  const sale = await saleService.voidSale({
    ...scope(req),
    saleId: req.params.saleId,
    voidedBy: req.user.id,
    voidReason: req.body.reason,
  })
  res.json({ sale })
}

const NOT_FOUND = new Set(['Sale not found.', 'Shop not found.', 'Customer not found.', 'Stock location not found.'])
const CONFLICT = new Set([
  'Sale is already voided.',
  'Insufficient stock for sale.',
  'Legacy sale inventory audit is unavailable; editing requires inventory reconciliation.',
  'Idempotency key was already used for a different sale request.',
  'Sale creation is already in progress. Retry with the same idempotency key.',
  'Credit Sale is missing its active ledger charge.',
  'Sale ledger charge customer does not match the Sale.',
  'Non-credit Sale has an active ledger charge.',
  'Sale payment ledger entry is inconsistent.',
  'Sale ledger charge amount does not match the Sale.',
  'Sale change would create customer credit. Record a refund or adjustment first.',
  'Sale cancellation would create a negative customer balance. Resolve later payments or ledger activity before cancelling this sale.',
])
const INVALID_INPUT = [
  /^Shop must be a valid ID\.$/,
  /^Sale must be a valid ID\.$/,
  /^Customer must be a valid ID\.$/,
  /^Creator must be a valid ID\.$/,
  /^Selling region must be a valid ID\.$/,
  /^Stock location must be a valid ID\.$/,
  /^Void operator must be a valid ID\.$/,
  /^Operator must be a valid ID\.$/,
  /^Business date must be/,
  /^Customer name is required/,
  /^Customer is required for credit sales\.$/,
  /^Customer (phone|address|region|city|notes) must/,
  /^Opening balance must be/,
  /^Choose an existing customer or enter a new customer/,
  /^New customer details are invalid\.$/,
  /^Notes must be/,
  /^Salesperson name must/,
  /^Stock location tea type does not match/,
  /^Quantity must/,
  /^Quantity and unit price must/,
  /^Unit price must/,
  /^Sale tea type is invalid\.$/,
  /^Sale payment method is invalid\.$/,
  /^Sale status is invalid\.$/,
  /^Void reason is required/,
  /^Idempotency key is required/,
  /^Amount paid must/,
  /^Non-credit sales must/,
  /^Received payment method is invalid/,
]

export function mapSalesError(error, req, res, next) {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message })
  if (NOT_FOUND.has(error.message)) error.statusCode = 404
  else if (error.message === 'Operator not found.') error.statusCode = 403
  else if (CONFLICT.has(error.message)) error.statusCode = 409
  else if (INVALID_INPUT.some(pattern => pattern.test(error.message))) error.statusCode = 400
  next(error)
}

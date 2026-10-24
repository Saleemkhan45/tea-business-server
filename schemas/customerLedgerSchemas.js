import { z } from 'zod'
import {
  CUSTOMER_DIRECTORY_DEFAULT_LIMIT,
  CUSTOMER_DIRECTORY_DEFAULT_PAGE,
  CUSTOMER_DIRECTORY_MAX_LIMIT,
  CUSTOMER_DIRECTORY_MAX_PAGE,
  CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH,
} from '../constants/customerDirectory.js'
import { CUSTOMER_CREATION_IDEMPOTENCY_KEY_MAX_LENGTH } from '../models/Customer.js'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID.')
const businessDate = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}, 'Business date must be a valid YYYY-MM-DD date.')
const integerPkr = z.number().int().refine(Number.isSafeInteger, 'Amount must be a safe integer PKR value.')
const positivePkr = integerPkr.positive()
const notes = z.string().trim().max(500).nullable().optional()
const customerNotes = z.string().trim().max(1000).optional()
const text = max => z.string().trim().min(1).max(max)
const phone = z.string().trim().max(40).refine(value => {
  if (!value) return true
  return /^\+?[0-9\s().-]+$/.test(value) && value.replace(/\D/g, '').length >= 7
}, 'Enter a valid phone number.').optional()

export const customerParamsSchema = z.object({ customerId: objectId }).strict()
export const customerBodySchema = z.object({
  name: text(160), phone,
  address: z.string().trim().max(300).optional(), region: z.string().trim().max(120).optional(),
  city: text(120).optional(),
  notes: customerNotes,
  openingBalancePkr: integerPkr.nonnegative().optional(),
  idempotencyKey: text(CUSTOMER_CREATION_IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
}).strict()
export const transactionParamsSchema = z.object({ customerId: objectId, transactionId: objectId }).strict()
export const customerDirectoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(CUSTOMER_DIRECTORY_MAX_PAGE).default(CUSTOMER_DIRECTORY_DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(CUSTOMER_DIRECTORY_MAX_LIMIT).default(CUSTOMER_DIRECTORY_DEFAULT_LIMIT),
  search: z.string().trim().max(CUSTOMER_DIRECTORY_SEARCH_MAX_LENGTH).optional()
    .transform(value => value || undefined),
  status: z.enum(['active', 'inactive']).optional(),
}).strict()

const optionalReferenceDate = z.object({ referenceDate: businessDate.optional() }).strict()
const dateRange = z.object({ from: businessDate, to: businessDate }).strict()
  .refine(value => value.from <= value.to, { path: ['to'], message: 'End date must be on or after start date.' })

export const ledgerQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  type: z.enum(['purchase', 'payment', 'opening_balance', 'adjustment', 'return']).optional(),
  teaType: z.enum(['green', 'black', 'jasmine', 'herbal', 'other']).optional(),
  status: z.enum(['active', 'voided']).optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, {
  path: ['to'], message: 'End date must be on or after start date.',
})

export const summaryQuerySchema = optionalReferenceDate
export const dailyPaymentsQuerySchema = dateRange
export const paymentCalendarQuerySchema = dateRange
export const paymentInsightsQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
  referenceDate: businessDate.optional(),
}).strict().refine(value => value.from <= value.to, {
  path: ['to'], message: 'End date must be on or after start date.',
})
export const reminderCandidateQuerySchema = z.object({
  referenceDate: businessDate.optional(),
  thresholdDays: z.string().regex(/^(0|[1-9]\d*)$/).transform(Number)
    .pipe(z.number().int().safe().nonnegative()),
}).strict()

const transactionBase = {
  businessDate,
  notes,
}

export const purchaseBodySchema = z.object({
  ...transactionBase,
  saleId: objectId,
  teaType: z.enum(['green', 'black', 'jasmine', 'herbal', 'other']),
  stockLocationId: text(120),
  quantityKg: z.number().finite().positive().refine(value => {
    const grams = Math.round(value * 1000)
    return Number.isSafeInteger(grams) && Math.abs(value - grams / 1000) < 1e-9
  }, 'Quantity must use no more than three decimal places.'),
  ratePerKgPkr: positivePkr,
}).strict()

export const paymentBodySchema = z.object({
  ...transactionBase,
  collectionOccurrence: objectId.optional(),
  idempotencyKey: text(120).optional(),
  amountPkr: positivePkr,
  paymentMethod: z.enum(['cash', 'bank_transfer', 'card', 'cheque', 'other']),
  reference: z.string().trim().max(120).optional(),
}).strict()

export const openingBalanceBodySchema = z.object({
  ...transactionBase,
  amountPkr: positivePkr,
}).strict()

export const adjustmentBodySchema = z.object({
  ...transactionBase,
  amountPkr: integerPkr.refine(value => value !== 0, 'Adjustment amount must not be zero.'),
  reason: text(240),
}).strict()

export const voidBodySchema = z.object({ reason: text(240) }).strict()

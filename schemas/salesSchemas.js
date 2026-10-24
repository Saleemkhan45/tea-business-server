import { z } from 'zod'
import { SALE_IDEMPOTENCY_KEY_MAX_LENGTH } from '../models/Sale.js'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID.')
const businessDate = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}, 'Business date must be a valid YYYY-MM-DD date.')
const safePositiveNumber = z.number().finite().positive()
const notes = z.string().trim().max(500).nullable().optional()
const text = max => z.string().trim().min(1).max(max)
const phone = z.string().trim().max(40).refine(value => {
  if (!value) return true
  return /^\+?[0-9\s().-]+$/.test(value) && value.replace(/\D/g, '').length >= 7
}, 'Enter a valid phone number.').optional()
const newCustomerSchema = z.object({
  name: text(160),
  phone,
  address: z.string().trim().max(300).optional(),
  region: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  openingBalancePkr: z.number().int().safe().nonnegative().optional(),
}).strict()

const saleCoreSchema = z.object({
  salespersonName: z.string().trim().max(160).nullable().optional(),
  customerId: objectId.optional(),
  customer: objectId.optional(),
  customerName: z.string().trim().max(160).optional(),
  businessDate,
  teaType: z.enum(['green', 'black', 'jasmine', 'herbal', 'other']),
  stockLocationId: objectId,
  sellingRegion: objectId.optional(),
  quantityKg: safePositiveNumber.refine(value => {
    const grams = Math.round(value * 1000)
    return Number.isSafeInteger(grams) && Math.abs(value - grams / 1000) < 1e-9
  }, 'Quantity must use no more than three decimal places.'),
  unitPrice: z.number().finite().nonnegative().refine(Number.isSafeInteger, 'Unit price must be a safe integer PKR value.'),
  amountPaid: z.number().finite().nonnegative().refine(Number.isSafeInteger, 'Payment must be a safe integer PKR value.').optional(),
  receivedPaymentMethod: z.enum(['cash', 'bank_transfer', 'card', 'cheque', 'other']).optional(),
  paymentMethod: z.enum(['cash', 'credit', 'bank_transfer', 'card', 'cheque', 'other']).optional().default('cash'),
  status: z.enum(['completed', 'pending']).optional().default('completed'),
  notes,
}).strict()

export const saleParamSchema = z.object({ saleId: objectId }).strict()

export const listSalesQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  customerId: objectId.optional(),
  status: z.enum(['completed', 'pending', 'voided']).optional(),
  paymentMethod: z.enum(['cash', 'credit', 'bank_transfer', 'card', 'cheque', 'other']).optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, {
  path: ['to'], message: 'End date must be on or after start date.',
})

export const topProductsQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  regionId: objectId.optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.from) !== Boolean(value.to)) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Supply both start and end dates.' })
  } else if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after start date.' })
  }
})

export const saleBodySchema = saleCoreSchema.extend({
  idempotencyKey: text(SALE_IDEMPOTENCY_KEY_MAX_LENGTH),
  newCustomer: newCustomerSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.newCustomer && (value.customerId || value.customer)) {
    ctx.addIssue({
      path: ['newCustomer'],
      code: z.ZodIssueCode.custom,
      message: 'Choose an existing customer or enter a new customer, not both.',
    })
  }
  if (value.paymentMethod === 'credit' && !value.customerId && !value.customer && !value.newCustomer) {
    ctx.addIssue({
      path: ['customerId'],
      code: z.ZodIssueCode.custom,
      message: 'An existing or new customer is required for credit sales.',
    })
  }
  if (value.newCustomer && value.unitPrice <= 0) {
    ctx.addIssue({
      path: ['unitPrice'],
      code: z.ZodIssueCode.custom,
      message: 'Unit price must be greater than zero for a new customer first sale.',
    })
  }
})

export const updateSaleBodySchema = saleCoreSchema.partial().superRefine((value, ctx) => {
  if (value.paymentMethod === 'credit' && !value.customerId && !value.customer) {
    ctx.addIssue({
      path: ['customerId'],
      code: z.ZodIssueCode.custom,
      message: 'Customer ID is required when changing a sale to credit.',
    })
  }
})

export const voidSaleBodySchema = z.object({ reason: text(240) }).strict()

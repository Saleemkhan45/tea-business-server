import { z } from 'zod'

export const regionalId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID.')
export const regionalDate = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, 'Choose a valid business date.')
const optionalText = max => z.string().trim().max(max).optional()
export const regionalSettingsSchema = z.object({
  sellingPriceOverride: z.number().int().safe().positive().nullable().optional(),
  lowStockThresholdOverride: z.number().finite().nonnegative().refine(value => Number.isSafeInteger(Math.round(value * 1000)) && Math.abs(value - Math.round(value * 1000) / 1000) < 1e-9, 'Use at most three decimal places.').nullable().optional(),
}).strict()
export const regionInputSchema = z.object({
  name: z.string().trim().min(1).max(120), city: optionalText(120),
  manager: optionalText(160), description: optionalText(1000), address: optionalText(300),
  phone: optionalText(40).refine(value => !value || /^\+?[\d\s().-]{7,40}$/.test(value), 'Enter a valid phone number.'),
  status: z.enum(['active', 'inactive']).optional(),
}).strict()
export const regionCreateSchema = regionInputSchema.extend({
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  openingStockConfirmed: z.boolean().optional(),
  openingProducts: z.array(z.object({
    itemId: regionalId.transform(value => value.toLowerCase()),
    ...regionalSettingsSchema.shape,
    quantityKg: z.number().finite().nonnegative().refine(value => Number.isSafeInteger(Math.round(value * 1000)) && Math.abs(value - Math.round(value * 1000) / 1000) < 1e-9, 'Use at most three decimal places.'),
  }).strict()).max(20).default([]),
}).superRefine((value, context) => {
  if (new Set(value.openingProducts.map(row => row.itemId)).size !== value.openingProducts.length) context.addIssue({ code: 'custom', path: ['openingProducts'], message: 'Choose each product only once.' })
  if (value.openingProducts.length && !value.idempotencyKey) context.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'A creation key is required for opening stock.' })
  if (value.openingProducts.some(row => row.quantityKg > 0) && !value.openingStockConfirmed) context.addIssue({ code: 'custom', path: ['openingStockConfirmed'], message: 'Confirm this is genuine opening stock, not stock already recorded elsewhere.' })
})
export const regionReportQuerySchema = z.object({
  from: regionalDate.optional(), to: regionalDate.optional(), itemId: regionalId.optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, { path: ['to'], message: 'End date must follow start date.' })

const pkr = z.number().int().safe().nonnegative()
export const purchasePaymentSchema = z.object({
  amountPkr: pkr.positive(), method: z.enum(['cash', 'bank_transfer', 'cheque', 'card', 'other']),
  businessDate: regionalDate, reference: optionalText(160),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict()
export const purchaseInputSchema = z.object({
  supplier: regionalId, item: regionalId, receivingRegion: regionalId, businessDate: regionalDate,
  quantityKg: z.number().positive().refine(value => Number.isSafeInteger(Math.round(value * 1000)) && Math.abs(value - Math.round(value * 1000) / 1000) < 1e-9, 'Quantity must use at most three decimal places.'),
  unitCost: pkr, taxAmount: pkr.optional().default(0), shippingAmount: pkr.optional().default(0), discountAmount: pkr.optional().default(0),
  reference: optionalText(160), notes: optionalText(1000),
  status: z.enum(['received', 'pending', 'in_transit']),
  payment: purchasePaymentSchema.optional(), idempotencyKey: z.string().trim().min(1).max(128),
}).strict()

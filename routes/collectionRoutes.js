import express from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { customerParamsSchema } from '../schemas/customerLedgerSchemas.js'
import * as collections from '../services/collectionService.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { addDays } from '../services/collectionCalculations.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}, 'Choose a valid business date.')
export const scheduleSchema = z.object({
  frequency: z.enum(['weekly', 'one_time']).default('weekly'),
  channels: z.array(z.enum(['in_app', 'push', 'whatsapp', 'customer_whatsapp'])).min(1).max(4)
    .refine(values => new Set(values).size === values.length).default(['in_app']),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7)
    .refine(values => new Set(values).size === values.length, 'Weekdays must be unique.'),
  expectedAmount: z.number().int().positive().safe(),
  time: z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).default(''),
  startDate: date,
  endDate: z.union([z.literal(''), date]).default(''),
  notes: z.string().trim().max(500).default(''),
  status: z.enum(['active', 'paused', 'disabled']),
  revision: z.number().int().nonnegative().safe(),
}).strict().refine(value => value.frequency !== 'weekly' || value.weekdays.length > 0, 'Choose at least one weekday for weekly reminders.')
  .refine(value => !value.endDate || value.endDate >= value.startDate, 'End date must follow start date.')
export const collectionQuerySchema = z.object({
  from: date.default(() => getBusinessDate()), to: date.default(() => addDays(getBusinessDate(), 7)),
  customer: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
  status: z.enum(['due', 'upcoming', 'overdue', 'partial', 'collected', 'cleared', 'pending', 'acknowledged']).optional(),
  search: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict().refine(value => value.from <= value.to && value.to <= addDays(value.from, 366), 'Choose a date range of at most 366 days.')

export const collectionRoutes = express.Router()
collectionRoutes.use(requireAuth)
collectionRoutes.put('/:occurrenceId/acknowledgment',
  validate(z.object({ occurrenceId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict(), 'params'),
  validate(z.object({ notes: z.string().trim().min(1).max(500) }).strict()), async (req, res) => {
    await collections.acknowledgeCollection(req.user.shopId, req.params.occurrenceId, req.user.id, req.body.notes)
    res.json({ acknowledged: true })
  })
collectionRoutes.get('/', validate(collectionQuerySchema, 'query'), async (req, res) => {
  await collections.syncShop(req.user.shopId)
  res.json(await collections.listCollections(req.user.shopId, req.query))
})
collectionRoutes.get('/:customerId/schedule', validate(customerParamsSchema, 'params'), async (req, res) => {
  res.json(await collections.getSchedule(req.user.shopId, req.params.customerId))
})
collectionRoutes.put('/:customerId/schedule', validate(customerParamsSchema, 'params'), validate(scheduleSchema), async (req, res) => {
  const schedule = await collections.saveSchedule(req.user.shopId, req.params.customerId, req.user.id, req.body)
  res.json({ schedule })
})

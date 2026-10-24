import express from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { validDate } from './policy.js'
import * as service from './service.js'

const date = z.string().refine(validDate, 'Use a valid YYYY-MM-DD business date.')
const id = z.string().regex(/^[a-f\d]{24}$/i)
const amount = z.number().int().nonnegative().safe()
const values = { shopCashAmount: amount, bossAddedAmount: amount, notes: z.string().trim().max(500).default('') }
export const createSchema = z.object({ ...values, key: z.string().uuid(), businessDate: date }).strict()
export const correctionSchema = z.object({ ...values, key: z.string().uuid(), expectedRevision: z.number().int().nonnegative().safe(), reason: z.string().trim().min(3).max(500) }).strict()
export const voidSchema = correctionSchema.pick({ key: true, expectedRevision: true, reason: true })
const range = z.object({ from: date.default(() => getBusinessDate()), to: date.default(() => getBusinessDate()), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict()
  .refine(value => value.from <= value.to && value.to <= getBusinessDate(), { message: 'Select a valid date range ending no later than today.' })
const recordParams = z.object({ recordId: id }).strict()
const send = callback => async (req, res, next) => {
  try { res.json(await callback(req)) } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('MANUAL_CASH_')) return res.status(error.statusCode ?? 503).json({ message: error.message, code: error.code })
    next(error)
  }
}
export const manualCashRoutes = express.Router()
manualCashRoutes.use(requireAuth)
manualCashRoutes.use((req, res, next) => ['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Only an authorized shop owner or admin can access manual Cash Book.' }))
manualCashRoutes.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false, skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) }))
manualCashRoutes.get('/status', send(req => service.status(req.user.role === 'owner')))
manualCashRoutes.get('/overview', send(req => service.overview(req.user.shopId)))
manualCashRoutes.get('/today', send(req => service.getByDate(req.user.shopId, getBusinessDate())))
manualCashRoutes.get('/records/by-date/:date', validate(z.object({ date }).strict(), 'params'), send(req => service.getByDate(req.user.shopId, req.params.date)))
manualCashRoutes.get('/records', validate(range, 'query'), send(req => service.history(req.user.shopId, req.query)))
manualCashRoutes.post('/records', validate(createSchema), send(req => service.saveDay(req.user.shopId, req.user.id, req.body)))
manualCashRoutes.get('/records/:recordId', validate(recordParams, 'params'), validate(z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict(), 'query'), send(req => service.details(req.user.shopId, req.params.recordId, req.query.page)))
manualCashRoutes.patch('/records/:recordId', validate(recordParams, 'params'), validate(correctionSchema), send(req => service.saveDay(req.user.shopId, req.user.id, req.body, req.params.recordId)))
manualCashRoutes.post('/records/:recordId/void', validate(recordParams, 'params'), validate(voidSchema), send(req => service.voidDay(req.user.shopId, req.user.id, req.body, req.params.recordId)))
manualCashRoutes.post('/records/:recordId/replace', validate(recordParams, 'params'), validate(correctionSchema), send(req => service.replaceDay(req.user.shopId, req.user.id, req.body, req.params.recordId)))

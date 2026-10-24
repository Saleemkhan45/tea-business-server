import express from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { ReminderSettings, PushDevice, ReminderDelivery } from '../models/ReminderDelivery.js'
import { reminderConfig, providerReady, operatorApproved } from './config.js'
import { fingerprint, protect, allowedPushEndpoint } from './privacy.js'
import { requireReminderIndexes } from './readiness.js'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const settingsSchema = z.object({
  push: z.boolean(), whatsapp: z.boolean(), operatorPhone: z.string().regex(/^(|\+[1-9]\d{7,14})$/).default(''),
  operatorConsent: z.boolean().default(false), quietStart: time, quietEnd: time,
  revision: z.number().int().nonnegative().safe(),
}).strict()
export const subscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(allowedPushEndpoint, 'Unsupported push service endpoint.'),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).refine(value => { const key = Buffer.from(value, 'base64url'); return key.length === 65 && key[0] === 4 }),
    auth: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).refine(value => Buffer.from(value, 'base64url').length === 16),
  }).strict(),
}).strict()
function admin(req, res, next) {
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Only shop administrators can manage collection delivery.' })
  next()
}
function serializeSettings(row) {
  return { push: row?.push ?? false, whatsapp: row?.whatsapp ?? false,
    operatorConfigured: Boolean(row?.protectedPhone), consentAt: row?.consentAt ?? null,
    quietStart: row?.quietStart ?? '21:00', quietEnd: row?.quietEnd ?? '08:00', revision: row?.revision ?? 0 }
}
export const reminderRoutes = express.Router()
// Mounted under the existing authenticated notification router (including CSRF).
reminderRoutes.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) }))
reminderRoutes.get('/capabilities', (req, res) => {
  const config = reminderConfig()
  res.json({ mode: config.live ? 'live' : 'dry_run', pushReady: providerReady('push', config),
    whatsappReady: providerReady('whatsapp', config), vapidPublicKey: config.vapidPublic,
    canManage: ['owner', 'admin'].includes(req.user.role) })
})
reminderRoutes.get('/settings', admin, async (req, res) => {
  res.json(serializeSettings(await ReminderSettings.findOne({ shop: req.user.shopId }).lean()))
})
reminderRoutes.put('/settings', admin, validate(settingsSchema), async (req, res) => {
  await requireReminderIndexes()
  const shop = req.user.shopId, actor = req.user.id, input = req.body, config = reminderConfig()
  const previous = await ReminderSettings.findOne({ shop }).lean()
  if ((previous?.revision ?? 0) !== input.revision) return res.status(409).json({ message: 'Delivery settings changed. Reload before saving.' })
  const values = { push: input.push, whatsapp: input.whatsapp, quietStart: input.quietStart, quietEnd: input.quietEnd }
  if (input.whatsapp && (!input.operatorPhone || !input.operatorConsent || !operatorApproved(config, shop, input.operatorPhone))) {
    return res.status(400).json({ message: 'WhatsApp requires an explicitly approved shop operator number and consent. Re-enter the approved number when enabling delivery.' })
  }
  if (input.whatsapp) Object.assign(values, { protectedPhone: protect(input.operatorPhone, config.encryptionKey, `${shop}:operator`),
    phoneHash: fingerprint(input.operatorPhone), operator: actor, consentAt: new Date(), consentBy: actor, consentSource: 'approved_operator_settings' })
  if (!input.whatsapp) Object.assign(values, { protectedPhone: null, phoneHash: null, operator: null, consentAt: null, consentBy: actor, consentSource: 'opted_out' })
  try {
    const saved = await ReminderSettings.findOneAndUpdate({ shop, revision: input.revision }, {
      $set: values, $inc: { revision: 1 }, $setOnInsert: { shop },
      $push: { history: { push: values.push, whatsapp: values.whatsapp, phoneHash: values.phoneHash, actor, at: new Date(), quietStart: values.quietStart, quietEnd: values.quietEnd } },
    }, { new: true, upsert: !previous, runValidators: true }).lean()
    if (!saved) return res.status(409).json({ message: 'Delivery settings changed. Reload before saving.' })
    res.json(serializeSettings(saved))
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Delivery settings changed. Reload before saving.' })
    throw error
  }
})
reminderRoutes.post('/push', validate(subscriptionSchema), async (req, res) => {
  await requireReminderIndexes()
  const shop = req.user.shopId, user = req.user.id, config = reminderConfig()
  if (!providerReady('push', config)) return res.status(503).json({ message: 'Phone notifications require VAPID setup.' })
  const endpointHash = fingerprint(req.body.endpoint)
  const protectedSubscription = protect(req.body, config.encryptionKey, `${shop}:${user}:${endpointHash}`)
  try {
    await PushDevice.findOneAndUpdate({ endpointHash, shop, user }, { $set: { protectedSubscription,
      session: req.auth.session._id, active: true, lastSeenAt: new Date() },
      $setOnInsert: { endpointHash, shop, user } }, { upsert: true, runValidators: true })
    res.json({ subscribed: true })
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'This browser must unsubscribe from its previous account before enabling notifications.' })
    throw error
  }
})
reminderRoutes.delete('/push', validate(z.object({ endpoint: z.string().max(2048) }).strict()), async (req, res) => {
  await PushDevice.updateOne({ shop: req.user.shopId, user: req.user.id, endpointHash: fingerprint(req.body.endpoint) }, { $set: { active: false } })
  res.json({ subscribed: false })
})
reminderRoutes.get('/history', async (req, res) => {
  const rows = await ReminderDelivery.find({ shop: req.user.shopId, ...(['owner', 'admin'].includes(req.user.role) ? {} : { user: req.user.id }) })
    .select('channel status attempts safeErrorCode createdAt acceptedAt deliveredAt').sort({ createdAt: -1 }).limit(50).lean()
  res.json({ rows })
})
// Simulation only. A normal API request cannot trigger external provider activity.
reminderRoutes.post('/test', (req, res) => {
  res.json({ status: 'simulated', message: 'Dry run: provider calls were not made. No delivery is claimed.',
    preview: { title: 'Khata Collection Due', body: 'You have a scheduled collection. Open your dashboard to review.' } })
})

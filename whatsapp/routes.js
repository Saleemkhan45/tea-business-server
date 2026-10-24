import express from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { WhatsAppConversation, WhatsAppIntegration } from '../models/WhatsApp.js'
import { providerReady } from '../reminders/config.js'
import { whatsappConfig } from './policy.js'
import { requireWhatsAppIndexes } from './readiness.js'
import * as service from './service.js'

const id = z.string().regex(/^[a-fA-F0-9]{24}$/)
const customerParams = z.object({ customerId: id }).strict()
const conversationParams = z.object({ conversationId: id }).strict()
export const contactSchema = z.object({ phone: z.string().trim().min(1).max(40), optedIn: z.boolean(), consentSource: z.string().trim().max(300).default(''), revision: z.number().int().nonnegative().safe() }).strict()
export const replySchema = z.object({ text: z.string().trim().min(1).max(4096), clientKey: z.string().uuid() }).strict()
export const whatsappRoutes = express.Router()
whatsappRoutes.use(requireAuth)
whatsappRoutes.use(rateLimit({ windowMs: 60000, limit: 90, standardHeaders: true, legacyHeaders: false, skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) }))
whatsappRoutes.get('/integration', async (req, res) => {
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Shop administrator access is required.' })
  const config = whatsappConfig(), assigned = config.customerShop === String(req.user.shopId)
  const record = assigned ? await WhatsAppIntegration.findOne({ shop: req.user.shopId }).lean() : null
  res.json({ assigned, enabled: config.customerEnabled && assigned, mode: config.live ? 'live' : 'dry_run',
    configured: assigned && providerReady('whatsapp', { ...config, template: config.customerTemplate }),
    senderNumber: assigned ? config.senderNumber : '', businessId: assigned ? config.businessId : '', phoneId: assigned ? config.phoneId : '',
    template: assigned ? config.customerTemplate : '', language: config.language, version: assigned ? config.version : '',
    signingConfigured: assigned && Boolean(config.appSecret && config.verifyToken),
    lastVerifiedWebhookAt: record?.lastVerifiedWebhookAt ?? null, lastInboundAt: record?.lastInboundAt ?? null,
    lastDeliveryAt: record?.lastDeliveryAt ?? null, retentionDays: config.retentionDays })
})
whatsappRoutes.get('/customers/:customerId', validate(customerParams, 'params'), async (req, res) => {
  res.json(await service.getContact(req.user.shopId, req.params.customerId))
})
whatsappRoutes.put('/customers/:customerId', validate(customerParams, 'params'), validate(contactSchema), async (req, res) => {
  await service.saveContact(req.user.shopId, req.params.customerId, req.user.id, req.body)
  res.json(await service.getContact(req.user.shopId, req.params.customerId))
})
whatsappRoutes.get('/conversations', validate(z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict(), 'query'), async (req, res) => {
  res.json(await service.listConversations(req.user.shopId, req.user.id, req.query.page))
})
whatsappRoutes.get('/conversations/:conversationId', validate(conversationParams, 'params'), validate(z.object({ before: id.optional() }).strict(), 'query'), async (req, res) => {
  res.json(await service.getMessages(req.user.shopId, req.params.conversationId, req.user.id, req.query.before))
})
whatsappRoutes.post('/conversations/:conversationId/read', validate(conversationParams, 'params'), validate(z.object({ messageIds: z.array(id).min(1).max(50) }).strict()), async (req, res) => {
  await requireWhatsAppIndexes()
  await service.markRead(req.user.shopId, req.params.conversationId, req.user.id, req.body.messageIds)
  res.json({ read: true })
})
whatsappRoutes.put('/conversations/:conversationId/customer', validate(conversationParams, 'params'), validate(z.object({ customerId: id }).strict()), async (req, res) => {
  await requireWhatsAppIndexes()
  await service.linkConversation(req.user.shopId, req.params.conversationId, req.body.customerId, req.user.id)
  res.json({ linked: true })
})
whatsappRoutes.post('/conversations/:conversationId/reply', validate(conversationParams, 'params'), validate(replySchema), async (req, res) => {
  const conversation = await WhatsAppConversation.findOne({ _id: req.params.conversationId, shop: req.user.shopId }).lean()
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' })
  res.status(202).json(await service.queueMessage(req.user.shopId, conversation, req.user.id, { ...req.body, kind: 'text' }))
})

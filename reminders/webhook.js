import express from 'express'
import { persistReceipt } from './receipts.js'
import { reminderConfig } from './config.js'
import { safeEqual, validSignature } from './privacy.js'
import { requireReminderIndexes } from './readiness.js'
import { whatsappConfig } from '../whatsapp/policy.js'
import { receiveInbound } from '../whatsapp/service.js'
import { WhatsAppIntegration } from '../models/WhatsApp.js'
import { requireWhatsAppIndexes } from '../whatsapp/readiness.js'

export const whatsappWebhook = express.Router()
whatsappWebhook.get('/', (req, res) => {
  const config = reminderConfig()
  if (req.query['hub.mode'] !== 'subscribe' || typeof req.query['hub.verify_token'] !== 'string'
    || !safeEqual(req.query['hub.verify_token'], config.verifyToken) || typeof req.query['hub.challenge'] !== 'string') return res.sendStatus(403)
  res.type('text/plain').send(req.query['hub.challenge'])
})
whatsappWebhook.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const config = reminderConfig()
  if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.get('x-hub-signature-256'), config.appSecret)) return res.sendStatus(403)
  let event
  try { event = JSON.parse(req.body.toString()) } catch { return res.sendStatus(400) }
  if (event.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) return res.sendStatus(400)
  try {
    await requireReminderIndexes()
    for (const entry of event.entry) {
      if (entry.id !== config.businessId) continue
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages' || change.value?.metadata?.phone_number_id !== config.phoneId) continue
        const customerConfig = whatsappConfig()
        if (customerConfig.customerEnabled) {
          if (!/^[a-fA-F0-9]{24}$/.test(customerConfig.customerShop)) throw new Error('Customer sender assignment is invalid.')
          await requireWhatsAppIndexes()
          for (const message of change.value.messages ?? []) await receiveInbound(customerConfig.customerShop, message, customerConfig)
        }
        for (const status of change.value.statuses ?? []) {
          if (typeof status.id !== 'string') continue
          const state = { sent: 'accepted', delivered: 'delivered', read: 'read', failed: 'failed' }[status.status]
          if (!state) continue
          await persistReceipt({ providerMessageId: status.id, status: state, businessId: entry.id, phoneId: config.phoneId })
          if (customerConfig.customerEnabled && /^[a-fA-F0-9]{24}$/.test(customerConfig.customerShop)) {
            await WhatsAppIntegration.updateOne({ shop: customerConfig.customerShop }, { $max: { lastVerifiedWebhookAt: new Date(), lastDeliveryAt: new Date() }, $setOnInsert: { shop: customerConfig.customerShop } }, { upsert: true })
          }
        }
      }
    }
    res.sendStatus(200)
  } catch { res.sendStatus(503) } // No raw webhook/provider data in logs.
})

import { ReminderDelivery, ReminderReceipt } from '../models/ReminderDelivery.js'
import { WhatsAppMessage } from '../models/WhatsApp.js'
import { whatsappConfig } from '../whatsapp/policy.js'

async function reconcile(receipt) {
  const config = whatsappConfig()
  if (config.customerEnabled && config.businessId === receipt.businessId && config.phoneId === receipt.phoneId) {
    const states = receipt.status === 'read' ? ['accepted', 'delivered', 'failed', 'uncertain']
      : receipt.status === 'delivered' ? ['accepted', 'failed', 'uncertain'] : receipt.status === 'failed' ? ['accepted'] : []
    if (await WhatsAppMessage.exists({ shop: config.customerShop, direction: 'out', providerMessageId: receipt.providerMessageId })) {
      await WhatsAppMessage.updateOne({ shop: config.customerShop, direction: 'out', providerMessageId: receipt.providerMessageId, status: { $in: states } }, {
        $set: { status: receipt.status }, $push: { events: { at: new Date(), status: receipt.status } },
      })
      await ReminderReceipt.updateOne({ providerMessageId: receipt.providerMessageId, status: receipt.status }, { $set: { processed: true } })
      return
    }
  }
  if (!await ReminderDelivery.exists({ channel: 'whatsapp', providerMessageId: receipt.providerMessageId })) {
    await ReminderReceipt.updateOne({ providerMessageId: receipt.providerMessageId, status: receipt.status }, { $set: { lastCheckedAt: new Date() } })
    return
  }
  const state = receipt.status
  const previous = state === 'read' ? ['accepted', 'delivered', 'failed', 'uncertain']
    : state === 'delivered' ? ['accepted', 'failed', 'uncertain'] : state === 'failed' ? ['accepted'] : []
  await ReminderDelivery.updateOne({ channel: 'whatsapp', providerMessageId: receipt.providerMessageId, status: { $in: previous } }, {
    $set: { status: state, ...(state === 'delivered' || state === 'read' ? { deliveredAt: receipt.createdAt ?? new Date() } : {}),
      ...(state === 'failed' ? { safeErrorCode: 'provider_delivery_failed' } : {}) },
    $push: { events: { at: new Date(), status: state } },
  })
  await ReminderReceipt.updateOne({ providerMessageId: receipt.providerMessageId, status: state }, { $set: { processed: true } })
}
export async function persistReceipt(receipt) {
  try {
    await ReminderReceipt.updateOne({ providerMessageId: receipt.providerMessageId, status: receipt.status },
      { $setOnInsert: { ...receipt, processed: false } }, { upsert: true })
  } catch (error) { if (error.code !== 11000) throw error }
  await reconcile(receipt)
}
export async function reconcileReceipts(config) {
  const rows = await ReminderReceipt.find({ businessId: config.businessId, phoneId: config.phoneId, processed: false })
    .sort({ lastCheckedAt: 1, createdAt: 1 }).limit(500).lean()
  for (const row of rows) await reconcile(row)
}

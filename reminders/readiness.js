import { ReminderDelivery, ReminderSettings, PushDevice, ReminderReceipt } from '../models/ReminderDelivery.js'
export async function requireReminderIndexes() {
  const expected = [
    [ReminderSettings, 'reminder_settings_shop_unique', { shop: 1 }],
    [PushDevice, 'push_endpoint_unique', { endpointHash: 1 }],
    [ReminderDelivery, 'reminder_delivery_unique', { shop: 1, occurrence: 1, channel: 1, recipient: 1 }],
    [ReminderReceipt, 'reminder_receipt_unique', { providerMessageId: 1, status: 1 }],
  ]
  try {
    for (const [model, name, key] of expected) {
      const indexes = await model.collection.listIndexes().toArray()
      if (!indexes.some(index => index.name === name && index.unique && !index.sparse && !index.partialFilterExpression
        && JSON.stringify(index.key) === JSON.stringify(key))) throw new Error()
    }
  } catch { throw Object.assign(new Error('Collection delivery requires reviewed index deployment.'), { statusCode: 503 }) }
}

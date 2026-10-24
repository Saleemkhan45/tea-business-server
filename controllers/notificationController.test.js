import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findNotification, updateReadState } = vi.hoisted(() => ({
  findNotification: vi.fn(),
  updateReadState: vi.fn(),
}))

vi.mock('../models/Item.js', () => ({ Item: {} }))
vi.mock('../models/Notification.js', () => ({
  NOTIFICATION_TYPES: ['LOW_STOCK', 'PURCHASE_ADDED', 'SALES_UP', 'NO_PAYMENT_TODAY'],
  Notification: { findOne: findNotification },
}))
vi.mock('../models/NotificationRead.js', () => ({ NotificationRead: { updateOne: updateReadState } }))
vi.mock('../models/NotificationSettings.js', () => ({
  DEFAULT_NOTIFICATION_ENABLED: {},
  NotificationSettings: {},
}))

import { markNotificationRead } from './notificationController.js'

describe('markNotificationRead ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findNotification.mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'notification-id' }) })
    updateReadState.mockResolvedValue({})
  })

  it('scopes the notification to the authenticated shop and user', async () => {
    const req = {
      params: { id: 'notification-id' },
      user: { id: 'authenticated-user', shopId: 'authenticated-shop' },
    }
    const res = { json: vi.fn() }

    await markNotificationRead(req, res, vi.fn())

    expect(findNotification).toHaveBeenCalledWith({ _id: 'notification-id', shop: 'authenticated-shop' })
    expect(updateReadState).toHaveBeenCalledWith(
      { user: 'authenticated-user', notification: 'notification-id' },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ user: 'authenticated-user' }) }),
      { upsert: true },
    )
  })
})
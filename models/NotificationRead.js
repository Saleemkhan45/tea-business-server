import mongoose from 'mongoose'

const notificationReadSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', required: true, index: true },
  readAt: { type: Date, default: Date.now },
}, { versionKey: false })

notificationReadSchema.index({ user: 1, notification: 1 }, { unique: true })

export const NotificationRead = mongoose.model('NotificationRead', notificationReadSchema)

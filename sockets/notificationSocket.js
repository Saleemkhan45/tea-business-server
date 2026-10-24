import { env } from '../config/env.js'
import { getClientOrigins } from '../config/clientOrigins.js'
import { authenticate, sessionToken } from '../services/authService.js'
import { registerNotificationEmitter } from '../services/notificationService.js'

export const socketExpiryDelay = expiresAt => Math.min(86400000, Math.max(1000, new Date(expiresAt).getTime() - Date.now()))

function serializeNotification(notification) {
  return {
    id: String(notification._id),
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    message: notification.message,
    entityType: notification.entityType,
    entityId: String(notification.entityId),
    meta: notification.meta ?? {},
    dedupeKey: notification.dedupeKey,
    createdAt: notification.createdAt,
    read: false,
  }
}

export function initNotificationSocket(io) {
  io.use(async (socket, next) => {
    try {
      if (!getClientOrigins(env).includes(socket.handshake.headers.origin)) return next(new Error('Socket origin is not allowed.'))
      const { token } = sessionToken(socket.handshake.headers)
      const { user, session } = await authenticate(token)
      if (session.accessMode === 'trusted-view') return next(new Error('Trusted viewing uses protected HTTP reads.'))
      socket.user = user
      socket.authSession = session
      next()
    } catch (error) {
      next(new Error('Invalid socket token.'))
    }
  })

  io.on('connection', socket => {
    socket.join(`user:${socket.user.id}`)
    socket.join(`shop:${socket.user.shopId}`)
    socket.join(`session:${socket.authSession._id}`)
    let expiry
    const check = async () => {
      try {
        const { token } = sessionToken(socket.handshake.headers)
        const { session } = await authenticate(token)
        if (socket.connected) expiry = setTimeout(check, socketExpiryDelay(session.expiresAt))
      } catch { socket.disconnect(true) }
    }
    expiry = setTimeout(check, socketExpiryDelay(socket.authSession.expiresAt))
    socket.on('disconnect', () => clearTimeout(expiry))
  })

  registerNotificationEmitter((notification, recipientUserIds) => {
    const payload = serializeNotification(notification)
    recipientUserIds.forEach(userId => {
      void io.in(`user:${userId}`).fetchSockets().then(async sockets => {
        for (const socket of sockets) {
          try {
            const { token } = sessionToken(socket.handshake.headers)
            const { user } = await authenticate(token)
            if (user.id !== String(userId) || user.shopId !== String(notification.shop)) { socket.disconnect(true); continue }
            socket.emit('notification:new', payload)
          } catch { socket.disconnect(true) }
        }
      }).catch(() => {})
    })
  })
}

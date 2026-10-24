import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { getClientOrigins } from '../config/clientOrigins.js'
import { authenticate, AuthError, sessionToken } from '../services/authService.js'
import { consumeApproval, trustedBoundary, trustedReadAllowed } from '../services/actionAuthorization.js'

export function requireTrustedOrigin(req, res, next) {
  if (!getClientOrigins(env).includes(req.get('origin'))) return res.status(403).json({ message: 'Request origin is not allowed.' })
  next()
}

export async function requireAuth(req, res, next) {
  try {
    const { token, cookieAuth } = sessionToken(req.headers)
    const { user, session } = await authenticate(token)
    req.user = { id: user.id, shopId: user.shopId, role: user.role, name: user.name, email: user.email }
    req.auth = { session, user, cookieAuth, token }
    if (session.accessMode === 'trusted-view' && (!trustedBoundary(req) || (['GET', 'HEAD'].includes(req.method) && !trustedReadAllowed(req)))) return res.status(403).json({ message: 'This viewing request is not permitted by the trusted shop boundary.' })
    if (cookieAuth && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!getClientOrigins(env).includes(req.get('origin'))) return res.status(403).json({ message: 'Request origin is not allowed.' })
      const supplied = Buffer.from(req.get('x-csrf-token') ?? '')
      const expected = Buffer.from(session.csrfToken)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.status(403).json({ message: 'Invalid request security token. Reload the page and try again.' })
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.originalUrl.startsWith('/api/v1/auth/')) await consumeApproval(req)
    next()
  } catch (error) {
    if (error instanceof AuthError) return res.status(401).json({ message: error.message, ...(trustedBoundary(req) ? { trustedViewingAvailable: true } : {}) })
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code })
    res.status(503).json({ message: 'Authentication is temporarily unavailable.' })
  }
}

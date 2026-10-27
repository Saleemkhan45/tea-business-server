import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'

import {
  diagnostic,
  diagnosticRoute,
  databaseFailure,
} from './utils/safeDiagnostics.js'

import { env } from './config/env.js'
import { getClientOrigins } from './config/clientOrigins.js'
import { connectDatabase, probeDatabase } from './config/db.js'
import { apiRoutes } from './routes/index.js'
import { whatsappWebhook } from './reminders/webhook.js'

export function createApp({ databaseReady, databaseProbe } = {}) {
  const app = express()

  if (env.nodeEnv === 'production') {
    app.set('trust proxy', 1)
  }

  app.use(helmet())

  app.use(
    cors({
      origin: getClientOrigins(env),
      credentials: true,
      exposedHeaders: ['X-Request-ID', 'Retry-After'],
    }),
  )

  app.use((req, res, next) => {
    req.requestId = randomUUID()
    res.set('X-Request-ID', req.requestId)

    const started = performance.now()
    let finished = false

    const record = aborted => {
      if (finished) return

      finished = true

      diagnostic(
        aborted ? 'request.aborted' : 'request.completed',
        {
          requestId: req.requestId,
          route: diagnosticRoute(req),
          method: req.method,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
          code:
            res.locals.diagnosticCode ??
            (aborted ? 'CLIENT_CLOSED' : 'HTTP_RESPONSE'),
        },
      )
    }

    res.once('finish', () => record(false))
    res.once('close', () => record(!res.writableFinished))

    next()
  })

  // Signature verification requires raw bytes.
  // Mount this route before JSON parsing.
  app.use('/api/v1/reminder-webhook', whatsappWebhook)

  app.use(express.json({ limit: '1mb' }))

  app.use('/api/v1', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  app.get('/api/v1/ready', async (req, res) => {
    let ready = databaseReady
      ? databaseReady()
      : mongoose.connection.readyState === 1

    if (ready && databaseProbe) {
      try {
        ready = await databaseProbe()
      } catch {
        ready = false
      }
    }

    if (!ready) {
      res.locals.diagnosticCode = 'DATABASE_UNAVAILABLE'
    }

    res
      .set('Retry-After', '5')
      .status(ready ? 200 : 503)
      .json({ ready })
  })

  if (databaseReady) {
    app.use('/api/v1', (req, res, next) => {
      if (req.path === '/health' || databaseReady()) {
        return next()
      }

      res.locals.diagnosticCode = 'DATABASE_UNAVAILABLE'

      return res
        .set('Retry-After', '5')
        .status(503)
        .json({
          message: 'Database temporarily unavailable. Please retry shortly.',
          code: 'DATABASE_UNAVAILABLE',
        })
    })
  }

  app.use('/api/v1', apiRoutes)

  app.use((req, res) => {
    res.status(404).json({ message: 'Route not found.' })
  })

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)

    const status = databaseFailure(error)
      ? 503
      : error.statusCode ?? error.status ?? 500

    res.locals.diagnosticCode = databaseFailure(error)
      ? 'DATABASE_UNAVAILABLE'
      : status < 500
        ? 'REQUEST_REJECTED'
        : 'INTERNAL_ERROR'

    if (status === 503) {
      res.set('Retry-After', '5')
    }

    res.status(status).json({
      message:
        status === 503
          ? 'Service temporarily unavailable. Please retry shortly.'
          : error.statusCode
            ? error.message
            : 'Internal server error.',
    })
  })

  return app
}

// Vercel uses this app to handle incoming requests.
const vercelApp = createApp({
  databaseReady: () => mongoose.connection.readyState === 1,
  databaseProbe: probeDatabase,
})

let connectionPromise

async function ensureDatabaseConnection() {
  if (mongoose.connection.readyState === 1) return

  if (!connectionPromise) {
    connectionPromise = connectDatabase().finally(() => {
      connectionPromise = undefined
    })
  }

  await connectionPromise
}

// Vercel requires a default function or server export.
export default async function handler(req, res) {
  try {
    await ensureDatabaseConnection()
    return vercelApp(req, res)
  } catch {
    return res.status(503).json({
      message: 'Database temporarily unavailable. Please retry shortly.',
      code: 'DATABASE_UNAVAILABLE',
    })
  }
}
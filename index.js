import http from 'node:http'
import mongoose from 'mongoose'
import { Server } from 'socket.io'
import { connectDatabase, disconnectDatabase, probeDatabase } from './config/db.js'
import { env } from './config/env.js'
import { getClientOrigins } from './config/clientOrigins.js'
import { createApp } from './app.js'
import { startNotificationJobs } from './jobs/notificationJobs.js'
import { initNotificationSocket } from './sockets/notificationSocket.js'
import { diagnostic } from './utils/safeDiagnostics.js'

const app = createApp({ databaseReady: () => mongoose.connection.readyState === 1, databaseProbe: probeDatabase })
const server = http.createServer(app)
server.headersTimeout = 15000
server.requestTimeout = 30000
server.keepAliveTimeout = 5000
const io = new Server(server, { cors: { origin: getClientOrigins(env), credentials: true } })
initNotificationSocket(io)
app.set('io', io)
let stopping = false, retry, jobs
async function connect() {
  if (stopping) return
  try {
    await connectDatabase()
    if (!stopping && !jobs) jobs = startNotificationJobs()
  } catch {
    diagnostic('database.unavailable')
    if (!stopping) retry = setTimeout(connect, 15000)
  }
}
for (const state of ['connected', 'disconnected', 'reconnected', 'error']) mongoose.connection.on(state, () => diagnostic('database.state', { state }))
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(retry)
  jobs?.stop()
  const deadline = setTimeout(() => process.exit(code || 1), 10000)
  deadline.unref()
  io.close(async () => { await disconnectDatabase().catch(() => {}); process.exit(code) })
}
server.on('error', error => { diagnostic('server.listen.failed', { code: error.code }); shutdown(1) })
server.listen(env.port, () => { diagnostic('server.listening', { port: server.address().port, durationMs: Math.round(process.uptime() * 1000) }); void connect() })
process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())
process.on('message', message => { if (message?.type === 'shutdown') shutdown() })
process.on('unhandledRejection', () => { diagnostic('process.unhandledRejection'); shutdown(1) })
process.on('uncaughtException', () => { diagnostic('process.uncaughtException'); shutdown(1) })

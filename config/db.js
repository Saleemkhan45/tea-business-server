import mongoose from 'mongoose'
import { env } from './env.js'
import { logDatabaseError } from '../utils/databaseDiagnostics.js'
import { diagnostic } from '../utils/safeDiagnostics.js'

export async function connectDatabase() {
  const started = performance.now()
  mongoose.set('strictQuery', true)
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, waitQueueTimeoutMS: 5000, socketTimeoutMS: 20000, maxPoolSize: 20, minPoolSize: 0, bufferCommands: false, autoIndex: false, autoCreate: false })
    diagnostic('database.connected', { durationMs: Math.round(performance.now() - started) })
    return mongoose.connection
  } catch (error) {
    diagnostic('database.connect.failed', { durationMs: Math.round(performance.now() - started), code: 'DB_CONNECT_FAILED' })
    console.error('MongoDB connection failed:')
    logDatabaseError(error, env.mongoUri)
    throw new Error('MongoDB connection failed.')
  }
}

let probing
export function probeDatabase() {
  if (mongoose.connection.readyState !== 1) return Promise.resolve(false)
  if (probing) return probing
  probing = mongoose.connection.db.admin().command({ ping: 1 }, { timeoutMS: 2000 }).then(() => true, () => false).finally(() => { probing = null })
  return probing
}

export async function disconnectDatabase() {
  await mongoose.disconnect()
}

import mongoose from 'mongoose'
import { env } from '../config/env.js'
import { logDatabaseError } from '../utils/databaseDiagnostics.js'

try {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 })
  console.log(`CONNECTED: ${mongoose.connection.host}`)
} catch (error) {
  logDatabaseError(error, env.mongoUri)
  process.exitCode = 1
} finally {
  try {
    await mongoose.disconnect()
  } catch (error) {
    logDatabaseError(error, env.mongoUri)
    process.exitCode = 1
  }
}

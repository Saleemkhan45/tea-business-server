import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runPasswordSetup, setupExitCode, startupFailure, uncertainFailure } from './passwordSetupOperation.js'
export { validateSetupAuthorization } from './passwordSetupOperation.js'

async function main() {
  let report
  let operationStarted = false
  try {
    const [{ default: mongoose }, { MongoClient }, { env }, { User }, { Shop }, { AuthSession }, { hashPassword }] = await Promise.all([
      import('mongoose'), import('mongodb'), import('../config/env.js'), import('../models/User.js'),
      import('../models/Shop.js'), import('../models/AuthSession.js'), import('../utils/passwords.js'),
    ])
    operationStarted = true
    report = await runPasswordSetup(process.env, {
      databaseName: () => new MongoClient(env.mongoUri).options.dbName,
      isTTY: process.stdin.isTTY,
      readPassword: () => fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''),
      hashPassword,
      connect: () => mongoose.connect(env.mongoUri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 }),
      startSession: () => mongoose.startSession(),
      findUser: (target, session) => User.findOne({ email: target.email, shop: target.shop, status: 'active' }).session(session).select('_id').lean(),
      findShop: (target, session) => Shop.findOne({ _id: target.shop, status: 'active' }).session(session).select('_id').lean(),
      updateUser: (target, user, passwordHash, session) => User.updateOne({ _id: user._id, shop: target.shop, status: 'active' }, { $set: { passwordHash }, $inc: { authVersion: 1 } }, { session, runValidators: true }),
      revokeSessions: (target, user, session) => AuthSession.updateMany({ user: user._id, shop: target.shop, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session }),
      disconnect: () => mongoose.disconnect(),
    })
  } catch (error) { report = operationStarted ? uncertainFailure(error) : startupFailure(error) }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exitCode = setupExitCode(report)
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => { process.exitCode = 2 })
}

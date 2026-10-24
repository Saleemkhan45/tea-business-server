// Read configuration presence only. No provider requests, database access or secret output.
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { emailDeliveryConfigured } from '../services/securityEmail.js'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true })
const enabled = process.env.SECURITY_EMAIL_ENABLED === 'true'
const keyPresent = Boolean(process.env.RESEND_API_KEY?.trim())
const senderPresent = Boolean(process.env.SECURITY_EMAIL_FROM?.trim())
console.log(JSON.stringify({
  provider: 'resend', enabled, keyPresent, senderPresent,
  configured: emailDeliveryConfigured(),
  providerAcceptanceChecked: false, inboxDeliveryChecked: false,
}, null, 2))
if (!enabled || !keyPresent || !senderPresent) process.exitCode = 1

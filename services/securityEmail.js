// Explicitly opt in only after sender/domain and deployment review. No fallback mail or logging.
export function emailDeliveryConfigured() {
  return process.env.SECURITY_EMAIL_ENABLED === 'true' && Boolean(process.env.RESEND_API_KEY?.trim() && process.env.SECURITY_EMAIL_FROM?.trim())
}
export async function sendSecurityEmail({ to, subject, text, html }) {
  if (!emailDeliveryConfigured()) throw Object.assign(new Error('Email delivery is not configured. Contact the owner; your current sign-in email is unchanged.'), { statusCode: 503 })
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.SECURITY_EMAIL_FROM.trim(), to: [to], subject, text, ...(html ? { html } : {}) }),
    })
    // Map only known HTTP statuses; never expose provider bodies, credentials or tokens.
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Email provider authorization or sender verification failed. Ask your deployment administrator to check the API key and verified sending domain.'), { statusCode: 503 })
    if (response.status === 429) throw Object.assign(new Error('The email provider is temporarily rate limited. Wait before requesting another verification message.'), { statusCode: 503 })
    if (response.status === 422) throw Object.assign(new Error('The email provider rejected the message configuration. Ask your deployment administrator to check the sender and recipient settings.'), { statusCode: 503 })
    const result = await response.json()
    if (!response.ok || typeof result?.id !== 'string' || !result.id.trim()) throw new Error('Delivery not acknowledged')
  } catch (error) {
    if (error.statusCode === 503) throw error
    throw Object.assign(new Error('Verification email delivery could not be confirmed. Your current sign-in email remains available.'), { statusCode: 503 })
  }
}

import { describe, expect, it } from 'vitest'
import cors from 'cors'
import express from 'express'
import { getClientOrigins } from './clientOrigins.js'

describe('client origin policy', () => {
  it('allows both loopback spellings on the configured development port', () => {
    expect(getClientOrigins({ clientOrigin: 'http://localhost:5173', nodeEnv: 'development' }))
      .toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
    expect(getClientOrigins({ clientOrigin: 'http://127.0.0.1:5174', nodeEnv: 'development' }))
      .toEqual(['http://127.0.0.1:5174', 'http://localhost:5174'])
  })

  it('keeps production and remote origins restricted to the configured origin', () => {
    expect(getClientOrigins({ clientOrigin: 'http://localhost:5173', nodeEnv: 'production' })).toEqual(['http://localhost:5173'])
    expect(getClientOrigins({ clientOrigin: 'https://dashboard.example.com', nodeEnv: 'development' })).toEqual(['https://dashboard.example.com'])
  })

  it('returns browser-compatible headers for the allowed preview origin and rejects other origins', async () => {
    const app = express()
    app.use(cors({ origin: getClientOrigins({ clientOrigin: 'http://localhost:5173', nodeEnv: 'development' }), credentials: true }))
    app.get('/health', (req, res) => res.json({ ok: true }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    try {
      const url = `http://127.0.0.1:${server.address().port}/health`
      const allowed = await fetch(url, { headers: { Origin: 'http://127.0.0.1:5173' } })
      expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
      const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
      const rejected = await fetch(url, { headers: { Origin: 'https://other.example.com' } })
      expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})

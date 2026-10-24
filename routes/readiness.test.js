import { afterAll, beforeAll, expect, it } from 'vitest'
import { createApp } from '../app.js'
let server, origin, ready = false
beforeAll(async () => { server = createApp({ databaseReady: () => ready }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}` })
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
it('keeps liveness available while refusing session/database work until ready, then recovers without restart', async () => {
  expect((await fetch(origin + '/api/v1/health')).status).toBe(200)
  const unavailable = await fetch(origin + '/api/v1/auth/session')
  expect(unavailable.status).toBe(503); expect(unavailable.headers.get('Retry-After')).toBe('5')
  expect((await fetch(origin + '/api/v1/ready')).status).toBe(503)
  ready = true
  expect((await fetch(origin + '/api/v1/ready')).status).toBe(200)
  expect((await fetch(origin + '/api/v1/auth/session')).status).toBe(401)
  ready = false
  expect((await fetch(origin + '/api/v1/ready')).status).toBe(503)
})

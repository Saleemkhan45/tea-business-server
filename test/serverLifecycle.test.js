import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
it('listens before an unavailable database, stays live, gates work, and shuts down cleanly', async () => {
  const child = spawn(process.execPath, ['index.js'], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, env: { ...process.env, NODE_ENV: 'test', PORT: '0', MONGODB_URI: 'mongodb://127.0.0.1:1/offline_lifecycle', JWT_SECRET: 'offline-lifecycle-only-signing-secret', SECURITY_EMAIL_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] })
  const events = []
  let text = ''
  child.stdout.on('data', data => {
    text += data.toString()
    const lines = text.split('\n'); text = lines.pop()
    for (const line of lines) { try { events.push(JSON.parse(line)) } catch { /* Non-structured startup notices contain no test evidence. */ } }
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (events.some(row => row.event === 'server.listening')) { clearInterval(timer); resolve() } }, 20)
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Offline child did not listen')) }, 5000)
      deadline.unref()
      child.once('exit', () => { clearInterval(timer); clearTimeout(deadline) })
    })
    const started = events.find(row => row.event === 'server.listening')
    const origin = `http://127.0.0.1:${started.port}`
    expect((await fetch(origin + '/api/v1/health')).status).toBe(200)
    expect((await fetch(origin + '/api/v1/ready')).status).toBe(503)
    expect((await fetch(origin + '/api/v1/auth/session')).status).toBe(503)
    await new Promise(resolve => setTimeout(resolve, 5600))
    expect(events.some(row => row.event === 'database.connect.failed')).toBe(true)
    expect((await fetch(origin + '/api/v1/health')).status).toBe(200)
    const exited = once(child, 'exit')
    child.send({ type: 'shutdown' })
    expect((await exited)[0]).toBe(0)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
}, 12000)

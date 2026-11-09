// @vitest-environment node
/**
 * The api/ route files driven over real HTTP.
 *
 * The handler logic is covered in postgres.test.mjs; this checks the layer
 * around it — method guards, the Authorization header, CORS preflight, the
 * bytes path for photo downloads, and the response helpers' fallback for a
 * plain node:http server.
 *
 * The dispatcher below stands in for Vercel's filesystem routing (including
 * the /api/login → /api/auth rewrite from vercel.json). It tests our handlers,
 * not Vercel's router; the routing table itself is only verified by a real
 * deployment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { PGlite } from '@electric-sql/pglite'
import { createStore } from './_lib/store.js'

let pg
let store

// Swap the production Postgres pool for PGlite; everything else is the real thing.
vi.mock('./_lib/db.js', () => ({
  isConfigured: () => true,
  getStore: async () => store,
}))

const { default: authRoute } = await import('./auth.js')
const { default: syncRoute } = await import('./sync.js')
const { default: healthRoute } = await import('./health.js')
const { default: photoRoute } = await import('./photos/[id].js')
const { default: visionStatusRoute } = await import('./vision/status.js')
const { default: visionIdentifyRoute } = await import('./vision/identify.js')

let server
let base

beforeAll(async () => {
  process.env.OPENAI_API_KEY = '' // no key: recognition reports itself as off
  process.env.ADMIN_EMAIL = 'admin@sufa.ac.tz'
  process.env.ADMIN_PASSWORD = 'verify123' // without this no admin is seeded at all
  pg = new PGlite()
  await pg.waitReady
  store = createStore((text, params) => pg.query(text, params))

  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    const photo = /^\/api\/photos\/(.+)$/.exec(pathname)

    if (pathname === '/api/login' || pathname === '/api/auth') return authRoute(req, res)
    if (pathname === '/api/sync') return syncRoute(req, res)
    if (pathname === '/api/health') return healthRoute(req, res)
    if (pathname === '/api/vision/status') return visionStatusRoute(req, res)
    if (pathname === '/api/vision/identify') return visionIdentifyRoute(req, res)
    if (photo) {
      req.query = { id: decodeURIComponent(photo[1]) }
      return photoRoute(req, res)
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  await pg?.close()
})

beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS records, users, tokens, photos CASCADE')
  await store.init()
})

const json = (path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })

async function token() {
  const res = await json('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@sufa.ac.tz', password: 'verify123' }),
  })
  return (await res.json()).token
}

describe('auth route', () => {
  it('signs in at /api/login, the path the client uses on both deployments', async () => {
    const res = await json('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@sufa.ac.tz', password: 'verify123' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a wrong password', async () => {
    const res = await json('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@sufa.ac.tz', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a GET', async () => {
    expect((await json('/api/auth')).status).toBe(405)
  })

  it('answers a CORS preflight without touching the database', async () => {
    const res = await fetch(`${base}/api/auth`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com')
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization')
  })
})

describe('sync route', () => {
  it('needs a bearer token', async () => {
    const res = await json('/api/sync', { method: 'POST', body: JSON.stringify({ since: 0, changes: {} }) })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  it('rejects a forged token', async () => {
    const res = await json('/api/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer deadbeef' },
      body: JSON.stringify({ since: 0, changes: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('round-trips a record for an authenticated device', async () => {
    const auth = { Authorization: `Bearer ${await token()}` }
    const push = await json('/api/sync', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        since: 0,
        changes: { entries: [{ id: 'en_1', quantity: 3, inspectorId: 'insp_1', updatedAt: Date.now() }] },
      }),
    })
    expect(push.status).toBe(200)
    expect((await push.json()).accepted.entries).toEqual(['en_1'])

    const pull = await json('/api/sync', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ since: 0, changes: {} }),
    })
    expect((await pull.json()).changes.entries[0].quantity).toBe(3)
  })

  it('rejects a GET', async () => {
    expect((await json('/api/sync')).status).toBe(405)
  })
})

describe('photo route', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x2a, 0x2a])

  it('uploads with a token and serves the bytes back', async () => {
    const up = await json('/api/photos/ph_1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        data: bytes.toString('base64'),
        contentType: 'image/jpeg',
        entryId: 'en_1',
        exerciseId: 'ex_1',
      }),
    })
    expect(up.status).toBe(200)
    expect((await up.json()).url).toBe('/api/photos/ph_1')

    const down = await fetch(`${base}/api/photos/ph_1`, {
      headers: { Authorization: `Bearer ${await token()}` },
    })
    expect(down.status).toBe(200)
    expect(down.headers.get('content-type')).toBe('image/jpeg')
    expect(down.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.compare(Buffer.from(await down.arrayBuffer()), bytes)).toBe(0)
  })

  it('refuses an upload without a token', async () => {
    const res = await json('/api/photos/ph_1', {
      method: 'POST',
      body: JSON.stringify({ data: bytes.toString('base64') }),
    })
    expect(res.status).toBe(401)
  })

  it('404s a photo that does not exist', async () => {
    const res = await fetch(`${base}/api/photos/ph_missing`, {
      headers: { Authorization: `Bearer ${await token()}` },
    })
    expect(res.status).toBe(404)
  })

  it('refuses a download without a token, now that one database holds many schools', async () => {
    expect((await fetch(`${base}/api/photos/ph_1`)).status).toBe(401)
  })

  it('rejects an unsupported method', async () => {
    expect((await fetch(`${base}/api/photos/ph_1`, { method: 'DELETE' })).status).toBe(405)
  })
})

describe('vision routes', () => {
  it('reports recognition as off when the server has no key', async () => {
    const res = await fetch(`${base}/api/vision/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false)
    expect(body.models).toContain('gpt-4o')
  })

  it('needs a token before it will call OpenAI', async () => {
    const res = await json('/api/vision/identify', { method: 'POST', body: JSON.stringify({ image: 'AAAA' }) })
    expect(res.status).toBe(401)
  })

  it('says plainly that it is not configured, rather than failing obscurely', async () => {
    const res = await json('/api/vision/identify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ image: 'AAAA', contentType: 'image/jpeg' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('vision-not-configured')
  })
})

describe('health route', () => {
  it('reports ok with per-table counts', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // Record counts belong to an institution, so an anonymous probe gets none.
    expect(body.records).toBeUndefined()
  })

  it('includes the caller own record counts when a token is sent', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${await token()}` },
    })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.records)).toBe(true)
  })
})

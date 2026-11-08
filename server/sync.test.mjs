// @vitest-environment node
/**
 * End-to-end test of the sync protocol against a real server process:
 * two devices, one exercise, including the case the brief calls out — two
 * inspectors recording the same room.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
const PORT = 4789
const BASE = `http://127.0.0.1:${PORT}/api`

let child
let tmpDir

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('server did not start')
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-sync-'))
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(tmpDir, 'data'),
      UPLOAD_DIR: path.join(tmpDir, 'uploads'),
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'secret123',
      // Pin recognition off whatever the developer has in their own .env:
      // an already-set variable wins over the file, empty string included.
      OPENAI_API_KEY: '',
    },
    stdio: 'ignore',
  })
  await waitForServer()
}, 30000)

afterAll(async () => {
  child?.kill()
  await new Promise((r) => setTimeout(r, 200))
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the sqlite file; the temp dir is disposable */
  }
})

async function login(email = 'admin@test.local', password = 'secret123') {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { status: res.status, body: res.ok ? await res.json() : null }
}

async function sync(token, since, changes) {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ since, changes }),
  })
  return { status: res.status, body: res.ok ? await res.json() : null }
}

function entry(over = {}) {
  return {
    id: 'en_1',
    exerciseId: 'ex_1',
    roomId: 'rm_p3',
    assetTypeId: 'at_chair',
    quantity: 30,
    serialNumbers: [],
    model: '',
    brand: '',
    tagNumbers: ['SC-1F-P3-001'],
    condition: 'G',
    photoIds: [],
    remarks: '',
    inspectorId: 'insp_a',
    inspectedAt: 1,
    isUnlistedItem: false,
    notPresent: false,
    updatedAt: 1000,
    deleted: false,
    ...over,
  }
}

describe('auth', () => {
  it('rejects a bad password and an unauthenticated sync', async () => {
    expect((await login('admin@test.local', 'wrong')).status).toBe(401)
    expect((await sync('not-a-token', 0, {})).status).toBe(401)
  })

  it('issues a token for the seeded admin', async () => {
    const { status, body } = await login()
    expect(status).toBe(200)
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(body.inspector.role).toBe('admin')
  })
})

describe('push and pull', () => {
  it('accepts a push and hands it to a second device', async () => {
    const { body: auth } = await login()
    const token = auth.token

    const pushed = await sync(token, 0, { entries: [entry()] })
    expect(pushed.status).toBe(200)
    expect(pushed.body.accepted.entries).toEqual(['en_1'])
    expect(pushed.body.conflicts).toEqual([])
    // The pusher does not get its own record echoed back.
    expect(pushed.body.changes.entries).toBeUndefined()

    const other = await sync(token, 0, {})
    expect(other.body.changes.entries).toHaveLength(1)
    expect(other.body.changes.entries[0].quantity).toBe(30)
  })

  it('registers inspectors pushed from the field so they can sign in here', async () => {
    const { body: auth } = await login()
    // sha256('fieldpass')
    const hash = '2e6b23b7ee9c4d1d16a8d15e4f4a9a79b2b9f1a3a6a5f7a3e2d7c3a9d5b4f7c0'
    await sync(auth.token, 0, {
      inspectors: [
        {
          id: 'insp_b',
          name: 'Field Inspector',
          email: 'field@test.local',
          role: 'inspector',
          active: true,
          passwordHash: hash,
          updatedAt: Date.now(),
        },
      ],
    })
    const { createHash } = await import('node:crypto')
    const realHash = createHash('sha256').update('fieldpass').digest('hex')
    await sync(auth.token, 0, {
      inspectors: [
        {
          id: 'insp_b',
          name: 'Field Inspector',
          email: 'field@test.local',
          role: 'inspector',
          active: true,
          passwordHash: realHash,
          updatedAt: Date.now() + 1,
        },
      ],
    })
    const res = await login('field@test.local', 'fieldpass')
    expect(res.status).toBe(200)
    expect(res.body.inspector.role).toBe('inspector')
  })
})

describe('conflicts', () => {
  it('flags an overwrite of another inspector edit the device never saw', async () => {
    const { body: auth } = await login()
    const token = auth.token

    await sync(token, 0, { entries: [entry({ id: 'en_conflict', inspectorId: 'insp_a', updatedAt: 2000 })] })

    // Device B last synced before that write and now sends its own version.
    const res = await sync(token, 1500, {
      entries: [entry({ id: 'en_conflict', inspectorId: 'insp_b', quantity: 28, updatedAt: 3000 })],
    })

    expect(res.body.conflicts).toHaveLength(1)
    expect(res.body.conflicts[0].id).toBe('en_conflict')
    expect(res.body.conflicts[0].server.quantity).toBe(30)
    expect(res.body.conflicts[0].server.inspectorId).toBe('insp_a')
    expect(res.body.accepted.entries ?? []).not.toContain('en_conflict')
  })

  it('accepts the same inspector editing their own record again', async () => {
    const { body: auth } = await login()
    const token = auth.token
    await sync(token, 0, { entries: [entry({ id: 'en_own', inspectorId: 'insp_a', updatedAt: 2000 })] })
    const res = await sync(token, 0, {
      entries: [entry({ id: 'en_own', inspectorId: 'insp_a', quantity: 31, updatedAt: 4000 })],
    })
    expect(res.body.accepted.entries).toContain('en_own')
    expect(res.body.conflicts).toEqual([])
  })

  it('rejects a stale write that is older than the server copy', async () => {
    const { body: auth } = await login()
    const token = auth.token
    await sync(token, 0, { entries: [entry({ id: 'en_stale', inspectorId: 'insp_a', updatedAt: 5000 })] })
    const res = await sync(token, 9_999_999, {
      entries: [entry({ id: 'en_stale', inspectorId: 'insp_a', quantity: 1, updatedAt: 4000 })],
    })
    expect(res.body.conflicts).toHaveLength(1)
    expect(res.body.conflicts[0].server.quantity).toBe(30)
  })

  it('propagates a soft delete', async () => {
    const { body: auth } = await login()
    const token = auth.token
    await sync(token, 0, { entries: [entry({ id: 'en_del', updatedAt: 6000 })] })
    await sync(token, 0, { entries: [entry({ id: 'en_del', deleted: true, updatedAt: 7000 })] })
    const pull = await sync(token, 0, {})
    const row = pull.body.changes.entries.find((e) => e.id === 'en_del')
    expect(row.deleted).toBe(true)
  })
})

describe('vision routes', () => {
  it('reports status without auth, and without a key configured', async () => {
    const res = await fetch(`${BASE}/vision/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false) // no OPENAI_API_KEY in this test server
    expect(body.models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('refuses an unauthenticated identify request', async () => {
    const res = await fetch(`${BASE}/vision/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'AAAA' }),
    })
    expect(res.status).toBe(401)
  })

  it('tells a signed-in device that recognition is not set up', async () => {
    const { body: auth } = await login()
    const res = await fetch(`${BASE}/vision/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ image: 'AAAA' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('vision-not-configured')
  })
})

describe('photos', () => {
  it('stores an uploaded photo and serves it back', async () => {
    const { body: auth } = await login()
    // 1x1 transparent PNG
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const up = await fetch(`${BASE}/photos/ph_test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ entryId: 'en_1', exerciseId: 'ex_1', contentType: 'image/png', data }),
    })
    expect(up.status).toBe(200)
    expect((await up.json()).url).toBe('/api/photos/ph_test')

    const down = await fetch(`${BASE}/photos/ph_test`)
    expect(down.status).toBe(200)
    expect(down.headers.get('content-type')).toBe('image/png')
    expect((await down.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('refuses an unauthenticated upload', async () => {
    const res = await fetch(`${BASE}/photos/ph_nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'AAAA' }),
    })
    expect(res.status).toBe(401)
  })
})

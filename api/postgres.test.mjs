// @vitest-environment node
/**
 * The serverless API against a real Postgres.
 *
 * PGlite is Postgres compiled to WASM, so the SQL in api/_lib/store.js is
 * genuinely executed — JSONB, BYTEA, ON CONFLICT and the BIGINT-as-string
 * behaviour all behave as they will on Vercel Postgres, Neon or Supabase.
 * Nothing here is mocked except OpenAI.
 *
 * What this cannot prove: connection pooling under real serverless
 * concurrency, and TLS to a managed provider. Those need a deployment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createStore } from './_lib/store.js'
import { authenticate, handleHealth, handleLogin, handlePhotoUpload, handleSync } from './_lib/handlers.js'
import { scryptHash, sha256 } from '../server/crypto.js'

let pg
let store

const ADMIN_EMAIL = 'admin@sufa.ac.tz'
const ADMIN_PASSWORD = 'verify123'

beforeAll(async () => {
  pg = new PGlite()
  await pg.waitReady
  store = createStore((text, params) => pg.query(text, params))
})

afterAll(async () => {
  await pg?.close()
})

beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS records, users, tokens, photos CASCADE')
  await store.init()
})

async function signIn(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const { status, body } = await handleLogin(store, { email, password })
  expect(status).toBe(200)
  return body
}

function entry(over = {}) {
  return {
    id: 'en_1',
    exerciseId: 'ex_1',
    roomId: 'rm_1',
    assetTypeId: 'at_1',
    quantity: 4,
    serialNumbers: ['SN-A'],
    tagNumbers: ['SC-1F-P3-001'],
    condition: 'G',
    material: 'Wooden seat and backrest with metal frame',
    editHistory: [],
    inspectorId: 'insp_1',
    updatedAt: 1000,
    deleted: false,
    ...over,
  }
}

describe('schema', () => {
  it('creates every table and is safe to run twice', async () => {
    await store.init() // the second cold start must not break on existing tables

    const { rows } = await pg.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(['photos', 'records', 'tokens', 'users'])
  })

  it('seeds exactly one admin, however many instances start up', async () => {
    await store.seedAdmin()
    await store.seedAdmin()
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [ADMIN_EMAIL])
    expect(rows[0].n).toBe(1)
  })
})

describe('auth', () => {
  it('issues a token for the seeded admin and rejects a wrong password', async () => {
    const { token, inspector } = await signIn()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(inspector.role).toBe('admin')

    const bad = await handleLogin(store, { email: ADMIN_EMAIL, password: 'nope' })
    expect(bad.status).toBe(401)
    expect(bad.body.error).toBe('invalid-credentials')
  })

  it('refuses an unknown account without leaking that it is unknown', async () => {
    const res = await handleLogin(store, { email: 'nobody@example.com', password: 'verify123' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid-credentials')
  })

  it('resolves a bearer token back to its user, and rejects a bad one', async () => {
    const { token } = await signIn()
    expect((await authenticate(store, token)).email).toBe(ADMIN_EMAIL)
    expect(await authenticate(store, 'not-a-token')).toBeNull()
    expect(await authenticate(store, '')).toBeNull()
  })

  it('expires a token older than its TTL', async () => {
    const { token } = await signIn()
    await pg.query('UPDATE tokens SET created_at = $1', [Date.now() - 31 * 24 * 60 * 60 * 1000])
    expect(await authenticate(store, token)).toBeNull()

    // ...and clears it, so an expired token cannot keep being retried.
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM tokens WHERE token = $1', [token])
    expect(rows[0].n).toBe(0)
  })

  it('signs in an account created offline on a phone, using its SHA-256 hash', async () => {
    const user = await signIn()
    await handleSync(store, { id: user.inspector.id }, {
      since: 0,
      changes: {
        inspectors: [
          {
            id: 'insp_field',
            email: 'Field.Officer@sufa.ac.tz',
            name: 'Field Officer',
            role: 'inspector',
            passwordHash: sha256('fieldpass'),
            updatedAt: 1,
          },
        ],
      },
    })

    const ok = await handleLogin(store, { email: 'field.officer@sufa.ac.tz', password: 'fieldpass' })
    expect(ok.status).toBe(200)
    expect(ok.body.inspector.name).toBe('Field Officer')

    const wrong = await handleLogin(store, { email: 'field.officer@sufa.ac.tz', password: 'other' })
    expect(wrong.status).toBe(401)
  })

  it('prefers the scrypt hash when a user has both', async () => {
    await pg.query('UPDATE users SET scrypt = $1, sha256 = $2 WHERE email = $3', [
      scryptHash('real-password'),
      sha256('stale-password'),
      ADMIN_EMAIL,
    ])
    expect((await handleLogin(store, { email: ADMIN_EMAIL, password: 'real-password' })).status).toBe(200)
    expect((await handleLogin(store, { email: ADMIN_EMAIL, password: 'stale-password' })).status).toBe(401)
  })
})

describe('sync', () => {
  const user = { id: 'insp_1' }

  it('accepts a push and gives it back to a second device', async () => {
    const push = await handleSync(store, user, { since: 0, changes: { entries: [entry()] } })
    expect(push.body.accepted.entries).toEqual(['en_1'])
    expect(push.body.conflicts).toEqual([])
    // The pushing device does not get its own record echoed back.
    expect(push.body.changes.entries).toBeUndefined()

    const pull = await handleSync(store, { id: 'insp_2' }, { since: 0, changes: {} })
    expect(pull.body.changes.entries).toHaveLength(1)
    expect(pull.body.changes.entries[0].material).toBe('Wooden seat and backrest with metal frame')
    expect(pull.body.changes.entries[0].quantity).toBe(4)
  })

  it('round-trips JSONB without mangling nested arrays or objects', async () => {
    const history = [{ field: 'quantity', oldValue: '4', newValue: '6', editedBy: 'insp_1', editedAt: 1699 }]
    await handleSync(store, user, {
      since: 0,
      changes: { entries: [entry({ editHistory: history, conditionBreakdown: { G: 28, P: 2 } })] },
    })

    const pull = await handleSync(store, { id: 'insp_2' }, { since: 0, changes: {} })
    const got = pull.body.changes.entries[0]
    expect(got.editHistory).toEqual(history)
    expect(got.conditionBreakdown).toEqual({ G: 28, P: 2 })
    expect(got.serialNumbers).toEqual(['SN-A'])
  })

  it('flags a conflict when another inspector changed the record since your last sync', async () => {
    // Two inspectors walk into the same room. A records it now; B last synced
    // a minute ago, so B's push is about to overwrite an edit B never saw.
    const now = Date.now()
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    const other = await handleSync(store, { id: 'insp_2' }, {
      since: now - 60_000,
      changes: { entries: [entry({ quantity: 99, inspectorId: 'insp_2', updatedAt: now + 5_000 })] },
    })

    expect(other.body.conflicts).toHaveLength(1)
    expect(other.body.conflicts[0].id).toBe('en_1')
    expect(other.body.conflicts[0].server.quantity).toBe(4) // the server copy, for the user to compare
    expect(other.body.accepted.entries).toEqual([])

    // The server copy is left alone until the inspector resolves it.
    const stored = await store.recordFor('entries', 'en_1')
    expect(stored.json.quantity).toBe(4)
  })

  it('accepts a second inspector who has already seen the server copy', async () => {
    const now = Date.now()
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    // B synced after A's write, so B is editing on top of it, not over it.
    const other = await handleSync(store, { id: 'insp_2' }, {
      since: now + 1,
      changes: { entries: [entry({ quantity: 99, inspectorId: 'insp_2', updatedAt: now + 5_000 })] },
    })

    expect(other.body.conflicts).toEqual([])
    expect(other.body.accepted.entries).toEqual(['en_1'])
  })

  it('refuses a stale push that would undo newer work', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: 5000 })] } })
    const stale = await handleSync(store, user, {
      since: 0,
      changes: { entries: [entry({ quantity: 1, updatedAt: 4000 })] },
    })
    expect(stale.body.conflicts).toHaveLength(1)

    const pull = await handleSync(store, { id: 'insp_2' }, { since: 0, changes: {} })
    expect(pull.body.changes.entries[0].quantity).toBe(4)
  })

  it('lets the same inspector overwrite their own newer record', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: 1000 })] } })
    const again = await handleSync(store, user, {
      since: 0,
      changes: { entries: [entry({ quantity: 7, updatedAt: 2000 })] },
    })
    expect(again.body.accepted.entries).toEqual(['en_1'])
    expect(again.body.conflicts).toEqual([])
  })

  it('propagates a soft delete', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: 1000 })] } })
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ deleted: true, updatedAt: 2000 })] } })

    const pull = await handleSync(store, { id: 'insp_2' }, { since: 0, changes: {} })
    expect(pull.body.changes.entries[0].deleted).toBe(true)

    const { rows } = await pg.query('SELECT deleted FROM records WHERE id = $1', ['en_1'])
    expect(rows[0].deleted).toBe(true) // stored as a real boolean, not 0/1
  })

  it('only returns records newer than the caller has seen', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ id: 'en_old', updatedAt: 1000 })] } })
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ id: 'en_new', updatedAt: 3000 })] } })

    const pull = await handleSync(store, { id: 'insp_2' }, { since: 2000, changes: {} })
    expect(pull.body.changes.entries.map((e) => e.id)).toEqual(['en_new'])
  })

  it('ignores tables the client is not allowed to push', async () => {
    const res = await handleSync(store, user, {
      since: 0,
      changes: { photos: [{ id: 'ph_1', updatedAt: 1 }], nonsense: [{ id: 'x' }] },
    })
    expect(res.body.accepted.photos).toBeUndefined()
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM records')
    expect(rows[0].n).toBe(0)
  })

  it('keeps millisecond timestamps exact through BIGINT', async () => {
    const now = 1762684800123
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    const stored = await store.recordFor('entries', 'en_1')
    expect(stored.updatedAt).toBe(now)
    expect(typeof stored.updatedAt).toBe('number') // the driver hands back a string

    // A `since` one millisecond earlier must still see it.
    const pull = await handleSync(store, { id: 'insp_2' }, { since: now - 1, changes: {} })
    expect(pull.body.changes.entries).toHaveLength(1)
  })
})

describe('photos', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

  it('stores the bytes and gives them back unchanged', async () => {
    const up = await handlePhotoUpload(store, 'ph_abc', {
      data: jpeg.toString('base64'),
      contentType: 'image/jpeg',
      entryId: 'en_1',
      exerciseId: 'ex_1',
      width: 1280,
      height: 960,
      createdAt: 1762684800123,
    })
    expect(up.status).toBe(200)
    expect(up.body.url).toBe('/api/photos/ph_abc')

    const got = await store.getPhoto('ph_abc')
    expect(got.contentType).toBe('image/jpeg')
    expect(Buffer.compare(got.bytes, jpeg)).toBe(0)
  })

  it('replaces the bytes when the same id is uploaded again', async () => {
    const second = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await handlePhotoUpload(store, 'ph_abc', { data: jpeg.toString('base64'), contentType: 'image/jpeg' })
    await handlePhotoUpload(store, 'ph_abc', { data: second.toString('base64'), contentType: 'image/png' })

    const got = await store.getPhoto('ph_abc')
    expect(got.contentType).toBe('image/png')
    expect(Buffer.compare(got.bytes, second)).toBe(0)
  })

  it('rejects a missing body and a hostile id', async () => {
    expect((await handlePhotoUpload(store, 'ph_abc', {})).status).toBe(400)
    expect((await handlePhotoUpload(store, 'ph_abc', { data: '' })).status).toBe(400)
    expect((await handlePhotoUpload(store, '../../etc/passwd', { data: 'AAAA' })).status).toBe(400)
    expect((await handlePhotoUpload(store, 'a'.repeat(100), { data: 'AAAA' })).status).toBe(400)
  })

  it('returns null for a photo that was never uploaded', async () => {
    expect(await store.getPhoto('ph_missing')).toBeNull()
  })
})

describe('health', () => {
  it('counts records per table', async () => {
    await handleSync(store, { id: 'insp_1' }, {
      since: 0,
      changes: { entries: [entry(), entry({ id: 'en_2' })], rooms: [{ id: 'rm_1', updatedAt: 1 }] },
    })

    const { status, body } = await handleHealth(store)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const counts = Object.fromEntries(body.records.map((r) => [r.table_name, r.n]))
    expect(counts).toEqual({ entries: 2, rooms: 1 })
  })
})

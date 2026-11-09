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
import {
  authenticate,
  handleCreateUser,
  handleHealth,
  handleListUsers,
  handleLogin,
  handlePhotoUpload,
  handleRegister,
  handleSync,
} from './_lib/handlers.js'
import { scryptHash, sha256 } from '../server/crypto.js'

let pg
let store

const ADMIN_EMAIL = 'admin@sufa.ac.tz'
const ADMIN_PASSWORD = 'verify123'

beforeAll(async () => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD
  pg = new PGlite()
  await pg.waitReady
  store = createStore((text, params) => pg.query(text, params))
})

afterAll(async () => {
  await pg?.close()
})

beforeEach(async () => {
  await pg.exec('DROP TABLE IF EXISTS records, users, tokens, photos, orgs CASCADE')
  await store.init()
})

async function signIn(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const { status, body } = await handleLogin(store, { email, password })
  expect(status).toBe(200)
  return body
}

/** Registers a fresh institution and returns its admin, as a device would. */
async function register(orgName, email) {
  const res = await handleRegister(store, {
    orgName,
    address: 'Dar es Salaam',
    name: `${orgName} Admin`,
    email,
    password: 'a-good-password',
  })
  expect(res.status).toBe(201)
  const actor = await authenticate(store, res.body.token)
  return { ...res.body, actor }
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

describe('upgrading a database built before multi-tenancy', () => {
  /** Exactly the schema the single-tenant release created. */
  async function legacySchema() {
    await pg.exec('DROP TABLE IF EXISTS records, users, tokens, photos, orgs CASCADE')
    await pg.exec(`
      CREATE TABLE records (
        table_name   TEXT NOT NULL,
        id           TEXT NOT NULL,
        updated_at   BIGINT NOT NULL,
        inspector_id TEXT,
        deleted      BOOLEAN NOT NULL DEFAULT FALSE,
        json         JSONB NOT NULL,
        PRIMARY KEY (table_name, id)
      );
      CREATE INDEX records_updated ON records (updated_at);
      CREATE TABLE users (
        id     TEXT PRIMARY KEY,
        email  TEXT UNIQUE NOT NULL,
        name   TEXT NOT NULL,
        role   TEXT NOT NULL DEFAULT 'inspector',
        scrypt TEXT,
        sha256 TEXT
      );
      CREATE TABLE tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at BIGINT NOT NULL);
      CREATE TABLE photos (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, exercise_id TEXT NOT NULL,
        width INTEGER, height INTEGER, created_at BIGINT,
        content_type TEXT NOT NULL DEFAULT 'image/jpeg', bytes BYTEA NOT NULL
      );
    `)
  }

  it('migrates an existing deployment without losing its data', async () => {
    await legacySchema()
    await pg.query(
      `INSERT INTO users (id, email, name, role, scrypt) VALUES ('usr_old', $1, 'Old Admin', 'admin', $2)`,
      [ADMIN_EMAIL, scryptHash(ADMIN_PASSWORD)],
    )
    await pg.query(
      `INSERT INTO records (table_name, id, updated_at, inspector_id, deleted, json)
       VALUES ('entries', 'en_old', 1000, 'usr_old', FALSE, $1)`,
      [JSON.stringify({ id: 'en_old', quantity: 7 })],
    )

    await store.init() // the cold start that upgrades the database

    // The old account and its work survive, adopted into one organization.
    const user = await store.userByEmail(ADMIN_EMAIL)
    expect(user.orgId).toBeTruthy()
    const record = await store.recordFor(user.orgId, 'entries', 'en_old')
    expect(record.json.quantity).toBe(7)

    // And it is a working multi-tenant database afterwards.
    const { rows } = await pg.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'records'::regclass AND i.indisprimary ORDER BY a.attname`,
    )
    expect(rows.map((r) => r.attname)).toEqual(['id', 'org_id', 'table_name'])

    const login = await handleLogin(store, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    expect(login.status).toBe(200)
  })

  it('is safe to run twice, as two cold starts will', async () => {
    await legacySchema()
    await store.init()
    await store.init()
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM orgs')
    expect(rows[0].n).toBe(1)
  })
})

describe('schema', () => {
  it('creates every table and is safe to run twice', async () => {
    await store.init() // the second cold start must not break on existing tables

    const { rows } = await pg.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(['orgs', 'photos', 'records', 'tokens', 'users'])
  })

  it('keys records by tenant, so one institution cannot squat another id', async () => {
    const { rows } = await pg.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'records'::regclass AND i.indisprimary
       ORDER BY a.attname`,
    )
    expect(rows.map((r) => r.attname)).toEqual(['id', 'org_id', 'table_name'])
  })

  it('seeds exactly one admin, however many instances start up', async () => {
    await store.seedAdmin()
    await store.seedAdmin()
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [ADMIN_EMAIL])
    expect(rows[0].n).toBe(1)
  })

  it('seeds no admin at all when ADMIN_PASSWORD is unset', async () => {
    const saved = process.env.ADMIN_PASSWORD
    delete process.env.ADMIN_PASSWORD
    try {
      await pg.exec('DROP TABLE IF EXISTS records, users, tokens, photos, orgs CASCADE')
      await store.init()
      const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM users')
      expect(rows[0].n).toBe(0) // no default password on a fresh deployment
    } finally {
      process.env.ADMIN_PASSWORD = saved
    }
  })
})

describe('registration', () => {
  it('creates the institution, its admin, and enough data to start work', async () => {
    const res = await handleRegister(store, {
      orgName: 'Mlimani Secondary',
      address: 'Dodoma',
      name: 'Asha Mushi',
      email: 'asha@mlimani.ac.tz',
      password: 'strong-enough',
    })

    expect(res.status).toBe(201)
    expect(res.body.organization.name).toBe('Mlimani Secondary')
    expect(res.body.inspector.role).toBe('admin')
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/)

    // The new tenant can sign in immediately, and lands on a usable app.
    const actor = await authenticate(store, res.body.token)
    const pull = await handleSync(store, actor, { since: 0, changes: {} })
    expect(pull.body.changes.organizations?.[0].name).toBe('Mlimani Secondary')
    expect(pull.body.changes.exercises?.[0].status).toBe('active')
    expect(pull.body.changes.inspectors?.[0].email).toBe('asha@mlimani.ac.tz')
  })

  it('lets the new admin sign in with the password they chose', async () => {
    await register('Mlimani Secondary', 'asha@mlimani.ac.tz')
    const ok = await handleLogin(store, { email: 'asha@mlimani.ac.tz', password: 'a-good-password' })
    expect(ok.status).toBe(200)
    expect(ok.body.organization.name).toBe('Mlimani Secondary')

    const wrong = await handleLogin(store, { email: 'asha@mlimani.ac.tz', password: 'guess' })
    expect(wrong.status).toBe(401)
  })

  it('refuses an email that is already registered anywhere', async () => {
    await register('Mlimani Secondary', 'asha@mlimani.ac.tz')
    const again = await handleRegister(store, {
      orgName: 'Another School',
      name: 'Someone Else',
      email: 'asha@mlimani.ac.tz',
      password: 'a-good-password',
    })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('email-taken')
  })

  it('checks its inputs', async () => {
    const base = { orgName: 'X', name: 'Y', email: 'y@x.tz', password: 'a-good-password' }
    expect((await handleRegister(store, { ...base, orgName: '  ' })).body.error).toBe('org-name-required')
    expect((await handleRegister(store, { ...base, name: '' })).body.error).toBe('name-required')
    expect((await handleRegister(store, { ...base, email: 'not-an-email' })).body.error).toBe('email-invalid')
    expect((await handleRegister(store, { ...base, password: 'short' })).body.error).toBe('password-too-short')
  })
})

describe('tenant isolation', () => {
  it('never shows one institution the records of another', async () => {
    const a = await register('School A', 'a@a.tz')
    const b = await register('School B', 'b@b.tz')

    await handleSync(store, a.actor, { since: 0, changes: { entries: [entry({ id: 'en_a' })] } })
    await handleSync(store, b.actor, { since: 0, changes: { entries: [entry({ id: 'en_b' })] } })

    const seenByA = await handleSync(store, a.actor, { since: 0, changes: {} })
    const ids = (seenByA.body.changes.entries || []).map((e) => e.id)
    expect(ids).toContain('en_a')
    expect(ids).not.toContain('en_b')

    // And A's pull must not contain B's organization or inspectors either.
    expect((seenByA.body.changes.organizations || []).map((o) => o.name)).toEqual(['School A'])
    expect((seenByA.body.changes.inspectors || []).map((i) => i.email)).toEqual(['a@a.tz'])
  })

  it('cannot overwrite another institution record by reusing its id', async () => {
    const a = await register('School A', 'a@a.tz')
    const b = await register('School B', 'b@b.tz')

    await handleSync(store, a.actor, { since: 0, changes: { entries: [entry({ id: 'shared', quantity: 4 })] } })
    await handleSync(store, b.actor, {
      since: 0,
      changes: { entries: [entry({ id: 'shared', quantity: 999 })] },
    })

    expect((await store.recordFor(a.orgId ?? a.actor.orgId, 'entries', 'shared')).json.quantity).toBe(4)
    expect((await store.recordFor(b.actor.orgId, 'entries', 'shared')).json.quantity).toBe(999)
  })

  it('keeps photos apart', async () => {
    const a = await register('School A', 'a@a.tz')
    const b = await register('School B', 'b@b.tz')
    const bytes = Buffer.from([0xff, 0xd8, 0xff])

    await handlePhotoUpload(store, a.actor.orgId, 'ph_1', { data: bytes.toString('base64') })

    expect(await store.getPhoto(a.actor.orgId, 'ph_1')).not.toBeNull()
    expect(await store.getPhoto(b.actor.orgId, 'ph_1')).toBeNull()
  })

  it('counts only the caller own records on health', async () => {
    const a = await register('School A', 'a@a.tz')
    const b = await register('School B', 'b@b.tz')
    await handleSync(store, b.actor, { since: 0, changes: { entries: [entry({ id: 'en_b' })] } })

    const health = await handleHealth(store, a.actor.orgId)
    const counts = Object.fromEntries(health.body.records.map((r) => [r.table_name, r.n]))
    expect(counts.entries ?? 0).toBe(0) // A recorded nothing; B's rows are invisible
  })

  it('will not let a pushed inspector record hijack another tenant account', async () => {
    const a = await register('School A', 'a@a.tz')
    const b = await register('School B', 'b@b.tz')

    // B pushes an inspector claiming A's admin email.
    await handleSync(store, b.actor, {
      since: 0,
      changes: {
        inspectors: [{ id: 'x', email: 'a@a.tz', name: 'Impostor', role: 'admin', passwordHash: sha256('hunter2'), updatedAt: 9 }],
      },
    })

    // A's account is untouched and still has its own password.
    const victim = await store.userByEmail('a@a.tz')
    expect(victim.name).toBe('School A Admin')
    expect(victim.orgId).toBe(a.actor.orgId)
    expect((await handleLogin(store, { email: 'a@a.tz', password: 'hunter2' })).status).toBe(401)
    expect((await handleLogin(store, { email: 'a@a.tz', password: 'a-good-password' })).status).toBe(200)
  })
})

describe('team accounts', () => {
  it('lets an admin add a colleague who can then sign in', async () => {
    const a = await register('School A', 'a@a.tz')

    const created = await handleCreateUser(store, a.actor, {
      name: 'Juma Kito',
      email: 'juma@a.tz',
      password: 'juma-password',
      role: 'inspector',
    })
    expect(created.status).toBe(201)
    expect(created.body.user.role).toBe('inspector')

    const login = await handleLogin(store, { email: 'juma@a.tz', password: 'juma-password' })
    expect(login.status).toBe(200)
    expect(login.body.organization.name).toBe('School A')

    // The account reaches the team's devices as an inspector record.
    const pull = await handleSync(store, a.actor, { since: 0, changes: {} })
    expect((pull.body.changes.inspectors || []).map((i) => i.email).sort()).toEqual(['a@a.tz', 'juma@a.tz'])
  })

  it('refuses a non-admin', async () => {
    const a = await register('School A', 'a@a.tz')
    await handleCreateUser(store, a.actor, {
      name: 'Juma Kito',
      email: 'juma@a.tz',
      password: 'juma-password',
      role: 'inspector',
    })
    const juma = await authenticate(store, (await handleLogin(store, { email: 'juma@a.tz', password: 'juma-password' })).body.token)

    const denied = await handleCreateUser(store, juma, {
      name: 'Another',
      email: 'another@a.tz',
      password: 'another-password',
    })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('admin-only')
  })

  it('lists only the accounts of the caller institution', async () => {
    const a = await register('School A', 'a@a.tz')
    await register('School B', 'b@b.tz')
    await handleCreateUser(store, a.actor, { name: 'Juma', email: 'juma@a.tz', password: 'juma-password' })

    const { body } = await handleListUsers(store, a.actor)
    expect(body.users.map((u) => u.email).sort()).toEqual(['a@a.tz', 'juma@a.tz'])
  })

  it('checks its inputs and refuses a duplicate email', async () => {
    const a = await register('School A', 'a@a.tz')
    const base = { name: 'Juma', email: 'juma@a.tz', password: 'juma-password' }
    expect((await handleCreateUser(store, a.actor, { ...base, password: 'short' })).body.error).toBe(
      'password-too-short',
    )
    expect((await handleCreateUser(store, a.actor, { ...base, email: 'nope' })).body.error).toBe('email-invalid')

    expect((await handleCreateUser(store, a.actor, base)).status).toBe(201)
    expect((await handleCreateUser(store, a.actor, base)).status).toBe(409)
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

  it('resolves a bearer token back to its user and organization', async () => {
    const { token } = await signIn()
    const who = await authenticate(store, token)
    expect(who.email).toBe(ADMIN_EMAIL)
    expect(who.orgId).toBeTruthy()
    expect(await authenticate(store, 'not-a-token')).toBeNull()
    expect(await authenticate(store, '')).toBeNull()
  })

  it('expires a token older than its TTL', async () => {
    const { token } = await signIn()
    await pg.query('UPDATE tokens SET created_at = $1', [Date.now() - 31 * 24 * 60 * 60 * 1000])
    expect(await authenticate(store, token)).toBeNull()

    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM tokens WHERE token = $1', [token])
    expect(rows[0].n).toBe(0)
  })

  it('signs in an account created offline on a phone, using its SHA-256 hash', async () => {
    const user = await signIn()
    const actor = await authenticate(store, user.token)
    await handleSync(store, actor, {
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
  let user

  beforeEach(async () => {
    user = await authenticate(store, (await signIn()).token)
  })

  it('accepts a push and gives it back to a second device', async () => {
    const push = await handleSync(store, user, { since: 0, changes: { entries: [entry()] } })
    expect(push.body.accepted.entries).toEqual(['en_1'])
    expect(push.body.conflicts).toEqual([])
    expect(push.body.changes.entries).toBeUndefined()

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: 0, changes: {} })
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

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: 0, changes: {} })
    const got = pull.body.changes.entries[0]
    expect(got.editHistory).toEqual(history)
    expect(got.conditionBreakdown).toEqual({ G: 28, P: 2 })
    expect(got.serialNumbers).toEqual(['SN-A'])
  })

  it('flags a conflict when another inspector changed the record since your last sync', async () => {
    const now = Date.now()
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    const other = await handleSync(store, { ...user, id: 'insp_2' }, {
      since: now - 60_000,
      changes: { entries: [entry({ quantity: 99, inspectorId: 'insp_2', updatedAt: now + 5_000 })] },
    })

    expect(other.body.conflicts).toHaveLength(1)
    expect(other.body.conflicts[0].id).toBe('en_1')
    expect(other.body.conflicts[0].server.quantity).toBe(4)
    expect(other.body.accepted.entries).toEqual([])

    const stored = await store.recordFor(user.orgId, 'entries', 'en_1')
    expect(stored.json.quantity).toBe(4)
  })

  it('accepts a second inspector who has already seen the server copy', async () => {
    const now = Date.now()
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    const other = await handleSync(store, { ...user, id: 'insp_2' }, {
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

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: 0, changes: {} })
    expect(pull.body.changes.entries[0].quantity).toBe(4)
  })

  it('propagates a soft delete', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: 1000 })] } })
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ deleted: true, updatedAt: 2000 })] } })

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: 0, changes: {} })
    const row = pull.body.changes.entries.find((e) => e.id === 'en_1')
    expect(row.deleted).toBe(true)

    const { rows } = await pg.query('SELECT deleted FROM records WHERE id = $1', ['en_1'])
    expect(rows[0].deleted).toBe(true)
  })

  it('only returns records newer than the caller has seen', async () => {
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ id: 'en_old', updatedAt: 1000 })] } })
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ id: 'en_new', updatedAt: 3000 })] } })

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: 2000, changes: {} })
    expect(pull.body.changes.entries.map((e) => e.id)).toEqual(['en_new'])
  })

  it('ignores tables the client is not allowed to push', async () => {
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM records')).rows[0].n
    const res = await handleSync(store, user, {
      since: 0,
      changes: { photos: [{ id: 'ph_1', updatedAt: 1 }], nonsense: [{ id: 'x' }] },
    })
    expect(res.body.accepted.photos).toBeUndefined()
    const after = (await pg.query('SELECT COUNT(*)::int AS n FROM records')).rows[0].n
    expect(after).toBe(before)
  })

  it('keeps millisecond timestamps exact through BIGINT', async () => {
    const now = 1762684800123
    await handleSync(store, user, { since: 0, changes: { entries: [entry({ updatedAt: now })] } })

    const stored = await store.recordFor(user.orgId, 'entries', 'en_1')
    expect(stored.updatedAt).toBe(now)
    expect(typeof stored.updatedAt).toBe('number')

    const pull = await handleSync(store, { ...user, id: 'insp_2' }, { since: now - 1, changes: {} })
    expect(pull.body.changes.entries).toHaveLength(1)
  })
})

describe('photos', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  let orgId

  beforeEach(async () => {
    orgId = (await authenticate(store, (await signIn()).token)).orgId
  })

  it('stores the bytes and gives them back unchanged', async () => {
    const up = await handlePhotoUpload(store, orgId, 'ph_abc', {
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

    const got = await store.getPhoto(orgId, 'ph_abc')
    expect(got.contentType).toBe('image/jpeg')
    expect(Buffer.compare(got.bytes, jpeg)).toBe(0)
  })

  it('replaces the bytes when the same id is uploaded again', async () => {
    const second = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await handlePhotoUpload(store, orgId, 'ph_abc', { data: jpeg.toString('base64'), contentType: 'image/jpeg' })
    await handlePhotoUpload(store, orgId, 'ph_abc', { data: second.toString('base64'), contentType: 'image/png' })

    const got = await store.getPhoto(orgId, 'ph_abc')
    expect(got.contentType).toBe('image/png')
    expect(Buffer.compare(got.bytes, second)).toBe(0)
  })

  it('rejects a missing body and a hostile id', async () => {
    expect((await handlePhotoUpload(store, orgId, 'ph_abc', {})).status).toBe(400)
    expect((await handlePhotoUpload(store, orgId, 'ph_abc', { data: '' })).status).toBe(400)
    expect((await handlePhotoUpload(store, orgId, '../../etc/passwd', { data: 'AAAA' })).status).toBe(400)
    expect((await handlePhotoUpload(store, orgId, 'a'.repeat(100), { data: 'AAAA' })).status).toBe(400)
  })

  it('returns null for a photo that was never uploaded', async () => {
    expect(await store.getPhoto(orgId, 'ph_missing')).toBeNull()
  })
})

describe('health', () => {
  it('counts records per table for the caller institution', async () => {
    const user = await authenticate(store, (await signIn()).token)
    await handleSync(store, user, {
      since: 0,
      changes: { entries: [entry(), entry({ id: 'en_2' })], rooms: [{ id: 'rm_1', updatedAt: 1 }] },
    })

    const { status, body } = await handleHealth(store, user.orgId)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const counts = Object.fromEntries(body.records.map((r) => [r.table_name, r.n]))
    expect(counts.entries).toBe(2)
    expect(counts.rooms).toBe(1)
  })

  it('reports liveness without a token, and no record counts', async () => {
    const { body } = await handleHealth(store, undefined)
    expect(body.ok).toBe(true)
    expect(body.records).toBeUndefined()
  })
})

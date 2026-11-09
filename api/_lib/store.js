/**
 * Postgres storage for the serverless deployment.
 *
 * `createStore` takes a `sql(text, params) => { rows }` function rather than a
 * driver, so the same code runs against node-postgres in production and
 * against PGlite (real Postgres compiled to WASM) in the test suite. The SQL
 * here is therefore genuinely exercised, not mocked.
 *
 * The record layout mirrors the SQLite server: one `records` table keyed by
 * (org_id, table_name, id) holding the client JSON verbatim, so adding a field
 * to the client still needs no migration on the server.
 *
 * MULTI-TENANCY. Every row carries `org_id`, and it is always taken from the
 * authenticated user — never from the request body, or one tenant could write
 * into another's data by guessing an id. `org_id` is part of the primary key
 * for the same reason: without it, a record id known to belong to another
 * institution could be overwritten by anyone.
 *
 * BIGINT note: node-postgres returns int8 as a *string*, because not every
 * int64 fits a JS number. Millisecond timestamps always fit, so every read of
 * one goes through Number() — never trust the driver to have done it.
 */
import { TOKEN_TTL_MS } from '../../server/sync-rules.js'
import { newToken, newUserId, scryptHash, sha256 } from '../../server/crypto.js'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orgs (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     address    TEXT NOT NULL DEFAULT '',
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS records (
     org_id       TEXT NOT NULL,
     table_name   TEXT NOT NULL,
     id           TEXT NOT NULL,
     updated_at   BIGINT NOT NULL,
     inspector_id TEXT,
     deleted      BOOLEAN NOT NULL DEFAULT FALSE,
     json         JSONB NOT NULL,
     PRIMARY KEY (org_id, table_name, id)
   )`,
  `CREATE INDEX IF NOT EXISTS records_org_updated ON records (org_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS users (
     id     TEXT PRIMARY KEY,
     org_id TEXT NOT NULL,
     email  TEXT UNIQUE NOT NULL,
     name   TEXT NOT NULL,
     role   TEXT NOT NULL DEFAULT 'inspector',
     scrypt TEXT,
     sha256 TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS users_org ON users (org_id)`,
  `CREATE TABLE IF NOT EXISTS tokens (
     token      TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS tokens_created ON tokens (created_at)`,
  `CREATE TABLE IF NOT EXISTS photos (
     id           TEXT PRIMARY KEY,
     org_id       TEXT NOT NULL,
     entry_id     TEXT NOT NULL,
     exercise_id  TEXT NOT NULL,
     width        INTEGER,
     height       INTEGER,
     created_at   BIGINT,
     content_type TEXT NOT NULL DEFAULT 'image/jpeg',
     bytes        BYTEA NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS photos_org ON photos (org_id)`,
]

/**
 * Brings a database created before multi-tenancy up to date. Written to be
 * safe to run on every cold start and on a database that is already current.
 *
 * Pre-tenant rows all belong to whoever was using that deployment, so they are
 * adopted into one organization rather than deleted.
 */
const LEGACY_ORG_ID = 'org_legacy'

const MIGRATIONS = [
  `ALTER TABLE records ADD COLUMN IF NOT EXISTS org_id TEXT`,
  `ALTER TABLE users   ADD COLUMN IF NOT EXISTS org_id TEXT`,
  `ALTER TABLE photos  ADD COLUMN IF NOT EXISTS org_id TEXT`,
  `INSERT INTO orgs (id, name, address, created_at)
     SELECT '${LEGACY_ORG_ID}', 'Organization', '', 0
     WHERE EXISTS (SELECT 1 FROM users WHERE org_id IS NULL)
        OR EXISTS (SELECT 1 FROM records WHERE org_id IS NULL)
     ON CONFLICT (id) DO NOTHING`,
  `UPDATE records SET org_id = '${LEGACY_ORG_ID}' WHERE org_id IS NULL`,
  `UPDATE users   SET org_id = '${LEGACY_ORG_ID}' WHERE org_id IS NULL`,
  `UPDATE photos  SET org_id = '${LEGACY_ORG_ID}' WHERE org_id IS NULL`,
  `ALTER TABLE records ALTER COLUMN org_id SET NOT NULL`,
  `ALTER TABLE users   ALTER COLUMN org_id SET NOT NULL`,
  `ALTER TABLE photos  ALTER COLUMN org_id SET NOT NULL`,
  // The old primary key did not include the tenant, which is the one thing
  // that makes cross-tenant overwriting impossible.
  `ALTER TABLE records DROP CONSTRAINT IF EXISTS records_pkey`,
  `ALTER TABLE records ADD CONSTRAINT records_pkey PRIMARY KEY (org_id, table_name, id)`,
]

/**
 * Two concurrent cold starts can run the same CREATE TABLE IF NOT EXISTS and
 * collide in the system catalog, and the same applies to the migrations below.
 * Postgres reports these as duplicate-object errors, which are harmless here:
 * the other request did exactly what we wanted.
 */
const BENIGN_DDL_CODES = new Set([
  '23505', // unique_violation
  '42P07', // duplicate_table
  '42710', // duplicate_object
  '42701', // duplicate_column
  '42P16', // invalid_table_definition (primary key already present)
])

export function createStore(sql) {
  async function tolerant(statement) {
    try {
      await sql(statement)
    } catch (err) {
      if (!BENIGN_DDL_CODES.has(err?.code)) throw err
    }
  }

  const store = {
    async init() {
      for (const statement of SCHEMA) await tolerant(statement)
      for (const statement of MIGRATIONS) await tolerant(statement)
      await store.seedAdmin()
    },

    /**
     * Creates the bootstrap admin and its organization once, so a fresh
     * deployment can be signed into before anyone has registered through the
     * app. Skipped entirely when ADMIN_PASSWORD is unset.
     */
    async seedAdmin() {
      const email = (process.env.ADMIN_EMAIL || 'admin@sufa.ac.tz').toLowerCase()
      const password = process.env.ADMIN_PASSWORD
      if (!password) return

      const existing = await store.userByEmail(email)
      if (existing) return

      const orgId = LEGACY_ORG_ID
      await sql(
        `INSERT INTO orgs (id, name, address, created_at) VALUES ($1, $2, '', $3)
         ON CONFLICT (id) DO NOTHING`,
        [orgId, process.env.ADMIN_ORG_NAME || 'Organization', Date.now()],
      )
      await sql(
        `INSERT INTO users (id, org_id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, $4, 'admin', $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [newUserId(), orgId, email, process.env.ADMIN_NAME || 'Admin', scryptHash(password), sha256(password)],
      )
    },

    // -------------------------------------------------------------- orgs ---
    /**
     * Registers an institution together with its first admin, in that order,
     * so an organization never exists without someone able to sign in to it.
     */
    async createOrgWithAdmin({ orgId, orgName, address, userId, name, email, password }) {
      const now = Date.now()
      await sql('INSERT INTO orgs (id, name, address, created_at) VALUES ($1, $2, $3, $4)', [
        orgId,
        orgName,
        address || '',
        now,
      ])
      await sql(
        `INSERT INTO users (id, org_id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, $4, 'admin', $5, $6)`,
        [userId, orgId, email, name, scryptHash(password), sha256(password)],
      )
      return { id: orgId, name: orgName, address: address || '', createdAt: now }
    },

    async orgById(orgId) {
      const { rows } = await sql('SELECT id, name, address, created_at FROM orgs WHERE id = $1', [orgId])
      const row = rows[0]
      return row ? { id: row.id, name: row.name, address: row.address, createdAt: Number(row.created_at) } : null
    },

    // ------------------------------------------------------------- users ---
    async userByEmail(email) {
      const { rows } = await sql(
        'SELECT id, org_id, email, name, role, scrypt, sha256 FROM users WHERE email = $1',
        [String(email || '').toLowerCase()],
      )
      const row = rows[0]
      return row ? { ...row, orgId: row.org_id } : null
    },

    async usersInOrg(orgId) {
      const { rows } = await sql(
        'SELECT id, email, name, role FROM users WHERE org_id = $1 ORDER BY name',
        [orgId],
      )
      return rows
    },

    /** Creates an account inside one organization, with a server-side hash. */
    async createUser({ orgId, id, name, email, role, password }) {
      await sql(
        `INSERT INTO users (id, org_id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, orgId, email, name, role, scryptHash(password), sha256(password)],
      )
      return { id, email, name, role }
    },

    /**
     * Registers or refreshes an account that was created offline on a phone.
     * Scoped to the pusher's organization; an inspector record naming an email
     * that already belongs to another tenant is ignored rather than hijacked.
     */
    async upsertUser(orgId, user) {
      const { rows } = await sql('SELECT id, org_id FROM users WHERE email = $1', [user.email])
      const existing = rows[0]
      if (existing) {
        if (existing.org_id !== orgId) return
        await sql('UPDATE users SET name = $1, role = $2, sha256 = COALESCE($3, sha256) WHERE id = $4', [
          user.name,
          user.role,
          user.sha256,
          existing.id,
        ])
        return
      }
      await sql(
        `INSERT INTO users (id, org_id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         ON CONFLICT (email) DO NOTHING`,
        [user.id || newUserId(), orgId, user.email, user.name, user.role, user.sha256],
      )
    },

    // ------------------------------------------------------------ tokens ---
    async issueToken(userId) {
      const token = newToken()
      await sql('INSERT INTO tokens (token, user_id, created_at) VALUES ($1, $2, $3)', [token, userId, Date.now()])
      await sql('DELETE FROM tokens WHERE created_at < $1', [Date.now() - TOKEN_TTL_MS])
      return token
    },

    async userForToken(token) {
      if (!token) return null
      const { rows } = await sql(
        `SELECT u.id, u.org_id, u.email, u.name, u.role, t.created_at
         FROM tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token = $1`,
        [token],
      )
      const row = rows[0]
      if (!row) return null
      if (Date.now() - Number(row.created_at) > TOKEN_TTL_MS) {
        await sql('DELETE FROM tokens WHERE token = $1', [token])
        return null
      }
      return { id: row.id, orgId: row.org_id, email: row.email, name: row.name, role: row.role }
    },

    // ----------------------------------------------------------- records ---
    async recordFor(orgId, tableName, id) {
      if (!id) return null
      const { rows } = await sql(
        'SELECT updated_at, inspector_id, json FROM records WHERE org_id = $1 AND table_name = $2 AND id = $3',
        [orgId, tableName, id],
      )
      const row = rows[0]
      if (!row) return null
      return { updatedAt: Number(row.updated_at), inspectorId: row.inspector_id, json: row.json }
    },

    async writeRecord(orgId, tableName, row) {
      await sql(
        `INSERT INTO records (org_id, table_name, id, updated_at, inspector_id, deleted, json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, table_name, id) DO UPDATE SET
           updated_at   = EXCLUDED.updated_at,
           inspector_id = EXCLUDED.inspector_id,
           deleted      = EXCLUDED.deleted,
           json         = EXCLUDED.json`,
        [orgId, tableName, row.id, row.updatedAt, row.inspectorId, row.deleted, JSON.stringify(row.json)],
      )
    },

    async recordsSince(orgId, since) {
      const { rows } = await sql(
        `SELECT table_name, id, json FROM records
         WHERE org_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
        [orgId, Number(since || 0)],
      )
      return rows.map((r) => ({ tableName: r.table_name, id: r.id, json: r.json }))
    },

    async recordCounts(orgId) {
      const { rows } = await sql(
        'SELECT table_name, COUNT(*) AS n FROM records WHERE org_id = $1 GROUP BY table_name',
        [orgId],
      )
      return rows.map((r) => ({ table_name: r.table_name, n: Number(r.n) }))
    },

    // ------------------------------------------------------------ photos ---
    async putPhoto(orgId, photo) {
      await sql(
        `INSERT INTO photos (id, org_id, entry_id, exercise_id, width, height, created_at, content_type, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           bytes        = EXCLUDED.bytes,
           content_type = EXCLUDED.content_type,
           width        = EXCLUDED.width,
           height       = EXCLUDED.height
         WHERE photos.org_id = EXCLUDED.org_id`,
        [
          photo.id,
          orgId,
          photo.entryId,
          photo.exerciseId,
          photo.width,
          photo.height,
          photo.createdAt,
          photo.contentType,
          photo.bytes,
        ],
      )
    },

    async getPhoto(orgId, id) {
      const { rows } = await sql('SELECT content_type, bytes FROM photos WHERE id = $1 AND org_id = $2', [id, orgId])
      const row = rows[0]
      if (!row) return null
      return { contentType: row.content_type, bytes: Buffer.from(row.bytes) }
    },
  }

  return store
}

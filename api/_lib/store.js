/**
 * Postgres storage for the serverless deployment.
 *
 * `createStore` takes a `sql(text, params) => { rows }` function rather than a
 * driver, so the same code runs against node-postgres in production and
 * against PGlite (real Postgres compiled to WASM) in the test suite. The SQL
 * here is therefore genuinely exercised, not mocked.
 *
 * The record layout mirrors the SQLite server: one `records` table keyed by
 * (table_name, id) holding the client JSON verbatim, so adding a field to the
 * client still needs no migration on the server.
 *
 * BIGINT note: node-postgres returns int8 as a *string*, because not every
 * int64 fits a JS number. Millisecond timestamps always fit, so every read of
 * one goes through Number() — never trust the driver to have done it.
 */
import { TOKEN_TTL_MS } from '../../server/sync-rules.js'
import { newToken, newUserId, scryptHash, sha256 } from '../../server/crypto.js'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS records (
     table_name   TEXT NOT NULL,
     id           TEXT NOT NULL,
     updated_at   BIGINT NOT NULL,
     inspector_id TEXT,
     deleted      BOOLEAN NOT NULL DEFAULT FALSE,
     json         JSONB NOT NULL,
     PRIMARY KEY (table_name, id)
   )`,
  `CREATE INDEX IF NOT EXISTS records_updated ON records (updated_at)`,
  `CREATE TABLE IF NOT EXISTS users (
     id     TEXT PRIMARY KEY,
     email  TEXT UNIQUE NOT NULL,
     name   TEXT NOT NULL,
     role   TEXT NOT NULL DEFAULT 'inspector',
     scrypt TEXT,
     sha256 TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS tokens (
     token      TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS tokens_created ON tokens (created_at)`,
  `CREATE TABLE IF NOT EXISTS photos (
     id           TEXT PRIMARY KEY,
     entry_id     TEXT NOT NULL,
     exercise_id  TEXT NOT NULL,
     width        INTEGER,
     height       INTEGER,
     created_at   BIGINT,
     content_type TEXT NOT NULL DEFAULT 'image/jpeg',
     bytes        BYTEA NOT NULL
   )`,
]

/**
 * Two concurrent cold starts can run the same CREATE TABLE IF NOT EXISTS and
 * collide in the system catalog. Postgres reports that as a duplicate-object
 * error, which is harmless here: the other request created exactly the table
 * we wanted.
 */
const BENIGN_DDL_CODES = new Set(['23505', '42P07', '42710'])

export function createStore(sql) {
  const store = {
    async init() {
      for (const statement of SCHEMA) {
        try {
          await sql(statement)
        } catch (err) {
          if (!BENIGN_DDL_CODES.has(err?.code)) throw err
        }
      }
      await store.seedAdmin()
    },

    /** Creates the bootstrap admin once, so a fresh database can be signed into. */
    async seedAdmin() {
      const email = (process.env.ADMIN_EMAIL || 'admin@sufa.ac.tz').toLowerCase()
      const password = process.env.ADMIN_PASSWORD || 'verify123'
      await sql(
        `INSERT INTO users (id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, 'admin', $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [newUserId(), email, process.env.ADMIN_NAME || 'Admin', scryptHash(password), sha256(password)],
      )
    },

    // ------------------------------------------------------------- users ---
    async userByEmail(email) {
      const { rows } = await sql('SELECT id, email, name, role, scrypt, sha256 FROM users WHERE email = $1', [
        String(email || '').toLowerCase(),
      ])
      return rows[0] ?? null
    },

    /** Registers or refreshes an account that was created offline on a phone. */
    async upsertUser(user) {
      const { rows } = await sql('SELECT id FROM users WHERE email = $1', [user.email])
      if (rows[0]) {
        await sql('UPDATE users SET name = $1, role = $2, sha256 = COALESCE($3, sha256) WHERE id = $4', [
          user.name,
          user.role,
          user.sha256,
          rows[0].id,
        ])
        return
      }
      await sql(
        `INSERT INTO users (id, email, name, role, scrypt, sha256)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (email) DO NOTHING`,
        [user.id || newUserId(), user.email, user.name, user.role, user.sha256],
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
        `SELECT u.id, u.email, u.name, u.role, t.created_at
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
      return { id: row.id, email: row.email, name: row.name, role: row.role }
    },

    // ----------------------------------------------------------- records ---
    /** Just the columns the conflict rule needs, plus the stored JSON. */
    async recordFor(tableName, id) {
      if (!id) return null
      const { rows } = await sql(
        'SELECT updated_at, inspector_id, json FROM records WHERE table_name = $1 AND id = $2',
        [tableName, id],
      )
      const row = rows[0]
      if (!row) return null
      return { updatedAt: Number(row.updated_at), inspectorId: row.inspector_id, json: row.json }
    },

    async writeRecord(tableName, row) {
      await sql(
        `INSERT INTO records (table_name, id, updated_at, inspector_id, deleted, json)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (table_name, id) DO UPDATE SET
           updated_at   = EXCLUDED.updated_at,
           inspector_id = EXCLUDED.inspector_id,
           deleted      = EXCLUDED.deleted,
           json         = EXCLUDED.json`,
        [tableName, row.id, row.updatedAt, row.inspectorId, row.deleted, JSON.stringify(row.json)],
      )
    },

    async recordsSince(since) {
      const { rows } = await sql(
        'SELECT table_name, id, json FROM records WHERE updated_at > $1 ORDER BY updated_at ASC',
        [Number(since || 0)],
      )
      return rows.map((r) => ({ tableName: r.table_name, id: r.id, json: r.json }))
    },

    async recordCounts() {
      const { rows } = await sql('SELECT table_name, COUNT(*) AS n FROM records GROUP BY table_name')
      return rows.map((r) => ({ table_name: r.table_name, n: Number(r.n) }))
    },

    // ------------------------------------------------------------ photos ---
    async putPhoto(photo) {
      await sql(
        `INSERT INTO photos (id, entry_id, exercise_id, width, height, created_at, content_type, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           bytes        = EXCLUDED.bytes,
           content_type = EXCLUDED.content_type,
           width        = EXCLUDED.width,
           height       = EXCLUDED.height`,
        [
          photo.id,
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

    async getPhoto(id) {
      const { rows } = await sql('SELECT content_type, bytes FROM photos WHERE id = $1', [id])
      const row = rows[0]
      if (!row) return null
      return { contentType: row.content_type, bytes: Buffer.from(row.bytes) }
    },
  }

  return store
}

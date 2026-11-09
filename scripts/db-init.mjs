/**
 * Creates the Postgres schema and the bootstrap admin, then exits.
 *
 * The serverless functions do this themselves on a cold start, but running it
 * once by hand after provisioning a database gives you a clear success or
 * failure message instead of discovering a bad connection string through a
 * 500 on the first sign-in.
 *
 *   POSTGRES_URL="postgres://…" npm run db:init
 */
import { createStore } from '../api/_lib/store.js'

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || ''
if (!connectionString) {
  console.error('Set POSTGRES_URL (or DATABASE_URL) to the pooled connection string first.')
  process.exit(1)
}

const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 })

try {
  const store = createStore((text, params) => pool.query(text, params))
  await store.init()
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
     ORDER BY table_name`,
  )
  console.log('Schema ready. Tables:', rows.map((r) => r.table_name).join(', '))
  console.log(`Admin account: ${(process.env.ADMIN_EMAIL || 'admin@sufa.ac.tz').toLowerCase()}`)
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('WARNING: ADMIN_PASSWORD is unset, so the seeded password is the public default.')
  }
} catch (err) {
  console.error('Failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}

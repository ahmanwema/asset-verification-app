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
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStore } from '../api/_lib/store.js'

// Read .env so the connection string can live in a gitignored file rather than
// a shell history or a CI log. Real environment variables still win.
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'))
} catch {
  /* no .env — the variable may come from the environment instead */
}

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || ''
if (!connectionString) {
  // Diagnose without printing any value: the usual causes are an unsaved
  // editor buffer, a .env in the wrong folder, or a key that was renamed.
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
  console.error('POSTGRES_URL is not set.\n')
  if (!existsSync(envPath)) {
    console.error(`No .env found at ${envPath}`)
  } else {
    const { mtime, size } = statSync(envPath)
    console.error(`.env found: ${envPath}`)
    console.error(`  ${size} bytes, last saved ${mtime.toLocaleString()}`)
    const names = Object.keys(process.env).filter((k) =>
      ['POSTGRES_URL', 'DATABASE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'OPENAI_API_KEY'].includes(k),
    )
    // Names and emptiness only — never a value, not even a fragment.
    console.error(
      `  keys loaded: ${names.length ? names.map((n) => `${n}=${process.env[n] ? 'set' : 'EMPTY'}`).join(', ') : 'none'}`,
    )
  }
  console.error('\nExpected a line of the form  POSTGRES_URL=postgresql://...  with no quotes.')
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

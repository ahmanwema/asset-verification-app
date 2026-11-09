/**
 * The production Postgres connection, shared by every serverless function.
 *
 * Works with any Postgres that speaks a standard connection string — Vercel
 * Postgres, Neon and Supabase all do — so the deployment is not tied to one
 * vendor. Set POSTGRES_URL (what Vercel's integrations inject) or DATABASE_URL.
 *
 * Use the *pooled* connection string. A serverless function is a fresh process
 * that opens its own socket; at any real concurrency, direct connections
 * exhaust Postgres' connection limit. Neon's `-pooler` host and Supabase's
 * port-6543 pgBouncer endpoint both solve this, and `max: 1` below keeps each
 * instance to a single socket since an invocation only ever runs one query at
 * a time.
 *
 * TLS is left to the connection string on purpose: `sslmode=require` (what
 * these providers hand you) or `sslmode=verify-full` for full certificate
 * verification. Nothing here silently disables certificate checking.
 */
import { createStore } from './store.js'

const CONNECTION =
  process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || ''

export function isConfigured() {
  return Boolean(CONNECTION)
}

let pool = null
let ready = null

async function getPool() {
  if (!pool) {
    const { default: pg } = await import('pg')
    pool = new pg.Pool({
      connectionString: CONNECTION,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
    // A dropped idle socket must not take the whole instance down with it.
    pool.on('error', (err) => console.error('[db] idle client error', err))
  }
  return pool
}

/**
 * Returns a store with the schema in place. The schema work runs once per
 * warm instance; a failure clears the latch so the next request retries
 * instead of the instance staying poisoned until it is recycled.
 */
export async function getStore() {
  const store = createStore(async (text, params) => (await getPool()).query(text, params))
  if (!ready) {
    ready = store.init().catch((err) => {
      ready = null
      throw err
    })
  }
  await ready
  return store
}

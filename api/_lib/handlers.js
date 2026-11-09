/**
 * Endpoint logic for the serverless deployment, kept apart from the HTTP
 * plumbing so each one can be tested directly against a real Postgres.
 *
 * Every handler returns `{ status, body }`; the route files under api/ do
 * nothing but read the request, call one of these, and write the response.
 */
import { SYNC_TABLES, decideRecord, userFromInspector } from '../../server/sync-rules.js'
import { verifyPassword } from '../../server/crypto.js'

/** Photo ids come from the client, so they are checked before use as a key. */
const PHOTO_ID = /^[\w.-]{1,64}$/

export async function handleLogin(store, body) {
  const email = String(body?.email || '')
    .toLowerCase()
    .trim()
  const password = String(body?.password || '')
  const user = await store.userByEmail(email)
  if (!verifyPassword(password, user)) {
    return { status: 401, body: { error: 'invalid-credentials' } }
  }
  return {
    status: 200,
    body: {
      token: await store.issueToken(user.id),
      inspector: { id: user.id, name: user.name, email: user.email, role: user.role },
    },
  }
}

export async function authenticate(store, token) {
  return store.userForToken(token)
}

/**
 * One sync round: apply everything the client pushed, then return everything
 * it has not seen. Identical in behaviour to the on-site server — the decision
 * for each record comes from the shared rules module.
 */
export async function handleSync(store, user, body) {
  const since = Number(body?.since || 0)
  const changes = body?.changes && typeof body.changes === 'object' ? body.changes : {}
  const accepted = {}
  const conflicts = []
  const pushedIds = {}

  for (const [tableName, rows] of Object.entries(changes)) {
    if (!SYNC_TABLES.has(tableName) || !Array.isArray(rows)) continue
    accepted[tableName] = []
    pushedIds[tableName] = new Set()

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (tableName === 'inspectors') {
        const asUser = userFromInspector(row)
        if (asUser) await store.upsertUser(asUser)
      }

      const existing = await store.recordFor(tableName, String(row.id || ''))
      const decision = decideRecord({ tableName, incoming: row, existing, since, actorId: user.id })

      pushedIds[tableName].add(String(row.id))
      if (decision.action === 'write') {
        await store.writeRecord(tableName, decision.row)
        accepted[tableName].push(String(row.id))
      } else if (decision.action === 'conflict') {
        conflicts.push({ table: tableName, id: String(row.id), server: existing.json })
      }
    }
  }

  const out = {}
  for (const record of await store.recordsSince(since)) {
    if (!SYNC_TABLES.has(record.tableName)) continue
    if (pushedIds[record.tableName]?.has(record.id)) continue
    ;(out[record.tableName] ||= []).push(record.json)
  }

  return { status: 200, body: { serverTime: Date.now(), accepted, conflicts, changes: out } }
}

export async function handlePhotoUpload(store, id, body) {
  if (!PHOTO_ID.test(String(id || ''))) return { status: 400, body: { error: 'bad-id' } }
  if (!body?.data) return { status: 400, body: { error: 'missing-data' } }

  const bytes = Buffer.from(String(body.data), 'base64')
  if (bytes.length === 0) return { status: 400, body: { error: 'missing-data' } }

  await store.putPhoto({
    id: String(id),
    entryId: String(body.entryId || ''),
    exerciseId: String(body.exerciseId || ''),
    width: Number(body.width || 0),
    height: Number(body.height || 0),
    createdAt: Number(body.createdAt || Date.now()),
    contentType: String(body.contentType || '').includes('png') ? 'image/png' : 'image/jpeg',
    bytes,
  })
  return { status: 200, body: { url: `/api/photos/${id}` } }
}

export async function handleHealth(store) {
  return { status: 200, body: { ok: true, time: Date.now(), records: await store.recordCounts() } }
}

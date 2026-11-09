/**
 * POST /api/sync — push pending records, pull everything changed since.
 *
 * Note the platform limit: a Vercel function request body is capped at 4.5 MB,
 * where the on-site server allows 16 MB. Records are small JSON, so a normal
 * exercise is far below it, but photos are uploaded one per request for
 * exactly this reason.
 */
import { applyCors, bearerToken, readJson, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { authenticate, handleSync } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const store = await getStore()
  const user = await authenticate(store, bearerToken(req))
  if (!user) return sendJson(res, 401, { error: 'unauthorized' })

  const { status, body } = await handleSync(store, user, await readJson(req))
  sendJson(res, status, body)
})

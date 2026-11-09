/** GET /api/health — liveness plus a per-table record count. */
import { applyCors, bearerToken, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { authenticate, handleHealth } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (!isConfigured()) return sendJson(res, 503, { ok: false, error: 'database-not-configured' })

  // Unauthenticated callers get liveness only; record counts belong to a tenant.
  const store = await getStore()
  const user = await authenticate(store, bearerToken(req))
  const { status, body } = await handleHealth(store, user?.orgId)
  sendJson(res, status, body)
})

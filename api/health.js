/** GET /api/health — liveness plus a per-table record count. */
import { applyCors, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { handleHealth } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (!isConfigured()) return sendJson(res, 503, { ok: false, error: 'database-not-configured' })

  const { status, body } = await handleHealth(await getStore())
  sendJson(res, status, body)
})

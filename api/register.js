/**
 * POST /api/register — create an institution and its first admin.
 *
 * Open to anyone with the address. A new signup gets an empty organization of
 * its own and can read nothing else, so the cost of an unwanted registration
 * is a handful of rows rather than exposure of another school's register.
 */
import { applyCors, readJson, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { handleRegister } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const { status, body } = await handleRegister(await getStore(), await readJson(req))
  sendJson(res, status, body)
})

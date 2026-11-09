/**
 * POST /api/auth — sign in, returns a bearer token.
 *
 * The client calls `/api/login` (the path the on-site server uses, so one
 * build works against both); vercel.json rewrites that to this function.
 */
import { applyCors, readJson, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { handleLogin } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const { status, body } = await handleLogin(await getStore(), await readJson(req))
  sendJson(res, status, body)
})

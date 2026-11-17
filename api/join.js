/**
 * GET  /api/join?token= — whose register the link joins, and in what role.
 * POST /api/join        — create that account and sign straight in.
 *
 * Unauthenticated by necessity: the holder of the link has no account yet.
 * The token is the only thing trusted, and it carries the organization and
 * the role, so neither can be chosen by the person opening the link.
 */
import { applyCors, readJson, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { handleInviteInfo, handleJoin } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const store = await getStore()

  if (req.method === 'GET') {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token')
    const { status, body } = await handleInviteInfo(store, token)
    return sendJson(res, status, body)
  }

  if (req.method === 'POST') {
    const { status, body } = await handleJoin(store, await readJson(req))
    return sendJson(res, status, body)
  }

  sendJson(res, 405, { error: 'method-not-allowed' })
})

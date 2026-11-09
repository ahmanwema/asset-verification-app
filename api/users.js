/**
 * GET  /api/users — the accounts in the caller's institution.
 * POST /api/users — an admin adds a colleague (name, email, password, role).
 *
 * Both are scoped to the caller's organization by the store; no org id is
 * ever read from the request.
 */
import { applyCors, bearerToken, readJson, sendJson, withErrors } from './_lib/http.js'
import { getStore, isConfigured } from './_lib/db.js'
import { authenticate, handleCreateUser, handleListUsers } from './_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const store = await getStore()
  const user = await authenticate(store, bearerToken(req))
  if (!user) return sendJson(res, 401, { error: 'unauthorized' })

  if (req.method === 'GET') {
    const { status, body } = await handleListUsers(store, user)
    return sendJson(res, status, body)
  }

  if (req.method === 'POST') {
    const { status, body } = await handleCreateUser(store, user, await readJson(req))
    return sendJson(res, status, body)
  }

  sendJson(res, 405, { error: 'method-not-allowed' })
})

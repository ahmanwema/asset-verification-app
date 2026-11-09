/**
 * POST /api/vision/identify — the OpenAI vision proxy.
 *
 * The prompt, the request shape and the normalisation of whatever the model
 * returns all live in server/vision.js, shared verbatim with the on-site
 * server. Only the authentication and transport differ here.
 *
 * The key stays server-side: an OPENAI_API_KEY in the browser bundle would be
 * readable by every user of the PWA.
 */
import { applyCors, bearerToken, readJson, sendJson, withErrors } from '../_lib/http.js'
import { getStore, isConfigured } from '../_lib/db.js'
import { authenticate } from '../_lib/handlers.js'
import { handleVisionIdentify } from '../../server/vision.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const user = await authenticate(await getStore(), bearerToken(req))
  if (!user) return sendJson(res, 401, { error: 'unauthorized' })

  const { status, payload } = await handleVisionIdentify(await readJson(req))
  sendJson(res, status, payload)
})

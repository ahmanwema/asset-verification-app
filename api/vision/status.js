/**
 * GET /api/vision/status — whether photo recognition is set up, and on which
 * model. Unauthenticated on purpose: it reveals no key, and the entry form
 * needs it to decide whether to offer "Capture & identify" at all.
 */
import { applyCors, sendJson, withErrors } from '../_lib/http.js'
import { visionStatus } from '../../server/vision.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  sendJson(res, 200, visionStatus())
})

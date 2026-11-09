/**
 * POST /api/photos/:id — upload one inspection photo (base64 in JSON).
 * GET  /api/photos/:id — fetch the bytes back.
 *
 * Images live in Postgres as BYTEA rather than on disk: a serverless function
 * has no durable filesystem, so the on-site server's uploads/ directory has no
 * equivalent here. Photos are ~200 KB after the client's 1280px JPEG
 * compression, which Postgres handles comfortably at exercise scale. If an
 * estate grows past a few gigabytes of images, move this one table to object
 * storage (Vercel Blob or S3) and keep the row as a pointer — nothing else in
 * the app reads the bytes directly.
 */
import { applyCors, bearerToken, readJson, sendBytes, sendJson, withErrors } from '../_lib/http.js'
import { getStore, isConfigured } from '../_lib/db.js'
import { authenticate, handlePhotoUpload } from '../_lib/handlers.js'

export default withErrors(async (req, res) => {
  if (applyCors(req, res)) return
  if (!isConfigured()) return sendJson(res, 503, { error: 'database-not-configured' })

  const id = String(req.query?.id ?? '')
  const store = await getStore()

  if (req.method === 'POST') {
    const user = await authenticate(store, bearerToken(req))
    if (!user) return sendJson(res, 401, { error: 'unauthorized' })

    const { status, body } = await handlePhotoUpload(store, user.orgId, id, await readJson(req))
    return sendJson(res, status, body)
  }

  if (req.method === 'GET') {
    // Downloads need a token too, now that one database holds several
    // institutions: a random id is not an access control.
    const user = await authenticate(store, bearerToken(req))
    if (!user) return sendJson(res, 401, { error: 'unauthorized' })

    const photo = await store.getPhoto(user.orgId, id)
    if (!photo) return sendJson(res, 404, { error: 'not-found' })
    // Immutable: a photo id is minted per capture and its bytes never change.
    return sendBytes(res, 200, photo.contentType, photo.bytes, 'public, max-age=604800, immutable')
  }

  sendJson(res, 405, { error: 'method-not-allowed' })
})

/**
 * Request/response helpers for the Vercel serverless functions.
 *
 * Files under api/ whose name starts with `_` are not routed, so this is a
 * shared module rather than an endpoint.
 */

/**
 * Vercel parses a JSON body for us when the Content-Type says so, but not in
 * every runtime version and not for `vercel dev` in all cases, so both paths
 * are handled. An unparseable body is an empty object: every handler validates
 * its own input anyway, and a 400 from the handler is clearer than a 500 here.
 */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}')
    } catch {
      return {}
    }
  }
  const raw = await readRaw(req)
  try {
    return JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    return {}
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Vercel's Node runtime adds Express-style `res.status().send()`. The fallback
 * keeps these routes runnable on a plain node:http server, which is how the
 * test suite drives them end to end without the Vercel runtime.
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(status)
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.send(body)
    return
  }
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/** Same fallback, for the one endpoint that returns bytes instead of JSON. */
export function sendBytes(res, status, contentType, bytes, cacheControl = 'no-store') {
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl }
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(status)
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.send(bytes)
    return
  }
  res.writeHead(status, { ...headers, 'Content-Length': bytes.length })
  res.end(bytes)
}

/**
 * The PWA is served from the same origin on Vercel, so CORS is not needed for
 * the normal case. It stays open because a team may keep using the on-site
 * laptop build while pointing some devices at the hosted API (Setup → Sync
 * lets each device set its own server URL).
 */
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') {
    if (typeof res.status === 'function') res.status(204).end()
    else {
      res.writeHead(204)
      res.end()
    }
    return true
  }
  return false
}

export function bearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/** Wraps a handler so an unexpected throw becomes a 500 rather than a hang. */
export function withErrors(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      console.error('[api]', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'server-error' })
      else res.end()
    }
  }
}

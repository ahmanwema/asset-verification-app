/**
 * Sync server for the Asset Verification & Tagging PWA.
 *
 * Deliberately dependency-free: Node's built-in HTTP server and node:sqlite
 * only, so an inspection team can run it from a laptop on the site LAN with
 * nothing but Node installed. It also serves the built PWA from dist/ when
 * present, so one process covers the whole exercise.
 *
 * This is one of two deployments. The other is Vercel (`api/`, Postgres), and
 * both import the same rules from ./sync-rules.js, ./crypto.js and
 * ./vision.js — only the storage differs.
 *
 * Storage model: every syncable table lands in one `records` table keyed by
 * (table_name, id) with the client JSON kept verbatim. That keeps the server
 * schema-agnostic — adding a field to the client needs no migration here.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { handleVisionIdentify, visionStatus } from './vision.js'
import { SYNC_TABLES, TOKEN_TTL_MS, decideRecord, userFromInspector } from './sync-rules.js'
import { newUserId, scryptHash, sha256, verifyPassword } from './crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// Overridable so tests (and multiple exercises on one machine) can keep their
// own database and photo store.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data')
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads')
const DIST_DIR = path.join(ROOT, 'dist')

// Reads .env without a dotenv dependency (Node 20.12+/21+). Real environment
// variables already set always win.
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env file — fine, the sync server works without one */
}

const PORT = Number(process.env.PORT || 4000)
const MAX_BODY = 16 * 1024 * 1024

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const db = new DatabaseSync(path.join(DATA_DIR, 'assets.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (
    table_name   TEXT NOT NULL,
    id           TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    inspector_id TEXT,
    deleted      INTEGER NOT NULL DEFAULT 0,
    json         TEXT NOT NULL,
    PRIMARY KEY (table_name, id)
  );
  CREATE INDEX IF NOT EXISTS records_updated ON records (updated_at);
  CREATE TABLE IF NOT EXISTS users (
    id      TEXT PRIMARY KEY,
    email   TEXT UNIQUE NOT NULL,
    name    TEXT NOT NULL,
    role    TEXT NOT NULL DEFAULT 'inspector',
    scrypt  TEXT,
    sha256  TEXT
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id          TEXT PRIMARY KEY,
    entry_id    TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    created_at  INTEGER,
    file        TEXT NOT NULL
  );
`)

// ---------------------------------------------------------------- auth ------

function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@sufa.ac.tz').toLowerCase()
  const password = process.env.ADMIN_PASSWORD || 'verify123'
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) return
  db.prepare('INSERT INTO users (id, email, name, role, scrypt, sha256) VALUES (?, ?, ?, ?, ?, ?)').run(
    newUserId(),
    email,
    process.env.ADMIN_NAME || 'Admin',
    'admin',
    scryptHash(password),
    sha256(password),
  )
  console.log(`[auth] seeded admin ${email}`)
}
seedAdmin()

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now())
  db.prepare('DELETE FROM tokens WHERE created_at < ?').run(Date.now() - TOKEN_TTL_MS)
  return token
}

function userForRequest(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const row = db
    .prepare(
      'SELECT u.id, u.email, u.name, u.role, t.created_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?',
    )
    .get(token)
  if (!row) return null
  if (Date.now() - Number(row.created_at) > TOKEN_TTL_MS) {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(token)
    return null
  }
  return row
}

/** Registers a field-created account so it can sign in to this server too. */
function upsertUserFromInspector(inspector) {
  const user = userFromInspector(inspector)
  if (!user) return
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(user.email)
  if (existing) {
    db.prepare('UPDATE users SET name = ?, role = ?, sha256 = COALESCE(?, sha256) WHERE id = ?').run(
      user.name,
      user.role,
      user.sha256,
      existing.id,
    )
    return
  }
  db.prepare('INSERT INTO users (id, email, name, role, scrypt, sha256) VALUES (?, ?, ?, ?, NULL, ?)').run(
    user.id || newUserId(),
    user.email,
    user.name,
    user.role,
    user.sha256,
  )
}

// ---------------------------------------------------------------- sync ------

function recordOf(row) {
  return JSON.parse(row.json)
}

/** Applies one client record; the decision itself lives in sync-rules.js. */
function applyRecord(tableName, incoming, since, actorId) {
  const existingRow = db
    .prepare('SELECT updated_at, inspector_id, json FROM records WHERE table_name = ? AND id = ?')
    .get(tableName, String(incoming?.id || ''))
  const existing = existingRow
    ? { updatedAt: Number(existingRow.updated_at || 0), inspectorId: existingRow.inspector_id }
    : null

  const decision = decideRecord({ tableName, incoming, existing, since, actorId })
  if (decision.action === 'reject') return { status: 'rejected' }
  if (decision.action === 'conflict') return { status: 'conflict', server: recordOf(existingRow) }

  const { row } = decision
  db.prepare(
    `INSERT INTO records (table_name, id, updated_at, inspector_id, deleted, json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(table_name, id) DO UPDATE SET
       updated_at = excluded.updated_at,
       inspector_id = excluded.inspector_id,
       deleted = excluded.deleted,
       json = excluded.json`,
  ).run(tableName, row.id, row.updatedAt, row.inspectorId, row.deleted ? 1 : 0, JSON.stringify(row.json))
  return { status: 'accepted' }
}

function handleSync(user, body) {
  const since = Number(body.since || 0)
  const changes = body.changes && typeof body.changes === 'object' ? body.changes : {}
  const accepted = {}
  const conflicts = []
  const pushedIds = {}

  for (const [tableName, rows] of Object.entries(changes)) {
    if (!SYNC_TABLES.has(tableName) || !Array.isArray(rows)) continue
    accepted[tableName] = []
    pushedIds[tableName] = new Set()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (tableName === 'inspectors') upsertUserFromInspector(row)
      const result = applyRecord(tableName, row, since, user.id)
      pushedIds[tableName].add(String(row.id))
      if (result.status === 'accepted') accepted[tableName].push(String(row.id))
      else if (result.status === 'conflict') {
        conflicts.push({ table: tableName, id: String(row.id), server: result.server })
      }
    }
  }

  // Everything the client has not seen yet, minus what it just sent us.
  const out = {}
  const rows = db.prepare('SELECT * FROM records WHERE updated_at > ? ORDER BY updated_at ASC').all(since)
  for (const row of rows) {
    if (!SYNC_TABLES.has(row.table_name)) continue
    if (pushedIds[row.table_name]?.has(row.id)) continue
    ;(out[row.table_name] ||= []).push(recordOf(row))
  }

  return { serverTime: Date.now(), accepted, conflicts, changes: out }
}

// ------------------------------------------------------------- plumbing -----

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('payload-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST_DIR)) {
    sendJson(res, 404, { error: 'not-found', hint: 'Run `npm run build` to serve the app from this server.' })
    return
  }
  const unsafe = decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = path.resolve(DIST_DIR, unsafe)
  // Containment check: never serve outside dist/.
  const candidate = target.startsWith(DIST_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()
    ? target
    : path.join(DIST_DIR, 'index.html')
  const ext = path.extname(candidate).toLowerCase()
  const immutable = candidate.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(candidate).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    if (pathname === '/api/health') {
      const counts = db.prepare('SELECT table_name, COUNT(*) n FROM records GROUP BY table_name').all()
      sendJson(res, 200, { ok: true, time: Date.now(), records: counts })
      return
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const email = String(body.email || '').toLowerCase().trim()
      const password = String(body.password || '')
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
      if (!verifyPassword(password, user)) {
        sendJson(res, 401, { error: 'invalid-credentials' })
        return
      }
      sendJson(res, 200, {
        token: issueToken(user.id),
        inspector: { id: user.id, name: user.name, email: user.email, role: user.role },
      })
      return
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      const user = userForRequest(req)
      if (!user) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      sendJson(res, 200, handleSync(user, body))
      return
    }

    const photoMatch = /^\/api\/photos\/([\w.-]+)$/.exec(pathname)
    if (photoMatch && req.method === 'POST') {
      const user = userForRequest(req)
      if (!user) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      const id = photoMatch[1]
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      if (!body.data) {
        sendJson(res, 400, { error: 'missing-data' })
        return
      }
      const ext = String(body.contentType || '').includes('png') ? '.png' : '.jpg'
      const file = `${id}${ext}`
      fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(String(body.data), 'base64'))
      db.prepare(
        `INSERT INTO photos (id, entry_id, exercise_id, width, height, created_at, file)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET file = excluded.file`,
      ).run(
        id,
        String(body.entryId || ''),
        String(body.exerciseId || ''),
        Number(body.width || 0),
        Number(body.height || 0),
        Number(body.createdAt || Date.now()),
        file,
      )
      sendJson(res, 200, { url: `/api/photos/${id}` })
      return
    }

    if (photoMatch && req.method === 'GET') {
      const row = db.prepare('SELECT file FROM photos WHERE id = ?').get(photoMatch[1])
      const file = row ? path.join(UPLOAD_DIR, row.file) : null
      if (!file || !fs.existsSync(file)) {
        sendJson(res, 404, { error: 'not-found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'public, max-age=604800',
      })
      fs.createReadStream(file).pipe(res)
      return
    }

    if (pathname === '/api/vision/status') {
      sendJson(res, 200, visionStatus())
      return
    }

    if (pathname === '/api/vision/identify' && req.method === 'POST') {
      const user = userForRequest(req)
      if (!user) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const { status, payload } = await handleVisionIdentify(body)
      sendJson(res, status, payload)
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'unknown-endpoint' })
      return
    }

    serveStatic(req, res, pathname)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'server-error'
    const status = message === 'payload-too-large' ? 413 : 500
    if (status === 500) console.error('[error]', err)
    if (!res.headersSent) sendJson(res, status, { error: message })
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`[server] sync API on http://localhost:${PORT}/api`)
  console.log(`[server] data: ${DATA_DIR}`)
  const vision = visionStatus()
  console.log(
    vision.configured
      ? `[vision] photo recognition enabled (${vision.model})`
      : '[vision] disabled — set OPENAI_API_KEY in .env to enable photo recognition',
  )
  if (fs.existsSync(DIST_DIR)) console.log(`[server] serving PWA from ${DIST_DIR}`)
  else console.log('[server] dist/ not built yet — run `npm run build` to serve the app from here')
})

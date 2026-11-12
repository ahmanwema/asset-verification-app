/**
 * Storage-agnostic sync rules.
 *
 * Shared by the two deployments: the on-site SQLite server (`server/index.js`,
 * run from a laptop on the school LAN) and the Vercel serverless functions
 * (`api/`, backed by Postgres). The SQL differs between them; the rules that
 * decide whether a push is accepted must not, because a disagreement there
 * means two inspectors' work resolving differently depending on where the
 * exercise happens to be hosted.
 *
 * Nothing in here touches a database or the network: it takes the server's
 * current view of a record and the incoming one, and returns a decision.
 */

/** Tables the client is allowed to push. Anything else is ignored. */
export const SYNC_TABLES = new Set([
  'organizations',
  'inspectors',
  'exercises',
  'blocks',
  'floors',
  'rooms',
  'assetTypes',
  'entries',
  'signoffs',
])

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Decides what to do with one incoming record.
 *
 * Conflict rule: a record is a conflict when the server copy was last written
 * by a *different* inspector and changed *after* the client's last sync — i.e.
 * the client is about to overwrite an edit it never saw. Everything else is
 * last-write-wins, with a stale push (older than the server copy) also
 * refused so a device that has been offline for a week cannot silently undo
 * newer work.
 *
 * The different-author test applies to `entries` only. The setup tables
 * (floors, rooms, the asset catalog) are edited by admins from one device, and
 * flagging those as conflicts would stop an exercise over a renamed room.
 *
 * @param {object}  args
 * @param {string}  args.tableName
 * @param {object}  args.incoming   the record the client pushed
 * @param {{updatedAt: number, inspectorId: string|null}|null} args.existing
 *        the server's current copy, or null when this id is new
 * @param {number}  args.since      the client's last-sync timestamp
 * @param {string}  args.actorId    the authenticated user, used when the
 *                                  record carries no inspectorId of its own
 * @returns {{action: 'write', row: object} | {action: 'conflict'} | {action: 'reject'}}
 */
export function decideRecord({ tableName, incoming, existing, since, actorId }) {
  if (!incoming || typeof incoming !== 'object') return { action: 'reject' }
  const id = String(incoming.id || '')
  if (!id) return { action: 'reject' }

  const updatedAt = Number(incoming.updatedAt || 0)
  const inspectorId = incoming.inspectorId || actorId || null
  const row = { id, updatedAt, inspectorId, deleted: Boolean(incoming.deleted), json: incoming }

  if (!existing) return { action: 'write', row }

  const serverUpdated = Number(existing.updatedAt || 0)
  const differentAuthor =
    tableName === 'entries' &&
    Boolean(existing.inspectorId) &&
    Boolean(inspectorId) &&
    existing.inspectorId !== inspectorId

  if (differentAuthor && serverUpdated > Number(since || 0)) return { action: 'conflict' }
  if (updatedAt < serverUpdated) return { action: 'conflict' }

  return { action: 'write', row }
}

/**
 * Normalises an inspector record pushed from a field device into the server's
 * user row. Accounts are created offline in the app's Setup screen and arrive
 * here on the first sync, carrying the SHA-256 unlock hash the client stores,
 * so the same credentials work against the server.
 *
 * @returns {{email: string, name: string, role: string, sha256: string|null, id: string|null}|null}
 */
export function userFromInspector(inspector) {
  if (!inspector?.email) return null
  const email = String(inspector.email).toLowerCase()
  return {
    id: inspector.id || null,
    email,
    name: inspector.name || email,
    role: inspector.role === 'admin' ? 'admin' : 'inspector',
    sha256: inspector.passwordHash || null,
  }
}

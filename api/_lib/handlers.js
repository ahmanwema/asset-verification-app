/**
 * Endpoint logic for the serverless deployment, kept apart from the HTTP
 * plumbing so each one can be tested directly against a real Postgres.
 *
 * Every handler returns `{ status, body }`; the route files under api/ do
 * nothing but read the request, call one of these, and write the response.
 *
 * TENANCY. Handlers that touch stored data take the organization from the
 * authenticated user and pass it to the store. No handler reads an org id
 * from the request body — that is the whole defence against one institution
 * reading or overwriting another's register.
 */
import { SYNC_TABLES, decideRecord, roleCanWrite, userFromInspector } from '../../server/sync-rules.js'
import { newId, newToken, newUserId, sha256, verifyPassword } from '../../server/crypto.js'

/** Photo ids come from the client, so they are checked before use as a key. */
const PHOTO_ID = /^[\w.-]{1,64}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8

/**
 * Roles an invite may hand out. `admin` is deliberately absent: a link that
 * anyone could forward should never be able to create an account that can
 * change the register's structure or read out its finances.
 */
const INVITABLE_ROLES = new Set(['viewer', 'inspector'])
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_INVITE_DAYS = 180
const MAX_INVITE_USES = 500

export async function handleLogin(store, body) {
  const email = String(body?.email || '')
    .toLowerCase()
    .trim()
  const password = String(body?.password || '')
  const user = await store.userByEmail(email)
  if (!verifyPassword(password, user)) {
    return { status: 401, body: { error: 'invalid-credentials' } }
  }
  const org = await store.orgById(user.orgId)
  return {
    status: 200,
    body: {
      token: await store.issueToken(user.id),
      inspector: { id: user.id, name: user.name, email: user.email, role: user.role },
      organization: org,
    },
  }
}

/**
 * Registers an institution and its first admin in one step — the entry point
 * for someone opening the link for the first time.
 *
 * Deliberately open: anyone with the address can create an organization. They
 * get an empty one of their own and can see nothing else, so the cost of an
 * unwanted signup is a few rows rather than a data leak.
 */
export async function handleRegister(store, body) {
  const orgName = String(body?.orgName || '').trim()
  const address = String(body?.address || '').trim()
  const name = String(body?.name || '').trim()
  const email = String(body?.email || '')
    .toLowerCase()
    .trim()
  const password = String(body?.password || '')

  if (!orgName) return { status: 400, body: { error: 'org-name-required' } }
  if (!name) return { status: 400, body: { error: 'name-required' } }
  if (!EMAIL.test(email)) return { status: 400, body: { error: 'email-invalid' } }
  if (password.length < MIN_PASSWORD) return { status: 400, body: { error: 'password-too-short' } }

  if (await store.userByEmail(email)) {
    return { status: 409, body: { error: 'email-taken' } }
  }

  const orgId = newId('org_')
  const userId = newUserId()
  const now = Date.now()

  const org = await store.createOrgWithAdmin({ orgId, orgName, address, userId, name, email, password })

  // Seed the tenant's own data so the app is usable the moment they sign in:
  // the organization, a first exercise, and the admin as an inspector. These
  // go in as ordinary records, so they reach every device through normal sync.
  await store.writeRecord(orgId, 'organizations', {
    id: orgId,
    updatedAt: now,
    inspectorId: null,
    deleted: false,
    json: { id: orgId, name: orgName, address, updatedAt: now, syncStatus: 'synced' },
  })

  const exerciseId = newId('ex_')
  await store.writeRecord(orgId, 'exercises', {
    id: exerciseId,
    updatedAt: now,
    inspectorId: userId,
    deleted: false,
    json: {
      id: exerciseId,
      orgId,
      name: `Asset Verification ${new Date(now).getFullYear()}`,
      date: new Date(now).toISOString().slice(0, 10),
      status: 'active',
      approvedBy: '',
      teamLeaderId: userId,
      updatedAt: now,
      syncStatus: 'synced',
    },
  })

  await store.writeRecord(orgId, 'inspectors', {
    id: userId,
    updatedAt: now,
    inspectorId: userId,
    deleted: false,
    json: {
      id: userId,
      name,
      email,
      role: 'admin',
      active: true,
      passwordHash: sha256(password),
      updatedAt: now,
      syncStatus: 'synced',
    },
  })

  return {
    status: 201,
    body: {
      token: await store.issueToken(userId),
      inspector: { id: userId, name, email, role: 'admin' },
      organization: org,
      exerciseId,
    },
  }
}

/** Admins add their colleagues; the account works on every device at once. */
export async function handleCreateUser(store, actor, body) {
  if (actor.role !== 'admin') return { status: 403, body: { error: 'admin-only' } }

  const name = String(body?.name || '').trim()
  const email = String(body?.email || '')
    .toLowerCase()
    .trim()
  const password = String(body?.password || '')
  const role = body?.role === 'admin' || body?.role === 'viewer' ? body.role : 'inspector'

  if (!name) return { status: 400, body: { error: 'name-required' } }
  if (!EMAIL.test(email)) return { status: 400, body: { error: 'email-invalid' } }
  if (password.length < MIN_PASSWORD) return { status: 400, body: { error: 'password-too-short' } }
  if (await store.userByEmail(email)) return { status: 409, body: { error: 'email-taken' } }

  const id = newUserId()
  const now = Date.now()
  const user = await store.createUser({ orgId: actor.orgId, id, name, email, role, password })

  // Mirrored as an inspector record so the account reaches the team's devices
  // and can be used to sign in with no signal.
  await store.writeRecord(actor.orgId, 'inspectors', {
    id,
    updatedAt: now,
    inspectorId: actor.id,
    deleted: false,
    json: {
      id,
      name,
      email,
      role,
      active: true,
      passwordHash: sha256(password),
      updatedAt: now,
      syncStatus: 'synced',
    },
  })

  return { status: 201, body: { user } }
}

export async function handleListUsers(store, actor) {
  return { status: 200, body: { users: await store.usersInOrg(actor.orgId) } }
}

// --------------------------------------------------------------- invites ---

/**
 * An admin mints a link their colleagues can open to create their own account
 * inside this institution. The role is fixed when the link is made, so the
 * person opening it cannot award themselves anything else.
 */
export async function handleCreateInvite(store, actor, body) {
  if (actor.role !== 'admin') return { status: 403, body: { error: 'admin-only' } }

  const role = INVITABLE_ROLES.has(body?.role) ? body.role : 'viewer'
  const label = String(body?.label || '').trim().slice(0, 80)

  const days = Number(body?.expiresInDays ?? 14)
  if (!Number.isFinite(days) || days <= 0 || days > MAX_INVITE_DAYS) {
    return { status: 400, body: { error: 'expiry-invalid' } }
  }

  // Absent means unlimited; a number must be a sane one.
  let maxUses = null
  if (body?.maxUses !== undefined && body?.maxUses !== null && body?.maxUses !== '') {
    maxUses = Number(body.maxUses)
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_INVITE_USES) {
      return { status: 400, body: { error: 'max-uses-invalid' } }
    }
  }

  const invite = await store.createInvite({
    token: newToken(),
    orgId: actor.orgId,
    role,
    label,
    createdBy: actor.id,
    expiresAt: Date.now() + days * DAY_MS,
    maxUses,
  })
  return { status: 201, body: { invite } }
}

export async function handleListInvites(store, actor) {
  if (actor.role !== 'admin') return { status: 403, body: { error: 'admin-only' } }
  return { status: 200, body: { invites: await store.invitesInOrg(actor.orgId) } }
}

export async function handleRevokeInvite(store, actor, token) {
  if (actor.role !== 'admin') return { status: 403, body: { error: 'admin-only' } }
  const revoked = await store.revokeInvite(actor.orgId, String(token || ''))
  return revoked ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'invite-not-found' } }
}

/** Why an invite cannot be used, or null when it can. */
function inviteProblem(invite, now = Date.now()) {
  if (!invite) return 'invite-not-found'
  if (invite.revoked) return 'invite-revoked'
  if (invite.expiresAt !== null && invite.expiresAt <= now) return 'invite-expired'
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return 'invite-used-up'
  return null
}

/**
 * Open with the link alone: the page needs to show whose register is being
 * joined, and in what capacity, before anyone types a password. Only the
 * institution name and the role are returned — never its data.
 */
export async function handleInviteInfo(store, token) {
  const invite = await store.inviteByToken(String(token || ''))
  const problem = inviteProblem(invite)
  if (problem) return { status: problem === 'invite-not-found' ? 404 : 410, body: { error: problem } }
  return {
    status: 200,
    body: { organization: { id: invite.orgId, name: invite.orgName }, role: invite.role },
  }
}

/**
 * Creates an account from an invite link and signs it straight in, so the
 * person is never left holding credentials they have to type again.
 */
export async function handleJoin(store, body) {
  const token = String(body?.token || '')
  const name = String(body?.name || '').trim()
  const email = String(body?.email || '')
    .toLowerCase()
    .trim()
  const password = String(body?.password || '')

  const invite = await store.inviteByToken(token)
  const problem = inviteProblem(invite)
  if (problem) return { status: problem === 'invite-not-found' ? 404 : 410, body: { error: problem } }

  if (!name) return { status: 400, body: { error: 'name-required' } }
  if (!EMAIL.test(email)) return { status: 400, body: { error: 'email-invalid' } }
  if (password.length < MIN_PASSWORD) return { status: 400, body: { error: 'password-too-short' } }
  if (await store.userByEmail(email)) return { status: 409, body: { error: 'email-taken' } }

  // Claim the place before creating the account, so a revoked or exhausted
  // invite cannot be raced into one more user than it was good for.
  if (!(await store.consumeInvite(token))) {
    return { status: 410, body: { error: 'invite-used-up' } }
  }

  const id = newUserId()
  const now = Date.now()
  await store.createUser({ orgId: invite.orgId, id, name, email, role: invite.role, password })

  await store.writeRecord(invite.orgId, 'inspectors', {
    id,
    updatedAt: now,
    inspectorId: id,
    deleted: false,
    json: {
      id,
      name,
      email,
      role: invite.role,
      active: true,
      passwordHash: sha256(password),
      updatedAt: now,
      syncStatus: 'synced',
    },
  })

  const org = await store.orgById(invite.orgId)
  return {
    status: 201,
    body: {
      token: await store.issueToken(id),
      inspector: { id, name, email, role: invite.role },
      organization: org,
    },
  }
}

export async function authenticate(store, token) {
  return store.userForToken(token)
}

/**
 * A record is stored under the authenticated tenant at the SQL layer, but its
 * own relationship fields must agree too. Older clients could accidentally
 * push a cached Loyola exercise while authenticated as Sufa; without this
 * check that foreign JSON would still live inside Sufa's partition.
 */
async function recordBelongsToOrganization(
  store,
  orgId,
  tableName,
  row,
  invalidExerciseIds = new Set(),
  exerciseCache = null,
) {
  if (!row || typeof row !== 'object') return false
  if (tableName === 'organizations') return String(row.id || '') === orgId
  if (tableName === 'exercises' || tableName === 'assetTypes') return String(row.orgId || '') === orgId
  if (tableName === 'inspectors') {
    const member = await store.userByEmail(String(row.email || '').toLowerCase())
    return Boolean(member && member.orgId === orgId)
  }

  const exerciseId = String(row.exerciseId || '')
  if (!exerciseId || invalidExerciseIds.has(exerciseId)) return false
  // A push is hundreds of rows of one exercise, so looking it up per row is
  // hundreds of needless round trips against the thirty-second function
  // budget - the very budget a large backlog was already overrunning.
  let exercise
  if (exerciseCache?.has(exerciseId)) {
    exercise = exerciseCache.get(exerciseId)
  } else {
    exercise = await store.recordFor(orgId, 'exercises', exerciseId)
    exerciseCache?.set(exerciseId, exercise)
  }
  // Legacy/on-site imports can contain child rows without a mirrored exercise.
  // They are retained for compatibility; a known parent must always match.
  return !exercise || String(exercise.json?.orgId || '') === orgId
}

/**
 * One sync round: apply everything the client pushed, then return everything
 * it has not seen. Identical in behaviour to the on-site server — the decision
 * for each record comes from the shared rules module.
 */
export async function handleSync(store, user, body) {
  const orgId = user.orgId
  const since = Number(body?.since || 0)
  // A read-only account is read-only here, not merely in its own interface.
  // Anything it pushes is dropped; it still receives the full changeset.
  const changes = roleCanWrite(user.role) && body?.changes && typeof body.changes === 'object' ? body.changes : {}
  const accepted = {}
  const conflicts = []
  const pushedIds = {}
  /** Exercise rows looked up while serving this one request. */
  const exerciseCache = new Map()
  const invalidExerciseIds = new Set(
    (Array.isArray(changes.exercises) ? changes.exercises : [])
      .filter((row) => row && typeof row === 'object' && String(row.orgId || '') !== orgId)
      .map((row) => String(row.id || '')),
  )

  for (const [tableName, rows] of Object.entries(changes)) {
    if (!SYNC_TABLES.has(tableName) || !Array.isArray(rows)) continue
    accepted[tableName] = []
    pushedIds[tableName] = new Set()

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (tableName === 'inspectors') {
        const asUser = userFromInspector(row)
        // Accounts are created and re-roled by admins only. Anyone else's push
        // can still refresh their own name and offline password hash, but it
        // carries their existing role, so no one can promote themselves by
        // editing an inspector record on their own device.
        if (asUser) {
          if (user.role === 'admin') await store.upsertUser(orgId, asUser)
          else if (asUser.email === user.email) await store.upsertUser(orgId, { ...asUser, role: user.role })
        }
      }

      if (!(await recordBelongsToOrganization(store, orgId, tableName, row, invalidExerciseIds, exerciseCache)))
        continue

      const existing = await store.recordFor(orgId, tableName, String(row.id || ''))
      const decision = decideRecord({ tableName, incoming: row, existing, since, actorId: user.id })

      pushedIds[tableName].add(String(row.id))
      if (decision.action === 'write') {
        await store.writeRecord(orgId, tableName, decision.row)
        // An exercise created in this same request must be visible to the
        // rows that hang off it, not read as missing from a stale cache.
        if (tableName === 'exercises') exerciseCache.set(String(row.id), decision.row)
        accepted[tableName].push(String(row.id))
      } else if (decision.action === 'conflict') {
        conflicts.push({ table: tableName, id: String(row.id), server: existing.json })
      }
    }
  }

  // A client with a large backlog splits its push across several requests and
  // asks for the changeset only on the last one, rather than dragging the
  // whole of it down the wire once per batch. Absent flag means pull, so an
  // older client keeps its single-request behaviour.
  const out = {}
  if (body?.pull !== false) {
    for (const record of await store.recordsSince(orgId, since)) {
      if (!SYNC_TABLES.has(record.tableName)) continue
      if (pushedIds[record.tableName]?.has(record.id)) continue
      if (!(await recordBelongsToOrganization(store, orgId, record.tableName, record.json, undefined, exerciseCache)))
        continue
      ;(out[record.tableName] ||= []).push(record.json)
    }
  }

  const response = { serverTime: Date.now(), accepted, conflicts, changes: out }
  // Told plainly, rather than left to infer it from an empty `accepted`, so a
  // read-only client can stop pushing instead of retrying for ever.
  if (!roleCanWrite(user.role)) response.readOnly = true
  return { status: 200, body: response }
}

export async function handlePhotoUpload(store, orgId, id, body) {
  if (!PHOTO_ID.test(String(id || ''))) return { status: 400, body: { error: 'bad-id' } }
  if (!body?.data) return { status: 400, body: { error: 'missing-data' } }

  const bytes = Buffer.from(String(body.data), 'base64')
  if (bytes.length === 0) return { status: 400, body: { error: 'missing-data' } }

  await store.putPhoto(orgId, {
    id: String(id),
    entryId: String(body.entryId || ''),
    exerciseId: String(body.exerciseId || ''),
    width: Number(body.width || 0),
    height: Number(body.height || 0),
    createdAt: Number(body.createdAt || Date.now()),
    contentType: String(body.contentType || '').includes('png') ? 'image/png' : 'image/jpeg',
    bytes,
  })
  return { status: 200, body: { url: `/api/photos/${id}` } }
}

export async function handleHealth(store, orgId) {
  const body = { ok: true, time: Date.now() }
  if (orgId) body.records = await store.recordCounts(orgId)
  return { status: 200, body }
}

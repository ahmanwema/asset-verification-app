import { db, getMeta, setMeta } from '../db/db'
import { SEED_DISABLED_KEY } from '../db/seed'
import { bytesToBase64 } from './photos'
import type { InspectionEntry, Role } from '../types'

export const SYNC_TABLES = [
  'organizations',
  'inspectors',
  'exercises',
  'blocks',
  'floors',
  'rooms',
  'assetTypes',
  'entries',
  'signoffs',
] as const

export type SyncTable = (typeof SYNC_TABLES)[number]

type AnyRecord = { id: string; updatedAt: number; syncStatus: string; [k: string]: unknown }

export interface SyncResult {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  photosUploaded: number
  error?: string
}

export interface SyncState {
  serverUrl: string
  token: string | null
  lastSyncAt: number
  pendingRecords: number
  pendingPhotos: number
  conflicts: number
}

const DEFAULT_SERVER = '/api'

export async function getServerUrl(): Promise<string> {
  return (await getMeta<string>('syncServerUrl', DEFAULT_SERVER)) || DEFAULT_SERVER
}

export async function setServerUrl(url: string): Promise<void> {
  await setMeta('syncServerUrl', url.trim().replace(/\/$/, '') || DEFAULT_SERVER)
}

export async function getToken(): Promise<string | null> {
  return getMeta<string | null>('syncToken', null)
}

function tableFor(name: SyncTable) {
  return db[name] as unknown as {
    where: (i: string) => { equals: (v: string) => { toArray: () => Promise<AnyRecord[]>; count: () => Promise<number> } }
    get: (id: string) => Promise<AnyRecord | undefined>
    put: (rec: AnyRecord) => Promise<unknown>
  }
}

/** Records waiting to go up, per table. Photos are counted separately. */
export async function loadSyncState(): Promise<SyncState> {
  const [serverUrl, token, lastSyncAt] = await Promise.all([
    getServerUrl(),
    getToken(),
    getMeta<number>('lastSyncAt', 0),
  ])
  let pendingRecords = 0
  for (const t of SYNC_TABLES) {
    pendingRecords += await tableFor(t).where('syncStatus').equals('pending').count()
  }
  const pendingPhotos = await db.photos.where('syncStatus').equals('pending').count()
  const conflicts = await db.entries.where('syncStatus').equals('conflict').count()
  return { serverUrl, token, lastSyncAt, pendingRecords, pendingPhotos, conflicts }
}

/** Number of rooms with at least one unsynced record — what the badge shows. */
export async function pendingRoomCount(exerciseId: string): Promise<number> {
  const [entries, signoffs] = await Promise.all([
    db.entries.where('exerciseId').equals(exerciseId).toArray(),
    db.signoffs.where('exerciseId').equals(exerciseId).toArray(),
  ])
  const rooms = new Set<string>()
  for (const e of entries) if (e.syncStatus === 'pending') rooms.add(e.roomId)
  for (const s of signoffs) if (s.syncStatus === 'pending') rooms.add(s.roomId)
  return rooms.size
}

export interface ServerAccount {
  id: string
  name: string
  email: string
  role: Role
  organization?: { id: string; name: string; address?: string }
}

export const ACTIVE_ORG_KEY = 'activeOrgId'

/**
 * Switching tenants while this device has unuploaded work would either lose
 * that work or send it to the wrong institution. Stop and let the user sign
 * back into the old tenant first instead of making either mistake.
 */
export class TenantSwitchPendingError extends Error {
  constructor() {
    super('tenant-switch-pending')
    this.name = 'TenantSwitchPendingError'
  }
}

async function inferLocalOrgId(): Promise<string | null> {
  const remembered = await getMeta<string | null>(ACTIVE_ORG_KEY, null)
  if (remembered) return remembered

  const activeExerciseId = await getMeta<string | null>('activeExerciseId', null)
  const activeExercise = activeExerciseId ? await db.exercises.get(activeExerciseId) : undefined
  if (activeExercise?.orgId) return activeExercise.orgId

  const organizations = await db.organizations.toArray()
  return organizations.length === 1 ? organizations[0].id : null
}

async function pendingLocalWork(): Promise<number> {
  let count = await db.photos.where('syncStatus').equals('pending').count()
  for (const table of SYNC_TABLES) {
    count += await tableFor(table).where('syncStatus').equals('pending').count()
  }
  return count
}

/**
 * A new installation is populated with a sample school so the interface can
 * be explored before an account is connected. Those seed rows are marked
 * pending, but they are not user work and must not block the first real login.
 *
 * Be deliberately strict here: any entry, photo, sign-off, added/deleted row,
 * or edited seed row makes this return false so actual offline work remains
 * protected by TenantSwitchPendingError.
 */
async function isUntouchedSampleCache(): Promise<boolean> {
  const seededAt = await getMeta<number | null>('seededAt', null)
  if (!seededAt) return false

  const [organizations, inspectors, exercises, blocks, floors, rooms, assetTypes, entryCount, signoffCount, photoCount] =
    await Promise.all([
      db.organizations.toArray(),
      db.inspectors.toArray(),
      db.exercises.toArray(),
      db.blocks.toArray(),
      db.floors.toArray(),
      db.rooms.toArray(),
      db.assetTypes.toArray(),
      db.entries.count(),
      db.signoffs.count(),
      db.photos.count(),
    ])

  if (entryCount || signoffCount || photoCount) return false
  if (organizations.length !== 1 || exercises.length !== 1 || blocks.length !== 1) return false
  if (!inspectors.length || !floors.length || !rooms.length || !assetTypes.length) return false
  if (organizations[0].name !== 'Sufa Schools Company Limited' || blocks[0].name !== 'Main Block') return false

  const rows = [...organizations, ...inspectors, ...exercises, ...blocks, ...floors, ...rooms, ...assetTypes]
  return rows.every(
    (row) =>
      row.syncStatus === 'pending' &&
      !('deleted' in row && row.deleted) &&
      row.updatedAt >= seededAt &&
      // Only seeded inspectors receive the +1, +2, ... millisecond offsets.
      row.updatedAt < seededAt + inspectors.length,
  )
}

/** Clears one tenant's cached operational data while retaining device settings. */
async function clearCachedTenant(): Promise<void> {
  const tables = [
    db.organizations,
    db.inspectors,
    db.exercises,
    db.blocks,
    db.floors,
    db.rooms,
    db.assetTypes,
    db.entries,
    db.signoffs,
    db.photos,
  ]
  await db.transaction('rw', tables, async () => {
    for (const table of tables) await table.clear()
  })
  await Promise.all([
    setMeta('activeExerciseId', null),
    setMeta('lastSyncAt', 0),
    setMeta('lastSyncError', null),
    setMeta(SEED_DISABLED_KEY, true),
  ])
  try {
    localStorage.removeItem('av.session.inspectorId')
  } catch {
    /* Storage can be unavailable in private browsing; IndexedDB is enough. */
  }
}

/**
 * Signs in against the sync server and stores the bearer token.
 *
 * Returns the account the server knows about, so the caller can create a local
 * record for it: a device that has never synced holds no accounts at all, and
 * an inspector's first sign-in on a new phone has to come from somewhere.
 */
export async function login(email: string, password: string): Promise<ServerAccount | null> {
  const base = await getServerUrl()
  try {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      token?: string
      inspector?: ServerAccount
      organization?: { id: string; name: string; address?: string }
    }
    if (!data.token) return null

    // The server is authoritative about the tenant. A browser database is
    // shared by every account on that phone, so explicitly replace the old
    // tenant's cache before storing the new tenant's token.
    if (data.organization?.id) {
      const oldOrgId = await inferLocalOrgId()
      if (oldOrgId && oldOrgId !== data.organization.id) {
        const untouchedSample = await isUntouchedSampleCache()
        if ((await pendingLocalWork()) > 0 && !untouchedSample) throw new TenantSwitchPendingError()
        await clearCachedTenant()
      }
      await setMeta(ACTIVE_ORG_KEY, data.organization.id)
      await setMeta('lastSyncAt', 0)
    }
    await setMeta('syncToken', data.token)
    if (data.organization?.id) await syncNow()
    const account =
      data.inspector ?? {
        id: `usr_${email.trim().toLowerCase()}`,
        name: email.trim(),
        email: email.trim().toLowerCase(),
        role: 'inspector',
      }
    return { ...account, organization: data.organization }
  } catch (error) {
    if (error instanceof TenantSwitchPendingError) throw error
    return null
  }
}

export async function logoutSync(): Promise<void> {
  await setMeta('syncToken', null)
}

function stripForPush(table: SyncTable, rec: AnyRecord): AnyRecord {
  const { syncStatus: _syncStatus, ...rest } = rec
  if (table === 'entries') {
    const { conflictWith: _conflictWith, ...entry } = rest as Record<string, unknown>
    return entry as AnyRecord
  }
  return rest as AnyRecord
}

/** Defense in depth for servers that pre-date tenant-aware sync filtering. */
async function belongsToActiveOrganization(table: SyncTable, row: AnyRecord, orgId: string): Promise<boolean> {
  if (table === 'organizations') return row.id === orgId
  if (table === 'exercises' || table === 'assetTypes') return row.orgId === orgId
  if (table === 'inspectors') return row.orgId === undefined || row.orgId === orgId

  const exerciseId = typeof row.exerciseId === 'string' ? row.exerciseId : ''
  if (!exerciseId) return false
  const exercise = await db.exercises.get(exerciseId)
  return exercise?.orgId === orgId
}

/**
 * One sync round: push every pending record, pull everything changed on the
 * server since the last run, then upload pending photos. Conflicts come back
 * from the server and are stored on the local entry for the user to resolve.
 */
/** Last sync outcome, so a background failure is visible instead of silent. */
export async function lastSyncError(): Promise<string | null> {
  return getMeta<string | null>('lastSyncError', null)
}

async function remember(result: SyncResult): Promise<SyncResult> {
  // A round can push every record and still fail to land a photo. Report the
  // error whenever there is one, rather than letting `ok` alone clear it.
  await setMeta('lastSyncError', result.error ?? (result.ok ? null : 'failed'))
  return result
}

interface SyncPayload {
  serverTime: number
  changes: Partial<Record<SyncTable, AnyRecord[]>>
  conflicts: Array<{ table: SyncTable; id: string; server: AnyRecord }>
  accepted: Partial<Record<SyncTable, string[]>>
}

/**
 * How much of the backlog one request may carry.
 *
 * The hosted deployment sits behind a serverless gateway that refuses a body
 * over about 4.5 MB outright, and allows the function thirty seconds, while
 * the server spends two queries on every record it is handed. A device that
 * worked offline for a day therefore builds a push that cannot succeed — and
 * because a refused push accepts nothing, the next round rebuilds the very
 * same oversized body and is refused again. The backlog only ever grows, and
 * the team sees none of that inspector's work.
 *
 * Splitting it turns that deadlock into progress. Whatever goes wrong, each
 * round lands at most one batch, and what lands stays landed.
 */
// Sized for the slower of the two limits. The server spends a small number of
// queries on each record it is handed, so the thirty-second budget binds well
// before the body size does; fifty records leaves generous margin on a field
// connection, and a backlog that needs many rounds still drains, because
// every round that completes keeps its batch.
const PUSH_MAX_RECORDS = 50
const PUSH_MAX_BYTES = 750_000

interface PushRound {
  changes: Partial<Record<SyncTable, AnyRecord[]>>
  count: number
}

/** Groups the outbox into requests. Always returns at least one round, because
 *  the last one carries the pull even when there is nothing to send. */
function splitPush(outbox: Array<{ table: SyncTable; row: AnyRecord }>): PushRound[] {
  const rounds: PushRound[] = []
  let current: PushRound = { changes: {}, count: 0 }
  let bytes = 0

  for (const { table, row } of outbox) {
    const size = JSON.stringify(row).length
    // A single record over the cap still has to travel; it just travels alone.
    if (current.count > 0 && (current.count >= PUSH_MAX_RECORDS || bytes + size > PUSH_MAX_BYTES)) {
      rounds.push(current)
      current = { changes: {}, count: 0 }
      bytes = 0
    }
    ;(current.changes[table] ??= []).push(row)
    current.count += 1
    bytes += size
  }

  if (current.count > 0) rounds.push(current)
  return rounds.length > 0 ? rounds : [{ changes: {}, count: 0 }]
}

/**
 * Files one round's answer: accepted pushes become synced, conflicts are kept
 * for the inspector to resolve, and every id the server ruled on is recorded
 * so the pull at the end of the round does not re-apply it.
 */
async function applyPushResult(
  body: SyncPayload,
  activeOrgId: string | null,
  settledIds: Map<SyncTable, Set<string>>,
): Promise<number> {
  const remember_ = (table: SyncTable, id: string) => {
    const seen = settledIds.get(table) ?? new Set<string>()
    seen.add(id)
    settledIds.set(table, seen)
  }

  const conflictIds = new Map<SyncTable, Set<string>>()
  for (const c of body.conflicts ?? []) {
    const set = conflictIds.get(c.table) ?? new Set<string>()
    set.add(c.id)
    conflictIds.set(c.table, set)
  }

  // Mark accepted pushes as synced.
  for (const t of SYNC_TABLES) {
    for (const id of body.accepted?.[t] ?? []) {
      remember_(t, id)
      if (conflictIds.get(t)?.has(id)) continue
      const local = await tableFor(t).get(id)
      if (local) await tableFor(t).put({ ...local, syncStatus: 'synced' })
    }
  }

  // Store conflicts on the local entry so the UI can offer mine/theirs.
  let conflicts = 0
  for (const c of body.conflicts ?? []) {
    remember_(c.table, c.id)
    if (activeOrgId && !(await belongsToActiveOrganization(c.table, c.server, activeOrgId))) continue
    if (c.table !== 'entries') {
      // Non-entry tables are setup data: the server copy wins.
      await tableFor(c.table).put({ ...c.server, syncStatus: 'synced' })
      continue
    }
    const local = await db.entries.get(c.id)
    if (!local) {
      await db.entries.put({ ...(c.server as unknown as InspectionEntry), syncStatus: 'synced' })
      continue
    }
    await db.entries.put({
      ...local,
      syncStatus: 'conflict',
      conflictWith: c.server as unknown as InspectionEntry,
    })
    conflicts += 1
  }
  return conflicts
}

export async function syncNow(): Promise<SyncResult> {
  const base = await getServerUrl()
  const token = await getToken()
  if (!token) {
    return remember({ ok: false, pushed: 0, pulled: 0, conflicts: 0, photosUploaded: 0, error: 'not-connected' })
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return remember({ ok: false, pushed: 0, pulled: 0, conflicts: 0, photosUploaded: 0, error: 'offline' })
  }

  const since = await getMeta<number>('lastSyncAt', 0)
  const activeOrgId = await getMeta<string | null>(ACTIVE_ORG_KEY, null)

  const outbox: Array<{ table: SyncTable; row: AnyRecord }> = []
  for (const t of SYNC_TABLES) {
    const pending = await tableFor(t).where('syncStatus').equals('pending').toArray()
    for (const row of pending) {
      if (!activeOrgId || (await belongsToActiveOrganization(t, row, activeOrgId))) {
        outbox.push({ table: t, row: stripForPush(t, row) })
      }
    }
  }

  const rounds = splitPush(outbox)
  const settledIds = new Map<SyncTable, Set<string>>()
  let pushed = 0
  let conflicts = 0
  let payload: SyncPayload | null = null

  for (let i = 0; i < rounds.length; i += 1) {
    const round = rounds[i]
    // Only the final request pulls. The ones before it are pure uploads, so a
    // long backlog does not drag the whole server-side changeset down the
    // wire once per batch.
    const pull = i === rounds.length - 1
    let body: SyncPayload

    try {
      const res = await fetch(`${base}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ since, changes: round.changes, pull }),
      })
      if (res.status === 401) {
        await setMeta('syncToken', null)
        return remember({ ok: false, pushed, pulled: 0, conflicts, photosUploaded: 0, error: 'unauthorized' })
      }
      if (!res.ok) {
        // Batches that already landed keep their accepted status - that is
        // the point of splitting the push. The watermark is left where it
        // was, because this round never got as far as pulling.
        //
        // remember() matters here: a 500 used to leave the last successful
        // run's cleared error in place, so the phone went on claiming a
        // healthy connection while every round dropped on the floor.
        return remember({
          ok: false,
          pushed,
          pulled: 0,
          conflicts,
          photosUploaded: 0,
          error: `http-${res.status}`,
        })
      }
      body = await res.json()
    } catch (err) {
      return remember({
        ok: false,
        pushed,
        pulled: 0,
        conflicts,
        photosUploaded: 0,
        error: err instanceof Error ? err.message : 'network',
      })
    }

    conflicts += await applyPushResult(body, activeOrgId, settledIds)
    pushed += round.count
    if (pull) payload = body
  }

  // splitPush always yields a final, pulling round, so this is never null.
  const settled: SyncPayload = payload ?? { serverTime: Date.now(), changes: {}, conflicts: [], accepted: {} }

  // Apply server changes, never clobbering a record we still hold unsynced.
  let pulled = 0
  let earliestSkipped = Number.POSITIVE_INFINITY
  for (const t of SYNC_TABLES) {
    const rows = settled.changes?.[t] ?? []
    for (const row of rows) {
      // An earlier batch in this same round already settled this record, as
      // an accepted push or as a conflict. The server only omits what it was
      // handed in the one request, so re-applying it here would undo a
      // conflict the inspector has yet to see.
      if (settledIds.get(t)?.has(String(row.id))) continue
      if (activeOrgId && !(await belongsToActiveOrganization(t, row, activeOrgId))) continue
      const local = await tableFor(t).get(row.id)
      if (local && (local.syncStatus === 'pending' || local.syncStatus === 'conflict')) {
        // Hold the watermark behind anything refused. The server only sends
        // what changed since `lastSyncAt`, so advancing past a record we
        // declined means it is never offered again and the two devices stay
        // different for ever — with nothing on screen to say so.
        earliestSkipped = Math.min(earliestSkipped, Number(row.updatedAt) || 0)
        continue
      }
      if (local && Number(local.updatedAt) > Number(row.updatedAt)) continue
      await tableFor(t).put({
        ...row,
        ...(t === 'inspectors' && activeOrgId ? { orgId: activeOrgId } : {}),
        syncStatus: 'synced',
      })
      pulled += 1
    }
  }

  const photos = await uploadPendingPhotos(base, token)
  const photosUploaded = photos.uploaded
  const serverTime = settled.serverTime ?? Date.now()
  // Skipped records resolve on a later round: a pending one is pushed and
  // either accepted or turned into a conflict, and a conflict waits for the
  // inspector. Re-asking for them until then costs one small response.
  const watermark = Number.isFinite(earliestSkipped)
    ? Math.min(serverTime, earliestSkipped - 1)
    : serverTime
  await setMeta('lastSyncAt', watermark)

  // The records round succeeded, so `ok` stays true and the caller does not
  // escalate to a full re-pull every minute; a photo that would not land is
  // still reported, so the lag has something on screen explaining it.
  return remember({ ok: true, pushed, pulled, conflicts, photosUploaded, error: photos.error })
}

/**
 * Uploads queued photos, one request each.
 *
 * Head-of-line blocking is the thing to avoid here. A single image the server
 * will always refuse — too large for the function's body limit, or stored
 * with a content type it rejects — used to `break` the loop on every round,
 * so every photo queued behind it stayed on the phone for good while the
 * records around them synced perfectly. A permanent refusal now steps over
 * that one photo; only a transient failure stops the round.
 */
async function uploadPendingPhotos(
  base: string,
  token: string,
): Promise<{ uploaded: number; error?: string }> {
  const pending = await db.photos.where('syncStatus').equals('pending').toArray()
  let uploaded = 0
  let error: string | undefined
  for (const photo of pending) {
    try {
      const res = await fetch(`${base}/photos/${encodeURIComponent(photo.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          entryId: photo.entryId,
          exerciseId: photo.exerciseId,
          width: photo.width,
          height: photo.height,
          createdAt: photo.createdAt,
          contentType: photo.contentType || 'image/jpeg',
          data: bytesToBase64(photo.data),
        }),
      })
      if (!res.ok) {
        error = `photo-http-${res.status}`
        // 408 and 429 are the two 4xx that are worth waiting out; every other
        // one means this image will be refused again however often it is sent.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
        if (permanent) continue
        break // transient: let the whole queue retry on the next round
      }
      const { url } = (await res.json()) as { url?: string }
      await db.photos.put({ ...photo, syncStatus: 'synced', remoteUrl: url })
      uploaded += 1
    } catch {
      error = 'photo-network'
      break // stay offline-safe: retry on the next sync
    }
  }
  return { uploaded, error }
}

/** Wipes local data and reloads the sample exercise. */
export async function resetLocalData(): Promise<void> {
  await db.delete()
  location.reload()
}

export interface RegisterInput {
  orgName: string
  address: string
  name: string
  email: string
  password: string
}

export type RegisterResult =
  | { ok: true; token: string; inspector: ServerAccount; organization: { id: string; name: string } }
  | { ok: false; error: string }

/**
 * Registers an institution and its first admin on the sync server.
 *
 * Deliberately free of side effects beyond the request: the caller has to
 * wipe the device and pull the new organization down in the right order, and
 * storing a token here would have it wiped a moment later.
 */
export async function registerOrganization(input: RegisterInput): Promise<RegisterResult> {
  const base = await getServerUrl()
  try {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgName: input.orgName.trim(),
        address: input.address.trim(),
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        password: input.password,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: String(data.error ?? 'register-failed') }
    if (!data.token) return { ok: false, error: 'register-failed' }
    return {
      ok: true,
      token: String(data.token),
      inspector: data.inspector as ServerAccount,
      organization: data.organization as { id: string; name: string },
    }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

/** Stores the bearer token. Used after registering, where login() is skipped. */
export async function setToken(token: string): Promise<void> {
  await setMeta('syncToken', token)
}

export interface NewAccount {
  name: string
  email: string
  password: string
  role: Role
}

/**
 * Creates a colleague's account on the server, so it works on every device
 * rather than only the admin's. Returns an error code the caller maps to a
 * message; 'offline' means the caller should fall back to a local-only
 * account that will be pushed on the next sync.
 */
export async function createTeamAccount(input: NewAccount): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const base = await getServerUrl()
  const token = await getToken()
  if (!token) return { ok: false, error: 'not-connected' }
  try {
    const res = await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        password: input.password,
        role: input.role,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { user?: { id: string }; error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'failed' }
    return { ok: true, id: data.user?.id ?? '' }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

/**
 * Fetches any of an entry's photos that this device does not hold.
 *
 * Photos only ever travelled upward: a second phone pulls the entry, sees its
 * photoIds, and has no bytes to show for them. Uploading is still one-way per
 * sync — images are large and a field connection is not — so they are pulled
 * on demand, when something actually wants to display one, and kept once
 * fetched so it works offline afterwards.
 *
 * Returns the number newly stored. Failures are silent by design: a missing
 * photo is a blank space, never a blocked screen.
 */
export async function ensureEntryPhotos(entryId: string): Promise<number> {
  const entry = await db.entries.get(entryId)
  if (!entry || entry.photoIds.length === 0) return 0

  const held = new Set((await db.photos.where('entryId').equals(entryId).toArray()).map((p) => p.id))
  const missing = entry.photoIds.filter((id) => !held.has(id))
  if (missing.length === 0) return 0

  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0
  const token = await getToken()
  if (!token) return 0
  const base = await getServerUrl()

  let fetched = 0
  for (const id of missing) {
    try {
      const res = await fetch(`${base}/photos/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) continue
      const data = await res.arrayBuffer()
      if (data.byteLength === 0) continue
      await db.photos.put({
        id,
        entryId,
        exerciseId: entry.exerciseId,
        data,
        contentType: res.headers.get('Content-Type') || 'image/jpeg',
        width: 0,
        height: 0,
        createdAt: Date.now(),
        remoteUrl: `${base}/photos/${id}`,
        // It came from the server; it must not be queued for upload again.
        syncStatus: 'synced',
      })
      fetched += 1
    } catch {
      // Leave it missing; the next time something asks, it tries again.
    }
  }
  return fetched
}

/**
 * Asks the server for everything again, from the beginning of time.
 *
 * A device whose watermark has already moved past a record it declined will
 * never be offered it again by an incremental pull. This is the way back,
 * and it is also the honest answer to "the two screens disagree". Local work
 * that has not been uploaded is still protected: a pending record is pushed
 * first and a conflict still waits for the inspector.
 */
export async function resyncEverything(): Promise<SyncResult> {
  await setMeta('lastSyncAt', 0)
  return syncNow()
}

/**
 * A snapshot of this device's sync state, safe to share.
 *
 * Three bugs in a row were diagnosed by querying the database behind the
 * user's back, because the device could not say what it held. It can now.
 * Deliberately excludes the token and anything an inspector typed — ids,
 * counts, timestamps and sync flags only.
 */
export async function syncDiagnostics(): Promise<string> {
  const [serverUrl, token, lastSyncAt, lastError, visionError] = await Promise.all([
    getServerUrl(),
    getToken(),
    getMeta<number>('lastSyncAt', 0),
    lastSyncError(),
    getMeta<string | null>('lastVisionError', null),
  ])

  const tables: Record<string, unknown> = {}
  for (const t of SYNC_TABLES) {
    const rows = await tableFor(t).where('syncStatus').equals('pending').toArray()
    const all = (await (db[t] as unknown as { toArray: () => Promise<AnyRecord[]> }).toArray()) ?? []
    tables[t] = {
      total: all.length,
      pending: rows.length,
      newest: all.reduce((max, r) => Math.max(max, Number(r.updatedAt) || 0), 0),
    }
  }

  const entries = await db.entries.toArray()
  return JSON.stringify(
    {
      build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown',
      serverUrl,
      connected: Boolean(token),
      lastSyncAt,
      lastSyncAtReadable: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      lastError,
      lastVisionError: visionError,
      online: typeof navigator === 'undefined' ? null : navigator.onLine,
      tables,
      entries: entries.map((e) => ({
        id: e.id.slice(-10),
        room: e.roomId.slice(-10),
        assetType: e.assetTypeId ? e.assetTypeId.slice(-10) : null,
        unlisted: e.isUnlistedItem,
        qty: e.quantity,
        deleted: e.deleted,
        sync: e.syncStatus,
        updatedAt: new Date(e.updatedAt).toISOString(),
      })),
    },
    null,
    2,
  )
}

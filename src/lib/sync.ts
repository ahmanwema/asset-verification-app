import { db, getMeta, setMeta } from '../db/db'
import { bytesToBase64 } from './photos'
import type { InspectionEntry, Role } from '../types'

export const SYNC_TABLES = [
  'organizations',
  'inspectors',
  'exercises',
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
    const data = (await res.json()) as { token?: string; inspector?: ServerAccount }
    if (!data.token) return null
    await setMeta('syncToken', data.token)
    return (
      data.inspector ?? {
        id: `usr_${email.trim().toLowerCase()}`,
        name: email.trim(),
        email: email.trim().toLowerCase(),
        role: 'inspector',
      }
    )
  } catch {
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
  await setMeta('lastSyncError', result.ok ? null : (result.error ?? 'failed'))
  return result
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
  const changes: Partial<Record<SyncTable, AnyRecord[]>> = {}
  let pushed = 0

  for (const t of SYNC_TABLES) {
    const pending = await tableFor(t).where('syncStatus').equals('pending').toArray()
    if (pending.length > 0) {
      changes[t] = pending.map((r) => stripForPush(t, r))
      pushed += pending.length
    }
  }

  let payload: {
    serverTime: number
    changes: Partial<Record<SyncTable, AnyRecord[]>>
    conflicts: Array<{ table: SyncTable; id: string; server: AnyRecord }>
    accepted: Partial<Record<SyncTable, string[]>>
  }

  try {
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ since, changes }),
    })
    if (res.status === 401) {
      await setMeta('syncToken', null)
      return remember({ ok: false, pushed: 0, pulled: 0, conflicts: 0, photosUploaded: 0, error: 'unauthorized' })
    }
    if (!res.ok) {
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, photosUploaded: 0, error: `http-${res.status}` }
    }
    payload = await res.json()
  } catch (err) {
    return remember({
      ok: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      photosUploaded: 0,
      error: err instanceof Error ? err.message : 'network',
    })
  }

  const conflictIds = new Map<SyncTable, Set<string>>()
  for (const c of payload.conflicts ?? []) {
    const set = conflictIds.get(c.table) ?? new Set<string>()
    set.add(c.id)
    conflictIds.set(c.table, set)
  }

  // Mark accepted pushes as synced.
  for (const t of SYNC_TABLES) {
    const ids = payload.accepted?.[t] ?? []
    for (const id of ids) {
      if (conflictIds.get(t)?.has(id)) continue
      const local = await tableFor(t).get(id)
      if (local) await tableFor(t).put({ ...local, syncStatus: 'synced' })
    }
  }

  // Store conflicts on the local entry so the UI can offer mine/theirs.
  let conflicts = 0
  for (const c of payload.conflicts ?? []) {
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

  // Apply server changes, never clobbering a record we still hold unsynced.
  let pulled = 0
  for (const t of SYNC_TABLES) {
    const rows = payload.changes?.[t] ?? []
    for (const row of rows) {
      const local = await tableFor(t).get(row.id)
      if (local && (local.syncStatus === 'pending' || local.syncStatus === 'conflict')) continue
      if (local && Number(local.updatedAt) > Number(row.updatedAt)) continue
      await tableFor(t).put({ ...row, syncStatus: 'synced' })
      pulled += 1
    }
  }

  const photosUploaded = await uploadPendingPhotos(base, token)
  await setMeta('lastSyncAt', payload.serverTime ?? Date.now())

  return remember({ ok: true, pushed, pulled, conflicts, photosUploaded })
}

async function uploadPendingPhotos(base: string, token: string): Promise<number> {
  const pending = await db.photos.where('syncStatus').equals('pending').toArray()
  let uploaded = 0
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
      if (!res.ok) break
      const { url } = (await res.json()) as { url?: string }
      await db.photos.put({ ...photo, syncStatus: 'synced', remoteUrl: url })
      uploaded += 1
    } catch {
      break // stay offline-safe: retry on the next sync
    }
  }
  return uploaded
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

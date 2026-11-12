/**
 * Client-side sync against a real server process: push, pull, conflict capture
 * and photo upload, exercised through the same code the phone runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, getMeta, setMeta } from '../db/db'
import { SEED_DISABLED_KEY, seedIfEmpty } from '../db/seed'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { resolveConflict, saveEntry } from './entries'
import {
  ACTIVE_ORG_KEY,
  ensureEntryPhotos,
  lastSyncError,
  loadSyncState,
  login,
  pendingRoomCount,
  resyncEverything,
  setServerUrl,
  syncNow,
  TenantSwitchPendingError,
} from './sync'

const PORT = 4791
const BASE = `http://127.0.0.1:${PORT}/api`
const SERVER = path.resolve(process.cwd(), 'server', 'index.js')

let child: ChildProcess
let tmpDir: string
let fx: Fixture

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('server did not start')
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-client-sync-'))
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(tmpDir, 'data'),
      UPLOAD_DIR: path.join(tmpDir, 'uploads'),
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'secret123',
      // Pin recognition off whatever the developer has in their own .env:
      // an already-set variable wins over the file, empty string included.
      OPENAI_API_KEY: '',
    },
    stdio: 'ignore',
  })
  await waitForServer()
}, 30000)

afterAll(async () => {
  child?.kill()
  await new Promise((r) => setTimeout(r, 200))
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* sqlite file may still be held on Windows; the temp dir is disposable */
  }
})

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
  await setServerUrl(BASE)
})

function draft(over: Partial<Parameters<typeof saveEntry>[0]> = {}) {
  return {
    exerciseId: fx.exercise.id,
    room: fx.room,
    floor: fx.floor,
    assetType: fx.chair,
    isUnlistedItem: false,
    quantity: 10,
    serialNumbers: [],
    model: '',
    brand: '',
    condition: 'G' as const,
    remarks: '',
    inspectorId: fx.inspector.id,
    notPresent: false,
    ...over,
  }
}

describe('connection', () => {
  it('refuses to sync before the device is connected', async () => {
    await saveEntry(draft())
    const res = await syncNow()
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not-connected')
  })

  it('stores a token after a successful server login', async () => {
    expect(await login('admin@test.local', 'wrong')).toBeNull()

    // The account comes back so a device with no local records can create one.
    const account = await login('admin@test.local', 'secret123')
    expect(account?.email).toBe('admin@test.local')
    expect(account?.id).toBeTruthy()

    const state = await loadSyncState()
    expect(state.token).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('switching organizations on one device', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('discards untouched sample rows on the first login to a real organization', async () => {
    await resetDb()
    await seedIfEmpty()
    await setServerUrl(BASE)
    const sampleOrg = (await db.organizations.toArray())[0]
    const now = Date.now()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/login')) {
          return new Response(
            JSON.stringify({
              token: 'real-token',
              inspector: { id: 'usr_real', name: 'Mohamed Sudi', email: 'abuusuleha@gmail.com', role: 'inspector' },
              organization: { id: 'org_real', name: 'Sufa Schools Company Limited' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            serverTime: now,
            accepted: {},
            conflicts: [],
            changes: {
              organizations: [{ id: 'org_real', name: 'Sufa Schools Company Limited', updatedAt: now }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    await expect(login('abuusuleha@gmail.com', 'correct-password')).resolves.toMatchObject({ id: 'usr_real' })
    expect(await db.organizations.get(sampleOrg.id)).toBeUndefined()
    expect(await db.organizations.get('org_real')).toBeTruthy()
    expect(await getMeta(SEED_DISABLED_KEY, false)).toBe(true)
  })

  it('replaces the old cache and ignores foreign rows returned by an old server', async () => {
    await db.organizations.toCollection().modify({ syncStatus: 'synced' })
    await db.inspectors.toCollection().modify({ syncStatus: 'synced' })
    await db.exercises.toCollection().modify({ syncStatus: 'synced' })
    await db.floors.toCollection().modify({ syncStatus: 'synced' })
    await db.rooms.toCollection().modify({ syncStatus: 'synced' })
    await db.assetTypes.toCollection().modify({ syncStatus: 'synced' })

    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/login')) {
          return new Response(
            JSON.stringify({
              token: 'sufa-token',
              inspector: { id: 'usr_sufa', name: 'Sufa Admin', email: 'admin@sufa.test', role: 'admin' },
              organization: { id: 'org_sufa', name: 'Sufa Schools Company Limited' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            serverTime: now,
            accepted: {},
            conflicts: [],
            changes: {
              organizations: [
                { id: 'org_sufa', name: 'Sufa Schools Company Limited', updatedAt: now },
                { id: fx.org.id, name: 'Loyola High School', updatedAt: now },
              ],
              exercises: [
                { id: 'ex_sufa', orgId: 'org_sufa', name: 'Sufa verification', updatedAt: now },
                { id: 'ex_loyola', orgId: fx.org.id, name: 'Loyola verification', updatedAt: now },
              ],
              inspectors: [
                { id: 'usr_sufa', email: 'admin@sufa.test', name: 'Sufa Admin', role: 'admin', active: true, updatedAt: now },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )

    const account = await login('admin@sufa.test', 'correct-password')
    expect(account?.organization?.id).toBe('org_sufa')
    expect(await getMeta(ACTIVE_ORG_KEY, null)).toBe('org_sufa')
    expect((await db.organizations.toArray()).map((row) => row.name)).toEqual(['Sufa Schools Company Limited'])
    expect((await db.exercises.toArray()).map((row) => row.id)).toEqual(['ex_sufa'])
    expect((await db.inspectors.get('usr_sufa'))?.orgId).toBe('org_sufa')
  })

  it('does not discard unsynced work when an account belongs to another organization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            token: 'sufa-token',
            inspector: { id: 'usr_sufa', name: 'Sufa Admin', email: 'admin@sufa.test', role: 'admin' },
            organization: { id: 'org_sufa', name: 'Sufa Schools Company Limited' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(login('admin@sufa.test', 'correct-password')).rejects.toBeInstanceOf(TenantSwitchPendingError)
    expect(await db.organizations.get(fx.org.id)).toBeTruthy()
    expect(await getMeta(ACTIVE_ORG_KEY, null)).toBeNull()
  })
})

describe('push', () => {
  it('uploads pending records and marks them synced', async () => {
    const entry = await saveEntry(draft())
    expect(await pendingRoomCount(fx.exercise.id)).toBe(1)

    await login('admin@test.local', 'secret123')
    const res = await syncNow()

    expect(res.ok).toBe(true)
    expect(res.pushed).toBeGreaterThanOrEqual(1)
    expect((await db.entries.get(entry.id))?.syncStatus).toBe('synced')
    expect(await pendingRoomCount(fx.exercise.id)).toBe(0)
    expect(await getMeta<number>('lastSyncAt', 0)).toBeGreaterThan(0)

    const state = await loadSyncState()
    expect(state.pendingRecords).toBe(0)
  })

  it('uploads photos and records where they landed', async () => {
    const entry = await saveEntry(draft())
    await db.photos.add({
      id: `ph_${Date.now()}`,
      entryId: entry.id,
      exerciseId: fx.exercise.id,
      data: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'image/jpeg',
      width: 100,
      height: 80,
      createdAt: Date.now(),
      syncStatus: 'pending',
    })

    await login('admin@test.local', 'secret123')
    const res = await syncNow()

    expect(res.photosUploaded).toBe(1)
    const photo = (await db.photos.toArray())[0]
    expect(photo.syncStatus).toBe('synced')
    expect(photo.remoteUrl).toMatch(/^\/api\/photos\//)
  })
})

describe('conflicts', () => {
  it('stores the server copy when another inspector got there first', async () => {
    const entry = await saveEntry(draft({ quantity: 10 }))
    await login('admin@test.local', 'secret123')
    await syncNow()

    // Another device pushes its own version of the same entry.
    const token = (await loadSyncState()).token!
    await fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        since: Date.now(),
        changes: {
          entries: [
            {
              ...(await db.entries.get(entry.id)),
              quantity: 28,
              inspectorId: fx.inspector2.id,
              updatedAt: Date.now() + 5_000,
              syncStatus: undefined,
            },
          ],
        },
      }),
    })

    // We edit locally without having seen their write, then sync.
    await saveEntry(draft({ id: entry.id, quantity: 12 }))
    const res = await syncNow()

    expect(res.conflicts).toBe(1)
    const local = await db.entries.get(entry.id)
    expect(local?.syncStatus).toBe('conflict')
    expect(local?.quantity).toBe(12)
    expect(local?.conflictWith?.quantity).toBe(28)
    expect(local?.conflictWith?.inspectorId).toBe(fx.inspector2.id)

    await resolveConflict(entry.id, 'theirs')
    const resolved = await db.entries.get(entry.id)
    expect(resolved?.quantity).toBe(28)
    expect(resolved?.syncStatus).toBe('synced')
  })

  it('never overwrites a local record that still has unsynced edits', async () => {
    const entry = await saveEntry(draft({ quantity: 10 }))
    await login('admin@test.local', 'secret123')
    await syncNow()

    const token = (await loadSyncState()).token!
    await fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        since: Date.now(),
        changes: {
          entries: [
            {
              ...(await db.entries.get(entry.id)),
              quantity: 99,
              inspectorId: fx.inspector.id,
              updatedAt: Date.now() + 5_000,
              syncStatus: undefined,
            },
          ],
        },
      }),
    })

    // Local edit is still pending: the pull must leave it alone.
    await db.entries.update(entry.id, { quantity: 11, syncStatus: 'pending' })
    await syncNow()
    expect((await db.entries.get(entry.id))?.quantity).not.toBe(99)
  })
})

describe('pull', () => {
  it('brings down records this device has never seen', async () => {
    await login('admin@test.local', 'secret123')
    const token = (await loadSyncState()).token!

    const foreignId = `en_foreign_${Date.now()}`
    await fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        since: 0,
        changes: {
          entries: [
            {
              id: foreignId,
              exerciseId: fx.exercise.id,
              roomId: fx.room2.id,
              assetTypeId: fx.table.id,
              quantity: 7,
              serialNumbers: [],
              model: '',
              brand: '',
              tagNumbers: ['ST-1F-P4-001'],
              condition: 'F',
              photoIds: [],
              remarks: 'from another device',
              inspectorId: fx.inspector2.id,
              inspectedAt: Date.now(),
              isUnlistedItem: false,
              notPresent: false,
              updatedAt: Date.now(),
              deleted: false,
            },
          ],
        },
      }),
    })

    const res = await syncNow()
    expect(res.pulled).toBeGreaterThanOrEqual(1)
    const pulled = await db.entries.get(foreignId)
    expect(pulled?.quantity).toBe(7)
    expect(pulled?.syncStatus).toBe('synced')
  })
})

describe('photo download', () => {
  it('fetches a photo this device never had, and keeps it', async () => {
    await login('admin@test.local', 'secret123')

    // One device records an item with a photo and uploads it.
    const entry = await saveEntry(draft())
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33])
    await db.photos.add({
      id: 'ph_1',
      entryId: entry.id,
      exerciseId: fx.exercise.id,
      data: bytes.buffer,
      contentType: 'image/jpeg',
      width: 1280,
      height: 960,
      createdAt: Date.now(),
      syncStatus: 'pending',
    })
    await db.entries.put({ ...entry, photoIds: ['ph_1'], syncStatus: 'pending' })
    await syncNow()

    // A second device has the entry but none of the bytes.
    await db.photos.clear()
    expect(await db.photos.count()).toBe(0)

    expect(await ensureEntryPhotos(entry.id)).toBe(1)
    const [got] = await db.photos.toArray()
    expect(new Uint8Array(got.data)).toEqual(bytes)
    expect(got.syncStatus).toBe('synced') // must not be queued for re-upload

    // Already held: no second request.
    expect(await ensureEntryPhotos(entry.id)).toBe(0)
  })

  it('does nothing for an entry with no photos', async () => {
    await login('admin@test.local', 'secret123')
    const entry = await saveEntry(draft())
    expect(await ensureEntryPhotos(entry.id)).toBe(0)
  })
})

describe('sync failure is visible', () => {
  it('records why a sync failed, and clears it on the next success', async () => {
    await login('admin@test.local', 'secret123')
    await saveEntry(draft())

    // A sync with no token stored cannot run.
    await setMeta('syncToken', null)
    const failed = await syncNow()
    expect(failed.ok).toBe(false)
    expect(await lastSyncError()).toBe('not-connected')

    await login('admin@test.local', 'secret123')
    const ok = await syncNow()
    expect(ok.ok).toBe(true)
    expect(await lastSyncError()).toBeNull()
  })

  it('reports a server error instead of leaving the last success on screen', async () => {
    await login('admin@test.local', 'secret123')
    await saveEntry(draft())

    // A clean round first, so lastSyncError is null and only a regression
    // could leave it that way through the failure below.
    expect((await syncNow()).ok).toBe(true)
    expect(await lastSyncError()).toBeNull()

    await saveEntry(draft({ quantity: 4 }))
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
      if (url.endsWith('/sync')) return Promise.resolve(new Response('upstream down', { status: 502 }))
      return real(input as RequestInfo, init)
    })

    try {
      const res = await syncNow()
      expect(res.ok).toBe(false)
      expect(res.error).toBe('http-502')
      expect(await lastSyncError()).toBe('http-502')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('photo upload', () => {
  async function queuePhoto(entryId: string, id: string) {
    await db.photos.add({
      id,
      entryId,
      exerciseId: fx.exercise.id,
      data: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'image/jpeg',
      width: 100,
      height: 80,
      createdAt: Date.now(),
      syncStatus: 'pending',
    })
  }

  it('steps over a photo the server will never accept, and uploads the rest', async () => {
    const entry = await saveEntry(draft())
    await queuePhoto(entry.id, 'ph_rejected')
    await queuePhoto(entry.id, 'ph_good_1')
    await queuePhoto(entry.id, 'ph_good_2')

    await login('admin@test.local', 'secret123')

    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
      // Stands in for an image over the function's body limit: refused the
      // same way every time it is offered.
      if (url.endsWith('/photos/ph_rejected')) {
        return Promise.resolve(new Response('too large', { status: 413 }))
      }
      return real(input as RequestInfo, init)
    })

    try {
      const res = await syncNow()
      // The two good photos queued behind the bad one still land.
      expect(res.photosUploaded).toBe(2)
      expect(res.error).toBe('photo-http-413')
    } finally {
      spy.mockRestore()
    }

    const byId = new Map((await db.photos.toArray()).map((p) => [p.id, p.syncStatus]))
    expect(byId.get('ph_good_1')).toBe('synced')
    expect(byId.get('ph_good_2')).toBe('synced')
    expect(byId.get('ph_rejected')).toBe('pending')

    // Records are not held back by it, and the reason is on record.
    expect(await lastSyncError()).toBe('photo-http-413')
  })

  it('stops the round on a transient failure, so the queue is retried intact', async () => {
    const entry = await saveEntry(draft())
    await queuePhoto(entry.id, 'ph_a')
    await queuePhoto(entry.id, 'ph_b')

    await login('admin@test.local', 'secret123')

    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
      if (url.includes('/photos/')) return Promise.resolve(new Response('later', { status: 503 }))
      return real(input as RequestInfo, init)
    })

    try {
      const res = await syncNow()
      expect(res.photosUploaded).toBe(0)
      expect(res.error).toBe('photo-http-503')
    } finally {
      spy.mockRestore()
    }

    expect(await db.photos.where('syncStatus').equals('pending').count()).toBe(2)

    // With the server healthy again, the untouched queue drains.
    const after = await syncNow()
    expect(after.photosUploaded).toBe(2)
    expect(await lastSyncError()).toBeNull()
  })
})

describe('the sync watermark', () => {
  it('re-offers a record that was skipped, instead of losing it for ever', async () => {
    await login('admin@test.local', 'secret123')

    // Device A records an item and uploads it.
    const entry = await saveEntry(draft({ quantity: 1 }))
    await syncNow()

    // Another device moves it on, straight against the server.
    const token = (await loadSyncState()).token!
    await fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        since: Date.now(),
        changes: {
          entries: [
            { ...(await db.entries.get(entry.id)), quantity: 10, updatedAt: Date.now() + 5_000, syncStatus: undefined },
          ],
        },
      }),
    })

    // Meanwhile this device has an unsynced edit of its own, so the pull
    // must decline the server's copy rather than overwrite local work.
    await db.entries.put({ ...(await db.entries.get(entry.id))!, remarks: 'mine', syncStatus: 'pending' })
    await syncNow()

    // The watermark must not have moved past the record it declined.
    const since = await getMeta<number>('lastSyncAt', 0)
    expect(since).toBeLessThan(Date.now() + 5_000)

    // Once the local edit is reconciled, a plain sync still finds it.
    const row = await db.entries.get(entry.id)
    await db.entries.put({ ...row!, syncStatus: 'synced' })
    await syncNow()
    expect((await db.entries.get(entry.id))?.quantity).toBe(10)
  })

  it('re-downloads everything on demand', async () => {
    await login('admin@test.local', 'secret123')
    const entry = await saveEntry(draft({ quantity: 2 }))
    await syncNow()

    // Wipe it locally, as a device that lost its copy would have. (The test
    // server is shared across this file, so other entries may exist too —
    // this one record is what matters.)
    await db.entries.delete(entry.id)
    expect(await db.entries.get(entry.id)).toBeUndefined()

    // An incremental sync has nothing to say: nothing changed since.
    await syncNow()
    expect(await db.entries.get(entry.id)).toBeUndefined()

    // Asking for everything brings it back.
    await resyncEverything()
    expect((await db.entries.get(entry.id))?.quantity).toBe(2)
  })
})

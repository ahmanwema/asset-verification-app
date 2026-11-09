/**
 * Client-side sync against a real server process: push, pull, conflict capture
 * and photo upload, exercised through the same code the phone runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, getMeta, setMeta } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { resolveConflict, saveEntry } from './entries'
import { ensureEntryPhotos, lastSyncError, loadSyncState, login, pendingRoomCount, resyncEverything, setServerUrl, syncNow } from './sync'

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

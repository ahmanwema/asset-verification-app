/**
 * Client-side sync against a real server process: push, pull, conflict capture
 * and photo upload, exercised through the same code the phone runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, getMeta } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { resolveConflict, saveEntry } from './entries'
import { loadSyncState, login, pendingRoomCount, setServerUrl, syncNow } from './sync'

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

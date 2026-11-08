import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { ValidationError, deleteEntry, markNotPresent, reopenRoom, resolveConflict, saveEntry, signoffRoom } from './entries'
import { breakdownIsValid, entryConditionCounts, loadExerciseStats, loadFloorProgress } from './queries'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

function draft(over: Partial<Parameters<typeof saveEntry>[0]> = {}) {
  return {
    exerciseId: fx.exercise.id,
    room: fx.room,
    floor: fx.floor,
    assetType: fx.chair,
    isUnlistedItem: false,
    quantity: 1,
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

describe('saveEntry', () => {
  it('rejects a zero quantity unless the item is marked not present', async () => {
    await expect(saveEntry(draft({ quantity: 0 }))).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an unlisted item with no name', async () => {
    await expect(
      saveEntry(draft({ isUnlistedItem: true, assetType: undefined, unlistedItemName: '  ' })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a condition breakdown that does not add up to the quantity', async () => {
    await expect(
      saveEntry(draft({ quantity: 30, conditionBreakdown: { G: 28, P: 1 } })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('stores a 28 Good / 2 Poor split against a quantity of 30', async () => {
    const entry = await saveEntry(draft({ quantity: 30, conditionBreakdown: { G: 28, P: 2 } }))
    expect(entry.tagNumbers).toHaveLength(30)
    expect(entryConditionCounts(entry)).toEqual({ G: 28, P: 2 })
    expect(breakdownIsValid({ G: 28, P: 2 }, 30)).toBe(true)
  })

  it('treats a bulk condition as the whole quantity', async () => {
    const entry = await saveEntry(draft({ quantity: 4, condition: 'F' }))
    expect(entryConditionCounts(entry)).toEqual({ F: 4 })
  })

  it('trims serials and drops empty ones', async () => {
    const entry = await saveEntry(draft({ serialNumbers: [' SN-1 ', '', '  '] }))
    expect(entry.serialNumbers).toEqual(['SN-1'])
  })

  it('marks every write pending for sync', async () => {
    const entry = await saveEntry(draft())
    expect(entry.syncStatus).toBe('pending')
  })
})

describe('detail fields', () => {
  it('stores and trims every "more details" field', async () => {
    const entry = await saveEntry(
      draft({
        material: '  Wooden seat and backrest with metal frame  ',
        colour: 'Light Brown / Grey',
        itemType: 'Single-seater student chair',
        additionalFeatures: 'Pen groove on tabletop',
        description: 'Single-seater student chair with wooden seat and grey metal legs',
        specificPosition: 'Front left corner',
      }),
    )
    expect(entry.material).toBe('Wooden seat and backrest with metal frame')
    expect(entry.colour).toBe('Light Brown / Grey')
    expect(entry.itemType).toBe('Single-seater student chair')
    expect(entry.additionalFeatures).toBe('Pen groove on tabletop')
    expect(entry.description).toBe('Single-seater student chair with wooden seat and grey metal legs')
    expect(entry.specificPosition).toBe('Front left corner')

    const stored = await db.entries.get(entry.id)
    expect(stored?.material).toBe('Wooden seat and backrest with metal frame')
  })

  it('defaults them to empty strings when the quick workflow skips them', async () => {
    const entry = await saveEntry(draft())
    expect(entry.material).toBe('')
    expect(entry.colour).toBe('')
    expect(entry.itemType).toBe('')
    expect(entry.additionalFeatures).toBe('')
    expect(entry.description).toBe('')
    expect(entry.specificPosition).toBe('')
    expect(entry.aiAssisted).toBeUndefined()
  })

  it('keeps the AI-assisted marker on the record for the register', async () => {
    const entry = await saveEntry(draft({ aiAssisted: true, description: 'From a photo' }))
    expect(entry.aiAssisted).toBe(true)
  })
})

describe('not present', () => {
  it('records quantity 0 with no tags, and is idempotent per asset type', async () => {
    const first = await markNotPresent({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      inspectorId: fx.inspector.id,
    })
    expect(first.quantity).toBe(0)
    expect(first.notPresent).toBe(true)
    expect(first.tagNumbers).toEqual([])

    const second = await markNotPresent({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      inspectorId: fx.inspector.id,
    })
    expect(second.id).toBe(first.id)
    expect(await db.entries.count()).toBe(1)
  })
})

describe('deletes', () => {
  it('soft-deletes so the removal can propagate on the next sync', async () => {
    const entry = await saveEntry(draft())
    await deleteEntry(entry.id)
    const row = await db.entries.get(entry.id)
    expect(row?.deleted).toBe(true)
    expect(row?.syncStatus).toBe('pending')
  })
})

describe('room sign-off', () => {
  it('totals the items found and can be reopened', async () => {
    await saveEntry(draft({ quantity: 30 }))
    await saveEntry(draft({ assetType: fx.table, quantity: 15 }))
    await markNotPresent({
      exerciseId: fx.exercise.id,
      room: fx.room2,
      floor: fx.floor,
      assetType: fx.chair,
      inspectorId: fx.inspector.id,
    })

    const signoff = await signoffRoom({
      exerciseId: fx.exercise.id,
      roomId: fx.room.id,
      inspectorId: fx.inspector.id,
      notes: 'All verified',
    })
    expect(signoff.totalItemsFound).toBe(45)

    let floors = await loadFloorProgress(fx.exercise.id)
    expect(floors[0].rooms.find((r) => r.room.id === fx.room.id)?.status).toBe('done')
    expect(floors[0].rooms.find((r) => r.room.id === fx.room2.id)?.status).toBe('in_progress')

    await reopenRoom(fx.room.id)
    floors = await loadFloorProgress(fx.exercise.id)
    expect(floors[0].rooms.find((r) => r.room.id === fx.room.id)?.status).toBe('in_progress')
  })
})

describe('progress and stats', () => {
  it('counts checked asset types, items found and conditions across the exercise', async () => {
    await saveEntry(draft({ quantity: 30, conditionBreakdown: { G: 28, P: 2 } }))
    await markNotPresent({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.table,
      inspectorId: fx.inspector.id,
    })
    await saveEntry(
      draft({
        room: fx.room2,
        isUnlistedItem: true,
        assetType: undefined,
        unlistedItemName: 'Projector Stand',
        quantity: 1,
        condition: 'U',
      }),
    )

    const stats = await loadExerciseStats(fx.exercise.id)
    expect(stats.roomsTotal).toBe(2)
    expect(stats.itemsFound).toBe(31)
    expect(stats.tagsIssued).toBe(31)
    expect(stats.conditions).toEqual({ G: 28, F: 0, P: 2, U: 1, total: 31 })
    expect(stats.missingItems).toBe(1)
    expect(stats.unlistedItems).toBe(1)

    const p3 = stats.floors[0].rooms.find((r) => r.room.id === fx.room.id)
    expect(p3?.checked).toBe(2) // both catalog types accounted for
    expect(p3?.total).toBe(2)
  })

  it('excludes soft-deleted entries from the rollups', async () => {
    const entry = await saveEntry(draft({ quantity: 5 }))
    await deleteEntry(entry.id)
    const stats = await loadExerciseStats(fx.exercise.id)
    expect(stats.itemsFound).toBe(0)
  })
})

describe('conflict resolution', () => {
  it('keeps the local record and re-queues it for upload', async () => {
    const mine = await saveEntry(draft({ quantity: 10 }))
    const theirs = { ...mine, quantity: 12, inspectorId: fx.inspector2.id, updatedAt: Date.now() + 1000 }
    await db.entries.put({ ...mine, syncStatus: 'conflict', conflictWith: theirs })

    await resolveConflict(mine.id, 'mine')
    const row = await db.entries.get(mine.id)
    expect(row?.quantity).toBe(10)
    expect(row?.syncStatus).toBe('pending')
    expect(row?.conflictWith).toBeUndefined()
  })

  it('takes the server copy and marks it synced', async () => {
    const mine = await saveEntry(draft({ quantity: 10 }))
    const theirs = { ...mine, quantity: 12, inspectorId: fx.inspector2.id, updatedAt: Date.now() + 1000 }
    await db.entries.put({ ...mine, syncStatus: 'conflict', conflictWith: theirs })

    await resolveConflict(mine.id, 'theirs')
    const row = await db.entries.get(mine.id)
    expect(row?.quantity).toBe(12)
    expect(row?.inspectorId).toBe(fx.inspector2.id)
    expect(row?.syncStatus).toBe('synced')
  })
})

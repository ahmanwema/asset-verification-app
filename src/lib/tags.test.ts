import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { allocateTagNumbers, deriveCode, deriveRoomCode, formatTag, parseTag } from './tags'
import { saveEntry } from './entries'
import { db, uid } from '../db/db'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

describe('tag format', () => {
  it('builds [AssetCode]-[Floor]-[Room]-[Seq] with a zero-padded sequence', () => {
    expect(formatTag('SC', '1F', 'P3', 1)).toBe('SC-1F-P3-001')
    expect(formatTag('SC', '1F', 'P3', 42)).toBe('SC-1F-P3-042')
  })

  it('round-trips through the parser', () => {
    expect(parseTag('SC-1F-P3-001')).toEqual({ assetCode: 'SC', floorCode: '1F', roomCode: 'P3', seq: 1 })
    expect(parseTag('SC-ADM-GF-R1-007')).toEqual({
      assetCode: 'SC',
      blockCode: 'ADM',
      floorCode: 'GF',
      roomCode: 'R1',
      seq: 7,
    })
    expect(parseTag('not-a-tag')).toBeNull()
  })

  it('includes a block code when the location belongs to a block', () => {
    expect(formatTag('SC', 'GF', 'R1', 1, 'ADM')).toBe('SC-ADM-GF-R1-001')
  })

  it('derives short codes for unlisted items and rooms', () => {
    expect(deriveCode('Projector Stand')).toBe('PS')
    expect(deriveCode('Kettle')).toBe('KET')
    // A catalog asset type and an unlisted item of the same name must derive
    // the same code, or one kind of thing ends up with two tag prefixes.
    expect(deriveCode('Chair')).toBe('CHA')
    expect(deriveCode('Table')).toBe('TAB')
    expect(deriveCode('Student Chair')).toBe('SC')
    expect(deriveRoomCode('P3')).toBe('P3')
    expect(deriveRoomCode('Lab Biology Office')).toBe('LBO')
  })
})

describe('tag allocation', () => {
  it('uses a room block override in tags when one floor spans multiple blocks', async () => {
    const blockId = uid('bl_')
    await db.blocks.add({
      id: blockId,
      exerciseId: fx.exercise.id,
      name: 'Administration Block',
      code: 'ADM',
      sortOrder: 0,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    const room = { ...fx.room, blockId }
    await db.rooms.put(room)

    const entry = await saveEntry({
      exerciseId: fx.exercise.id,
      room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 1,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })

    expect(entry.tagNumbers).toEqual(['SC-ADM-1F-P3-001'])
  })

  it('numbers a batch sequentially from 001', async () => {
    const tags = await allocateTagNumbers({
      roomId: fx.room.id,
      assetCode: 'SC',
      floorCode: '1F',
      roomCode: 'P3',
      quantity: 3,
    })
    expect(tags).toEqual(['SC-1F-P3-001', 'SC-1F-P3-002', 'SC-1F-P3-003'])
  })

  it('continues after tags already issued in the same room', async () => {
    await saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 2,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })

    const next = await allocateTagNumbers({
      roomId: fx.room.id,
      assetCode: 'SC',
      floorCode: '1F',
      roomCode: 'P3',
      quantity: 2,
    })
    expect(next).toEqual(['SC-1F-P3-003', 'SC-1F-P3-004'])
  })

  it('keeps an entry its own tags when it is edited, so printed labels stay valid', async () => {
    const first = await saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 3,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })
    expect(first.tagNumbers).toEqual(['SC-1F-P3-001', 'SC-1F-P3-002', 'SC-1F-P3-003'])

    const grown = await saveEntry({
      id: first.id,
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 5,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })
    expect(grown.tagNumbers.slice(0, 3)).toEqual(['SC-1F-P3-001', 'SC-1F-P3-002', 'SC-1F-P3-003'])
    expect(grown.tagNumbers).toHaveLength(5)

    const shrunk = await saveEntry({
      id: first.id,
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 2,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })
    expect(shrunk.tagNumbers).toEqual(['SC-1F-P3-001', 'SC-1F-P3-002'])
  })

  it('keeps sequences independent per asset type and per room', async () => {
    const chairs = await allocateTagNumbers({
      roomId: fx.room.id,
      assetCode: 'SC',
      floorCode: '1F',
      roomCode: 'P3',
      quantity: 1,
    })
    const tables = await allocateTagNumbers({
      roomId: fx.room.id,
      assetCode: 'ST',
      floorCode: '1F',
      roomCode: 'P3',
      quantity: 1,
    })
    const otherRoom = await allocateTagNumbers({
      roomId: fx.room2.id,
      assetCode: 'SC',
      floorCode: '1F',
      roomCode: 'P4',
      quantity: 1,
    })
    expect(chairs[0]).toBe('SC-1F-P3-001')
    expect(tables[0]).toBe('ST-1F-P3-001')
    expect(otherRoom[0]).toBe('SC-1F-P4-001')
  })
})

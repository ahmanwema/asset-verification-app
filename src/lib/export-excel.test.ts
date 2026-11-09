import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import { markNotPresent, saveEntry, signoffRoom } from './entries'
import { buildReportBundle } from './export-excel'

let fx: Fixture

beforeEach(async () => {
  await resetDb()
  fx = await seedFixture()
})

async function populate() {
  await saveEntry({
    exerciseId: fx.exercise.id,
    room: fx.room,
    floor: fx.floor,
    assetType: fx.chair,
    isUnlistedItem: false,
    quantity: 30,
    serialNumbers: ['SN-A'],
    model: 'Classic',
    brand: 'Furnico',
    condition: 'G',
    conditionBreakdown: { G: 28, P: 2 },
    remarks: 'Two seats cracked',
    material: 'Wooden seat and backrest with metal frame',
    colour: 'Light Brown / Grey',
    itemType: 'Single-seater student chair',
    additionalFeatures: 'Pen groove on tabletop',
    description: 'Single-seater student chair with wooden seat, wooden backrest and grey metal legs',
    specificPosition: 'Front left corner',
    aiAssisted: true,
    inspectorId: fx.inspector.id,
    notPresent: false,
  })
  await markNotPresent({
    exerciseId: fx.exercise.id,
    room: fx.room,
    floor: fx.floor,
    assetType: fx.table,
    inspectorId: fx.inspector.id,
  })
  await saveEntry({
    exerciseId: fx.exercise.id,
    room: fx.room2,
    floor: fx.floor,
    assetType: undefined,
    isUnlistedItem: true,
    unlistedItemName: 'Projector Stand',
    quantity: 1,
    serialNumbers: [],
    model: '',
    brand: '',
    condition: 'U',
    remarks: 'Broken leg',
    specificPosition: 'Near window row 3',
    description: 'Folding projector stand with a broken rear leg',
    inspectorId: fx.inspector2.id,
    notPresent: false,
  })
  await signoffRoom({
    exerciseId: fx.exercise.id,
    roomId: fx.room.id,
    inspectorId: fx.inspector.id,
    notes: 'Done',
  })
}

describe('fixed assets register', () => {
  it('emits one row per tagged item with the per-item condition', async () => {
    await populate()
    const bundle = await buildReportBundle(fx.exercise.id)

    // 30 chairs + 1 unlisted stand; the not-present table contributes no rows.
    expect(bundle.register).toHaveLength(31)

    const chairRows = bundle.register.filter((r) => r['Asset Description'] === 'Student Chair')
    expect(chairRows).toHaveLength(30)
    expect(chairRows.filter((r) => r.Condition === 'Good')).toHaveLength(28)
    expect(chairRows.filter((r) => r.Condition === 'Poor')).toHaveLength(2)
    expect(chairRows[0]['Tag Number']).toBe('SC-1F-P3-001')
    expect(chairRows[0].Floor).toBe('1st Floor')
    expect(chairRows[0].Room).toBe('P3')
    expect(chairRows[0].Brand).toBe('Furnico')

    // Only the first item carried a serial; the rest fall back to it, never blank.
    expect(chairRows[0]['Serial Number']).toBe('SN-A')
    expect(chairRows[5]['Serial Number']).toBe('SN-A')
  })
})

describe('detail columns', () => {
  it('carries the physical description through to the register', async () => {
    await populate()
    const { register } = await buildReportBundle(fx.exercise.id)
    const chair = register.find((r) => r['Asset Description'] === 'Student Chair')!

    expect(chair['Item Type']).toBe('Single-seater student chair')
    expect(chair.Material).toBe('Wooden seat and backrest with metal frame')
    expect(chair.Colour).toBe('Light Brown / Grey')
    expect(chair['Additional Features']).toBe('Pen groove on tabletop')
    expect(chair['Position in Room']).toBe('Front left corner')
    expect(chair.Description).toContain('grey metal legs')
    expect(chair['AI Assisted']).toBe('Yes')
  })

  it('leaves the columns blank rather than undefined when details were skipped', async () => {
    await saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room2,
      floor: fx.floor,
      assetType: fx.table,
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
    const { register } = await buildReportBundle(fx.exercise.id)
    const row = register.find((r) => r['Asset Description'] === 'Student Table')!
    expect(row.Material).toBe('')
    expect(row['AI Assisted']).toBe('')
  })

  it('gives the condition report the position so a fixer can find the item', async () => {
    await populate()
    const { condition } = await buildReportBundle(fx.exercise.id)
    const worst = condition[0]
    expect(worst.Item).toBe('Projector Stand')
    expect(worst['Position in Room']).toBe('Near window row 3')
    expect(worst.Description).toContain('broken rear leg')
  })

  it('carries every detail field into the room summary', async () => {
    await populate()
    const { rooms } = await buildReportBundle(fx.exercise.id)
    const chair = rooms.find((r) => r.Item === 'Student Chair')!

    expect(chair['Item Type']).toBe('Single-seater student chair')
    expect(chair.Material).toBe('Wooden seat and backrest with metal frame')
    expect(chair.Colour).toBe('Light Brown / Grey')
    expect(chair['Additional Features']).toBe('Pen groove on tabletop')
    expect(chair['Position in Room']).toBe('Front left corner')
    expect(chair.Description).toContain('grey metal legs')
    expect(chair['AI Assisted']).toBe('Yes')
    expect(chair.Edits).toBe(0)
  })

  it('carries every detail field into the condition report', async () => {
    await populate()
    const { condition } = await buildReportBundle(fx.exercise.id)
    const chair = condition.find((r) => r.Item === 'Student Chair')!

    expect(chair['Item Type']).toBe('Single-seater student chair')
    expect(chair.Material).toBe('Wooden seat and backrest with metal frame')
    expect(chair.Colour).toBe('Light Brown / Grey')
    expect(chair['Additional Features']).toBe('Pen groove on tabletop')
    expect(chair['Position in Room']).toBe('Front left corner')
    expect(chair.Description).toContain('grey metal legs')
    expect(chair['AI Assisted']).toBe('Yes')
  })

  it('reports the same detail columns in all three sheets', async () => {
    await populate()
    const { register, rooms, condition } = await buildReportBundle(fx.exercise.id)
    const DETAILS = [
      'Item Type',
      'Material',
      'Colour',
      'Description',
      'Additional Features',
      'Position in Room',
      'AI Assisted',
    ]
    for (const sheet of [register, rooms, condition]) {
      expect(Object.keys(sheet[0])).toEqual(expect.arrayContaining(DETAILS))
    }
  })
})

describe('condition report', () => {
  it('lists only non-Good items, worst first', async () => {
    await populate()
    const { condition } = await buildReportBundle(fx.exercise.id)
    expect(condition.map((r) => r.Condition)).toEqual(['Unserviceable', 'Poor'])
    expect(condition[0].Item).toBe('Projector Stand')
    expect(condition[1].Quantity).toBe(2)
  })
})

describe('variance report', () => {
  it('covers missing items, unlisted finds and uninspected rooms', async () => {
    await populate()
    const { variance } = await buildReportBundle(fx.exercise.id)
    const types = variance.map((r) => r.Type)
    expect(types).toContain('Expected but not found')
    expect(types).toContain('Unlisted item found')

    const missing = variance.find((r) => r.Type === 'Expected but not found')
    expect(missing?.Item).toBe('Student Table')
    expect(missing?.Room).toBe('P3')
  })

  it('flags a room nobody visited', async () => {
    const { variance } = await buildReportBundle(fx.exercise.id)
    expect(variance.filter((r) => r.Type === 'Room not inspected')).toHaveLength(2)
  })
})

describe('tag register and room totals', () => {
  it('lists every issued tag in sequence', async () => {
    await populate()
    const { tags } = await buildReportBundle(fx.exercise.id)
    expect(tags).toHaveLength(31)
    expect(tags[0]['Tag Number']).toBe('PS-1F-P4-001')
    expect(tags[1]['Tag Number']).toBe('SC-1F-P3-001')
  })

  it('summarises each room including sign-off state', async () => {
    await populate()
    const { roomTotals, summary } = await buildReportBundle(fx.exercise.id)
    const p3 = roomTotals.find((r) => r.Room === 'P3')
    expect(p3?.['Items Found']).toBe(30)
    expect(p3?.['Not Present']).toBe(1)
    expect(p3?.Status).toBe('Signed off')
    expect(p3?.['Signed Off By']).toBe('Team Leader')

    expect(summary.find((r) => r.Metric === 'Items counted')?.Value).toBe(31)
    expect(summary.find((r) => r.Metric === 'Tags issued')?.Value).toBe(31)
    expect(summary.find((r) => r.Metric === 'Organization')?.Value).toBe('Sufa Schools')
  })
})

describe('edit log sheet', () => {
  /** Re-saves the chair entry created by populate(), as a second inspector. */
  async function editChair(over: Partial<Parameters<typeof saveEntry>[0]>) {
    const chair = (await db.entries.toArray()).find((e) => e.assetTypeId === fx.chair.id)!
    return saveEntry({
      id: chair.id,
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 30,
      serialNumbers: ['SN-A'],
      model: 'Classic',
      brand: 'Furnico',
      condition: 'G',
      conditionBreakdown: { G: 28, P: 2 },
      remarks: 'Two seats cracked',
      material: 'Wooden seat and backrest with metal frame',
      colour: 'Light Brown / Grey',
      itemType: 'Single-seater student chair',
      additionalFeatures: 'Pen groove on tabletop',
      description: 'Single-seater student chair with wooden seat, wooden backrest and grey metal legs',
      specificPosition: 'Front left corner',
      inspectorId: fx.inspector2.id,
      notPresent: false,
      ...over,
    })
  }

  it('is empty until something is actually edited', async () => {
    await populate()
    const { editLog } = await buildReportBundle(fx.exercise.id)
    expect(editLog).toEqual([])
  })

  it('names the field in English, the old and new value, and who changed it', async () => {
    await populate()
    await editChair({ brand: 'Dodoma Furniture', material: 'All-metal frame' })

    const { editLog, summary } = await buildReportBundle(fx.exercise.id)
    expect(editLog.map((r) => r.Field)).toEqual(expect.arrayContaining(['Brand', 'Material']))

    const brand = editLog.find((r) => r.Field === 'Brand')!
    expect(brand['Old Value']).toBe('Furnico')
    expect(brand['New Value']).toBe('Dodoma Furniture')
    expect(brand['Edited By']).toBe('Inspector Two')
    expect(brand.Item).toBe('Student Chair')
    expect(brand.Floor).toBe('1st Floor')
    expect(brand.Room).toBe('P3')
    expect(brand['Tag Numbers']).toContain('SC-1F-P3-001')
    expect(String(brand['Edited At'])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    expect(summary.find((r) => r.Metric === 'Field changes logged')?.Value).toBe(editLog.length)
  })

  it('spells out the codes the log stores raw', async () => {
    await populate()
    await editChair({ condition: 'U', conditionBreakdown: undefined })
    await markNotPresent({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      inspectorId: fx.inspector2.id,
    })

    const { editLog } = await buildReportBundle(fx.exercise.id)
    const cond = editLog.filter((r) => r.Field === 'Condition')
    expect(cond.some((r) => r['Old Value'] === 'Good' && r['New Value'] === 'Unserviceable')).toBe(true)

    const absent = editLog.find((r) => r.Field === 'Not present')!
    expect(absent['Old Value']).toBe('No')
    expect(absent['New Value']).toBe('Yes')
  })

  it('puts the newest change first', async () => {
    await populate()
    await editChair({ remarks: 'first change' })
    await editChair({ remarks: 'second change' })

    const { editLog } = await buildReportBundle(fx.exercise.id)
    const remarks = editLog.filter((r) => r.Field === 'Remarks')
    expect(remarks[0]['New Value']).toBe('second change')
    expect(remarks[1]['New Value']).toBe('first change')
  })
})

describe('label data', () => {
  it('carries the entry id and condition so a label can show its photo', async () => {
    await populate()
    const { collectLabels } = await import('./labels')
    const sheet = await collectLabels({ exerciseId: fx.exercise.id, scope: 'exercise' })

    const chair = sheet.labels.find((l) => l.description === 'Student Chair')!
    expect(chair.entryId).toBeTruthy()
    expect(chair.condition).toBe('G')

    // Every tag of a multi-item entry points back at the same entry.
    const chairTags = sheet.labels.filter((l) => l.description === 'Student Chair')
    expect(new Set(chairTags.map((l) => l.entryId)).size).toBe(1)
    expect(chairTags).toHaveLength(30)
  })
})

describe('an item found in the wrong room', () => {
  it('is listed as a variance with where it belongs', async () => {
    await saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room2, // found in P4
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 2,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: 'Carried through for an exam',
      expectedRoomId: fx.room.id, // belongs in P3
      inspectorId: fx.inspector.id,
      notPresent: false,
    })

    const { variance, rooms } = await buildReportBundle(fx.exercise.id)
    const row = variance.find((r) => r.Type === 'Found in the wrong room')!
    expect(row).toBeTruthy()
    expect(row.Item).toBe('Student Chair')
    expect(row.Room).toBe('P4') // where it is
    expect(row['Belongs In']).toContain('P3') // where it should be
    expect(row.Quantity).toBe(2)

    expect(rooms.find((r) => r.Item === 'Student Chair')?.['Belongs In']).toBe('P3')
  })

  it('says nothing when the item is where it belongs', async () => {
    await saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 1,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      // Naming the room it is already in must not read as a misplacement.
      expectedRoomId: fx.room.id,
      inspectorId: fx.inspector.id,
      notPresent: false,
    })

    const { variance } = await buildReportBundle(fx.exercise.id)
    expect(variance.filter((r) => r.Type === 'Found in the wrong room')).toEqual([])
  })
})

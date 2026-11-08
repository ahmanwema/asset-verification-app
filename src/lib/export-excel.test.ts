import { beforeEach, describe, expect, it } from 'vitest'
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

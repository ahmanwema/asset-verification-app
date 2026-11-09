import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import type { AssetFinancialRecord } from '../types'
import { saveEntry } from './entries'
import { buildReportBundle } from './export-excel'
import { calculateDepreciation, saveFinancialRecord } from './depreciation'

const record: AssetFinancialRecord = {
  tagNumber: 'PC-001',
  acquisitionDate: '2024-01-01',
  availableForUseDate: '2024-01-01',
  originalCost: 1_200_000,
  residualValue: 0,
  usefulLifeMonths: 48,
  depreciationMethod: 'diminishing_balance',
  annualDepreciationRate: 25,
  openingAccumulatedDepreciation: 0,
  openingBalanceDate: '',
  supplier: '',
  invoiceNumber: '',
  fundingSource: '',
  notes: '',
  updatedAt: 1,
  updatedBy: 'admin',
}

describe('diminishing-balance depreciation', () => {
  it('calculates accumulated depreciation and net book value', () => {
    const result = calculateDepreciation(record, '2026-01-01')
    expect(result.complete).toBe(true)
    expect(result.accumulatedDepreciation).toBeCloseTo(525_000, -3)
    expect(result.carryingAmount).toBeCloseTo(675_000, -3)
  })

  it('never depreciates below residual value', () => {
    const result = calculateDepreciation({ ...record, residualValue: 200_000 }, '2040-01-01')
    expect(result.accumulatedDepreciation).toBe(1_000_000)
    expect(result.carryingAmount).toBe(200_000)
  })

  it('continues from an approved opening accumulated balance', () => {
    const result = calculateDepreciation(
      { ...record, openingAccumulatedDepreciation: 450_000, openingBalanceDate: '2026-01-01' },
      '2027-01-01',
    )
    expect(result.accumulatedDepreciation).toBeCloseTo(637_500, -3)
  })

  it('marks incomplete records instead of inventing a value', () => {
    expect(calculateDepreciation({ ...record, availableForUseDate: '' }, '2026-01-01').complete).toBe(false)
    expect(calculateDepreciation({ ...record, annualDepreciationRate: 0 }, '2026-01-01').complete).toBe(false)
  })
})

describe('financial records and reports', () => {
  let fx: Fixture

  beforeEach(async () => {
    await resetDb()
    fx = await seedFixture()
  })

  it('stores one financial record per tag and includes it in the schedule', async () => {
    const entry = await saveEntry({
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
    await saveFinancialRecord(
      entry,
      { ...record, tagNumber: entry.tagNumbers[0], updatedBy: fx.inspector.id },
      fx.inspector.id,
    )

    const stored = await db.entries.get(entry.id)
    expect(stored?.financialRecords).toHaveLength(1)
    expect(stored?.syncStatus).toBe('pending')

    const bundle = await buildReportBundle(fx.exercise.id)
    expect(bundle.depreciation).toHaveLength(2)
    expect(bundle.depreciation.filter((row) => row.Status === 'Complete')).toHaveLength(1)
    expect(bundle.depreciation[0]['Original Cost']).toBe(1_200_000)
    expect(bundle.register[0]['Net Book Value']).not.toBe('')
  })

  it('keeps accounting details when the physical inspection is edited later', async () => {
    const entry = await saveEntry({
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
      inspectorId: fx.inspector.id,
      notPresent: false,
    })
    await saveFinancialRecord(entry, { ...record, tagNumber: entry.tagNumbers[0] }, fx.inspector.id)

    await saveEntry({
      id: entry.id,
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity: 1,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'F',
      remarks: 'Condition updated',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })

    expect((await db.entries.get(entry.id))?.financialRecords?.[0].originalCost).toBe(1_200_000)
  })
})

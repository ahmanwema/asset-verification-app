import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { resetDb, seedFixture, type Fixture } from '../test/fixtures'
import type { AssetFinancialRecord } from '../types'
import { saveEntry } from './entries'
import { buildReportBundle } from './export-excel'
import {
  applyFinanceTemplate,
  calculateDepreciation,
  financeGroupKey,
  priorFiscalYearEnd,
  residualAtEndOfLife,
  saveFinancialRecord,
  saveFinancialRecords,
} from './depreciation'

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

  it('writes off the balance the rate leaves at the end of the useful life', () => {
    // 25% reducing balance over 4 years leaves 31.6% of cost standing. The
    // life is an input the accountant gave, so it has to bind.
    const atEndOfLife = calculateDepreciation(record, '2028-01-01')
    expect(atEndOfLife.accumulatedDepreciation).toBe(1_200_000)
    expect(atEndOfLife.carryingAmount).toBe(0)
    expect(Math.round(residualAtEndOfLife(record) ?? 0)).toBe(379_688)

    // One day before the end it is still on the reducing-balance curve.
    const beforeEnd = calculateDepreciation(record, '2027-12-31')
    expect(beforeEnd.carryingAmount).toBeGreaterThan(370_000)
  })

  it('honours an opening balance dated before the available-for-use date', () => {
    const base = { ...record, availableForUseDate: '2024-06-01', openingAccumulatedDepreciation: 500_000 }
    const early = calculateDepreciation({ ...base, openingBalanceDate: '2024-03-01' }, '2025-06-01')
    const onStart = calculateDepreciation({ ...base, openingBalanceDate: '2024-06-01' }, '2025-06-01')
    expect(early.accumulatedDepreciation).toBeCloseTo(onStart.accumulatedDepreciation, 0)
    // The approved 500,000 is carried, not discarded back to a fresh start.
    expect(early.accumulatedDepreciation).toBeGreaterThan(600_000)
  })

  it('marks incomplete records instead of inventing a value', () => {
    expect(calculateDepreciation({ ...record, availableForUseDate: '' }, '2026-01-01').complete).toBe(false)
    expect(calculateDepreciation({ ...record, annualDepreciationRate: 0 }, '2026-01-01').complete).toBe(false)
  })
})

describe('straight-line depreciation', () => {
  const line: AssetFinancialRecord = {
    ...record,
    availableForUseDate: '2022-01-01',
    acquisitionDate: '2022-01-01',
    originalCost: 1_000_000,
    residualValue: 0,
    usefulLifeMonths: 48,
    depreciationMethod: 'straight_line',
    annualDepreciationRate: 0,
  }

  it('spreads the depreciable amount evenly over the life', () => {
    expect(calculateDepreciation(line, '2023-01-01').accumulatedDepreciation).toBeCloseTo(250_000, -3)
    expect(calculateDepreciation(line, '2024-01-01').accumulatedDepreciation).toBeCloseTo(500_000, -3)
  })

  it('reaches exactly the residual value at the end of the life and stops', () => {
    const atEnd = calculateDepreciation({ ...line, residualValue: 100_000 }, '2026-01-01')
    expect(atEnd.accumulatedDepreciation).toBe(900_000)
    expect(atEnd.carryingAmount).toBe(100_000)
    const later = calculateDepreciation({ ...line, residualValue: 100_000 }, '2031-01-01')
    expect(later.carryingAmount).toBe(100_000)
    expect(later.currentPeriodDepreciation).toBe(0)
  })

  it('needs no annual rate, unlike the reducing-balance method', () => {
    expect(calculateDepreciation(line, '2023-01-01').complete).toBe(true)
    expect(calculateDepreciation({ ...line, depreciationMethod: 'diminishing_balance' }, '2023-01-01').complete).toBe(false)
    expect(residualAtEndOfLife(line)).toBeNull()
  })
})

describe('financial year', () => {
  it('finds the year end before a date', () => {
    expect(priorFiscalYearEnd('2026-11-16', 12)).toBe('2025-12-31')
    expect(priorFiscalYearEnd('2026-11-16', 6)).toBe('2026-06-30')
    expect(priorFiscalYearEnd('2026-03-10', 6)).toBe('2025-06-30')
    expect(priorFiscalYearEnd('2026-12-31', 12)).toBe('2025-12-31')
    expect(priorFiscalYearEnd('2027-01-01', 12)).toBe('2026-12-31')
    expect(priorFiscalYearEnd('2028-02-29', 2)).toBe('2027-02-28')
  })

  it('charges the current period against the school year, not the calendar', () => {
    const line: AssetFinancialRecord = {
      ...record,
      availableForUseDate: '2020-01-01',
      originalCost: 1_200_000,
      residualValue: 0,
      usefulLifeMonths: 120,
      depreciationMethod: 'straight_line',
      annualDepreciationRate: 0,
    }
    const june = calculateDepreciation(line, '2026-11-16', 6).currentPeriodDepreciation
    const december = calculateDepreciation(line, '2026-11-16', 12).currentPeriodDepreciation
    // 139 days since 30 June against 320 days since 31 December.
    expect(Math.round(june)).toBe(45_667)
    expect(Math.round(december)).toBe(105_133)
    expect(june).toBeLessThan(december)
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
      { ...record, tagNumber: entry.tagNumbers[0], updatedBy: fx.inspector2.id },
      fx.inspector2.id,
    )

    const stored = await db.entries.get(entry.id)
    expect(stored?.financialRecords).toHaveLength(1)
    expect(stored?.syncStatus).toBe('pending')
    expect(stored?.inspectorId).toBe(fx.inspector.id)
    expect(stored?.editHistory.at(-1)?.editedBy).toBe(fx.inspector2.id)

    const bundle = await buildReportBundle(fx.exercise.id)
    expect(bundle.depreciation).toHaveLength(2)
    expect(bundle.depreciation.filter((row) => row.Status === 'Complete')).toHaveLength(1)
    expect(bundle.depreciation[0]['Original Cost (TZS)']).toBe(1_200_000)
    expect(bundle.register[0]['Net Book Value (TZS)']).not.toBe('')
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

  it('applies one purchase batch to many tags while keeping separate records', async () => {
    const entry = await saveEntry({
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
    const invoiceTotal = 300_000
    const unitCost = invoiceTotal / entry.tagNumbers.length
    await saveFinancialRecords(
      entry,
      entry.tagNumbers.map((tagNumber) => ({ ...record, tagNumber, originalCost: unitCost })),
      fx.inspector.id,
    )

    const stored = await db.entries.get(entry.id)
    expect(stored?.financialRecords).toHaveLength(3)
    expect(stored?.financialRecords?.map((item) => item.tagNumber)).toEqual(entry.tagNumbers)
    expect(stored?.financialRecords?.reduce((sum, item) => sum + item.originalCost, 0)).toBe(invoiceTotal)

    const bundle = await buildReportBundle(fx.exercise.id)
    expect(bundle.depreciation).toHaveLength(3)
    expect(bundle.depreciation.reduce((sum, row) => sum + Number(row['Original Cost (TZS)']), 0)).toBe(invoiceTotal)
  })
})

describe('bulk costing by asset type', () => {
  let fx: Fixture

  beforeEach(async () => {
    await resetDb()
    fx = await seedFixture()
  })

  async function chairEntry(quantity: number) {
    return saveEntry({
      exerciseId: fx.exercise.id,
      room: fx.room,
      floor: fx.floor,
      assetType: fx.chair,
      isUnlistedItem: false,
      quantity,
      serialNumbers: [],
      model: '',
      brand: '',
      condition: 'G',
      remarks: '',
      inspectorId: fx.inspector.id,
      notPresent: false,
    })
  }

  const template = {
    acquisitionDate: '2024-01-01',
    availableForUseDate: '2024-01-01',
    originalCost: 80_000,
    residualValue: 0,
    usefulLifeMonths: 60,
    depreciationMethod: 'straight_line' as const,
    annualDepreciationRate: 0,
    openingAccumulatedDepreciation: 0,
    openingBalanceDate: '',
    supplier: 'Furniture Ltd',
    invoiceNumber: 'INV-9',
    fundingSource: 'School fund',
    notes: '',
  }

  it('writes one record per tag across every entry of the type', async () => {
    const first = await chairEntry(3)
    const second = await chairEntry(2)

    const written = await applyFinanceTemplate(
      fx.exercise.id,
      financeGroupKey(first),
      template,
      { onlyMissing: true },
      fx.inspector.id,
    )

    expect(written).toBe(5)
    const storedFirst = await db.entries.get(first.id)
    const storedSecond = await db.entries.get(second.id)
    expect(storedFirst?.financialRecords).toHaveLength(3)
    expect(storedSecond?.financialRecords).toHaveLength(2)
    // One record per tag, each keyed to its own tag, not a shared row.
    expect(storedFirst?.financialRecords?.map((r) => r.tagNumber).sort()).toEqual([...first.tagNumbers].sort())
    expect(storedFirst?.syncStatus).toBe('pending')
  })

  it('leaves figures entered by hand alone when only the missing are filled', async () => {
    const entry = await chairEntry(2)
    await saveFinancialRecord(
      entry,
      { ...record, tagNumber: entry.tagNumbers[0], originalCost: 999_000 },
      fx.inspector.id,
    )

    const written = await applyFinanceTemplate(
      fx.exercise.id,
      financeGroupKey(entry),
      template,
      { onlyMissing: true },
      fx.inspector.id,
    )

    expect(written).toBe(1)
    const stored = await db.entries.get(entry.id)
    expect(stored?.financialRecords?.find((r) => r.tagNumber === entry.tagNumbers[0])?.originalCost).toBe(999_000)
    expect(stored?.financialRecords?.find((r) => r.tagNumber === entry.tagNumbers[1])?.originalCost).toBe(80_000)
  })

  it('replaces every record of the type when the run is not limited to missing ones', async () => {
    const entry = await chairEntry(2)
    await saveFinancialRecord(
      entry,
      { ...record, tagNumber: entry.tagNumbers[0], originalCost: 999_000 },
      fx.inspector.id,
    )

    const written = await applyFinanceTemplate(
      fx.exercise.id,
      financeGroupKey(entry),
      template,
      { onlyMissing: false },
      fx.inspector.id,
    )

    expect(written).toBe(2)
    const stored = await db.entries.get(entry.id)
    expect(stored?.financialRecords?.every((r) => r.originalCost === 80_000)).toBe(true)
  })
})

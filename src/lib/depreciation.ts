import { db } from '../db/db'
import type { AssetFinancialRecord, InspectionEntry } from '../types'
import { EDIT_HISTORY_LIMIT } from './entries'

export interface DepreciationResult {
  depreciableAmount: number
  accumulatedDepreciation: number
  currentPeriodDepreciation: number
  carryingAmount: number
  complete: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_DAYS = 365.25

function dateValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ts = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ts) ? ts : null
}

function amountThrough(record: AssetFinancialRecord, asOfDate: string): number {
  const asOf = dateValue(asOfDate)
  const start = dateValue(record.availableForUseDate)
  if (asOf === null || start === null || asOf < start || record.usefulLifeMonths <= 0) return 0

  const cap = Math.max(0, record.originalCost - record.residualValue)
  const annual = cap / (record.usefulLifeMonths / 12)
  const openingDate = dateValue(record.openingBalanceDate)
  const opening = Math.min(cap, Math.max(0, record.openingAccumulatedDepreciation || 0))

  if (openingDate !== null && openingDate >= start) {
    if (asOf <= openingDate) return opening
    const elapsedDays = (asOf - openingDate) / DAY_MS
    return Math.min(cap, opening + annual * (elapsedDays / YEAR_DAYS))
  }

  const elapsedDays = (asOf - start) / DAY_MS
  return Math.min(cap, annual * (elapsedDays / YEAR_DAYS))
}

/** Straight-line estimate. The institution's approved policy remains authoritative. */
export function calculateDepreciation(
  record: AssetFinancialRecord | undefined,
  asOfDate: string,
): DepreciationResult {
  const complete = Boolean(
    record &&
      record.availableForUseDate &&
      record.originalCost >= 0 &&
      record.usefulLifeMonths > 0 &&
      record.residualValue >= 0 &&
      record.residualValue <= record.originalCost,
  )
  if (!record || !complete) {
    return { depreciableAmount: 0, accumulatedDepreciation: 0, currentPeriodDepreciation: 0, carryingAmount: 0, complete: false }
  }

  const accumulatedDepreciation = amountThrough(record, asOfDate)
  const year = Number(asOfDate.slice(0, 4))
  const priorYearEnd = Number.isFinite(year) ? `${year - 1}-12-31` : asOfDate
  const openingForYear = amountThrough(record, priorYearEnd)
  const depreciableAmount = Math.max(0, record.originalCost - record.residualValue)

  return {
    depreciableAmount,
    accumulatedDepreciation,
    currentPeriodDepreciation: Math.max(0, accumulatedDepreciation - openingForYear),
    carryingAmount: Math.max(record.residualValue, record.originalCost - accumulatedDepreciation),
    complete: true,
  }
}

export function financialRecordFor(entry: InspectionEntry, tagNumber: string): AssetFinancialRecord | undefined {
  return (entry.financialRecords ?? []).find((record) => record.tagNumber === tagNumber)
}

export function financialRecordComplete(record: AssetFinancialRecord | undefined): boolean {
  return Boolean(
    record &&
      record.acquisitionDate &&
      record.availableForUseDate &&
      record.originalCost >= 0 &&
      record.usefulLifeMonths > 0 &&
      record.residualValue >= 0 &&
      record.residualValue <= record.originalCost,
  )
}

export async function saveFinancialRecord(
  entry: InspectionEntry,
  record: AssetFinancialRecord,
  actorId: string,
): Promise<void> {
  const records = [...(entry.financialRecords ?? [])]
  const index = records.findIndex((item) => item.tagNumber === record.tagNumber)
  const before = index >= 0 ? records[index] : undefined
  if (index >= 0) records[index] = record
  else records.push(record)

  const summary = (item: AssetFinancialRecord | undefined) =>
    item ? `${item.originalCost}|${item.availableForUseDate}|${item.usefulLifeMonths}` : ''
  const history = summary(before) === summary(record)
    ? (entry.editHistory ?? [])
    : [
        ...(entry.editHistory ?? []),
        {
          field: 'financialDetails',
          oldValue: summary(before),
          newValue: summary(record),
          editedBy: actorId,
          editedAt: Date.now(),
        },
      ].slice(-EDIT_HISTORY_LIMIT)

  await db.entries.put({
    ...entry,
    financialRecords: records,
    editHistory: history,
    inspectorId: actorId,
    updatedAt: Date.now(),
    syncStatus: 'pending',
  })
}

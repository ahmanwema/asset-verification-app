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
  const rate = record.annualDepreciationRate / 100
  const openingDate = dateValue(record.openingBalanceDate)
  const opening = Math.min(cap, Math.max(0, record.openingAccumulatedDepreciation || 0))

  if (!(rate > 0 && rate <= 1)) return 0

  if (openingDate !== null && openingDate >= start) {
    if (asOf <= openingDate) return opening
    const elapsedDays = (asOf - openingDate) / DAY_MS
    const openingCarryingAmount = Math.max(record.residualValue, record.originalCost - opening)
    const carryingAmount = Math.max(
      record.residualValue,
      openingCarryingAmount * Math.pow(1 - rate, elapsedDays / YEAR_DAYS),
    )
    return Math.min(cap, record.originalCost - carryingAmount)
  }

  const elapsedDays = (asOf - start) / DAY_MS
  const carryingAmount = Math.max(
    record.residualValue,
    record.originalCost * Math.pow(1 - rate, elapsedDays / YEAR_DAYS),
  )
  return Math.min(cap, record.originalCost - carryingAmount)
}

/** Fixed-rate diminishing-balance estimate. The approved policy remains authoritative. */
export function calculateDepreciation(
  record: AssetFinancialRecord | undefined,
  asOfDate: string,
): DepreciationResult {
  const complete = Boolean(
    record &&
      record.availableForUseDate &&
      record.originalCost >= 0 &&
      record.usefulLifeMonths > 0 &&
      record.annualDepreciationRate > 0 &&
      record.annualDepreciationRate <= 100 &&
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
      record.annualDepreciationRate > 0 &&
      record.annualDepreciationRate <= 100 &&
      record.residualValue >= 0 &&
      record.residualValue <= record.originalCost,
  )
}

export async function saveFinancialRecord(
  entry: InspectionEntry,
  record: AssetFinancialRecord,
  actorId: string,
): Promise<void> {
  await saveFinancialRecords(entry, [record], actorId)
}

/** Writes a purchase batch in one IndexedDB update, so sync never sees half a batch. */
export async function saveFinancialRecords(
  entry: InspectionEntry,
  incoming: AssetFinancialRecord[],
  actorId: string,
): Promise<void> {
  const records = [...(entry.financialRecords ?? [])]
  const summary = (item: AssetFinancialRecord | undefined) => item
    ? JSON.stringify({
        acquisitionDate: item.acquisitionDate,
        availableForUseDate: item.availableForUseDate,
        originalCost: item.originalCost,
        residualValue: item.residualValue,
        usefulLifeMonths: item.usefulLifeMonths,
        depreciationMethod: item.depreciationMethod,
        annualDepreciationRate: item.annualDepreciationRate,
        openingAccumulatedDepreciation: item.openingAccumulatedDepreciation,
        openingBalanceDate: item.openingBalanceDate,
        supplier: item.supplier,
        invoiceNumber: item.invoiceNumber,
        fundingSource: item.fundingSource,
        notes: item.notes,
      })
    : ''
  let changed = false
  for (const record of incoming) {
    const index = records.findIndex((item) => item.tagNumber === record.tagNumber)
    const before = index >= 0 ? records[index] : undefined
    if (summary(before) !== summary(record)) changed = true
    if (index >= 0) records[index] = record
    else records.push(record)
  }

  const history = !changed
    ? (entry.editHistory ?? [])
    : [
        ...(entry.editHistory ?? []),
        {
          field: 'financialDetails',
          oldValue: incoming.length === 1 ? summary(financialRecordFor(entry, incoming[0].tagNumber)) : '',
          newValue: incoming.length === 1 ? summary(incoming[0]) : `Batch: ${incoming.length} assets`,
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

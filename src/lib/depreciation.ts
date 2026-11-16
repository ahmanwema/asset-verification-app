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
const DEFAULT_FISCAL_YEAR_END_MONTH = 12

function dateValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ts = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ts) ? ts : null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Last calendar day of a month, so a February year end lands on 28 or 29. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The financial year end immediately before `asOfDate`. The charge for the
 * current period is whatever has accrued since that day, so a school whose
 * year ends in June gets its own period rather than a calendar one.
 */
export function priorFiscalYearEnd(asOfDate: string, fiscalYearEndMonth = DEFAULT_FISCAL_YEAR_END_MONTH): string {
  const month = Number(asOfDate.slice(5, 7))
  const day = Number(asOfDate.slice(8, 10))
  const year = Number(asOfDate.slice(0, 4))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return asOfDate
  const end = Math.min(12, Math.max(1, Math.round(fiscalYearEndMonth) || DEFAULT_FISCAL_YEAR_END_MONTH))
  const endedThisYear = month > end || (month === end && day > lastDayOfMonth(year, end))
  const y = endedThisYear ? year : year - 1
  return `${y}-${pad(end)}-${pad(lastDayOfMonth(y, end))}`
}

/** True when the method needs an annual rate; straight line derives it from the life. */
function usesRate(record: AssetFinancialRecord): boolean {
  return record.depreciationMethod !== 'straight_line'
}

function amountThrough(record: AssetFinancialRecord, asOfDate: string): number {
  const asOf = dateValue(asOfDate)
  const start = dateValue(record.availableForUseDate)
  if (asOf === null || start === null || asOf < start || record.usefulLifeMonths <= 0) return 0

  const cap = Math.max(0, record.originalCost - record.residualValue)
  if (cap === 0) return 0
  const lifeDays = (record.usefulLifeMonths / 12) * YEAR_DAYS
  const opening = Math.min(cap, Math.max(0, record.openingAccumulatedDepreciation || 0))

  // An approved opening balance is never discarded. Dated before the asset was
  // available for use — or left undated — it is taken to stand at the start
  // date rather than dropped, which used to happen silently.
  const openingRaw = dateValue(record.openingBalanceDate)
  const openingDate = openingRaw === null ? (opening > 0 ? start : null) : Math.max(openingRaw, start)
  const from = openingDate ?? start
  const base = openingDate === null ? 0 : opening
  if (asOf <= from) return base

  const elapsedDays = (asOf - from) / DAY_MS
  const consumedDays = (from - start) / DAY_MS
  // Useful life is an input the accountant entered, so it has to bind: at the
  // end of the life the asset stands at its residual value under either
  // method, and any balance the rate has not written off is written off then.
  if (consumedDays + elapsedDays >= lifeDays) return cap

  if (record.depreciationMethod === 'straight_line') {
    return Math.min(cap, base + (cap * elapsedDays) / lifeDays)
  }

  const rate = record.annualDepreciationRate / 100
  if (!(rate > 0 && rate <= 1)) return 0
  const carryingAtStart = Math.max(record.residualValue, record.originalCost - base)
  const carryingAmount = Math.max(
    record.residualValue,
    carryingAtStart * Math.pow(1 - rate, elapsedDays / YEAR_DAYS),
  )
  return Math.min(cap, record.originalCost - carryingAmount)
}

/**
 * Depreciation to `asOfDate` under the record's own method. The approved
 * accounting policy remains authoritative; this is the register's estimate.
 */
export function calculateDepreciation(
  record: AssetFinancialRecord | undefined,
  asOfDate: string,
  fiscalYearEndMonth = DEFAULT_FISCAL_YEAR_END_MONTH,
): DepreciationResult {
  const complete = Boolean(
    record &&
      record.availableForUseDate &&
      record.originalCost >= 0 &&
      record.usefulLifeMonths > 0 &&
      record.residualValue >= 0 &&
      record.residualValue <= record.originalCost &&
      (!usesRate(record) || (record.annualDepreciationRate > 0 && record.annualDepreciationRate <= 100)),
  )
  if (!record || !complete) {
    return { depreciableAmount: 0, accumulatedDepreciation: 0, currentPeriodDepreciation: 0, carryingAmount: 0, complete: false }
  }

  const accumulatedDepreciation = amountThrough(record, asOfDate)
  const openingForYear = amountThrough(record, priorFiscalYearEnd(asOfDate, fiscalYearEndMonth))
  const depreciableAmount = Math.max(0, record.originalCost - record.residualValue)

  return {
    depreciableAmount,
    accumulatedDepreciation,
    currentPeriodDepreciation: Math.max(0, accumulatedDepreciation - openingForYear),
    carryingAmount: Math.max(record.residualValue, record.originalCost - accumulatedDepreciation),
    complete: true,
  }
}

/**
 * Carrying amount the rate alone would leave at the end of the useful life.
 * A reducing-balance rate rarely lands exactly on the residual value, and the
 * difference is written off in the final period — the editor says so before
 * the figure is saved rather than leaving it to be discovered in the export.
 */
export function residualAtEndOfLife(record: AssetFinancialRecord): number | null {
  if (record.depreciationMethod === 'straight_line') return null
  const rate = record.annualDepreciationRate / 100
  if (!(rate > 0 && rate <= 1) || record.usefulLifeMonths <= 0 || record.originalCost <= 0) return null
  const years = record.usefulLifeMonths / 12
  return Math.max(record.residualValue, record.originalCost * Math.pow(1 - rate, years))
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
      record.residualValue <= record.originalCost &&
      (!usesRate(record) || (record.annualDepreciationRate > 0 && record.annualDepreciationRate <= 100)),
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
    // Keep the original recorder; the finance editor is already in history.
    inspectorId: entry.inspectorId,
    updatedAt: Date.now(),
    syncStatus: 'pending',
  })
}

/** One tagged item that a bulk costing run can write to. */
export interface FinanceTarget {
  entry: InspectionEntry
  tagNumber: string
  hasRecord: boolean
}

/** Everything that can carry a cost, grouped per asset type for bulk entry. */
export async function financeTargets(exerciseId: string): Promise<FinanceTarget[]> {
  const entries = await db.entries.where('exerciseId').equals(exerciseId).toArray()
  const targets: FinanceTarget[] = []
  for (const entry of entries) {
    if (entry.deleted || entry.notPresent) continue
    for (const tagNumber of entry.tagNumbers) {
      targets.push({ entry, tagNumber, hasRecord: Boolean(financialRecordFor(entry, tagNumber)) })
    }
  }
  return targets
}

/** The key a bulk run groups by: a listed type, or the name of an unlisted item. */
export function financeGroupKey(entry: InspectionEntry): string {
  return entry.isUnlistedItem ? `unlisted:${entry.unlistedItemName ?? ''}` : (entry.assetTypeId ?? '')
}

export type FinanceTemplate = Omit<AssetFinancialRecord, 'tagNumber' | 'updatedAt' | 'updatedBy'>

/**
 * Writes one financial record per tag across every entry of one asset type.
 *
 * A school buys its furniture in identical batches, so costing them one tag at
 * a time means thousands of passes through the editor. The write is grouped by
 * entry, so each entry is saved once however many of its tags are covered, and
 * `onlyMissing` keeps a bulk run from overwriting figures entered by hand.
 */
export async function applyFinanceTemplate(
  exerciseId: string,
  groupKey: string,
  template: FinanceTemplate,
  options: { onlyMissing: boolean },
  actorId: string,
): Promise<number> {
  const targets = (await financeTargets(exerciseId)).filter(
    (target) => financeGroupKey(target.entry) === groupKey && (!options.onlyMissing || !target.hasRecord),
  )
  const byEntry = new Map<string, { entry: InspectionEntry; tags: string[] }>()
  for (const target of targets) {
    const group = byEntry.get(target.entry.id) ?? { entry: target.entry, tags: [] }
    group.tags.push(target.tagNumber)
    byEntry.set(target.entry.id, group)
  }

  const savedAt = Date.now()
  let written = 0
  for (const { entry, tags } of byEntry.values()) {
    // Re-read inside the loop: an entry may have been edited since the scan.
    const current = await db.entries.get(entry.id)
    if (!current || current.deleted) continue
    await saveFinancialRecords(
      current,
      tags.map((tagNumber) => ({ ...template, tagNumber, updatedAt: savedAt, updatedBy: actorId })),
      actorId,
    )
    written += tags.length
  }
  return written
}

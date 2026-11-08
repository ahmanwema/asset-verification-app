import type * as XLSXTypes from 'xlsx'
import { db } from '../db/db'
import { entryConditionCounts } from './queries'
import type { Condition, InspectionEntry } from '../types'
import { CONDITIONS } from '../types'

const CONDITION_LABEL: Record<Condition, string> = {
  G: 'Good',
  F: 'Fair',
  P: 'Poor',
  U: 'Unserviceable',
}

/** Unserviceable first — that is the order a maintenance team acts on. */
const CONDITION_PRIORITY: Record<Condition, number> = { U: 1, P: 2, F: 3, G: 4 }

export type ReportKind = 'register' | 'rooms' | 'condition' | 'variance' | 'tags'

export interface ReportBundle {
  meta: {
    organization: string
    address: string
    exercise: string
    date: string
    approvedBy: string
    teamLeader: string
    generatedAt: string
  }
  summary: Array<Record<string, string | number>>
  register: Array<Record<string, string | number>>
  rooms: Array<Record<string, string | number>>
  roomTotals: Array<Record<string, string | number>>
  condition: Array<Record<string, string | number>>
  variance: Array<Record<string, string | number>>
  tags: Array<Record<string, string | number>>
}

function fmtDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function conditionSummary(entry: InspectionEntry): string {
  const counts = entryConditionCounts(entry)
  const parts = CONDITIONS.filter((c) => (counts[c] ?? 0) > 0).map((c) => `${counts[c]} ${CONDITION_LABEL[c]}`)
  return parts.join(', ')
}

/** Pulls everything the reports need and shapes the rows for each sheet. */
export async function buildReportBundle(exerciseId: string): Promise<ReportBundle> {
  const [exercise, floors, rooms, assetTypes, inspectors, entriesRaw, signoffs, orgs] = await Promise.all([
    db.exercises.get(exerciseId),
    db.floors.where('exerciseId').equals(exerciseId).toArray(),
    db.rooms.where('exerciseId').equals(exerciseId).toArray(),
    db.assetTypes.toArray(),
    db.inspectors.toArray(),
    db.entries.where('exerciseId').equals(exerciseId).toArray(),
    db.signoffs.where('exerciseId').equals(exerciseId).toArray(),
    db.organizations.toArray(),
  ])

  const org = orgs.find((o) => o.id === exercise?.orgId) ?? orgs[0]
  const floorById = new Map(floors.map((f) => [f.id, f]))
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  const typeById = new Map(assetTypes.map((a) => [a.id, a]))
  const whoById = new Map(inspectors.map((i) => [i.id, i]))
  const signoffByRoom = new Map(signoffs.filter((s) => !s.deleted).map((s) => [s.roomId, s]))
  const entries = entriesRaw.filter((e) => !e.deleted)

  const locationOf = (roomId: string) => {
    const room = roomById.get(roomId)
    const floor = room ? floorById.get(room.floorId) : undefined
    return {
      floorName: floor?.name ?? '',
      floorCode: floor?.code ?? '',
      floorOrder: floor?.sortOrder ?? 99,
      roomName: room?.name ?? '',
      roomCode: room?.code ?? '',
      roomOrder: room?.sortOrder ?? 99,
    }
  }

  const sorted = [...entries].sort((a, b) => {
    const la = locationOf(a.roomId)
    const lb = locationOf(b.roomId)
    if (la.floorOrder !== lb.floorOrder) return la.floorOrder - lb.floorOrder
    if (la.roomOrder !== lb.roomOrder) return la.roomOrder - lb.roomOrder
    return (a.tagNumbers[0] ?? '').localeCompare(b.tagNumbers[0] ?? '')
  })

  const nameOf = (e: InspectionEntry) =>
    e.isUnlistedItem ? (e.unlistedItemName ?? 'Unlisted item') : (typeById.get(e.assetTypeId ?? '')?.name ?? 'Unknown')

  // --- Fixed assets register: one row per tagged item ---------------------
  const register: Array<Record<string, string | number>> = []
  for (const e of sorted) {
    if (e.notPresent || e.quantity === 0) continue
    const loc = locationOf(e.roomId)
    const at = typeById.get(e.assetTypeId ?? '')
    const counts = entryConditionCounts(e)
    // Expand the breakdown into a per-item condition list, worst first.
    const perItem: Condition[] = []
    for (const c of CONDITIONS) for (let i = 0; i < (counts[c] ?? 0); i += 1) perItem.push(c)
    const tags = e.tagNumbers.length > 0 ? e.tagNumbers : Array.from({ length: e.quantity }, () => '')

    tags.forEach((tag, i) => {
      register.push({
        'Tag Number': tag,
        'Asset Description': nameOf(e),
        'Asset Code': e.isUnlistedItem ? 'UNLISTED' : (at?.code ?? ''),
        Category: e.isUnlistedItem ? 'Unlisted' : (at?.category ?? ''),
        Floor: loc.floorName,
        Room: loc.roomName,
        'Serial Number': e.serialNumbers[i] ?? e.serialNumbers[0] ?? 'N/A',
        Brand: e.brand,
        Model: e.model,
        Condition: CONDITION_LABEL[perItem[i] ?? e.condition],
        'Qty in Entry': e.quantity,
        Photos: e.photoIds.length,
        Inspector: whoById.get(e.inspectorId)?.name ?? '',
        'Inspected At': fmtDate(e.inspectedAt),
        Remarks: e.remarks,
      })
    })
  }

  // --- Room-by-room summary ----------------------------------------------
  const roomRows: Array<Record<string, string | number>> = []
  const roomTotals: Array<Record<string, string | number>> = []
  const orderedRooms = [...rooms].sort((a, b) => {
    const fa = floorById.get(a.floorId)?.sortOrder ?? 99
    const fb = floorById.get(b.floorId)?.sortOrder ?? 99
    return fa !== fb ? fa - fb : a.sortOrder - b.sortOrder
  })

  for (const room of orderedRooms) {
    const loc = locationOf(room.id)
    const roomEntries = sorted.filter((e) => e.roomId === room.id)
    const signoff = signoffByRoom.get(room.id)

    for (const e of roomEntries) {
      roomRows.push({
        Floor: loc.floorName,
        Room: room.name,
        Item: nameOf(e),
        Quantity: e.notPresent ? 0 : e.quantity,
        Condition: e.notPresent ? 'Not present' : conditionSummary(e),
        'Tag Numbers': e.tagNumbers.join(', '),
        'Serial Numbers': e.serialNumbers.join(', '),
        Brand: e.brand,
        Model: e.model,
        Photos: e.photoIds.length,
        Remarks: e.remarks,
        Inspector: whoById.get(e.inspectorId)?.name ?? '',
      })
    }

    const found = roomEntries.filter((e) => !e.notPresent).reduce((n, e) => n + e.quantity, 0)
    roomTotals.push({
      Floor: loc.floorName,
      Room: room.name,
      'Room Code': room.code,
      'Item Types Checked': new Set(roomEntries.filter((e) => !e.isUnlistedItem).map((e) => e.assetTypeId)).size,
      'Items Found': found,
      'Tags Issued': roomEntries.reduce((n, e) => n + e.tagNumbers.length, 0),
      'Not Present': roomEntries.filter((e) => e.notPresent).length,
      Unlisted: roomEntries.filter((e) => e.isUnlistedItem).length,
      Status: signoff ? 'Signed off' : roomEntries.length > 0 ? 'In progress' : 'Not started',
      'Signed Off By': signoff ? (whoById.get(signoff.inspectorId)?.name ?? '') : '',
      'Signed At': signoff ? fmtDate(signoff.signedAt) : '',
      'Sign-off Notes': signoff?.notes ?? '',
    })
  }

  // --- Condition report: anything not Good, worst first -------------------
  const condition: Array<Record<string, string | number>> = []
  for (const e of sorted) {
    if (e.notPresent) continue
    const counts = entryConditionCounts(e)
    const loc = locationOf(e.roomId)
    for (const c of CONDITIONS) {
      const n = counts[c] ?? 0
      if (n === 0 || c === 'G') continue
      condition.push({
        Priority: CONDITION_PRIORITY[c],
        Condition: CONDITION_LABEL[c],
        Quantity: n,
        Item: nameOf(e),
        Floor: loc.floorName,
        Room: loc.roomName,
        'Tag Numbers': e.tagNumbers.join(', '),
        'Serial Numbers': e.serialNumbers.join(', '),
        Brand: e.brand,
        Model: e.model,
        Remarks: e.remarks,
        Inspector: whoById.get(e.inspectorId)?.name ?? '',
        'Inspected At': fmtDate(e.inspectedAt),
      })
    }
  }
  condition.sort((a, b) => Number(a.Priority) - Number(b.Priority))

  // --- Variance report: expected-but-missing, plus unlisted finds ---------
  const variance: Array<Record<string, string | number>> = []
  for (const e of sorted) {
    const loc = locationOf(e.roomId)
    if (e.notPresent) {
      variance.push({
        Type: 'Expected but not found',
        Item: nameOf(e),
        Floor: loc.floorName,
        Room: loc.roomName,
        Quantity: 0,
        Remarks: e.remarks,
        Inspector: whoById.get(e.inspectorId)?.name ?? '',
        'Recorded At': fmtDate(e.inspectedAt),
      })
    } else if (e.isUnlistedItem) {
      variance.push({
        Type: 'Unlisted item found',
        Item: nameOf(e),
        Floor: loc.floorName,
        Room: loc.roomName,
        Quantity: e.quantity,
        Remarks: e.remarks,
        Inspector: whoById.get(e.inspectorId)?.name ?? '',
        'Recorded At': fmtDate(e.inspectedAt),
      })
    }
  }

  // Rooms never visited are a variance too: nothing was recorded at all.
  for (const room of orderedRooms) {
    const loc = locationOf(room.id)
    if (!sorted.some((e) => e.roomId === room.id)) {
      variance.push({
        Type: 'Room not inspected',
        Item: '',
        Floor: loc.floorName,
        Room: room.name,
        Quantity: 0,
        Remarks: '',
        Inspector: '',
        'Recorded At': '',
      })
    }
  }

  // --- Tag register -------------------------------------------------------
  const tags: Array<Record<string, string | number>> = []
  for (const e of sorted) {
    const loc = locationOf(e.roomId)
    e.tagNumbers.forEach((tag, i) => {
      tags.push({
        'Tag Number': tag,
        'Asset Description': nameOf(e),
        Floor: loc.floorName,
        Room: loc.roomName,
        'Serial Number': e.serialNumbers[i] ?? '',
        Condition: CONDITION_LABEL[e.condition],
        'Issued At': fmtDate(e.inspectedAt),
        Printed: '',
      })
    })
  }
  tags.sort((a, b) => String(a['Tag Number']).localeCompare(String(b['Tag Number'])))

  const conditionTotals = entries.reduce(
    (acc, e) => {
      const counts = entryConditionCounts(e)
      for (const c of CONDITIONS) acc[c] += counts[c] ?? 0
      return acc
    },
    { G: 0, F: 0, P: 0, U: 0 } as Record<Condition, number>,
  )

  const summary: Array<Record<string, string | number>> = [
    { Metric: 'Organization', Value: org?.name ?? '' },
    { Metric: 'Address', Value: org?.address ?? '' },
    { Metric: 'Exercise', Value: exercise?.name ?? '' },
    { Metric: 'Exercise date', Value: exercise?.date ?? '' },
    { Metric: 'Team leader', Value: whoById.get(exercise?.teamLeaderId ?? '')?.name ?? '' },
    { Metric: 'Approval authority', Value: exercise?.approvedBy ?? '' },
    { Metric: 'Report generated', Value: fmtDate(Date.now()) },
    { Metric: 'Floors', Value: floors.length },
    { Metric: 'Rooms', Value: rooms.length },
    { Metric: 'Rooms signed off', Value: signoffByRoom.size },
    { Metric: 'Asset types in catalog', Value: assetTypes.filter((a) => a.active).length },
    { Metric: 'Items counted', Value: entries.filter((e) => !e.notPresent).reduce((n, e) => n + e.quantity, 0) },
    { Metric: 'Tags issued', Value: tags.length },
    { Metric: 'Photos attached', Value: entries.reduce((n, e) => n + e.photoIds.length, 0) },
    { Metric: 'Good', Value: conditionTotals.G },
    { Metric: 'Fair', Value: conditionTotals.F },
    { Metric: 'Poor', Value: conditionTotals.P },
    { Metric: 'Unserviceable', Value: conditionTotals.U },
    { Metric: 'Expected but not found', Value: entries.filter((e) => e.notPresent).length },
    { Metric: 'Unlisted items found', Value: entries.filter((e) => e.isUnlistedItem).length },
  ]

  return {
    meta: {
      organization: org?.name ?? '',
      address: org?.address ?? '',
      exercise: exercise?.name ?? '',
      date: exercise?.date ?? '',
      approvedBy: exercise?.approvedBy ?? '',
      teamLeader: whoById.get(exercise?.teamLeaderId ?? '')?.name ?? '',
      generatedAt: fmtDate(Date.now()),
    },
    summary,
    register,
    rooms: roomRows,
    roomTotals,
    condition,
    variance,
    tags,
  }
}

/**
 * SheetJS is ~430 KB — a third of the bundle — and only ever runs when someone
 * taps Export, so it is loaded on demand. The service worker still precaches the
 * chunk, so exporting keeps working with no signal.
 */
let xlsxPromise: Promise<typeof XLSXTypes> | null = null
function loadXlsx(): Promise<typeof XLSXTypes> {
  xlsxPromise ??= import('xlsx')
  return xlsxPromise
}

function sheetFrom(XLSX: typeof XLSXTypes, rows: Array<Record<string, string | number>>, placeholder: string): XLSXTypes.WorkSheet {
  if (rows.length === 0) return XLSX.utils.aoa_to_sheet([[placeholder]])
  const ws = XLSX.utils.json_to_sheet(rows)
  const headers = Object.keys(rows[0])
  ws['!cols'] = headers.map((h) => {
    const longest = rows.reduce((max, r) => Math.max(max, String(r[h] ?? '').length), h.length)
    return { wch: Math.min(42, Math.max(10, longest + 2)) }
  })
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) }
  ws['!freeze'] = { xSplit: '0', ySplit: '1' }
  return ws
}

function fileName(bundle: ReportBundle, suffix: string): string {
  const org = (bundle.meta.organization || 'Organization').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  const date = bundle.meta.date || new Date().toISOString().slice(0, 10)
  return `${org}-${suffix}-${date}.xlsx`
}

const SHEETS: Record<ReportKind, { name: string; suffix: string }> = {
  register: { name: 'Fixed Assets Register', suffix: 'Assets-Register' },
  rooms: { name: 'Room Summary', suffix: 'Room-Summary' },
  condition: { name: 'Condition Report', suffix: 'Condition-Report' },
  variance: { name: 'Variance Report', suffix: 'Variance-Report' },
  tags: { name: 'Tag Register', suffix: 'Tag-Register' },
}

/** Downloads a single report as its own workbook. */
export async function exportReport(exerciseId: string, kind: ReportKind): Promise<number> {
  const [XLSX, bundle] = await Promise.all([loadXlsx(), buildReportBundle(exerciseId)])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.summary, 'No data'), 'Summary')

  const rows =
    kind === 'register'
      ? bundle.register
      : kind === 'rooms'
        ? bundle.rooms
        : kind === 'condition'
          ? bundle.condition
          : kind === 'variance'
            ? bundle.variance
            : bundle.tags

  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, rows, 'Nothing recorded yet'), SHEETS[kind].name)
  if (kind === 'rooms') {
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.roomTotals, 'No rooms'), 'Room Totals')
  }
  XLSX.writeFile(wb, fileName(bundle, SHEETS[kind].suffix))
  return rows.length
}

/** Downloads every report as one multi-sheet workbook. */
export async function exportFullWorkbook(exerciseId: string): Promise<number> {
  const [XLSX, bundle] = await Promise.all([loadXlsx(), buildReportBundle(exerciseId)])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.summary, 'No data'), 'Summary')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.register, 'Nothing recorded yet'), 'Fixed Assets Register')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.rooms, 'Nothing recorded yet'), 'Room Summary')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.roomTotals, 'No rooms'), 'Room Totals')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.condition, 'No items need attention'), 'Condition Report')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.variance, 'No variances'), 'Variance Report')
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, bundle.tags, 'No tags issued'), 'Tag Register')
  XLSX.writeFile(wb, fileName(bundle, 'Verification-Workbook'))
  return bundle.register.length
}

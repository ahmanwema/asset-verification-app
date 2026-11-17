import { db } from '../db/db'
import { itemDetailFor } from './entries'
import { assetCodeFor, formatTag, parseTag } from './tags'
import type { Condition } from '../types'

export type LabelScope = 'room' | 'floor' | 'exercise'

export interface LabelData {
  tag: string
  description: string
  block: string
  floor: string
  room: string
  serial: string
  brand: string
  model: string
  photoCount: number
  photoIds: string[]
  /** The entry this tag belongs to, so its photos can be shown before printing. */
  entryId: string
  roomId: string
  /** False when the label still contains codes from a room it was moved out of. */
  tagMatchesLocation: boolean
  condition: Condition
}

export interface LabelSheet {
  organization: string
  verifiedOn: string
  labels: LabelData[]
}

export type LabelSearchField = 'block' | 'floor' | 'room' | 'description' | 'brand'

export interface LabelSearchTerm {
  field: LabelSearchField
  value: string
}

/** Selected suggestion chips are field-specific and combine with AND logic. */
export function labelMatchesSearchTerms(label: LabelData, terms: LabelSearchTerm[]): boolean {
  return terms.every((term) => label[term.field].localeCompare(term.value, undefined, { sensitivity: 'base' }) === 0)
}

/** Builds de-duplicated location, asset and brand suggestions from the current result set. */
export function labelSearchSuggestions(
  labels: LabelData[],
  selected: LabelSearchTerm[],
  query: string,
  limit?: number,
): LabelSearchTerm[] {
  const needle = query.trim().toLocaleLowerCase()
  const blockSelected = selected.some((term) => term.field === 'block')
  const floorSelected = selected.some((term) => term.field === 'floor')

  const selectedKeys = new Set(selected.map((term) => `${term.field}\u0000${term.value.toLocaleLowerCase()}`))
  const options = new Map<string, LabelSearchTerm>()
  for (const label of labels) {
    if (!labelMatchesSearchTerms(label, selected)) continue
    // With an empty search, show every room immediately. Once a block is
    // selected, place its floors above the rooms so the user can narrow the
    // location hierarchically. Typed searches still cover every field.
    const candidates: LabelSearchTerm[] = needle
      ? [
          { field: 'block', value: label.block },
          { field: 'floor', value: label.floor },
          { field: 'room', value: label.room },
          { field: 'description', value: label.description },
          { field: 'brand', value: label.brand },
        ]
      : blockSelected && !floorSelected
        ? [
            { field: 'floor', value: label.floor },
            { field: 'room', value: label.room },
          ]
        : [{ field: 'room', value: label.room }]
    for (const candidate of candidates) {
      const value = candidate.value.trim()
      const key = `${candidate.field}\u0000${value.toLocaleLowerCase()}`
      if (!value || selectedKeys.has(key) || (needle && !value.toLocaleLowerCase().includes(needle))) continue
      if (!options.has(key)) options.set(key, { ...candidate, value })
    }
  }

  const suggestions = [...options.values()]
    .sort((a, b) => {
      const aStarts = a.value.toLocaleLowerCase().startsWith(needle)
      const bStarts = b.value.toLocaleLowerCase().startsWith(needle)
      const fieldOrder: Record<LabelSearchField, number> = {
        block: 0,
        floor: 1,
        room: 2,
        description: 3,
        brand: 4,
      }
      return Number(bStarts) - Number(aStarts) ||
        (!needle ? fieldOrder[a.field] - fieldOrder[b.field] : 0) ||
        a.value.localeCompare(b.value) ||
        fieldOrder[a.field] - fieldOrder[b.field]
    })
  return limit === undefined ? suggestions : suggestions.slice(0, limit)
}

/**
 * Matches every search term independently, so one query can combine fields.
 * For example, "Reception Mouse Logitech" can match room + item + brand.
 */
export function labelMatchesQuery(label: LabelData, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/[\s,]+/).filter(Boolean)
  if (terms.length === 0) return true

  const values = [
    label.tag,
    label.description,
    label.block,
    label.floor,
    label.room,
    label.serial,
    label.brand,
    label.model,
  ].map((value) => value.toLocaleLowerCase())

  return terms.every((term) => values.some((value) => value.includes(term)))
}

/** Gathers the tags to print for a room, a floor or the whole exercise. */
export async function collectLabels(opts: {
  exerciseId: string
  scope: LabelScope
  roomId?: string
  floorId?: string
}): Promise<LabelSheet> {
  const [exercise, blocks, floors, rooms, assetTypes, entriesRaw, orgs] = await Promise.all([
    db.exercises.get(opts.exerciseId),
    db.blocks.where('exerciseId').equals(opts.exerciseId).toArray().then((rows) => rows.filter((block) => !block.deleted)),
    db.floors
      .where('exerciseId')
      .equals(opts.exerciseId)
      .toArray()
      .then((rows) => rows.filter((floor) => !floor.deleted)),
    db.rooms
      .where('exerciseId')
      .equals(opts.exerciseId)
      .toArray()
      .then((rows) => rows.filter((room) => !room.deleted)),
    db.assetTypes.toArray(),
    db.entries.where('exerciseId').equals(opts.exerciseId).toArray(),
    db.organizations.toArray(),
  ])

  const blockById = new Map(blocks.map((b) => [b.id, b]))
  const floorById = new Map(floors.map((f) => [f.id, f]))
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  const typeById = new Map(assetTypes.map((a) => [a.id, a]))
  const org = orgs.find((o) => o.id === exercise?.orgId)

  const inScope = entriesRaw.filter((e) => {
    if (e.deleted || e.tagNumbers.length === 0) return false
    if (opts.scope === 'room') return e.roomId === opts.roomId
    if (opts.scope === 'floor') return roomById.get(e.roomId)?.floorId === opts.floorId
    return true
  })

  const labels: Array<LabelData & { blockOrder: number; floorOrder: number; roomOrder: number }> = []
  for (const e of inScope) {
    const room = roomById.get(e.roomId)
    const floor = room ? floorById.get(room.floorId) : undefined
    const effectiveBlockId = room?.blockId ?? floor?.blockId
    const block = effectiveBlockId ? blockById.get(effectiveBlockId) : undefined
    const description = e.isUnlistedItem
      ? (e.unlistedItemName ?? 'Unlisted item')
      : (typeById.get(e.assetTypeId ?? '')?.name ?? 'Asset')
    const assetCode = assetCodeFor(e, typeById.get(e.assetTypeId ?? '')).trim().toUpperCase()
    e.tagNumbers.forEach((tag, i) => {
      const detail = itemDetailFor(e, tag, i)
      const photoIds = [...new Set([...detail.photoIds, ...detail.representativePhotoIds])]
      const parsed = parseTag(tag)
      const tagMatchesLocation = Boolean(
        e.acceptedTagNumbers?.includes(tag) ||
        (parsed &&
          floor &&
          room &&
          tag.trim().toUpperCase() ===
            formatTag(
              assetCode,
              floor.code.trim().toUpperCase(),
              room.code.trim().toUpperCase(),
              parsed.seq,
              block?.code.trim().toUpperCase(),
            )),
      )
      labels.push({
        tag,
        description,
        block: block?.name ?? '',
        floor: floor?.name ?? '',
        room: room?.name ?? '',
        serial: detail.serialNumber,
        brand: detail.brand,
        model: detail.model,
        photoCount: photoIds.length,
        photoIds,
        entryId: e.id,
        roomId: e.roomId,
        tagMatchesLocation,
        condition: e.condition,
        blockOrder: block?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        floorOrder: floor?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        roomOrder: room?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      })
    })
  }

  labels.sort(
    (a, b) =>
      a.blockOrder - b.blockOrder ||
      a.floorOrder - b.floorOrder ||
      a.roomOrder - b.roomOrder ||
      a.tag.localeCompare(b.tag),
  )

  return {
    organization: org?.name ?? '',
    verifiedOn: exercise?.date ?? new Date().toISOString().slice(0, 10),
    labels: labels.map(({ blockOrder: _blockOrder, floorOrder: _floorOrder, roomOrder: _roomOrder, ...label }) => label),
  }
}

/** Loaded on demand: QR generation is only needed on the label screens. */
async function loadQrCode() {
  return (await import('qrcode')).default
}

export async function qrDataUrl(text: string, size = 160): Promise<string> {
  const QRCode = await loadQrCode()
  return QRCode.toDataURL(text, {
    margin: 0,
    width: size,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })
}

export interface LabelRoomSummary {
  roomId: string
  block: string
  floor: string
  room: string
  count: number
}

/**
 * The rooms present in a set of labels, in the order the labels already carry
 * (block, then floor, then room), so each room can be offered for printing on
 * its own.
 */
export function roomsInLabels(labels: LabelData[]): LabelRoomSummary[] {
  const grouped = new Map<string, LabelRoomSummary>()
  for (const label of labels) {
    const current = grouped.get(label.roomId)
    if (current) current.count += 1
    else {
      const { roomId, block, floor, room } = label
      grouped.set(roomId, { roomId, block, floor, room, count: 1 })
    }
  }
  return [...grouped.values()]
}

/** "Limited" is spelled out nowhere on a 50mm label; "Ltd" buys the line real space. */
export function labelOrgName(organization: string): string {
  return organization.replace(/\bLimited\b\.?/gi, 'Ltd')
}

/**
 * The owner's name heads every label on one unbroken line, so the type is
 * shrunk to whatever still fits the 47mm of printable width. Uppercase glyphs
 * in the label font average about 0.62em, which keeps the estimate on the safe
 * side of the real measurement.
 */
export function orgFontSize(organization: string, widthMm = 47): number {
  const chars = organization.trim().length
  if (chars === 0) return 7
  const widthPt = widthMm * 2.8346
  const fits = widthPt / (chars * 0.62)
  return Math.max(3.6, Math.min(7, Math.floor(fits * 10) / 10))
}

/** Authenticated app page opened when a printed label is scanned. */
export function labelTargetUrl(label: Pick<LabelData, 'entryId' | 'tag'>, origin: string): string {
  const url = new URL(`/asset/${encodeURIComponent(label.entryId)}`, origin)
  url.searchParams.set('tag', label.tag)
  return url.toString()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * Builds a self-contained print document: 50x30mm labels, 4 per row on A4,
 * with the QR codes inlined as data URLs so printing works with no network.
 */
export async function renderLabelsHtml(sheet: LabelSheet, origin = 'http://localhost'): Promise<string> {
  const qrs = await Promise.all(
    sheet.labels.map((label) => qrDataUrl(labelTargetUrl(label, origin), 180)),
  )
  const orgName = labelOrgName(sheet.organization)
  const orgSize = orgFontSize(orgName)
  const cellFor = (l: LabelData, i: number) => `
      <div class="label">
        <div class="org">${escapeHtml(orgName)}</div>
        <div class="row">
          <img class="qr" src="${qrs[i]}" alt="${escapeHtml(l.tag)}" />
          <div class="body">
            <div class="tag">${escapeHtml(l.tag)}</div>
            <div class="desc">${escapeHtml(l.description)}</div>
            ${l.brand ? `<div class="meta">Brand: ${escapeHtml(l.brand)}</div>` : ''}
            <div class="loc">${escapeHtml([l.block, l.floor, l.room].filter(Boolean).join(' · '))}</div>
            <div class="date">Verified ${escapeHtml(sheet.verifiedOn)}</div>
          </div>
        </div>
      </div>`

  const roomGroups = new Map<string, Array<{ label: LabelData; index: number }>>()
  sheet.labels.forEach((label, index) => {
    const key = label.roomId || [label.block, label.floor, label.room].join('\u0000')
    const group = roomGroups.get(key) ?? []
    group.push({ label, index })
    roomGroups.set(key, group)
  })

  const roomSections = [...roomGroups.values()]
    .map((group) => {
      const location = group[0].label
      const context = [location.block, location.floor].filter(Boolean).map(escapeHtml).join(' &middot; ')
      const roomName = location.room || 'Room not recorded'
      const cells = group.map(({ label, index }) => cellFor(label, index)).join('')
      return `
      <section class="room-section">
        <header class="room-heading">
          <div class="room-kicker">ROOM / CHUMBA</div>
          <h1>${escapeHtml(roomName)}</h1>
          ${context ? `<div class="room-context">${context}</div>` : ''}
          <div class="custodian">
            <div class="custodian-kicker">ROOM CUSTODIAN / MSIMAMIZI WA CHUMBA</div>
            <div class="fields">
              <div class="field"><span>Name / Jina</span><i class="line name"></i></div>
              <div class="field"><span>Phone / Simu</span><i class="line phone"></i></div>
              <div class="field"><span>Signature / Saini</span><i class="line sign"></i></div>
              <div class="field"><span>Date / Tarehe</span><i class="line date"></i></div>
            </div>
          </div>
        </header>
        <div class="label-grid">${cells}</div>
      </section>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Asset labels — ${escapeHtml(sheet.organization)}</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; }
  .sheet { background: #fff; }
  .room-section { break-inside: auto; }
  .room-section + .room-section { break-before: page; page-break-before: always; }
  .room-heading {
    min-height: 15mm; margin: 0 0 4mm; padding: 2.5mm 3mm;
    border: 0.4mm solid #0f766e; border-left-width: 2mm; border-radius: 1.5mm;
    break-after: avoid; page-break-after: avoid;
  }
  .room-kicker { color: #0f766e; font-size: 7pt; font-weight: 800; letter-spacing: 0.8pt; }
  .room-heading h1 { margin: 0.5mm 0 0; font-size: 16pt; line-height: 1.1; }
  .room-context { margin-top: 0.8mm; color: #334155; font-size: 9pt; font-weight: 600; }
  /*
   * The person answerable for the room signs the sheet that its tags were
   * printed from, so the signed page is itself the record of handover.
   */
  .custodian { margin-top: 2.2mm; padding-top: 1.8mm; border-top: 0.3mm dashed #94a3b8; }
  .custodian-kicker { color: #0f766e; font-size: 6.5pt; font-weight: 800; letter-spacing: 0.6pt; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 10mm; margin-top: 1.8mm; }
  .field { display: flex; align-items: flex-end; gap: 1.5mm; font-size: 8pt; color: #334155; }
  .field span { font-weight: 700; white-space: nowrap; }
  .line { flex: 1; border-bottom: 0.35mm solid #475569; height: 3.8mm; }
  .label-grid { display: flex; flex-wrap: wrap; gap: 2mm; }
  .label {
    width: 50mm; height: 30mm; border: 0.3mm solid #000; border-radius: 1mm;
    padding: 1.5mm; display: flex; flex-direction: column;
    page-break-inside: avoid; break-inside: avoid; overflow: hidden;
  }
  .row { display: flex; gap: 1.5mm; align-items: center; min-height: 0; flex: 1; }
  .qr { width: 20mm; height: 20mm; flex: 0 0 20mm; }
  .body { min-width: 0; line-height: 1.1; }
  /*
   * The owner's full name heads the label across its whole width, on one line.
   * Its size is computed per sheet so even a long name never wraps or clips.
   */
  .org {
    font-size: ${orgSize}pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1pt;
    line-height: 1.2; text-align: center; white-space: nowrap; overflow: hidden;
    padding-bottom: 0.5mm; margin-bottom: 0.8mm; border-bottom: 0.2mm solid #000;
  }
  .tag { font-size: 10pt; font-weight: 700; font-family: ui-monospace, "Courier New", monospace; margin: 0.4mm 0; }
  .desc { font-size: 6.5pt; font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .meta { font-size: 6pt; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .loc { font-size: 6pt; }
  .date { font-size: 5.5pt; color: #333; margin-top: 0.3mm; }
  .empty { padding: 20mm; text-align: center; font-size: 12pt; }
  @media screen {
    body { background: #f1f5f9; padding: 6mm; }
    .sheet { padding: 8mm; box-shadow: 0 1px 6px rgba(0,0,0,.2); }
    .room-section + .room-section { margin-top: 10mm; padding-top: 8mm; border-top: 1px dashed #94a3b8; }
  }
</style>
</head>
<body>
  ${sheet.labels.length === 0 ? '<div class="empty">No tags issued for this selection yet.</div>' : `<main class="sheet">${roomSections}</main>`}
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print() }, 250) })</script>
</body>
</html>`
}

/** Opens the print sheet in a new tab. Must be called from a user gesture. */
export async function printLabels(sheet: LabelSheet): Promise<boolean> {
  const html = await renderLabelsHtml(sheet, window.location.origin)
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.open()
  win.document.write(html)
  win.document.close()
  return true
}

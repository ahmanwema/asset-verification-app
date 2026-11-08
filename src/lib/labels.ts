import { db } from '../db/db'

export type LabelScope = 'room' | 'floor' | 'exercise'

export interface LabelData {
  tag: string
  description: string
  floor: string
  room: string
  serial: string
}

export interface LabelSheet {
  organization: string
  verifiedOn: string
  labels: LabelData[]
}

/** Gathers the tags to print for a room, a floor or the whole exercise. */
export async function collectLabels(opts: {
  exerciseId: string
  scope: LabelScope
  roomId?: string
  floorId?: string
}): Promise<LabelSheet> {
  const [exercise, floors, rooms, assetTypes, entriesRaw, orgs] = await Promise.all([
    db.exercises.get(opts.exerciseId),
    db.floors.where('exerciseId').equals(opts.exerciseId).toArray(),
    db.rooms.where('exerciseId').equals(opts.exerciseId).toArray(),
    db.assetTypes.toArray(),
    db.entries.where('exerciseId').equals(opts.exerciseId).toArray(),
    db.organizations.toArray(),
  ])

  const floorById = new Map(floors.map((f) => [f.id, f]))
  const roomById = new Map(rooms.map((r) => [r.id, r]))
  const typeById = new Map(assetTypes.map((a) => [a.id, a]))
  const org = orgs.find((o) => o.id === exercise?.orgId) ?? orgs[0]

  const inScope = entriesRaw.filter((e) => {
    if (e.deleted || e.tagNumbers.length === 0) return false
    if (opts.scope === 'room') return e.roomId === opts.roomId
    if (opts.scope === 'floor') return roomById.get(e.roomId)?.floorId === opts.floorId
    return true
  })

  const labels: LabelData[] = []
  for (const e of inScope) {
    const room = roomById.get(e.roomId)
    const floor = room ? floorById.get(room.floorId) : undefined
    const description = e.isUnlistedItem
      ? (e.unlistedItemName ?? 'Unlisted item')
      : (typeById.get(e.assetTypeId ?? '')?.name ?? 'Asset')
    e.tagNumbers.forEach((tag, i) => {
      labels.push({
        tag,
        description,
        floor: floor?.name ?? '',
        room: room?.name ?? '',
        serial: e.serialNumbers[i] ?? '',
      })
    })
  }

  labels.sort((a, b) => a.tag.localeCompare(b.tag))

  return {
    organization: org?.name ?? '',
    verifiedOn: exercise?.date ?? new Date().toISOString().slice(0, 10),
    labels,
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * Builds a self-contained print document: 50x30mm labels, 4 per row on A4,
 * with the QR codes inlined as data URLs so printing works with no network.
 */
export async function renderLabelsHtml(sheet: LabelSheet): Promise<string> {
  const qrs = await Promise.all(sheet.labels.map((l) => qrDataUrl(l.tag, 180)))
  const cells = sheet.labels
    .map(
      (l, i) => `
      <div class="label">
        <img class="qr" src="${qrs[i]}" alt="${escapeHtml(l.tag)}" />
        <div class="body">
          <div class="org">${escapeHtml(sheet.organization)}</div>
          <div class="tag">${escapeHtml(l.tag)}</div>
          <div class="desc">${escapeHtml(l.description)}</div>
          <div class="loc">${escapeHtml(l.room)}</div>
          <div class="date">Verified ${escapeHtml(sheet.verifiedOn)}</div>
        </div>
      </div>`,
    )
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
  .sheet { display: flex; flex-wrap: wrap; gap: 2mm; }
  .label {
    width: 50mm; height: 30mm; border: 0.3mm solid #000; border-radius: 1mm;
    padding: 1.5mm; display: flex; gap: 1.5mm; align-items: center;
    page-break-inside: avoid; break-inside: avoid; overflow: hidden;
  }
  .qr { width: 20mm; height: 20mm; flex: 0 0 20mm; }
  .body { min-width: 0; line-height: 1.15; }
  .org { font-size: 5.5pt; text-transform: uppercase; letter-spacing: 0.2pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tag { font-size: 10pt; font-weight: 700; font-family: ui-monospace, "Courier New", monospace; margin: 0.4mm 0; }
  .desc { font-size: 6.5pt; font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .loc { font-size: 6pt; }
  .date { font-size: 5.5pt; color: #333; margin-top: 0.3mm; }
  .empty { padding: 20mm; text-align: center; font-size: 12pt; }
  @media screen {
    body { background: #f1f5f9; padding: 6mm; }
    .sheet { background: #fff; padding: 8mm; box-shadow: 0 1px 6px rgba(0,0,0,.2); }
  }
</style>
</head>
<body>
  ${sheet.labels.length === 0 ? '<div class="empty">No tags issued for this selection yet.</div>' : `<div class="sheet">${cells}</div>`}
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print() }, 250) })</script>
</body>
</html>`
}

/** Opens the print sheet in a new tab. Must be called from a user gesture. */
export async function printLabels(sheet: LabelSheet): Promise<boolean> {
  const html = await renderLabelsHtml(sheet)
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.open()
  win.document.write(html)
  win.document.close()
  return true
}

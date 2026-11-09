import { db, uid } from '../db/db'
import { allocateTagNumbers, deriveCode } from './tags'
import { breakdownIsValid } from './queries'
import type {
  AssetType,
  Condition,
  ConditionBreakdown,
  EditRecord,
  Floor,
  InspectionEntry,
  Room,
  RoomSignoff,
} from '../types'
import { CONDITIONS } from '../types'

export interface EntryDraft {
  id?: string
  exerciseId: string
  room: Room
  floor: Floor
  assetType?: AssetType
  isUnlistedItem: boolean
  unlistedItemName?: string
  quantity: number
  serialNumbers: string[]
  model: string
  brand: string
  condition: Condition
  conditionBreakdown?: ConditionBreakdown
  remarks: string
  material?: string
  colour?: string
  itemType?: string
  additionalFeatures?: string
  description?: string
  specificPosition?: string
  aiAssisted?: boolean
  inspectorId: string
  notPresent: boolean
  /** Manual tag numbers override auto-generation when provided. */
  manualTagNumbers?: string[]
  photoIds?: string[]
}

export class ValidationError extends Error {}

/**
 * The fields the edit log watches, with the English label the reports print and
 * how each is rendered into the log.
 *
 * Deliberately not tracked: `updatedAt`, `syncStatus`, `inspectedAt` and
 * `aiAssisted`. Those move on their own — a sync or a re-save changes them
 * without anyone editing anything — and logging them would bury the handful of
 * changes an auditor actually cares about.
 */
const TRACKED_FIELDS: Array<{ field: string; label: string; render: (e: InspectionEntry) => string }> = [
  { field: 'quantity', label: 'Quantity', render: (e) => String(e.quantity) },
  { field: 'notPresent', label: 'Not present', render: (e) => String(e.notPresent) },
  { field: 'condition', label: 'Condition', render: (e) => e.condition },
  {
    field: 'conditionBreakdown',
    label: 'Condition breakdown',
    render: (e) =>
      CONDITIONS.filter((c) => (e.conditionBreakdown?.[c] ?? 0) > 0)
        .map((c) => `${e.conditionBreakdown?.[c]} ${c}`)
        .join(', '),
  },
  { field: 'serialNumbers', label: 'Serial number', render: (e) => e.serialNumbers.join(', ') },
  { field: 'brand', label: 'Brand', render: (e) => e.brand },
  { field: 'model', label: 'Model', render: (e) => e.model },
  { field: 'tagNumbers', label: 'Tag numbers', render: (e) => e.tagNumbers.join(', ') },
  { field: 'itemType', label: 'Item type', render: (e) => e.itemType ?? '' },
  { field: 'material', label: 'Material', render: (e) => e.material ?? '' },
  { field: 'colour', label: 'Colour', render: (e) => e.colour ?? '' },
  { field: 'additionalFeatures', label: 'Additional features', render: (e) => e.additionalFeatures ?? '' },
  { field: 'specificPosition', label: 'Position in room', render: (e) => e.specificPosition ?? '' },
  { field: 'description', label: 'Description', render: (e) => e.description ?? '' },
  { field: 'remarks', label: 'Remarks', render: (e) => e.remarks },
  { field: 'unlistedItemName', label: 'Item name', render: (e) => e.unlistedItemName ?? '' },
  { field: 'photos', label: 'Photos', render: (e) => String(e.photoIds.length) },
]

/** English labels for the report sheet, keyed by field. */
export const EDIT_FIELD_LABEL: Record<string, string> = Object.fromEntries(
  TRACKED_FIELDS.map((f) => [f.field, f.label]),
)

/**
 * Hard cap on retained records. The whole entry travels to the server as one
 * JSON row, so an entry edited hundreds of times would otherwise grow until it
 * slowed every sync on a weak connection. The oldest records are dropped first.
 */
export const EDIT_HISTORY_LIMIT = 200

/** Field-by-field comparison of a saved entry against its replacement. */
function diffEntries(before: InspectionEntry, after: InspectionEntry, editedBy: string): EditRecord[] {
  const editedAt = Date.now()
  const changes: EditRecord[] = []
  for (const { field, render } of TRACKED_FIELDS) {
    const oldValue = render(before)
    const newValue = render(after)
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue, editedBy, editedAt })
  }
  return changes
}

/**
 * Creates or updates an inspection entry, allocating tag numbers to match the
 * quantity. Tag numbers already on the entry are kept so re-editing an item does
 * not invalidate labels that were printed and stuck on earlier.
 */
export async function saveEntry(draft: EntryDraft): Promise<InspectionEntry> {
  if (draft.isUnlistedItem && !draft.unlistedItemName?.trim()) {
    throw new ValidationError('entry.nameRequired')
  }
  if (!draft.notPresent && (!Number.isInteger(draft.quantity) || draft.quantity < 1)) {
    throw new ValidationError('entry.quantityRequired')
  }
  if (
    !draft.notPresent &&
    draft.conditionBreakdown &&
    Object.keys(draft.conditionBreakdown).length > 0 &&
    !breakdownIsValid(draft.conditionBreakdown, draft.quantity)
  ) {
    throw new ValidationError('entry.breakdownError')
  }

  const existing = draft.id ? await db.entries.get(draft.id) : undefined
  const id = existing?.id ?? uid('en_')
  const quantity = draft.notPresent ? 0 : draft.quantity
  const assetCode = draft.isUnlistedItem
    ? deriveCode(draft.unlistedItemName ?? 'Unlisted')
    : (draft.assetType?.code ?? 'XX')

  const tagNumbers = draft.manualTagNumbers?.length
    ? draft.manualTagNumbers.map((t) => t.trim().toUpperCase()).filter(Boolean)
    : await allocateTagNumbers({
        roomId: draft.room.id,
        assetCode,
        floorCode: draft.floor.code,
        roomCode: draft.room.code,
        quantity,
        keepEntryId: id,
      })

  const entry: InspectionEntry = {
    id,
    exerciseId: draft.exerciseId,
    roomId: draft.room.id,
    assetTypeId: draft.isUnlistedItem ? null : (draft.assetType?.id ?? null),
    quantity,
    serialNumbers: draft.serialNumbers.map((s) => s.trim()).filter(Boolean),
    model: draft.model.trim(),
    brand: draft.brand.trim(),
    tagNumbers,
    condition: draft.condition,
    conditionBreakdown:
      !draft.notPresent && draft.conditionBreakdown && Object.keys(draft.conditionBreakdown).length > 0
        ? draft.conditionBreakdown
        : undefined,
    photoIds: draft.photoIds ?? existing?.photoIds ?? [],
    remarks: draft.remarks.trim(),
    material: (draft.material ?? '').trim(),
    colour: (draft.colour ?? '').trim(),
    itemType: (draft.itemType ?? '').trim(),
    additionalFeatures: (draft.additionalFeatures ?? '').trim(),
    description: (draft.description ?? '').trim(),
    specificPosition: (draft.specificPosition ?? '').trim(),
    aiAssisted: draft.aiAssisted ?? existing?.aiAssisted,
    inspectorId: draft.inspectorId,
    inspectedAt: existing?.inspectedAt ?? Date.now(),
    isUnlistedItem: draft.isUnlistedItem,
    unlistedItemName: draft.isUnlistedItem ? draft.unlistedItemName?.trim() : undefined,
    notPresent: draft.notPresent,
    editHistory: existing?.editHistory ?? [],
    updatedAt: Date.now(),
    deleted: false,
    syncStatus: 'pending',
  }

  // A first save is not an edit, so a new entry starts with an empty log.
  if (existing) {
    const changes = diffEntries(existing, entry, draft.inspectorId)
    if (changes.length > 0) {
      entry.editHistory = [...entry.editHistory, ...changes].slice(-EDIT_HISTORY_LIMIT)
    }
  }

  await db.entries.put(entry)
  return entry
}

/** One-tap "this asset type is not in this room". */
export async function markNotPresent(opts: {
  exerciseId: string
  room: Room
  floor: Floor
  assetType: AssetType
  inspectorId: string
}): Promise<InspectionEntry> {
  const existing = await db.entries
    .where('[roomId+assetTypeId]')
    .equals([opts.room.id, opts.assetType.id])
    .first()

  return saveEntry({
    id: existing?.id,
    exerciseId: opts.exerciseId,
    room: opts.room,
    floor: opts.floor,
    assetType: opts.assetType,
    isUnlistedItem: false,
    quantity: 0,
    serialNumbers: [],
    model: '',
    brand: '',
    condition: 'G',
    remarks: existing?.remarks ?? '',
    inspectorId: opts.inspectorId,
    notPresent: true,
    manualTagNumbers: [],
  })
}

/** Soft delete so the deletion propagates on the next sync. */
export async function deleteEntry(entryId: string): Promise<void> {
  const entry = await db.entries.get(entryId)
  if (!entry) return
  await db.entries.put({ ...entry, deleted: true, updatedAt: Date.now(), syncStatus: 'pending' })
  await db.photos.where('entryId').equals(entryId).delete()
}

export async function attachPhoto(entryId: string, photoId: string): Promise<void> {
  const entry = await db.entries.get(entryId)
  if (!entry) return
  if (entry.photoIds.includes(photoId)) return
  await db.entries.put({
    ...entry,
    photoIds: [...entry.photoIds, photoId],
    updatedAt: Date.now(),
    syncStatus: 'pending',
  })
}

export async function detachPhoto(entryId: string, photoId: string): Promise<void> {
  const entry = await db.entries.get(entryId)
  if (!entry) return
  await db.entries.put({
    ...entry,
    photoIds: entry.photoIds.filter((p) => p !== photoId),
    updatedAt: Date.now(),
    syncStatus: 'pending',
  })
  await db.photos.delete(photoId)
}

export async function signoffRoom(opts: {
  exerciseId: string
  roomId: string
  inspectorId: string
  notes: string
}): Promise<RoomSignoff> {
  const entries = await db.entries.where('roomId').equals(opts.roomId).toArray()
  const totalItemsFound = entries
    .filter((e) => !e.deleted && !e.notPresent)
    .reduce((n, e) => n + e.quantity, 0)

  const existing = await db.signoffs.where('roomId').equals(opts.roomId).first()
  const signoff: RoomSignoff = {
    id: existing?.id ?? uid('so_'),
    exerciseId: opts.exerciseId,
    roomId: opts.roomId,
    inspectorId: opts.inspectorId,
    signedAt: Date.now(),
    totalItemsFound,
    notes: opts.notes.trim(),
    updatedAt: Date.now(),
    deleted: false,
    syncStatus: 'pending',
  }
  await db.signoffs.put(signoff)
  return signoff
}

export async function reopenRoom(roomId: string): Promise<void> {
  const existing = await db.signoffs.where('roomId').equals(roomId).first()
  if (!existing) return
  await db.signoffs.put({ ...existing, deleted: true, updatedAt: Date.now(), syncStatus: 'pending' })
}

/** Resolves a sync conflict by keeping the local record or the server's copy. */
export async function resolveConflict(entryId: string, keep: 'mine' | 'theirs'): Promise<void> {
  const entry = await db.entries.get(entryId)
  if (!entry) return
  if (keep === 'mine') {
    await db.entries.put({ ...entry, conflictWith: undefined, syncStatus: 'pending', updatedAt: Date.now() })
    return
  }
  const theirs = entry.conflictWith
  if (!theirs) {
    await db.entries.put({ ...entry, syncStatus: 'synced', conflictWith: undefined })
    return
  }
  await db.entries.put({ ...theirs, conflictWith: undefined, syncStatus: 'synced' })
}

export class ConversionError extends Error {}

/**
 * Reclassifies an item that was recorded as "unlisted" into a catalog asset
 * type.
 *
 * This happens constantly in a real exercise: an inspector finds something
 * that is not on the checklist and records it as unlisted, which is correct,
 * and the catalog catches up afterwards. Without this the variance report
 * counts it as an unexpected find for ever and the per-type totals stay wrong.
 *
 * Tag numbers are deliberately left alone. They may already be printed and
 * stuck on the furniture, and a tag's job is to identify one physical object,
 * not to encode its classification — so a converted item can keep a prefix
 * derived from its old name. The change is written to the edit log, so the
 * register shows what it used to be.
 */
export async function convertToAssetType(entryId: string, assetType: AssetType, actorId: string): Promise<InspectionEntry> {
  const entry = await db.entries.get(entryId)
  if (!entry) throw new ConversionError('entry.notRecorded')
  if (!entry.isUnlistedItem) throw new ConversionError('convert.alreadyListed')

  // One entry per asset type per room is assumed everywhere — the room
  // checklist, the progress counts and the [roomId+assetTypeId] index all
  // rely on it, so a merge would have to be a different, explicit action.
  const clash = await db.entries.where('[roomId+assetTypeId]').equals([entry.roomId, assetType.id]).first()
  if (clash && !clash.deleted) throw new ConversionError('convert.alreadyInRoom')

  const was = entry.unlistedItemName?.trim() || 'Unlisted item'
  const converted: InspectionEntry = {
    ...entry,
    assetTypeId: assetType.id,
    isUnlistedItem: false,
    unlistedItemName: undefined,
    editHistory: [
      ...(entry.editHistory ?? []),
      {
        field: 'assetType',
        oldValue: `Unlisted: ${was}`,
        newValue: assetType.name,
        editedBy: actorId,
        editedAt: Date.now(),
      },
    ].slice(-EDIT_HISTORY_LIMIT),
    updatedAt: Date.now(),
    syncStatus: 'pending',
  }

  await db.entries.put(converted)
  return converted
}

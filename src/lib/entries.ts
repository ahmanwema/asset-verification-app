import { db, uid } from '../db/db'
import { allocateTagNumbers, deriveCode } from './tags'
import { breakdownIsValid } from './queries'
import type {
  AssetType,
  Condition,
  ConditionBreakdown,
  Floor,
  InspectionEntry,
  Room,
  RoomSignoff,
} from '../types'

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
    updatedAt: Date.now(),
    deleted: false,
    syncStatus: 'pending',
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

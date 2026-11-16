import { db, uid } from '../db/db'
import { allocateTagNumbers, assetCodeFor, deriveCode, formatTag, parseTag } from './tags'
import { breakdownIsValid } from './queries'
import type {
  AssetType,
  Condition,
  ConditionBreakdown,
  EditRecord,
  Floor,
  InspectionEntry,
  ItemDetail,
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
  /** Room the item belongs to, when it was found somewhere else. */
  expectedRoomId?: string
  inspectorId: string
  notPresent: boolean
  /** Manual tag numbers override auto-generation when provided. */
  manualTagNumbers?: string[]
  /** Existing auto labels to retain when one specific item is removed. */
  preferredTagNumbers?: string[]
  photoIds?: string[]
  itemDetails?: Array<Omit<ItemDetail, 'tagNumber'>>
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
  {
    field: 'itemDetails',
    label: 'Per-item details',
    render: (e) => JSON.stringify(e.itemDetails ?? []),
  },
  { field: 'expectedRoomId', label: 'Belongs to room', render: (e) => e.expectedRoomId ?? '' },
]

/** English labels for the report sheet, keyed by field. */
export const EDIT_FIELD_LABEL: Record<string, string> = Object.fromEntries(
  TRACKED_FIELDS.map((f) => [f.field, f.label]),
)
EDIT_FIELD_LABEL.financialDetails = 'Financial details'
EDIT_FIELD_LABEL.room = 'Room'

/**
 * Hard cap on retained records. The whole entry travels to the server as one
 * JSON row, so an entry edited hundreds of times would otherwise grow until it
 * slowed every sync on a weak connection. The oldest records are dropped first.
 */
export const EDIT_HISTORY_LIMIT = 200

/** Per-tag details with a backward-compatible fallback for older entries. */
export function itemDetailFor(entry: InspectionEntry, tag: string, index?: number): ItemDetail {
  const position = index ?? Math.max(0, entry.tagNumbers.indexOf(tag))
  return entry.itemDetails?.find((detail) => detail.tagNumber === tag) ?? {
    tagNumber: tag,
    brand: entry.brand,
    model: entry.model,
    serialNumber: entry.serialNumbers[position] ?? entry.serialNumbers[0] ?? '',
    photoIds: entry.photoIds,
    representativePhotoIds: [],
  }
}

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
  const effectiveBlockId = draft.room.blockId ?? draft.floor.blockId
  const block = effectiveBlockId ? await db.blocks.get(effectiveBlockId) : undefined

  const tagNumbers = draft.manualTagNumbers?.length
    ? draft.manualTagNumbers.map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, quantity)
    : await allocateTagNumbers({
        roomId: draft.room.id,
        assetCode,
        floorCode: draft.floor.code,
        roomCode: draft.room.code,
        blockCode: block?.code,
        quantity,
        keepEntryId: id,
        keepTagNumbers: draft.preferredTagNumbers,
      })

  const itemDetails: ItemDetail[] = tagNumbers.map((tagNumber, index) => {
    const detail = draft.itemDetails?.[index]
    const legacyPhotoIds = draft.photoIds ?? existing?.photoIds ?? []
    return {
      tagNumber,
      brand: (detail?.brand ?? draft.brand).trim(),
      model: (detail?.model ?? draft.model).trim(),
      serialNumber: (detail?.serialNumber ?? draft.serialNumbers[index] ?? draft.serialNumbers[0] ?? '').trim(),
      photoIds: detail?.photoIds ?? [],
      representativePhotoIds: detail?.representativePhotoIds ?? (draft.itemDetails ? [] : legacyPhotoIds),
    }
  })
  const allPhotoIds = [...new Set([
    ...(draft.photoIds ?? existing?.photoIds ?? []),
    ...itemDetails.flatMap((detail) => [...detail.photoIds, ...detail.representativePhotoIds]),
  ])]

  const entry: InspectionEntry = {
    id,
    exerciseId: draft.exerciseId,
    roomId: draft.room.id,
    assetTypeId: draft.isUnlistedItem ? null : (draft.assetType?.id ?? null),
    quantity,
    serialNumbers: itemDetails.map((detail) => detail.serialNumber),
    model: itemDetails[0]?.model ?? draft.model.trim(),
    brand: itemDetails[0]?.brand ?? draft.brand.trim(),
    tagNumbers,
    condition: draft.condition,
    conditionBreakdown:
      !draft.notPresent && draft.conditionBreakdown && Object.keys(draft.conditionBreakdown).length > 0
        ? draft.conditionBreakdown
        : undefined,
    photoIds: allPhotoIds,
    itemDetails,
    remarks: draft.remarks.trim(),
    financialRecords: existing?.financialRecords ?? [],
    material: (draft.material ?? '').trim(),
    colour: (draft.colour ?? '').trim(),
    itemType: (draft.itemType ?? '').trim(),
    additionalFeatures: (draft.additionalFeatures ?? '').trim(),
    description: (draft.description ?? '').trim(),
    specificPosition: (draft.specificPosition ?? '').trim(),
    aiAssisted: draft.aiAssisted ?? existing?.aiAssisted,
    // Stored only when it differs: "belongs here" is the normal case and
    // should not read as a misplacement in the variance report.
    expectedRoomId:
      draft.expectedRoomId && draft.expectedRoomId !== draft.room.id ? draft.expectedRoomId : undefined,
    // The inspector on the entry is its original recorder. Later editors are
    // captured field-by-field in editHistory and must not replace this audit
    // identity.
    inspectorId: existing?.inspectorId ?? draft.inspectorId,
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

export type MoveEntriesErrorCode =
  | 'no-selection'
  | 'same-room'
  | 'room-not-found'
  | 'wrong-source'
  | 'destination-conflict'

export class MoveEntriesError extends Error {
  constructor(readonly code: MoveEntriesErrorCode) {
    super(code)
  }
}

/**
 * Moves complete inspection cards between rooms without changing tag identity.
 *
 * A card can represent several physical units, so moving a selected card keeps
 * its quantity, per-item details, photos, serials, financial records and tag
 * numbers together. Existing labels may already be attached to assets; a room
 * correction must never silently issue replacement identities.
 */
export async function moveEntriesToRoom(opts: {
  sourceRoomId: string
  targetRoomId: string
  entryIds: string[]
  actorId: string
}): Promise<{ movedCards: number; movedItems: number }> {
  const entryIds = [...new Set(opts.entryIds)]
  if (entryIds.length === 0) throw new MoveEntriesError('no-selection')
  if (opts.sourceRoomId === opts.targetRoomId) throw new MoveEntriesError('same-room')

  return db.transaction('rw', db.rooms, db.entries, db.signoffs, async () => {
    const [sourceRoom, targetRoom, rows] = await Promise.all([
      db.rooms.get(opts.sourceRoomId),
      db.rooms.get(opts.targetRoomId),
      db.entries.bulkGet(entryIds),
    ])
    if (!sourceRoom || !targetRoom || sourceRoom.exerciseId !== targetRoom.exerciseId) {
      throw new MoveEntriesError('room-not-found')
    }

    const entries = rows.filter((entry): entry is InspectionEntry => Boolean(entry && !entry.deleted))
    if (entries.length !== entryIds.length) throw new MoveEntriesError('room-not-found')
    if (entries.some((entry) => entry.roomId !== sourceRoom.id || entry.exerciseId !== targetRoom.exerciseId)) {
      throw new MoveEntriesError('wrong-source')
    }

    const targetEntries = (await db.entries.where('roomId').equals(targetRoom.id).toArray()).filter(
      (entry) => !entry.deleted,
    )
    const targetAssetTypes = new Set(
      targetEntries.filter((entry) => !entry.isUnlistedItem && entry.assetTypeId).map((entry) => entry.assetTypeId),
    )
    if (entries.some((entry) => !entry.isUnlistedItem && entry.assetTypeId && targetAssetTypes.has(entry.assetTypeId))) {
      throw new MoveEntriesError('destination-conflict')
    }

    const updatedAt = Date.now()
    const moved = entries.map((entry) => ({
      ...entry,
      roomId: targetRoom.id,
      expectedRoomId: entry.expectedRoomId === targetRoom.id ? undefined : entry.expectedRoomId,
      editHistory: [
        ...(entry.editHistory ?? []),
        {
          field: 'room',
          oldValue: sourceRoom.name,
          newValue: targetRoom.name,
          editedBy: opts.actorId,
          editedAt: updatedAt,
        },
      ].slice(-EDIT_HISTORY_LIMIT),
      updatedAt,
      syncStatus: 'pending' as const,
    }))
    await db.entries.bulkPut(moved)

    // A signed total is no longer true after either room changes. Reopen both
    // rooms so they can be reviewed and signed again with the corrected totals.
    for (const roomId of [sourceRoom.id, targetRoom.id]) {
      const signoffs = await db.signoffs.where('roomId').equals(roomId).toArray()
      await db.signoffs.bulkPut(
        signoffs
          .filter((signoff) => !signoff.deleted)
          .map((signoff) => ({ ...signoff, deleted: true, updatedAt, syncStatus: 'pending' as const })),
      )
    }

    return {
      movedCards: moved.length,
      movedItems: moved.reduce((sum, entry) => sum + (entry.notPresent ? 0 : entry.quantity), 0),
    }
  })
}

export class RetagRoomError extends Error {}

/**
 * Reissues every mismatched tag in a room using that room's current location
 * codes. Tags that already match the room are kept, while per-item details and
 * financial records follow any tag that changes.
 */
export async function retagRoomEntries(opts: {
  roomId: string
  actorId: string
}): Promise<{ changedEntries: number; changedTags: number }> {
  return db.transaction('rw', db.rooms, db.floors, db.blocks, db.assetTypes, db.entries, async () => {
    const room = await db.rooms.get(opts.roomId)
    if (!room) throw new RetagRoomError('room-not-found')
    const floor = await db.floors.get(room.floorId)
    if (!floor) throw new RetagRoomError('floor-not-found')
    const blockId = room.blockId ?? floor.blockId
    const [block, assetTypes, allEntries] = await Promise.all([
      blockId ? db.blocks.get(blockId) : undefined,
      db.assetTypes.toArray(),
      db.entries.where('exerciseId').equals(room.exerciseId).toArray(),
    ])
    const assetTypeById = new Map(assetTypes.map((assetType) => [assetType.id, assetType]))
    const floorCode = floor.code.trim().toUpperCase()
    const roomCode = room.code.trim().toUpperCase()
    const blockCode = block?.code.trim().toUpperCase()
    const entries = allEntries
      .filter((entry) => !entry.deleted && entry.roomId === room.id && entry.tagNumbers.length > 0)
      .sort((a, b) => a.inspectedAt - b.inspectedAt || a.id.localeCompare(b.id))
    const outsideTags = new Set(
      allEntries
        .filter((entry) => !entry.deleted && entry.roomId !== room.id)
        .flatMap((entry) => entry.tagNumbers.map((tag) => tag.trim().toUpperCase())),
    )
    const assignedTags = new Set<string>()
    const usedSequences = new Map<string, Set<number>>()
    const retainedByEntry = new Map<string, Map<number, string>>()

    // Keep matching tags first. This ensures moved tags are allocated around
    // labels that already belong to the destination room.
    for (const entry of entries) {
      const assetCode = assetCodeFor(entry, assetTypeById.get(entry.assetTypeId ?? '')).trim().toUpperCase()
      const used = usedSequences.get(assetCode) ?? new Set<number>()
      usedSequences.set(assetCode, used)
      const retained = new Map<number, string>()
      entry.tagNumbers.forEach((rawTag, index) => {
        const tag = rawTag.trim().toUpperCase()
        const parsed = parseTag(tag)
        if (!parsed) return
        const expected = formatTag(assetCode, floorCode, roomCode, parsed.seq, blockCode)
        if (tag !== expected || used.has(parsed.seq) || assignedTags.has(tag) || outsideTags.has(tag)) return
        used.add(parsed.seq)
        assignedTags.add(tag)
        retained.set(index, tag)
      })
      retainedByEntry.set(entry.id, retained)
    }

    const updatedAt = Date.now()
    let changedTags = 0
    const updatedEntries: InspectionEntry[] = []
    for (const entry of entries) {
      const assetCode = assetCodeFor(entry, assetTypeById.get(entry.assetTypeId ?? '')).trim().toUpperCase()
      const used = usedSequences.get(assetCode) ?? new Set<number>()
      usedSequences.set(assetCode, used)
      const retained = retainedByEntry.get(entry.id) ?? new Map<number, string>()
      let nextSequence = 1
      const newTags = entry.tagNumbers.map((oldTag, index) => {
        const kept = retained.get(index)
        if (kept) return kept
        let candidate = ''
        while (!candidate) {
          if (nextSequence > 9999) throw new RetagRoomError('tag-limit')
          const next = formatTag(assetCode, floorCode, roomCode, nextSequence, blockCode)
          if (!used.has(nextSequence) && !assignedTags.has(next) && !outsideTags.has(next)) {
            candidate = next
            used.add(nextSequence)
            assignedTags.add(next)
          }
          nextSequence += 1
        }
        if (candidate !== oldTag) changedTags += 1
        return candidate
      })
      if (newTags.every((tag, index) => tag === entry.tagNumbers[index])) continue

      const replacements = new Map(entry.tagNumbers.map((tag, index) => [tag, newTags[index]]))
      updatedEntries.push({
        ...entry,
        tagNumbers: newTags,
        itemDetails: entry.itemDetails?.map((detail, index) => ({
          ...detail,
          tagNumber: newTags[index] ?? replacements.get(detail.tagNumber) ?? detail.tagNumber,
        })),
        financialRecords: entry.financialRecords?.map((record) => ({
          ...record,
          tagNumber: replacements.get(record.tagNumber) ?? record.tagNumber,
        })),
        editHistory: [
          ...(entry.editHistory ?? []),
          {
            field: 'tagNumbers',
            oldValue: entry.tagNumbers.join(', '),
            newValue: newTags.join(', '),
            editedBy: opts.actorId,
            editedAt: updatedAt,
          },
        ].slice(-EDIT_HISTORY_LIMIT),
        updatedAt,
        syncStatus: 'pending',
      })
    }

    if (updatedEntries.length > 0) await db.entries.bulkPut(updatedEntries)
    return { changedEntries: updatedEntries.length, changedTags }
  })
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

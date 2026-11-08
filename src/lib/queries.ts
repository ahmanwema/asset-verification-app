import { db } from '../db/db'
import type {
  AssetType,
  Condition,
  ConditionBreakdown,
  Floor,
  InspectionEntry,
  Room,
  RoomSignoff,
  RoomStatus,
} from '../types'
import { CONDITIONS } from '../types'

export interface RoomProgress {
  room: Room
  status: RoomStatus
  checked: number
  total: number
  itemsFound: number
  unlistedCount: number
  signoff?: RoomSignoff
  hasConflict: boolean
}

export interface FloorProgress {
  floor: Floor
  rooms: RoomProgress[]
  done: number
  inProgress: number
  notStarted: number
  itemsFound: number
}

export interface ConditionTotals extends Record<Condition, number> {
  total: number
}

/** Spreads one entry's quantity across conditions, honouring a breakdown when present. */
export function entryConditionCounts(entry: InspectionEntry): ConditionBreakdown {
  if (entry.notPresent || entry.quantity <= 0) return {}
  if (entry.conditionBreakdown && Object.keys(entry.conditionBreakdown).length > 0) {
    return entry.conditionBreakdown
  }
  return { [entry.condition]: entry.quantity }
}

export function emptyConditionTotals(): ConditionTotals {
  return { G: 0, F: 0, P: 0, U: 0, total: 0 }
}

export function addConditionCounts(acc: ConditionTotals, entry: InspectionEntry): ConditionTotals {
  const counts = entryConditionCounts(entry)
  for (const c of CONDITIONS) {
    const n = counts[c] ?? 0
    acc[c] += n
    acc.total += n
  }
  return acc
}

export function sumConditions(entries: InspectionEntry[]): ConditionTotals {
  return entries.reduce(addConditionCounts, emptyConditionTotals())
}

/** True when the breakdown is usable: non-negative numbers summing to the quantity. */
export function breakdownIsValid(breakdown: ConditionBreakdown, quantity: number): boolean {
  let sum = 0
  for (const c of CONDITIONS) {
    const n = breakdown[c]
    if (n === undefined) continue
    if (!Number.isInteger(n) || n < 0) return false
    sum += n
  }
  return sum === quantity
}

function statusFor(entries: InspectionEntry[], signoff?: RoomSignoff): RoomStatus {
  if (signoff && !signoff.deleted) return 'done'
  return entries.length > 0 ? 'in_progress' : 'not_started'
}

export function roomProgress(
  room: Room,
  entries: InspectionEntry[],
  signoff: RoomSignoff | undefined,
  assetTypeCount: number,
): RoomProgress {
  const live = entries.filter((e) => !e.deleted)
  const listedChecked = new Set(live.filter((e) => !e.isUnlistedItem && e.assetTypeId).map((e) => e.assetTypeId!))
  const unlisted = live.filter((e) => e.isUnlistedItem)
  return {
    room,
    status: statusFor(live, signoff),
    checked: listedChecked.size,
    total: assetTypeCount,
    itemsFound: live.reduce((n, e) => n + (e.notPresent ? 0 : e.quantity), 0),
    unlistedCount: unlisted.length,
    signoff: signoff && !signoff.deleted ? signoff : undefined,
    hasConflict: live.some((e) => e.syncStatus === 'conflict'),
  }
}

/** One pass over the exercise, grouped by floor. Used by the dashboard and room lists. */
export async function loadFloorProgress(exerciseId: string): Promise<FloorProgress[]> {
  const [floors, rooms, entries, signoffs, assetTypes] = await Promise.all([
    db.floors.where('exerciseId').equals(exerciseId).toArray(),
    db.rooms.where('exerciseId').equals(exerciseId).toArray(),
    db.entries.where('exerciseId').equals(exerciseId).toArray(),
    db.signoffs.where('exerciseId').equals(exerciseId).toArray(),
    db.assetTypes.toArray(),
  ])

  const activeTypes = assetTypes.filter((a) => a.active).length
  const byRoom = new Map<string, InspectionEntry[]>()
  for (const e of entries) {
    const list = byRoom.get(e.roomId)
    if (list) list.push(e)
    else byRoom.set(e.roomId, [e])
  }
  const signoffByRoom = new Map<string, RoomSignoff>()
  for (const s of signoffs) if (!s.deleted) signoffByRoom.set(s.roomId, s)

  return floors
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((floor) => {
      const floorRooms = rooms
        .filter((r) => r.floorId === floor.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((room) => roomProgress(room, byRoom.get(room.id) ?? [], signoffByRoom.get(room.id), activeTypes))
      return {
        floor,
        rooms: floorRooms,
        done: floorRooms.filter((r) => r.status === 'done').length,
        inProgress: floorRooms.filter((r) => r.status === 'in_progress').length,
        notStarted: floorRooms.filter((r) => r.status === 'not_started').length,
        itemsFound: floorRooms.reduce((n, r) => n + r.itemsFound, 0),
      }
    })
}

export interface ExerciseStats {
  floors: FloorProgress[]
  roomsTotal: number
  roomsDone: number
  roomsInProgress: number
  itemsFound: number
  tagsIssued: number
  conditions: ConditionTotals
  unlistedItems: number
  missingItems: number
  pendingSync: number
  conflicts: number
  photoCount: number
  byAssetType: Array<{ assetType: AssetType | undefined; name: string; quantity: number }>
}

export async function loadExerciseStats(exerciseId: string): Promise<ExerciseStats> {
  const [floors, entries, assetTypes, photoCount, pendingSync, conflicts] = await Promise.all([
    loadFloorProgress(exerciseId),
    db.entries.where('exerciseId').equals(exerciseId).toArray(),
    db.assetTypes.toArray(),
    db.photos.where('exerciseId').equals(exerciseId).count(),
    db.entries.where('syncStatus').equals('pending').count(),
    db.entries.where('syncStatus').equals('conflict').count(),
  ])

  const live = entries.filter((e) => !e.deleted)
  const typeById = new Map(assetTypes.map((a) => [a.id, a]))
  const perType = new Map<string, { assetType: AssetType | undefined; name: string; quantity: number }>()

  for (const e of live) {
    const key = e.isUnlistedItem ? `unlisted:${e.unlistedItemName ?? 'Unlisted'}` : (e.assetTypeId ?? 'unknown')
    const at = e.assetTypeId ? typeById.get(e.assetTypeId) : undefined
    const name = e.isUnlistedItem ? (e.unlistedItemName ?? 'Unlisted item') : (at?.name ?? 'Unknown')
    const row = perType.get(key) ?? { assetType: at, name, quantity: 0 }
    row.quantity += e.notPresent ? 0 : e.quantity
    perType.set(key, row)
  }

  const rooms = floors.flatMap((f) => f.rooms)
  return {
    floors,
    roomsTotal: rooms.length,
    roomsDone: rooms.filter((r) => r.status === 'done').length,
    roomsInProgress: rooms.filter((r) => r.status === 'in_progress').length,
    itemsFound: live.reduce((n, e) => n + (e.notPresent ? 0 : e.quantity), 0),
    tagsIssued: live.reduce((n, e) => n + e.tagNumbers.length, 0),
    conditions: sumConditions(live),
    unlistedItems: live.filter((e) => e.isUnlistedItem).length,
    missingItems: live.filter((e) => e.notPresent).length,
    pendingSync,
    conflicts,
    photoCount,
    byAssetType: [...perType.values()].sort((a, b) => b.quantity - a.quantity),
  }
}

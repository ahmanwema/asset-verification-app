import Dexie, { type Table } from 'dexie'
import type {
  AssetType,
  Exercise,
  Floor,
  InspectionEntry,
  Inspector,
  Meta,
  Organization,
  Photo,
  Room,
  RoomSignoff,
} from '../types'

export class AssetDB extends Dexie {
  organizations!: Table<Organization, string>
  exercises!: Table<Exercise, string>
  floors!: Table<Floor, string>
  rooms!: Table<Room, string>
  assetTypes!: Table<AssetType, string>
  inspectors!: Table<Inspector, string>
  entries!: Table<InspectionEntry, string>
  signoffs!: Table<RoomSignoff, string>
  photos!: Table<Photo, string>
  meta!: Table<Meta, string>

  constructor() {
    super('asset-verification')
    this.version(1).stores({
      organizations: 'id, updatedAt, syncStatus',
      exercises: 'id, orgId, updatedAt, syncStatus',
      floors: 'id, exerciseId, [exerciseId+sortOrder], updatedAt, syncStatus',
      rooms: 'id, floorId, exerciseId, [floorId+sortOrder], updatedAt, syncStatus',
      assetTypes: 'id, orgId, code, sortOrder, updatedAt, syncStatus',
      inspectors: 'id, email, updatedAt, syncStatus',
      entries:
        'id, exerciseId, roomId, assetTypeId, [roomId+assetTypeId], [exerciseId+roomId], inspectorId, updatedAt, syncStatus',
      signoffs: 'id, roomId, exerciseId, [exerciseId+roomId], updatedAt, syncStatus',
      photos: 'id, entryId, exerciseId, syncStatus',
      meta: 'key',
    })

    // v2 adds the detailed description fields. No index changes, but existing
    // entries are backfilled so reports never print "undefined".
    this.version(2)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table('entries')
          .toCollection()
          .modify((entry: Record<string, unknown>) => {
            entry.material ??= ''
            entry.colour ??= ''
            entry.itemType ??= ''
            entry.additionalFeatures ??= ''
            entry.description ??= ''
            entry.specificPosition ??= ''
          })
      })
  }
}

export const db = new AssetDB()

/** Short, collision-resistant id that works without crypto.randomUUID on old WebViews. */
export function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  return `${prefix}${Date.now().toString(36)}${rnd}`
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

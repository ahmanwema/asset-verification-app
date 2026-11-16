import { db } from '../db/db'
import type { AssetType, Floor, InspectionEntry, Room } from '../types'

/**
 * Tag numbers created inside a block follow
 * [AssetCode]-[BlockCode]-[FloorCode]-[RoomCode]-[Seq]. Legacy locations with
 * no block retain [AssetCode]-[FloorCode]-[RoomCode]-[Seq].
 */
export const TAG_PATTERN = /^([A-Z0-9]{1,6})-(?:([A-Z0-9]{1,6})-)?([A-Z0-9]{1,4})-([A-Z0-9]{1,6})-(\d{3,4})$/

export interface ParsedTag {
  assetCode: string
  blockCode?: string
  floorCode: string
  roomCode: string
  seq: number
}

export function parseTag(tag: string): ParsedTag | null {
  const m = TAG_PATTERN.exec(tag.trim().toUpperCase())
  if (!m) return null
  return {
    assetCode: m[1],
    ...(m[2] ? { blockCode: m[2] } : {}),
    floorCode: m[3],
    roomCode: m[4],
    seq: Number(m[5]),
  }
}

export function formatTag(assetCode: string, floorCode: string, roomCode: string, seq: number, blockCode?: string): string {
  const location = blockCode ? `${blockCode}-${floorCode}-${roomCode}` : `${floorCode}-${roomCode}`
  return `${assetCode}-${location}-${String(seq).padStart(3, '0')}`
}

/**
 * Reissues selected tags with one asset code while keeping their locations.
 * Sequences are allocated around every unselected/occupied tag, so changing
 * CMP, MP2 and MP3 to MP cannot create three copies of MP-...-001.
 */
export function reissueTagsWithAssetCode(
  tags: string[],
  assetCode: string,
  occupiedTags: string[] = [],
): string[] | null {
  const code = assetCode.trim().toUpperCase()
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return null
  const parsed = tags.map(parseTag)
  if (parsed.some((tag) => !tag)) return null

  const occupied = new Set(occupiedTags.map((tag) => tag.trim().toUpperCase()))
  return parsed.map((tag) => {
    let sequence = 1
    let candidate = ''
    while (!candidate && sequence <= 9999) {
      const next = formatTag(code, tag!.floorCode, tag!.roomCode, sequence, tag!.blockCode)
      if (!occupied.has(next)) candidate = next
      sequence += 1
    }
    if (!candidate) return ''
    occupied.add(candidate)
    return candidate
  })
}

/** Builds a short uppercase code from a free-text name, for unlisted items. */
export function deriveCode(name: string, maxLen = 3): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'XX'
  if (words.length === 1) return words[0].slice(0, maxLen)
  return words
    .map((w) => w[0])
    .join('')
    .slice(0, maxLen)
}

/** Room codes are derived from the room name but stay editable in Setup. */
export function deriveRoomCode(name: string): string {
  const compact = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (compact.length <= 4) return compact || 'RM'
  return deriveCode(name, 3)
}

export function assetCodeFor(entry: Pick<InspectionEntry, 'isUnlistedItem' | 'unlistedItemName'>, assetType?: AssetType): string {
  if (entry.isUnlistedItem) return deriveCode(entry.unlistedItemName ?? 'Unlisted')
  return assetType?.code ?? 'XX'
}

/**
 * Allocates `quantity` sequential tag numbers for one asset type in one room,
 * continuing after the highest sequence already issued there. Existing tags on
 * `keepEntryId` are reused so editing an entry does not renumber its labels.
 */
export async function allocateTagNumbers(opts: {
  roomId: string
  assetCode: string
  floorCode: string
  roomCode: string
  blockCode?: string
  quantity: number
  keepEntryId?: string
  /** When removing one item, keep these exact labels instead of the first N. */
  keepTagNumbers?: string[]
}): Promise<string[]> {
  const { roomId, assetCode, floorCode, roomCode, blockCode, quantity, keepEntryId, keepTagNumbers } = opts
  if (quantity <= 0) return []

  const entries = await db.entries.where('roomId').equals(roomId).toArray()
  const used = new Set<number>()
  let keep: string[] = []
  const requested = keepTagNumbers ? new Set(keepTagNumbers) : null

  for (const e of entries) {
    if (e.deleted) continue
    const mine = e.id === keepEntryId
    for (const tag of e.tagNumbers) {
      const parsed = parseTag(tag)
      if (!parsed || parsed.assetCode !== assetCode) continue
      if (mine && (!requested || requested.has(tag))) keep.push(tag)
      else used.add(parsed.seq)
    }
  }

  keep = keep.sort()
  const out = keep.slice(0, quantity)
  let seq = 1
  while (out.length < quantity) {
    const candidate = formatTag(assetCode, floorCode, roomCode, seq, blockCode)
    if (!used.has(seq) && !out.includes(candidate)) out.push(candidate)
    seq += 1
    if (seq > 9999) break
  }
  return out.sort()
}

/** Convenience wrapper that resolves the floor/room codes itself. */
export async function allocateForEntry(opts: {
  room: Room
  floor: Floor
  assetCode: string
  blockCode?: string
  quantity: number
  keepEntryId?: string
}): Promise<string[]> {
  return allocateTagNumbers({
    roomId: opts.room.id,
    assetCode: opts.assetCode,
    floorCode: opts.floor.code,
    roomCode: opts.room.code,
    blockCode: opts.blockCode,
    quantity: opts.quantity,
    keepEntryId: opts.keepEntryId,
  })
}

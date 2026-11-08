import { db, getMeta, setMeta } from '../db/db'
import { blobToBase64 } from './photos'
import { getServerUrl, getToken } from './sync'
import type { Condition } from '../types'

export const VISION_MODELS = ['gpt-4o', 'gpt-4o-mini'] as const
export type VisionModel = (typeof VISION_MODELS)[number]

export interface VisionResult {
  assetTypeCode: string
  itemName: string
  itemType: string
  quantity: number
  condition: Condition
  material: string
  colour: string
  brand: string
  model: string
  serialNumber: string
  additionalFeatures: string
  description: string
  specificPosition: string
  remarks: string
  confidence: number
}

export type VisionError =
  | 'offline'
  | 'not-connected'
  | 'vision-not-configured'
  | 'vision-timeout'
  | 'vision-unreachable'
  | 'vision-upstream'
  | 'vision-bad-response'
  | 'unauthorized'
  | 'failed'

export type VisionOutcome =
  | { ok: true; result: VisionResult; model: string }
  | { ok: false; error: VisionError }

export interface VisionAvailability {
  configured: boolean
  model: string
  models: string[]
}

/** The model preference is per device, so a team can run mini on spare phones. */
export async function getVisionModel(): Promise<VisionModel | null> {
  const stored = await getMeta<string | null>('visionModel', null)
  return VISION_MODELS.includes(stored as VisionModel) ? (stored as VisionModel) : null
}

export async function setVisionModel(model: VisionModel | null): Promise<void> {
  await setMeta('visionModel', model)
}

/** Asks the server whether a key is configured; null when it cannot be reached. */
export async function checkVisionAvailability(): Promise<VisionAvailability | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null
  try {
    const res = await fetch(`${await getServerUrl()}/vision/status`)
    if (!res.ok) return null
    return (await res.json()) as VisionAvailability
  } catch {
    return null
  }
}

/** Catalog and location give the model something to match against. */
async function buildContext(opts: { roomId: string; expectedAssetName?: string }) {
  const room = await db.rooms.get(opts.roomId)
  const floor = room ? await db.floors.get(room.floorId) : undefined
  const assetTypes = await db.assetTypes.orderBy('sortOrder').toArray()
  return {
    assetTypes: assetTypes.filter((a) => a.active).map((a) => ({ code: a.code, name: a.name })),
    roomName: room?.name ?? '',
    floorName: floor?.name ?? '',
    expectedAssetName: opts.expectedAssetName ?? '',
  }
}

/**
 * Sends one photo to the server for identification. The OpenAI key stays on the
 * server — the phone only ever talks to the sync API, which is also why this
 * needs the device to be connected and signed in to that server.
 */
export async function identifyPhoto(
  blob: Blob,
  opts: { roomId: string; expectedAssetName?: string },
): Promise<VisionOutcome> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' }

  const token = await getToken()
  if (!token) return { ok: false, error: 'not-connected' }

  try {
    const [image, context, model] = await Promise.all([
      blobToBase64(blob),
      buildContext(opts),
      getVisionModel(),
    ])

    const res = await fetch(`${await getServerUrl()}/vision/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        image,
        contentType: blob.type || 'image/jpeg',
        model: model ?? undefined,
        context,
      }),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      const known: VisionError[] = [
        'vision-not-configured',
        'vision-timeout',
        'vision-unreachable',
        'vision-upstream',
        'vision-bad-response',
        'unauthorized',
      ]
      const error = known.find((e) => e === body.error) ?? 'failed'
      return { ok: false, error }
    }

    const body = (await res.json()) as { model: string; result: VisionResult }
    return { ok: true, result: body.result, model: body.model }
  } catch {
    return { ok: false, error: 'vision-unreachable' }
  }
}

/** Maps a returned asset code back to a catalog entry, if the exercise has one. */
export async function assetTypeForCode(code: string) {
  if (!code) return undefined
  const all = await db.assetTypes.toArray()
  return all.find((a) => a.code.toUpperCase() === code.toUpperCase() && a.active)
}

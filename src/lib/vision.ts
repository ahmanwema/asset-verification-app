import { db, getMeta, setMeta } from '../db/db'
import { blobToBase64 } from './photos'
import { getServerUrl, getToken } from './sync'
import type { Condition } from '../types'

export const VISION_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4o', 'gpt-4o-mini'] as const
export type VisionModel = (typeof VISION_MODELS)[number]

export interface VisionResult {
  assetTypeCode: string
  itemName: string
  /** Suggested Swahili catalog name; English itemName remains the default. */
  itemNameSw: string
  /** Suggested fixed-asset category, e.g. Furniture or ICT Equipment. */
  category: string
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
  | { ok: false; error: VisionError; upstreamStatus?: number }

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
async function buildContext(opts: {
  roomId?: string
  expectedAssetName?: string
  purpose?: 'entry' | 'catalog'
}) {
  const room = opts.roomId ? await db.rooms.get(opts.roomId) : undefined
  const floor = room ? await db.floors.get(room.floorId) : undefined
  const assetTypes = await db.assetTypes.orderBy('sortOrder').toArray()
  return {
    assetTypes: assetTypes.filter((a) => a.active).map((a) => ({ code: a.code, name: a.name })),
    roomName: room?.name ?? '',
    floorName: floor?.name ?? '',
    expectedAssetName: opts.expectedAssetName ?? '',
    purpose: opts.purpose ?? 'entry',
  }
}

/**
 * Sends one photo to the server for identification. The OpenAI key stays on the
 * server — the phone only ever talks to the sync API, which is also why this
 * needs the device to be connected and signed in to that server.
 */
/** More views than this are not sent: each costs tokens and waiting. */
export const MAX_IDENTIFY_IMAGES = 4

/**
 * Reads one item from one or more photographs of it.
 *
 * Several views help where one cannot: the serial plate on the back, the
 * brand mark underneath, the damage only visible from the side. The server
 * tells the model they are the same item, so the count of photos never
 * becomes the quantity.
 */
export async function identifyPhoto(
  input: Blob | Blob[],
  opts: { roomId?: string; expectedAssetName?: string; purpose?: 'entry' | 'catalog' },
): Promise<VisionOutcome> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' }

  const token = await getToken()
  if (!token) return { ok: false, error: 'not-connected' }

  const blobs = (Array.isArray(input) ? input : [input]).slice(0, MAX_IDENTIFY_IMAGES)
  if (blobs.length === 0) return { ok: false, error: 'failed' }

  try {
    const [images, context, model] = await Promise.all([
      Promise.all(blobs.map((b) => blobToBase64(b))),
      buildContext(opts),
      getVisionModel(),
    ])

    const res = await fetch(`${await getServerUrl()}/vision/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        images,
        contentType: blobs[0].type || 'image/jpeg',
        model: model ?? undefined,
        context,
      }),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; upstreamStatus?: number }
      const known: VisionError[] = [
        'vision-not-configured',
        'vision-timeout',
        'vision-unreachable',
        'vision-upstream',
        'vision-bad-response',
        'unauthorized',
      ]
      const error = known.find((e) => e === body.error) ?? 'failed'
      // Kept so the inspector, and anyone they ask for help, can see what
      // actually went wrong instead of "could not identify".
      await setMeta(
        'lastVisionError',
        `${error}${body.upstreamStatus ? ` (upstream ${body.upstreamStatus})` : ''} · HTTP ${res.status} · ${
          blobs.length
        } photo(s) · ${new Date().toISOString()}`,
      )
      return { ok: false, error, upstreamStatus: body.upstreamStatus }
    }

    const body = (await res.json()) as { model: string; result: VisionResult }
    await setMeta('lastVisionError', null)
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

/** Why the last identification failed, for the diagnostics report. */
export async function lastVisionError(): Promise<string | null> {
  return getMeta<string | null>('lastVisionError', null)
}

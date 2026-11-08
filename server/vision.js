/**
 * Photo recognition for the asset verification app.
 *
 * The OpenAI key lives on this server and never reaches the phone: the PWA
 * posts a compressed photo to /api/vision/identify, this module calls the
 * vision model, and only the normalised result goes back to the device.
 *
 * Configuration (all via .env, loaded by index.js):
 *   OPENAI_API_KEY      required to enable the feature
 *   OPENAI_MODEL        gpt-4o (default) or gpt-4o-mini
 *   OPENAI_BASE_URL     override for a proxy or a test stub
 *   OPENAI_TIMEOUT_MS   request timeout, default 45000
 */

export const VISION_MODELS = ['gpt-4o', 'gpt-4o-mini']

function baseUrl() {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
}

/** Read lazily so tests and .env loading order cannot bake in a stale value. */
export function defaultModel() {
  const configured = process.env.OPENAI_MODEL || ''
  return VISION_MODELS.includes(configured) ? configured : 'gpt-4o'
}

export function visionStatus() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: defaultModel(),
    models: VISION_MODELS,
  }
}

/**
 * System prompt for photo recognition.
 *
 * Kept as one exported constant on purpose: tune the wording here and every
 * device picks it up on its next request — no app rebuild, no redeploy to the
 * phones in the field.
 */
export const VISION_SYSTEM_PROMPT = `You are an asset verification assistant for a physical asset verification and tagging exercise at a school in Tanzania. An inspector photographs one item (or a group of identical items) in a room, and you describe that item for the fixed assets register.

Report only what you can actually see in the photograph. Never guess a serial number, brand or model that is not legible — return an empty string instead. The inspector is tagging real property, and an invented serial number corrupts the register, so "" is always better than a plausible guess.

Reply with a single JSON object and nothing else, using exactly these keys:

{
  "assetTypeCode": string,      // closest code from the catalog supplied below, or "" if nothing matches
  "itemName": string,           // short name, e.g. "Student Chair"
  "itemType": string,           // sub-type, e.g. "Top-Loading Water Dispenser", "Single-seater student chair"
  "quantity": number,           // how many identical items of this type are visible; 1 if unsure
  "condition": string,          // one of "G", "F", "P", "U"
  "material": string,           // e.g. "Wooden seat and backrest with metal frame"
  "colour": string,             // e.g. "Light Brown / Grey"
  "brand": string,              // only if a logo or label is legible
  "model": string,              // only if legible
  "serialNumber": string,       // only if a serial or asset sticker is legible
  "additionalFeatures": string, // e.g. "pen groove on tabletop", "three water taps"
  "description": string,        // one full sentence describing the item physically
  "specificPosition": string,   // where it sits in the room if visible, e.g. "Front left corner", "Mounted on east wall"
  "remarks": string,            // anything an inspector should note, e.g. visible damage
  "confidence": number          // 0 to 1, overall confidence in the identification
}

Condition rubric:
- "G" (Good): fully serviceable, no visible damage beyond light wear.
- "F" (Fair): usable but with visible wear, scratches, fading or minor damage.
- "P" (Poor): heavily damaged, unstable or barely usable; needs repair.
- "U" (Unserviceable): broken, unusable, or beyond economic repair.

Write all text values in English and in sentence case. Every field is a string except "quantity" and "confidence", which are numbers.`

function buildUserContent(context, dataUrl) {
  const catalog = Array.isArray(context?.assetTypes) ? context.assetTypes : []
  const catalogText =
    catalog.length > 0
      ? catalog.map((a) => `${a.code} = ${a.name}`).join('\n')
      : '(no catalog supplied — set assetTypeCode to "")'

  const where = [context?.floorName, context?.roomName].filter(Boolean).join(' / ')
  const expected = context?.expectedAssetName
    ? `\nThe inspector took this photo while recording "${context.expectedAssetName}". Prefer that identification if the photograph is consistent with it.`
    : ''

  return [
    {
      type: 'text',
      text: `Asset type catalog for this exercise:\n${catalogText}\n\nLocation: ${
        where || 'unknown'
      }.${expected}\n\nIdentify the item in the photograph and reply with the JSON object.`,
    },
    { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
  ]
}

const STRING_FIELDS = [
  'assetTypeCode',
  'itemName',
  'itemType',
  'condition',
  'material',
  'colour',
  'brand',
  'model',
  'serialNumber',
  'additionalFeatures',
  'description',
  'specificPosition',
  'remarks',
]

/** Coerces whatever the model returned into exactly the shape the client expects. */
export function normalizeVisionResult(raw) {
  const out = {}
  for (const key of STRING_FIELDS) {
    const value = raw?.[key]
    out[key] = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  }
  out.condition = ['G', 'F', 'P', 'U'].includes(out.condition.toUpperCase()) ? out.condition.toUpperCase() : 'G'
  out.assetTypeCode = out.assetTypeCode.toUpperCase()

  const qty = Number(raw?.quantity)
  out.quantity = Number.isFinite(qty) ? Math.max(0, Math.min(9999, Math.round(qty))) : 1

  const confidence = Number(raw?.confidence)
  out.confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
  return out
}

/**
 * Calls the vision model for one photo.
 * Returns { status, payload } rather than touching the response, so the HTTP
 * layer stays in index.js and this stays unit-testable.
 */
export async function handleVisionIdentify(body) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return { status: 503, payload: { error: 'vision-not-configured' } }

  const image = String(body?.image || '')
  if (!image) return { status: 400, payload: { error: 'missing-image' } }

  const model = VISION_MODELS.includes(body?.model) ? body.model : defaultModel()
  const contentType = String(body?.contentType || 'image/jpeg')
  const dataUrl = `data:${contentType};base64,${image}`
  const timeout = Number(process.env.OPENAI_TIMEOUT_MS || 45000)

  let res
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(body?.context, dataUrl) },
        ],
      }),
    })
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return { status: 504, payload: { error: timedOut ? 'vision-timeout' : 'vision-unreachable' } }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('[vision] upstream', res.status, detail.slice(0, 300))
    return { status: 502, payload: { error: 'vision-upstream', upstreamStatus: res.status } }
  }

  let parsed
  try {
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    parsed = typeof content === 'string' ? JSON.parse(content) : content
  } catch {
    return { status: 502, payload: { error: 'vision-bad-response' } }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 502, payload: { error: 'vision-bad-response' } }
  }

  return { status: 200, payload: { model, result: normalizeVisionResult(parsed) } }
}

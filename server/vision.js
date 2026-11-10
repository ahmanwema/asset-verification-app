/**
 * Photo recognition for the asset verification app.
 *
 * The OpenAI key lives on this server and never reaches the phone: the PWA
 * posts a compressed photo to /api/vision/identify, this module calls the
 * vision model, and only the normalised result goes back to the device.
 *
 * Configuration (all via .env, loaded by index.js):
 *   OPENAI_API_KEY      required to enable the feature
 *   OPENAI_MODEL        any model id the key can use; default gpt-4o
 *   OPENAI_REASONING_EFFORT  none (default) | low | medium | high | xhigh,
 *                       for models that reason before answering
 *   OPENAI_BASE_URL     override for a proxy or a test stub
 *   OPENAI_TIMEOUT_MS   request timeout, default 45000
 */

/**
 * Models offered in the app's picker. A device may only ask for one of these;
 * the server's own OPENAI_MODEL is trusted and may name anything the key can
 * reach, including a model newer than this list.
 */
export const VISION_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4o', 'gpt-4o-mini']

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

/** Reasoning effort for models that support it; null means do not send it. */
export function reasoningEffort() {
  const value = (process.env.OPENAI_REASONING_EFFORT || '').trim().toLowerCase()
  return EFFORTS.includes(value) && value !== 'none' ? value : null
}

function baseUrl() {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
}

/**
 * Read lazily so tests and .env loading order cannot bake in a stale value.
 *
 * Whatever OPENAI_MODEL says is used as-is. It used to be checked against
 * VISION_MODELS and silently replaced with gpt-4o when it did not match,
 * which meant configuring a newer model appeared to work and quietly did
 * nothing — the worst kind of failure, because the bill and the results both
 * look plausible.
 */
export function defaultModel() {
  return (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o'
}

export function visionStatus() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: defaultModel(),
    effort: reasoningEffort(),
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
  "itemName": string,           // short ENGLISH name, e.g. "Student Chair"; this is the default catalog name
  "itemNameSw": string,         // short KISWAHILI translation suitable for the catalog
  "category": string,           // broad class, e.g. "Furniture", "ICT Equipment", "Electrical", "Vehicle"
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

Write text values in English and in sentence case, except itemNameSw which must be in Kiswahili. Every field is a string except "quantity" and "confidence", which are numbers.`

/** At most this many views per request: each one costs tokens and latency. */
export const MAX_IMAGES = 4

export function buildUserContent(context, dataUrls) {
  const catalog = Array.isArray(context?.assetTypes) ? context.assetTypes : []
  const catalogText =
    catalog.length > 0
      ? catalog.map((a) => `${a.code} = ${a.name}`).join('\n')
      : '(no catalog supplied — set assetTypeCode to "")'

  const where = [context?.floorName, context?.roomName].filter(Boolean).join(' / ')
  const expected = context?.expectedAssetName
    ? `\nThe inspector took this photo while recording "${context.expectedAssetName}". Prefer that identification if the photograph is consistent with it.`
    : ''
  const catalogInstruction =
    context?.purpose === 'catalog'
      ? '\nThe inspector is creating a NEW asset type in the catalog. Give a concise generic English itemName as the default name, its concise Kiswahili translation in itemNameSw, and a useful fixed-asset category. The inspector will review and edit all suggestions before saving.'
      : ''

  const urls = Array.isArray(dataUrls) ? dataUrls : [dataUrls]

  // Several photographs are views of ONE item - the front, the back, the
  // serial plate. Saying so matters: without it a model reasonably reads
  // three pictures as three chairs and returns a quantity of three.
  const multi =
    urls.length > 1
      ? `\n\nThere are ${urls.length} photographs below. They are different views of the SAME single item - do not treat them as separate items, and do not let their number affect the quantity. Combine what they show: a detail legible in one of them (a serial plate, a brand mark, damage) is a detail of the item.`
      : ''

  return [
    {
      type: 'text',
      text: `Asset type catalog for this exercise:\n${catalogText}\n\nLocation: ${
        where || 'unknown'
      }.${expected}${catalogInstruction}${multi}\n\nIdentify the item in the photograph${
        urls.length > 1 ? 's' : ''
      } and reply with the JSON object.`,
    },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' } })),
  ]
}

const STRING_FIELDS = [
  'assetTypeCode',
  'itemName',
  'itemNameSw',
  'category',
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
/** Parameters worth dropping to get an answer, rather than failing outright. */
const DROPPABLE = new Set(['temperature', 'reasoning_effort', 'response_format', 'max_completion_tokens'])

/**
 * Reads the parameter the API objected to and edits the request in place.
 * Returns what it changed, or null when it cannot help.
 */
export function adaptRequest(request, detail) {
  let param = null
  try {
    param = JSON.parse(detail)?.error?.param ?? null
  } catch {
    /* not JSON; fall through to the text match */
  }
  if (!param) {
    const m = /(?:unsupported|unrecognized|invalid)[^']*'([a-z_]+)'|'([a-z_]+)'\s+is not supported/i.exec(detail)
    param = m?.[1] || m?.[2] || null
  }
  if (!param) return null

  // The reasoning models renamed this one rather than dropping it.
  if (param === 'max_tokens' && 'max_tokens' in request) {
    request.max_completion_tokens = request.max_tokens
    delete request.max_tokens
    return 'max_tokens (sent as max_completion_tokens)'
  }
  if (DROPPABLE.has(param) && param in request) {
    delete request[param]
    return param
  }
  return null
}

/**
 * Without response_format the model may wrap its JSON in a code fence, so the
 * fence is stripped before parsing. Dropping that parameter is one of the
 * retries above, which makes this reachable in normal operation.
 */
export function parseJsonLoose(text) {
  const trimmed = String(text).trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
    const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
    return JSON.parse(candidate)
  }
}

export async function handleVisionIdentify(body) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return { status: 503, payload: { error: 'vision-not-configured' } }

  // `images` is the current shape; `image` is kept so an older client that
  // has not picked up a new build still works.
  const supplied = Array.isArray(body?.images) && body.images.length > 0 ? body.images : [body?.image]
  const images = supplied
    .map((i) => String(i || ''))
    .filter(Boolean)
    .slice(0, MAX_IMAGES)
  if (images.length === 0) return { status: 400, payload: { error: 'missing-image' } }

  const model = VISION_MODELS.includes(body?.model) ? body.model : defaultModel()
  const contentType = String(body?.contentType || 'image/jpeg')
  const dataUrls = images.map((i) => `data:${contentType};base64,${i}`)
  const timeout = Number(process.env.OPENAI_TIMEOUT_MS || 45000)

  const request = {
    model,
    max_tokens: 700,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(body?.context, dataUrls) },
    ],
  }
  const effort = reasoningEffort()
  if (effort) request.reasoning_effort = effort

  // Models disagree about which parameters they accept — a reasoning model
  // rejects `temperature` and wants `max_completion_tokens` where an older
  // one requires `max_tokens`, and the set moves with every release. Rather
  // than keep a compatibility table that goes stale, the request is adjusted
  // to whatever the API says it will not take, and retried.
  let data = null
  let lastStatus = 0
  let lastDetail = ''

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let res
    try {
      res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify(request),
      })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return { status: 504, payload: { error: timedOut ? 'vision-timeout' : 'vision-unreachable' } }
    }

    if (res.ok) {
      data = await res.json().catch(() => null)
      break
    }

    lastStatus = res.status
    lastDetail = await res.text().catch(() => '')
    const adapted = res.status === 400 ? adaptRequest(request, lastDetail) : null
    if (!adapted) break
    console.warn(`[vision] ${model} rejected ${adapted}; retrying without it`)
  }

  if (!data) {
    console.error('[vision] upstream', lastStatus, lastDetail.slice(0, 300))
    return { status: 502, payload: { error: 'vision-upstream', upstreamStatus: lastStatus } }
  }

  let parsed
  try {
    const content = data?.choices?.[0]?.message?.content
    parsed = typeof content === 'string' ? parseJsonLoose(content) : content
  } catch {
    return { status: 502, payload: { error: 'vision-bad-response' } }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 502, payload: { error: 'vision-bad-response' } }
  }

  return { status: 200, payload: { model, images: images.length, result: normalizeVisionResult(parsed) } }
}

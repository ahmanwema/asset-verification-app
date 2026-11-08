// @vitest-environment node
/**
 * Photo recognition, tested against a stub that stands in for OpenAI, so the
 * request we send and the answer we accept are both pinned down without
 * spending a token or needing a key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { handleVisionIdentify, normalizeVisionResult, VISION_SYSTEM_PROMPT } from './vision.js'

let stub
let stubPort
/** Set by each test: what the stub should answer with. */
let respond
/** Every request body the stub received. */
let received = []

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      respond(res)
    })
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  stubPort = stub.address().port

  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${stubPort}/v1`
  process.env.OPENAI_API_KEY = 'sk-test-key'
  delete process.env.OPENAI_MODEL
})

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve))
})

afterEach(() => {
  received = []
  process.env.OPENAI_API_KEY = 'sk-test-key'
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_TIMEOUT_MS
})

function replyWith(content, status = 200) {
  respond = (res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        status === 200
          ? { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }
          : { error: content },
      ),
    )
  }
}

const GOOD_RESULT = {
  assetTypeCode: 'sc',
  itemName: 'Student Chair',
  itemType: 'Single-seater student chair',
  quantity: 4,
  condition: 'f',
  material: 'Wooden seat and backrest with metal frame',
  colour: 'Light Brown / Grey',
  brand: '',
  model: '',
  serialNumber: '',
  additionalFeatures: 'Pen groove under the seat',
  description: 'Single-seater student chair with wooden seat, wooden backrest and grey metal legs',
  specificPosition: 'Front left corner',
  remarks: 'Scratches on the backrest',
  confidence: 0.82,
}

const IMAGE = Buffer.from([1, 2, 3, 4]).toString('base64')

function body(over = {}) {
  return {
    image: IMAGE,
    contentType: 'image/jpeg',
    context: {
      assetTypes: [
        { code: 'SC', name: 'Student Chair' },
        { code: 'WD', name: 'Water Dispenser' },
      ],
      roomName: 'P3',
      floorName: '1st Floor',
      expectedAssetName: 'Student Chair',
    },
    ...over,
  }
}

describe('request shape', () => {
  it('sends the photo as a data URL with the catalog and the system prompt', async () => {
    replyWith(GOOD_RESULT)
    const { status } = await handleVisionIdentify(body())
    expect(status).toBe(200)

    expect(received).toHaveLength(1)
    const sent = received[0]
    expect(sent.url).toBe('/v1/chat/completions')
    expect(sent.auth).toBe('Bearer sk-test-key')
    expect(sent.body.model).toBe('gpt-4o')
    expect(sent.body.response_format).toEqual({ type: 'json_object' })

    const [system, user] = sent.body.messages
    expect(system.role).toBe('system')
    expect(system.content).toBe(VISION_SYSTEM_PROMPT)

    const text = user.content.find((c) => c.type === 'text').text
    expect(text).toContain('SC = Student Chair')
    expect(text).toContain('1st Floor / P3')
    expect(text).toContain('Student Chair')

    const image = user.content.find((c) => c.type === 'image_url')
    expect(image.image_url.url).toBe(`data:image/jpeg;base64,${IMAGE}`)
  })

  it('honours a per-device model override but ignores an unknown one', async () => {
    replyWith(GOOD_RESULT)
    await handleVisionIdentify(body({ model: 'gpt-4o-mini' }))
    expect(received[0].body.model).toBe('gpt-4o-mini')

    received = []
    replyWith(GOOD_RESULT)
    await handleVisionIdentify(body({ model: 'definitely-not-a-model' }))
    expect(received[0].body.model).toBe('gpt-4o')
  })

  it('takes the server default model from the environment', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    replyWith(GOOD_RESULT)
    await handleVisionIdentify(body())
    expect(received[0].body.model).toBe('gpt-4o-mini')
  })
})

describe('response handling', () => {
  it('normalises the model output into the shape the app expects', async () => {
    replyWith(GOOD_RESULT)
    const { status, payload } = await handleVisionIdentify(body())

    expect(status).toBe(200)
    expect(payload.result.assetTypeCode).toBe('SC') // upper-cased
    expect(payload.result.condition).toBe('F') // upper-cased and validated
    expect(payload.result.quantity).toBe(4)
    expect(payload.result.confidence).toBeCloseTo(0.82)
    expect(payload.result.material).toBe('Wooden seat and backrest with metal frame')
    expect(payload.result.brand).toBe('')
  })

  it('repairs junk values rather than passing them to the form', () => {
    const out = normalizeVisionResult({
      condition: 'excellent',
      quantity: '7.6',
      confidence: 42,
      material: null,
      colour: 123,
      assetTypeCode: 'wd',
    })
    expect(out.condition).toBe('G') // unknown rubric value falls back to Good
    expect(out.quantity).toBe(8)
    expect(out.confidence).toBe(1)
    expect(out.material).toBe('')
    expect(out.colour).toBe('123')
    expect(out.assetTypeCode).toBe('WD')
    expect(out.description).toBe('')
  })

  it('defaults a missing quantity to 1 rather than 0', () => {
    expect(normalizeVisionResult({}).quantity).toBe(1)
  })

  it('rejects a non-JSON answer instead of guessing', async () => {
    replyWith('I think that is a chair.')
    const { status, payload } = await handleVisionIdentify(body())
    expect(status).toBe(502)
    expect(payload.error).toBe('vision-bad-response')
  })

  it('reports an upstream failure with its status', async () => {
    replyWith({ message: 'rate limited' }, 429)
    const { status, payload } = await handleVisionIdentify(body())
    expect(status).toBe(502)
    expect(payload.error).toBe('vision-upstream')
    expect(payload.upstreamStatus).toBe(429)
  })

  it('times out instead of hanging the inspector', async () => {
    process.env.OPENAI_TIMEOUT_MS = '120'
    respond = () => {
      /* never answer */
    }
    const { status, payload } = await handleVisionIdentify(body())
    expect(status).toBe(504)
    expect(payload.error).toBe('vision-timeout')
  })
})

describe('configuration', () => {
  it('reports clearly when no API key is set', async () => {
    delete process.env.OPENAI_API_KEY
    const { status, payload } = await handleVisionIdentify(body())
    expect(status).toBe(503)
    expect(payload.error).toBe('vision-not-configured')
    expect(received).toHaveLength(0) // never calls upstream without a key
  })

  it('refuses a request with no image', async () => {
    const { status, payload } = await handleVisionIdentify(body({ image: '' }))
    expect(status).toBe(400)
    expect(payload.error).toBe('missing-image')
  })
})

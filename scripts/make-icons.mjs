/**
 * Generates the PWA icons (public/icon-192.png, public/icon-512.png) with no
 * image libraries: it rasterises a rounded teal tile with a white check mark and
 * writes the PNG chunks directly. Run with `npm run icons`.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BRAND = [15, 118, 110] // #0f766e
const INK = [255, 255, 255]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function pngFromRgba(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Shortest distance from p to segment ab, all in normalised 0..1 space. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  const tRaw = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq
  const t = Math.max(0, Math.min(1, tRaw))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function roundedRectCoverage(x, y, radius) {
  // x, y in 0..1. Returns a signed distance-ish coverage in pixels-of-unit.
  const cx = Math.abs(x - 0.5)
  const cy = Math.abs(y - 0.5)
  const half = 0.5
  const inner = half - radius
  const dx = Math.max(cx - inner, 0)
  const dy = Math.max(cy - inner, 0)
  return radius - Math.hypot(dx, dy) + (cx <= inner && cy <= inner ? radius : 0)
}

const CHECK = [
  [0.27, 0.52],
  [0.43, 0.68],
  [0.75, 0.33],
]

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 3 // 3x3 supersampling keeps the curves and the check smooth
  const radius = 0.22
  const stroke = 0.075

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tileHits = 0
      let inkHits = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size
          const y = (py + (sy + 0.5) / samples) / size
          if (roundedRectCoverage(x, y, radius) <= 0) continue
          tileHits += 1
          const d = Math.min(
            distToSegment(x, y, CHECK[0][0], CHECK[0][1], CHECK[1][0], CHECK[1][1]),
            distToSegment(x, y, CHECK[1][0], CHECK[1][1], CHECK[2][0], CHECK[2][1]),
          )
          if (d <= stroke / 2) inkHits += 1
        }
      }
      const total = samples * samples
      const alpha = Math.round((tileHits / total) * 255)
      const inkMix = tileHits === 0 ? 0 : inkHits / tileHits
      const i = (py * size + px) * 4
      for (let c = 0; c < 3; c += 1) {
        rgba[i + c] = Math.round(BRAND[c] * (1 - inkMix) + INK[c] * inkMix)
      }
      rgba[i + 3] = alpha
    }
  }
  return pngFromRgba(size, size, rgba)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`)
  fs.writeFileSync(file, render(size))
  console.log(`wrote ${file} (${fs.statSync(file).size} bytes)`)
}

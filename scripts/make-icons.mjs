// Draws the app icons for the installable tablet app (public/icons/*.png). Plain Node, no image library:
// a dark square with the orange mountain mark of the web app, written as PNG with zlib.
// Run once with `node scripts/make-icons.mjs`; the PNGs are committed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BG = [14, 17, 22]
const ORANGE = [255, 138, 61]
const DARK = [26, 14, 6]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0 // no filter
    for (let x = 0; x < size; x++) raw.set(pixel(x / size, y / size), y * (size * 3 + 1) + 1 + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Is (u, v) inside the triangle a, b, c? */
function inTri(u, v, [a, b, c]) {
  const s = (p, q) => (u - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (v - q[1])
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/** `pad` keeps the mark inside the safe zone of a maskable icon. */
function icon(pad) {
  const k = 1 - 2 * pad
  const at = (x, y) => [pad + x * k, pad + y * k]
  const peaks = [
    [at(0.12, 0.8), at(0.42, 0.28), at(0.72, 0.8)],
    [at(0.45, 0.8), at(0.66, 0.46), at(0.9, 0.8)],
  ]
  const [cx, cy] = at(0.5, 0.5)
  return (u, v) => {
    const disc = (u - cx) ** 2 + (v - cy) ** 2 < (0.46 * k) ** 2
    if (!disc) return BG
    return peaks.some((t) => inTri(u, v, t)) ? DARK : ORANGE
  }
}

mkdirSync('public/icons', { recursive: true })
for (const size of [192, 512]) writeFileSync(`public/icons/icon-${size}.png`, png(size, icon(0.04)))
writeFileSync('public/icons/maskable-512.png', png(512, icon(0.14)))
console.log('wrote public/icons/icon-192.png, icon-512.png, maskable-512.png')

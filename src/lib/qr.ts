// Minimal dependency-free QR encoder for signing URLs.
// Fixed QR version 8, error correction M, byte mode. Capacity is 152 ASCII/UTF-8 bytes.
// This keeps temporary signing links entirely inside Blagajna (no external QR service).

const VERSION = 8
const SIZE = 17 + VERSION * 4 // 49
const DATA_CODEWORDS = 154
const ECC_CODEWORDS = 22
const ALIGNMENT = [6, 24, 42]

type Cell = boolean | null

function gfTables() {
  const exp = new Array<number>(512).fill(0)
  const log = new Array<number>(256).fill(0)
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255]
  return { exp, log }
}
const GF = gfTables()

function gfMul(a: number, b: number) {
  if (!a || !b) return 0
  return GF.exp[GF.log[a] + GF.log[b]]
}

function polyMul(a: number[], b: number[]) {
  const out = new Array(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= gfMul(a[i], b[j])
  }
  return out
}

function rsGenerator(degree: number) {
  let g = [1]
  for (let i = 0; i < degree; i += 1) g = polyMul(g, [1, GF.exp[i]])
  return g
}

function rsEncode(data: number[], degree: number) {
  const gen = rsGenerator(degree)
  const ecc = new Array(degree).fill(0)
  for (const value of data) {
    const factor = value ^ ecc[0]
    ecc.shift()
    ecc.push(0)
    if (factor) {
      for (let i = 0; i < degree; i += 1) ecc[i] ^= gfMul(gen[i + 1], factor)
    }
  }
  return ecc
}

class BitBuffer {
  bits: number[] = []
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }
  toBytes() {
    const out: number[] = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let v = 0
      for (let j = 0; j < 8; j += 1) v = (v << 1) | (this.bits[i + j] ?? 0)
      out.push(v)
    }
    return out
  }
}

function createCodewords(text: string) {
  const bytes = Array.from(new TextEncoder().encode(text))
  // version 8/M byte-mode payload maximum: 152 bytes after mode/length overhead.
  if (bytes.length > 152) throw new Error('Povezava je predolga za vgrajeno QR kodo.')
  const b = new BitBuffer()
  b.put(0b0100, 4) // byte mode
  b.put(bytes.length, 8) // version < 10
  for (const x of bytes) b.put(x, 8)
  const capacityBits = DATA_CODEWORDS * 8
  for (let i = 0; i < 4 && b.bits.length < capacityBits; i += 1) b.bits.push(0)
  while (b.bits.length % 8) b.bits.push(0)
  const data = b.toBytes()
  let pad = 0
  while (data.length < DATA_CODEWORDS) {
    data.push(pad % 2 === 0 ? 0xec : 0x11)
    pad += 1
  }

  // Version 8 / M: 2 x (60 total, 38 data) + 2 x (61 total, 39 data), each with 22 ECC bytes.
  const blocks: number[][] = []
  let at = 0
  for (const len of [38, 38, 39, 39]) {
    blocks.push(data.slice(at, at + len))
    at += len
  }
  const ecc = blocks.map((block) => rsEncode(block, ECC_CODEWORDS))
  const out: number[] = []
  for (let i = 0; i < 39; i += 1) for (const block of blocks) if (i < block.length) out.push(block[i])
  for (let i = 0; i < ECC_CODEWORDS; i += 1) for (const block of ecc) out.push(block[i])
  return out
}

function bchTypeInfo(data: number) {
  let d = data << 10
  const g = 0x537
  const degree = (x: number) => {
    let n = 0
    while (x) { n += 1; x >>>= 1 }
    return n
  }
  while (degree(d) - degree(g) >= 0) d ^= g << (degree(d) - degree(g))
  return ((data << 10) | d) ^ 0x5412
}

function bchVersion(data: number) {
  let d = data << 12
  const g = 0x1f25
  const degree = (x: number) => {
    let n = 0
    while (x) { n += 1; x >>>= 1 }
    return n
  }
  while (degree(d) - degree(g) >= 0) d ^= g << (degree(d) - degree(g))
  return (data << 12) | d
}

function finder(m: Cell[][], row: number, col: number) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r; const x = col + c
      if (y < 0 || y >= SIZE || x < 0 || x >= SIZE) continue
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (
        r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      )
      m[y][x] = dark
    }
  }
}

function setupPatterns(m: Cell[][]) {
  finder(m, 0, 0)
  finder(m, SIZE - 7, 0)
  finder(m, 0, SIZE - 7)

  for (const row of ALIGNMENT) {
    for (const col of ALIGNMENT) {
      if (m[row][col] !== null) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          m[row + r][col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)
        }
      }
    }
  }

  for (let i = 8; i < SIZE - 8; i += 1) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0
    if (m[6][i] === null) m[6][i] = i % 2 === 0
  }

  const versionBits = bchVersion(VERSION)
  for (let i = 0; i < 18; i += 1) {
    const bit = ((versionBits >>> i) & 1) === 1
    m[Math.floor(i / 3)][(i % 3) + SIZE - 11] = bit
    m[(i % 3) + SIZE - 11][Math.floor(i / 3)] = bit
  }

  // Error correction M = 0, mask pattern 0 = 0.
  const formatBits = bchTypeInfo(0)
  for (let i = 0; i < 15; i += 1) {
    const bit = ((formatBits >>> i) & 1) === 1
    if (i < 6) m[i][8] = bit
    else if (i < 8) m[i + 1][8] = bit
    else m[SIZE - 15 + i][8] = bit

    if (i < 8) m[8][SIZE - i - 1] = bit
    else if (i < 9) m[8][15 - i] = bit
    else m[8][14 - i] = bit
  }
  m[SIZE - 8][8] = true
}

export function qrMatrix(text: string): boolean[][] {
  const codewords = createCodewords(text)
  const m: Cell[][] = Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(null))
  setupPatterns(m)

  let row = SIZE - 1
  let inc = -1
  let byteIndex = 0
  let bitIndex = 7
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    while (true) {
      for (let c = 0; c < 2; c += 1) {
        const x = col - c
        if (m[row][x] !== null) continue
        let dark = false
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
        if ((row + x) % 2 === 0) dark = !dark // mask 0
        m[row][x] = dark
        bitIndex -= 1
        if (bitIndex < 0) { byteIndex += 1; bitIndex = 7 }
      }
      row += inc
      if (row < 0 || row >= SIZE) {
        row -= inc
        inc = -inc
        break
      }
    }
  }
  return m.map((r) => r.map(Boolean))
}

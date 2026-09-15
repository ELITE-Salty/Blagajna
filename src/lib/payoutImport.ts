import type { Employee, Potrdilo } from '../types'

export interface PayoutSourceRow {
  rowNo: number
  firstName: string
  lastName: string
  displayName: string
  amount: number
}

export interface PayoutPart {
  sourceRow: number
  employee: Employee | null
  employeeName: string
  originalAmount: number
  amount: number
  date: string
  time: string
  dateSource: 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW'
  potrdiloId: string | null
  warning?: string
}

const norm = (v: string) => v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

function parseAmountCell(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  const raw = String(v ?? '').trim().replace(/\s/g, '')
  if (!raw) return null
  let s = raw.replace(/€/g, '')
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  else if (s.includes(',')) s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function parseDelimited(text: string): unknown[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.trim())
  if (!lines.length) return []
  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ','
  return lines.map((line) => {
    const out: string[] = []
    let cur = '', quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++ }
        else quoted = !quoted
      } else if (ch === delimiter && !quoted) { out.push(cur.trim()); cur = '' }
      else cur += ch
    }
    out.push(cur.trim())
    return out
  })
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true)
const u32 = (d: DataView, o: number) => d.getUint32(o, true)

async function unzipXlsx(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buf)
  const view = new DataView(buf)
  let eocd = -1
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 22; i++) {
    if (u32(view, i) === 0x06054b50) eocd = i
  }
  if (eocd < 0) throw new Error('Datoteka ni veljaven XLSX/ZIP.')
  const count = u16(view, eocd + 10)
  let pos = u32(view, eocd + 16)
  const decoder = new TextDecoder()
  const files = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    if (u32(view, pos) !== 0x02014b50) throw new Error('XLSX: napačen centralni imenik ZIP.')
    const method = u16(view, pos + 10)
    const compSize = u32(view, pos + 20)
    const nameLen = u16(view, pos + 28)
    const extraLen = u16(view, pos + 30)
    const commentLen = u16(view, pos + 32)
    const localOffset = u32(view, pos + 42)
    const name = decoder.decode(bytes.slice(pos + 46, pos + 46 + nameLen))
    if (u32(view, localOffset) !== 0x04034b50) throw new Error('XLSX: napačna lokalna ZIP glava.')
    const localNameLen = u16(view, localOffset + 26)
    const localExtraLen = u16(view, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const packed = bytes.slice(dataStart, dataStart + compSize)
    let data: Uint8Array
    if (method === 0) data = packed
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Ta brskalnik ne podpira branja XLSX. Datoteko shranite kot CSV ali uporabite novejši brskalnik.')
      const ds = new DecompressionStream('deflate-raw')
      const ab = await new Response(new Blob([packed]).stream().pipeThrough(ds)).arrayBuffer()
      data = new Uint8Array(ab)
    } else throw new Error(`XLSX: nepodprta ZIP kompresija (${method}).`)
    files.set(name, data)
    pos += 46 + nameLen + extraLen + commentLen
  }
  return files
}

function xmlText(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('XLSX vsebuje neveljaven XML.')
  return doc
}

function colIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/i)?.[0] ?? 'A').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

function parseSheetXml(sheetXml: string, shared: string[]): unknown[][] {
  const doc = xmlText(sheetXml)
  const rows: unknown[][] = []
  for (const row of Array.from(doc.getElementsByTagName('row'))) {
    const out: unknown[] = []
    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const idx = colIndex(c.getAttribute('r') ?? 'A1')
      const type = c.getAttribute('t') ?? ''
      const v = c.getElementsByTagName('v')[0]?.textContent ?? ''
      let value: unknown = v
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = Array.from(c.getElementsByTagName('t')).map((t) => t.textContent ?? '').join('')
      else if (type === 'b') value = v === '1'
      else if (v !== '' && Number.isFinite(Number(v))) value = Number(v)
      out[idx] = value
    }
    rows.push(out)
  }
  return rows
}

async function parseXlsx(file: File): Promise<unknown[][]> {
  const files = await unzipXlsx(await file.arrayBuffer())
  const decoder = new TextDecoder()
  const sharedXml = files.get('xl/sharedStrings.xml')
  const shared = sharedXml
    ? Array.from(xmlText(decoder.decode(sharedXml)).getElementsByTagName('si')).map((si) => Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join(''))
    : []
  const sheetName = [...files.keys()].filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(x)).sort()[0]
  if (!sheetName) throw new Error('XLSX nima delovnega lista.')
  return parseSheetXml(decoder.decode(files.get(sheetName)!), shared)
}

export async function readPayoutSource(file: File): Promise<PayoutSourceRow[]> {
  const name = file.name.toLowerCase()
  const matrix = name.endsWith('.xlsx') ? await parseXlsx(file) : parseDelimited(await file.text())
  if (matrix.length < 2) return []
  const headerNames = {
    first: ['ime', 'first name', 'firstname'],
    last: ['priimek', 'last name', 'lastname'],
    display: ['ime in priimek', 'priimek in ime', 'zaposleni', 'employee', 'name surname', 'full name'],
    amount: ['znesek', 'vrednost', 'value', 'amount', 'eur', 'znesek eur'],
  }
  let headerRow = -1
  let headers: string[] = []
  let firstIdx = -1, lastIdx = -1, displayIdx = -1, amountIdx = -1
  for (let h = 0; h < Math.min(matrix.length, 20); h++) {
    const candidate = (matrix[h] ?? []).map((x) => norm(String(x ?? '')))
    const find = (names: string[]) => candidate.findIndex((v) => names.map(norm).includes(v))
    const fi = find(headerNames.first), li = find(headerNames.last), di = find(headerNames.display), ai = find(headerNames.amount)
    if (ai >= 0 && (di >= 0 || (fi >= 0 && li >= 0))) {
      headerRow = h; headers = candidate; firstIdx = fi; lastIdx = li; displayIdx = di; amountIdx = ai
      break
    }
  }
  if (headerRow < 0) {
    throw new Error('Excel mora imeti stolpca Ime + Priimek (ali Ime in priimek) ter Znesek/Vrednost.')
  }
  void headers
  const out: PayoutSourceRow[] = []
  for (let i = headerRow + 1; i < matrix.length; i++) {
    const r = matrix[i] ?? []
    let firstName = firstIdx >= 0 ? String(r[firstIdx] ?? '').trim() : ''
    let lastName = lastIdx >= 0 ? String(r[lastIdx] ?? '').trim() : ''
    const display = displayIdx >= 0 ? String(r[displayIdx] ?? '').trim() : ''
    if ((!firstName || !lastName) && display) {
      const parts = display.split(/\s+/)
      if (!lastName && parts.length > 1) lastName = parts.pop() ?? ''
      if (!firstName) firstName = parts.join(' ')
    }
    const amount = parseAmountCell(r[amountIdx])
    if ((!firstName && !lastName) || amount == null || amount <= 0) continue
    out.push({ rowNo: i + 1, firstName, lastName, displayName: display || `${firstName} ${lastName}`.trim(), amount })
  }
  return out
}

export function splitPayoutAmount(amount: number, seed = 1): { parts: number[]; split: boolean } {
  const totalCents = Math.round(amount * 100)
  const minPart = 30000
  const maxPart = 50000

  // Accountant rule: only amounts ABOVE 700 EUR are split.
  // Amounts up to and including 700 EUR stay as one BI entry.
  if (totalCents <= 70000) return { parts: [totalCents / 100], split: false }

  // Aim for pieces around 400-450 EUR rather than always using the fewest
  // possible pieces. Then adjust to the mathematically valid 300-500 EUR range.
  let count = Math.max(2, Math.ceil(totalCents / 45000))
  while (count * minPart > totalCents && count > 2) count--
  while (count * maxPart < totalCents) count++
  const partsCents: number[] = []
  let remaining = totalCents
  let state = (Math.abs(Math.trunc(seed)) + totalCents) >>> 0
  const nextRand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }

  for (let i = 0; i < count; i++) {
    const remainingParts = count - i - 1
    if (remainingParts === 0) {
      partsCents.push(remaining)
      break
    }

    // Leave enough for all remaining pieces while keeping this piece legal.
    const low = Math.max(minPart, remaining - remainingParts * maxPart)
    const high = Math.min(maxPart, remaining - remainingParts * minPart)

    // Prefer natural 5 EUR steps for intermediate pieces, but never alter
    // the imported total. The final piece carries any cents/remainder exactly.
    const step = 500
    const lowStep = Math.ceil(low / step) * step
    const highStep = Math.floor(high / step) * step
    let chosen: number
    if (lowStep <= highStep) {
      const slots = Math.floor((highStep - lowStep) / step) + 1
      chosen = lowStep + Math.floor(nextRand() * slots) * step
    } else {
      chosen = Math.round(low + nextRand() * (high - low))
    }
    chosen = Math.max(low, Math.min(high, chosen))
    partsCents.push(chosen)
    remaining -= chosen
  }

  return { parts: partsCents.map((x) => x / 100), split: true }
}

export function payoutWindow(monthKey: string): { start: string; end: string; days: string[] } {
  const [y, m] = monthKey.split('-').map(Number)
  const start = new Date(y, m - 1, 20)
  const end = new Date(y, m, 16)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const days: string[] = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(iso(d))
  return { start: iso(start), end: iso(end), days }
}

// Employee names in the payout export are not always clean: first/last name can be
// reversed, cells can contain duplicate words or trailing spaces, and some exports add
// suffixes such as "ml." or notes such as "NIMA PREB. V SLO". Build a canonical
// token key so those harmless differences do not prevent an otherwise exact match.
function personNameTokens(...values: unknown[]): string[] {
  let value = values
    .map((v) => String(v ?? ''))
    .join(' ')
    .toLowerCase()
    // Characters such as đ/Đ do not reliably decompose with Unicode NFD/NFKD.
    .replace(/[đð]/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Known non-name text that appears in the payout source.
  value = value
    .replace(/\bnima preb v slo\b/g, ' ')
    .replace(/\bml\b/g, ' ')
    .replace(/\bjr\b/g, ' ')
    .replace(/\bjunior\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // A repeated token should not matter, e.g. "ČAPELJA Mario" + "MARIO".
  return [...new Set(value.split(' ').filter(Boolean))].sort()
}

function personNameKey(...values: unknown[]): string {
  return personNameTokens(...values).join('|')
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i])
}

function isSubset(subset: string[], superset: string[]): boolean {
  return subset.length > 0 && subset.every((token) => superset.includes(token))
}

function uniqueEmployee(matches: Employee[]): Employee | null {
  const byId = new Map(matches.map((e) => [e.id, e]))
  return byId.size === 1 ? [...byId.values()][0] : null
}

function matchEmployee(row: PayoutSourceRow, employees: Employee[]): Employee | null {
  // Keep the source columns separate as well as combined. Some employee records contain
  // an extra middle name / suffix in displayName even when firstName + lastName are exact.
  const rowParts = personNameTokens(row.firstName, row.lastName)
  const rowDisplay = personNameTokens(row.displayName)
  const rowAll = personNameTokens(row.firstName, row.lastName, row.displayName)
  if (rowAll.length < 2) return null

  // 1) Safest match: first + last tokens are exactly the same, regardless of order,
  // accents, duplicate words, or whitespace.
  const exactParts = employees.filter((e) =>
    sameTokens(personNameTokens(e.firstName, e.lastName), rowParts)
  )
  const exactPartsMatch = uniqueEmployee(exactParts)
  if (exactPartsMatch) return exactPartsMatch

  // 2) Exact display-name token match.
  const exactDisplay = employees.filter((e) =>
    sameTokens(personNameTokens(e.displayName), rowDisplay)
  )
  const exactDisplayMatch = uniqueEmployee(exactDisplay)
  if (exactDisplayMatch) return exactDisplayMatch

  // 3) Exact match across every available name field.
  const exactAll = employees.filter((e) =>
    sameTokens(personNameTokens(e.firstName, e.lastName, e.displayName), rowAll)
  )
  const exactAllMatch = uniqueEmployee(exactAll)
  if (exactAllMatch) return exactAllMatch

  // 4) Controlled fallback for records where one side contains an extra middle name,
  // suffix, or administrative word. We still require at least two matching name tokens
  // and accept the result only when exactly ONE employee satisfies it.
  const subsetMatches = employees.filter((e) => {
    const employeeTokens = personNameTokens(e.firstName, e.lastName, e.displayName)
    if (employeeTokens.length < 2) return false
    return isSubset(rowParts, employeeTokens) || isSubset(employeeTokens, rowAll)
  })

  return uniqueEmployee(subsetMatches)
}

function uniqueBounds(bounds: { date: string; source: 'POTRDILO_START' | 'POTRDILO_END'; potrdiloId: string }[]) {
  const seen = new Set<string>()
  return bounds.filter((b) => {
    if (seen.has(b.date)) return false
    seen.add(b.date)
    return true
  })
}

function spreadWindowDays(days: string[], count: number, seed: number, excluded: Set<string>): string[] {
  if (count <= 0 || !days.length) return []
  const available = days.filter((d) => !excluded.has(d))
  if (!available.length) return []
  const out: string[] = []
  const offset = Math.abs(seed) % available.length

  // Pick dates across the full 20th -> 16th window rather than taking
  // consecutive days. For normal imports, each split piece gets a unique day.
  for (let i = 0; i < count && out.length < available.length; i++) {
    const base = Math.floor(((i + 0.5) * available.length) / Math.min(count, available.length))
    let idx = (base + offset) % available.length
    let guard = 0
    while (out.includes(available[idx]) && guard++ < available.length) idx = (idx + 1) % available.length
    if (!out.includes(available[idx])) out.push(available[idx])
  }
  return out
}

function timeToMinutes(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return fallback
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback
  return hour * 60 + minute
}

function payoutTime(seed: number, partIndex: number, timeFrom: string, timeTo: string): string {
  // Generate a deterministic time INSIDE the user-selected inclusive range.
  // Defaults preserve the old 08:00-17:59 working-day window.
  const from = timeToMinutes(timeFrom, 8 * 60)
  const to = timeToMinutes(timeTo, 17 * 60 + 59)
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const span = end - start + 1
  const offset = (Math.abs(Math.trunc(seed)) * 47 + partIndex * 137) % span
  const totalMinutes = start + offset
  const hour = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function buildPayoutParts(
  rows: PayoutSourceRow[],
  employees: Employee[],
  potrdila: Potrdilo[],
  monthKey: string,
  timeFrom = '08:00',
  timeTo = '17:59',
): PayoutPart[] {
  const win = payoutWindow(monthKey)
  const out: PayoutPart[] = []
  let fallbackCursor = 0

  for (const row of rows) {
    const employee = matchEmployee(row, employees)
    const split = splitPayoutAmount(row.amount, row.rowNo)
    const bounds = uniqueBounds(employee ? potrdila
      .filter((p) => p.employeeId === employee.id)
      .flatMap((p) => [
        { date: p.fromAt.slice(0, 10), source: 'POTRDILO_START' as const, potrdiloId: p.id },
        { date: p.toAt.slice(0, 10), source: 'POTRDILO_END' as const, potrdiloId: p.id },
      ])
      .filter((x) => x.date >= win.start && x.date <= win.end)
      .sort((a, b) => a.date.localeCompare(b.date)) : [])

    // Use valid dopust-list boundaries first, but never put all split pieces
    // on one day. Any remaining pieces are spread across the full 20.-16. window.
    const chosenBounds = bounds.slice(0, split.parts.length)
    const usedDates = new Set(chosenBounds.map((b) => b.date))
    const neededFallback = Math.max(0, split.parts.length - chosenBounds.length)
    let fallbackDays = spreadWindowDays(win.days, neededFallback, row.rowNo + fallbackCursor, usedDates)

    // Extremely large imports can contain more pieces than the number of days
    // in the window. In that unusual case, cycle through the window; times stay different.
    while (fallbackDays.length < neededFallback) {
      fallbackDays.push(win.days[(fallbackCursor + fallbackDays.length) % win.days.length])
    }
    fallbackCursor += neededFallback

    const schedule = [
      ...chosenBounds.map((b) => ({ date: b.date, source: b.source, potrdiloId: b.potrdiloId })),
      ...fallbackDays.map((date) => ({ date, source: 'WINDOW' as const, potrdiloId: null })),
    ].sort((a, b) => a.date.localeCompare(b.date))

    split.parts.forEach((amount, i) => {
      const slot = schedule[i]
      const warnings: string[] = []
      if (!employee) warnings.push('Zaposleni ni enolično najden')
      if (slot.source === 'WINDOW') warnings.push(bounds.length ? 'Dodatni del je razporejen na drug dan v oknu 20.–16.' : 'Ni meje dopust lista v obdobju; uporabljen je razpršen datum iz okna 20.–16.')
      if (split.split) warnings.push('Znesek nad 700 € je razdeljen na dele 300–500 €; vsota ostane nespremenjena')

      out.push({
        sourceRow: row.rowNo,
        employee,
        employeeName: employee?.displayName ?? row.displayName,
        originalAmount: row.amount,
        amount,
        date: slot.date,
        time: payoutTime(row.rowNo, i, timeFrom, timeTo),
        dateSource: slot.source,
        potrdiloId: slot.potrdiloId,
        warning: warnings.join(' · ') || undefined,
      })
    })
  }
  return out
}

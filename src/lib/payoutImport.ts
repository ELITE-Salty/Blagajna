import type { Employee, Potrdilo } from '../types'

export interface PayoutSourceRow {
  rowNo: number
  firstName: string
  lastName: string
  displayName: string
  amount: number
}

export type PayoutDateSource = 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW' | 'MANUAL'

export interface PayoutPart {
  partKey: string
  sourceRow: number
  employee: Employee | null
  employeeName: string
  originalAmount: number
  amount: number
  date: string
  time: string
  dateSource: PayoutDateSource
  potrdiloId: string | null
  warning?: string
  scheduleError?: string
  skipReason?: string
  cashAvailable?: number
  cashAt?: string
}

export interface CashEvent {
  at: string
  delta: number
  source?: 'DOC' | 'TRANSFER'
  id?: string
  label?: string
}

export interface PayoutScheduleContext {
  currentBalance: number
  events: CashEvent[]
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

function isoDateToUtc(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const out = new Date(Date.UTC(y, mo - 1, d))
  if (out.getUTCFullYear() !== y || out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d) return null
  return out
}

function utcToIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function addIsoDays(date: string, days: number): string {
  const d = isoDateToUtc(date)
  if (!d) return date
  d.setUTCDate(d.getUTCDate() + days)
  return utcToIso(d)
}

function daysBetween(a: string, b: string): number {
  const da = isoDateToUtc(a), db = isoDateToUtc(b)
  if (!da || !db) return Number.NaN
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

export function formatSloDate(date: string): string {
  const d = isoDateToUtc(date)
  if (!d) return date
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
}

export function parseSloDate(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return isoDateToUtc(raw) ? raw : null
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(raw)
  if (!m) return null
  const iso = `${m[3]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`
  return isoDateToUtc(iso) ? iso : null
}

export function normalizePayoutTime(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const hour = Number(m[1]), minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function easterSundayIso(year: number): string {
  // Meeus/Jones/Butcher Gregorian Easter algorithm.
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function slovenianHolidayName(date: string): string | null {
  const d = isoDateToUtc(date)
  if (!d) return null
  const md = date.slice(5)
  const fixed: Record<string, string> = {
    '01-01': 'novo leto',
    '01-02': 'novo leto',
    '02-08': 'Prešernov dan',
    '04-27': 'dan upora proti okupatorju',
    '05-01': 'praznik dela',
    '05-02': 'praznik dela',
    '06-25': 'dan državnosti',
    '08-15': 'Marijino vnebovzetje',
    '10-31': 'dan reformacije',
    '11-01': 'dan spomina na mrtve',
    '12-25': 'božič',
    '12-26': 'dan samostojnosti in enotnosti',
  }
  if (fixed[md]) return fixed[md]
  const easterMonday = addIsoDays(easterSundayIso(d.getUTCFullYear()), 1)
  if (date === easterMonday) return 'velikonočni ponedeljek'
  return null
}

export function isSlovenianWorkday(date: string): boolean {
  const d = isoDateToUtc(date)
  if (!d) return false
  const day = d.getUTCDay()
  return day !== 0 && day !== 6 && !slovenianHolidayName(date)
}

function timeToMinutes(value: string, fallback: number): number {
  const normalized = normalizePayoutTime(value)
  if (!normalized) return fallback
  const [hour, minute] = normalized.split(':').map(Number)
  return hour * 60 + minute
}

function minutesToTime(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60)
  const minute = totalMinutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function payoutTime(seed: number, partIndex: number, timeFrom: string, timeTo: string): string {
  const from = timeToMinutes(timeFrom, 8 * 60)
  const to = timeToMinutes(timeTo, 17 * 60 + 59)
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const span = end - start + 1
  const offset = (Math.abs(Math.trunc(seed)) * 47 + partIndex * 137) % span
  return minutesToTime(start + offset)
}

type Boundary = {
  date: string
  source: 'POTRDILO_START' | 'POTRDILO_END'
  potrdiloId: string
}

function moveToWorkday(date: string, direction: 1 | -1, minDate: string, maxDate: string): string | null {
  let cur = date
  for (let guard = 0; guard < 14 && cur >= minDate && cur <= maxDate; guard++) {
    if (isSlovenianWorkday(cur)) return cur
    cur = addIsoDays(cur, direction)
  }
  return null
}

function employeeBounds(employee: Employee | null, potrdila: Potrdilo[], win: ReturnType<typeof payoutWindow>): Boundary[] {
  if (!employee) return []
  const out: Boundary[] = []
  for (const p of potrdila.filter((x) => x.employeeId === employee.id)) {
    const rawFrom = p.fromAt.slice(0, 10)
    const rawTo = p.toAt.slice(0, 10)
    if (rawTo < win.start || rawFrom > win.end) continue
    const overlapStart = rawFrom < win.start ? win.start : rawFrom
    const overlapEnd = rawTo > win.end ? win.end : rawTo
    const start = moveToWorkday(overlapStart, 1, overlapStart, overlapEnd)
    const end = moveToWorkday(overlapEnd, -1, overlapStart, overlapEnd)
    if (start) out.push({ date: start, source: 'POTRDILO_START', potrdiloId: p.id })
    if (end) out.push({ date: end, source: 'POTRDILO_END', potrdiloId: p.id })
  }
  const seen = new Set<string>()
  return out
    .sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source))
    .filter((b) => {
      const key = `${b.date}|${b.potrdiloId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function baseBalanceAt(context: PayoutScheduleContext, at: string): number {
  let balance = context.currentBalance
  for (const event of context.events) {
    if (event.at > at) balance -= event.delta
  }
  return Math.round(balance * 100) / 100
}

function scheduleStaysSolvent(context: PayoutScheduleContext, scheduled: { at: string; amount: number }[]): boolean {
  if (!scheduled.length) return true
  const checkpoints = [...new Set([
    ...context.events.map((e) => e.at),
    ...scheduled.map((s) => s.at),
  ])].sort()
  for (const at of checkpoints) {
    const imported = scheduled.reduce((sum, s) => sum + (s.at <= at ? s.amount : 0), 0)
    if (baseBalanceAt(context, at) - imported < -0.001) return false
  }
  const importedTotal = scheduled.reduce((sum, s) => sum + s.amount, 0)
  return context.currentBalance - importedTotal >= -0.001
}

function availableBeforeCandidate(
  context: PayoutScheduleContext,
  scheduled: { at: string; amount: number }[],
  at: string,
): number {
  const alreadyImported = scheduled.reduce((sum, s) => sum + (s.at <= at ? s.amount : 0), 0)
  return Math.round((baseBalanceAt(context, at) - alreadyImported) * 100) / 100
}

function candidateTimesForDate(
  date: string,
  preferred: string,
  timeFrom: string,
  timeTo: string,
  context?: PayoutScheduleContext,
  extraTimes: string[] = [],
): string[] {
  const from = timeToMinutes(timeFrom, 8 * 60)
  const to = timeToMinutes(timeTo, 17 * 60 + 59)
  const start = Math.min(from, to), end = Math.max(from, to)
  const ordered: number[] = []
  const addMinute = (minute: number) => {
    if (minute >= start && minute <= end && !ordered.includes(minute)) ordered.push(minute)
  }
  addMinute(timeToMinutes(preferred, start))
  extraTimes.forEach((time) => addMinute(timeToMinutes(time, -1)))
  if (context) {
    const afterIncoming = context.events
      .filter((e) => e.delta > 0 && e.at.startsWith(`${date}T`))
      .map((e) => {
        const t = normalizePayoutTime(e.at.slice(11, 16))
        return t ? timeToMinutes(t, -1) + 1 : -1
      })
      .filter((minute) => minute >= start && minute <= end)
      .sort((a, b) => a - b)
    afterIncoming.forEach(addMinute)
  }
  addMinute(start)
  addMinute(end)
  return ordered.map(minutesToTime)
}

function findCoveringPotrdilo(employee: Employee | null, potrdila: Potrdilo[], date: string, time: string): Potrdilo | null {
  if (!employee || !date || !time) return null
  const at = `${date}T${time}:00`
  return potrdila.find((p) => p.employeeId === employee.id && at >= p.fromAt && at <= p.toAt) ?? null
}

function employeeEligibleBusinessDays(employee: Employee | null, potrdila: Potrdilo[], win: ReturnType<typeof payoutWindow>): string[] {
  const workdays = win.days.filter(isSlovenianWorkday)
  if (!employee) return workdays
  const certs = potrdila.filter((p) => p.employeeId === employee.id && p.toAt.slice(0, 10) >= win.start && p.fromAt.slice(0, 10) <= win.end)
  // For a matched employee, a payout may only be scheduled inside an overlapping certificate.
  // No overlapping certificate means no automatic BI for that employee.
  if (!certs.length) return []
  return workdays.filter((date) => certs.some((p) => date >= p.fromAt.slice(0, 10) && date <= p.toAt.slice(0, 10)))
}

function certificateTimesOnDate(employee: Employee | null, potrdila: Potrdilo[], date: string): string[] {
  if (!employee) return []
  const out: string[] = []
  for (const p of potrdila.filter((x) => x.employeeId === employee.id)) {
    if (p.fromAt.startsWith(`${date}T`)) out.push(p.fromAt.slice(11, 16))
    if (p.toAt.startsWith(`${date}T`)) out.push(p.toAt.slice(11, 16))
  }
  return out
}

export function validatePayoutSchedule(
  parts: PayoutPart[],
  win: ReturnType<typeof payoutWindow>,
  timeFrom = '08:00',
  timeTo = '17:59',
  context?: PayoutScheduleContext,
  potrdila: Potrdilo[] = [],
): Map<string, string[]> {
  const errors = new Map<string, string[]>()
  const add = (key: string, message: string) => errors.set(key, [...(errors.get(key) ?? []), message])
  const from = timeToMinutes(timeFrom, 8 * 60)
  const to = timeToMinutes(timeTo, 17 * 60 + 59)
  const minTime = Math.min(from, to), maxTime = Math.max(from, to)

  for (const p of parts) {
    // Yellow/skipped rows are informational only and are not imported.
    if (p.skipReason) continue
    if (p.scheduleError) add(p.partKey, p.scheduleError)
    // When the automatic scheduler intentionally leaves both fields empty because
    // there is no cash-feasible slot, the scheduleError above is the useful error.
    // Do not add misleading date/time-format errors on top of it.
    if (p.scheduleError && !p.date && !p.time) continue
    if (!isoDateToUtc(p.date)) add(p.partKey, 'Datum ni veljaven. Uporabite DD.MM.YYYY.')
    else {
      if (p.date < win.start || p.date > win.end) add(p.partKey, `Datum mora biti med ${formatSloDate(win.start)} in ${formatSloDate(win.end)}.`)
      if (!isSlovenianWorkday(p.date)) {
        const holiday = slovenianHolidayName(p.date)
        add(p.partKey, holiday ? `Datum je praznik (${holiday}).` : 'Datum je sobota ali nedelja.')
      }
    }
    const time = normalizePayoutTime(p.time)
    if (!time) add(p.partKey, 'Čas ni veljaven. Uporabite HH:MM.')
    else {
      const minutes = timeToMinutes(time, -1)
      if (minutes < minTime || minutes > maxTime) add(p.partKey, `Čas mora biti med ${minutesToTime(minTime)} in ${minutesToTime(maxTime)}.`)
      if (p.employee && isoDateToUtc(p.date) && potrdila.length > 0) {
        const at = `${p.date}T${time}:00`
        const employeeCerts = potrdila.filter((cert) => cert.employeeId === p.employee!.id)
        if (employeeCerts.length > 0 && !employeeCerts.some((cert) => at >= cert.fromAt && at <= cert.toAt)) {
          add(p.partKey, 'Datum/čas ni znotraj nobenega dopust lista zaposlenega.')
        }
      }
    }
  }

  const groups = new Map<number, PayoutPart[]>()
  for (const p of parts) {
    if (p.skipReason) continue
    const group = groups.get(p.sourceRow) ?? []
    group.push(p)
    groups.set(p.sourceRow, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ordered = group.filter((p) => isoDateToUtc(p.date)).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    for (let i = 1; i < ordered.length; i++) {
      if (daysBetween(ordered[i - 1].date, ordered[i].date) < 7) add(ordered[i].partKey, 'Med razdeljenima BI mora biti najmanj 7 dni.')
    }
  }

  if (context) {
    const valid = parts
      .filter((p) => !p.skipReason && isoDateToUtc(p.date) && normalizePayoutTime(p.time))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
    const scheduled: { at: string; amount: number }[] = []
    for (const p of valid) {
      scheduled.push({ at: `${p.date}T${p.time}:00`, amount: p.amount })
      if (!scheduleStaysSolvent(context, scheduled)) add(p.partKey, 'Na ta datum/čas v blagajni še ni dovolj denarja za ta BI.')
    }
  }
  return errors
}

export function buildPayoutParts(
  rows: PayoutSourceRow[],
  employees: Employee[],
  potrdila: Potrdilo[],
  monthKey: string,
  timeFrom = '08:00',
  timeTo = '17:59',
  context?: PayoutScheduleContext,
): PayoutPart[] {
  const win = payoutWindow(monthKey)
  const out: PayoutPart[] = []
  const scheduledCash: { at: string; amount: number }[] = []

  for (const row of rows) {
    const employee = matchEmployee(row, employees)
    const split = splitPayoutAmount(row.amount, row.rowNo)
    const bounds = employeeBounds(employee, potrdila, win)
    const overlappingCertificates = employee
      ? potrdila.filter((p) => p.employeeId === employee.id && p.toAt.slice(0, 10) >= win.start && p.fromAt.slice(0, 10) <= win.end)
      : []
    const eligibleDays = employeeEligibleBusinessDays(employee, potrdila, win)
    let previousDate: string | null = null

    split.parts.forEach((amount, i) => {
      const partKey = `${row.rowNo}-${i}`
      const earliest = previousDate ? addIsoDays(previousDate, 7) : win.start
      const remainingParts = split.parts.length - i - 1
      // Do not consume a late date too early: leave at least 7 calendar days
      // for every remaining BI from the same source row.
      const latest = addIsoDays(win.end, -7 * remainingParts)
      const preferredTime = payoutTime(row.rowNo, i, timeFrom, timeTo)
      const boundCandidates = bounds.filter((b) => b.date >= earliest && b.date <= latest)
      const boundaryByDate = new Map(boundCandidates.map((b) => [b.date, b]))
      // Walk forward chronologically. A certificate start/end wins when it falls on
      // that day, but we do not postpone a BI to a much later boundary if money is
      // already available on an earlier valid workday.
      const candidates = eligibleDays
        .filter((date) => date >= earliest && date <= latest)
        .map((date) => boundaryByDate.get(date) ?? { date, source: 'WINDOW' as const, potrdiloId: null })

      const certificateSlots: { date: string; time: string; source: 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW'; potrdiloId: string | null }[] = []
      for (const c of candidates) {
        const certificateTimes = certificateTimesOnDate(employee, potrdila, c.date)
        for (const time of candidateTimesForDate(c.date, preferredTime, timeFrom, timeTo, context, certificateTimes)) {
          const covering = findCoveringPotrdilo(employee, potrdila, c.date, time)
          // A matched employee must ALWAYS have an active certificate at the exact payout date/time.
          if (employee && !covering) continue
          certificateSlots.push({ ...c, time, potrdiloId: covering?.id ?? c.potrdiloId })
        }
      }

      const warnings: string[] = []
      if (!employee) warnings.push('Zaposleni ni enolično najden')
      if (split.split) warnings.push('Znesek nad 700 € je razdeljen na dele 300–500 €; med deli je najmanj 7 dni.')

      // If there is no valid date+time inside a dopust list, do not suggest a
      // date OR a time. Keep the row yellow so it is obvious that it will not be imported.
      if (employee && certificateSlots.length === 0) {
        const reason = overlappingCertificates.length === 0
          ? `V obdobju ${formatSloDate(win.start)}–${formatSloDate(win.end)} zaposleni nima dopust lista. Datum in čas nista predlagana; ta BI ne bo uvožen.`
          : 'Dopust list obstaja, vendar v njegovem prekrivanju z izbranim obdobjem ni veljavnega delovnega dne in časa. Datum in čas nista predlagana; ta BI ne bo uvožen.'
        out.push({
          partKey,
          sourceRow: row.rowNo,
          employee,
          employeeName: employee.displayName,
          originalAmount: row.amount,
          amount,
          date: '',
          time: '',
          dateSource: 'WINDOW',
          potrdiloId: null,
          warning: warnings.join(' · ') || undefined,
          skipReason: reason,
        })
        return
      }

      let chosen: { date: string; time: string; source: 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW'; potrdiloId: string | null } | null = null
      for (const slot of certificateSlots) {
        if (context && !scheduleStaysSolvent(context, [...scheduledCash, { at: `${slot.date}T${slot.time}:00`, amount }])) continue
        chosen = slot
        break
      }

      if (chosen?.source === 'WINDOW' && bounds.length) warnings.push('Datum je bil premaknjen z meje dopust lista zaradi 7-dnevnega razmika ali stanja blagajne.')

      if (!chosen) {
        let cashAvailable: number | undefined
        let cashAt: string | undefined
        if (context && certificateSlots.length) {
          for (const slot of certificateSlots) {
            const at = `${slot.date}T${slot.time}:00`
            const available = availableBeforeCandidate(context, scheduledCash, at)
            if (cashAvailable === undefined || available > cashAvailable) {
              cashAvailable = available
              cashAt = at
            }
          }
        }
        const shortfall = cashAvailable === undefined ? undefined : Math.max(0, Math.round((amount - cashAvailable) * 100) / 100)
        const cashDetail = context && cashAvailable !== undefined && cashAt
          ? ` Največ razpoložljivo v veljavnih terminih je ${cashAvailable.toFixed(2)} EUR (${formatSloDate(cashAt.slice(0, 10))} ${cashAt.slice(11, 16)}); BI potrebuje ${amount.toFixed(2)} EUR${shortfall && shortfall > 0 ? `, manjka ${shortfall.toFixed(2)} EUR` : ''}.`
          : ''
        out.push({
          partKey,
          sourceRow: row.rowNo,
          employee,
          employeeName: employee?.displayName ?? row.displayName,
          originalAmount: row.amount,
          amount,
          date: '',
          time: '',
          dateSource: 'WINDOW',
          potrdiloId: null,
          warning: warnings.join(' · ') || undefined,
          scheduleError: context
            ? `Znotraj dopust lista obstaja veljaven termin, vendar takrat v blagajni ni dovolj denarja za ta BI.${cashDetail}`
            : 'V dopust listu ni mogoče razporediti vseh delov z zahtevanim 7-dnevnim razmikom.',
          cashAvailable,
          cashAt,
        })
        return
      }

      const covering = findCoveringPotrdilo(employee, potrdila, chosen.date, chosen.time)
      const linkedPotrdiloId = covering?.id ?? chosen.potrdiloId
      out.push({
        partKey,
        sourceRow: row.rowNo,
        employee,
        employeeName: employee?.displayName ?? row.displayName,
        originalAmount: row.amount,
        amount,
        date: chosen.date,
        time: chosen.time,
        dateSource: chosen.source,
        potrdiloId: linkedPotrdiloId,
        warning: warnings.join(' · ') || undefined,
      })
      scheduledCash.push({ at: `${chosen.date}T${chosen.time}:00`, amount })
      previousDate = chosen.date
    })
  }
  return out
}

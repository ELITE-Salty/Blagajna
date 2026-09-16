

import type { Employee, Potrdilo } from '../types'

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * Minimum spacing between two BI documents that came from the SAME source row
 * (one amount that had to be split into several izdatki).
 *
 * Counted in WORKDAYS, not calendar days: weekends and Slovenian public
 * holidays do not count. `workdaysBetween(a, b)` counts workdays strictly
 * after `a` up to and including `b`, so a value of 5 means "Monday -> next
 * Monday" and never lets a holiday week silently shorten the real gap.
 */
export const MIN_GAP_WORKDAYS = 5

/** Only amounts strictly above this are split into several izdatki. */
export const SPLIT_THRESHOLD_EUR = 700

/** Legal size range of a single split part. */
export const SPLIT_MIN_EUR = 300
export const SPLIT_MAX_EUR = 500

/** Cash comparisons are done in EUR, so tolerate float noise below 1 cent. */
const EPS = 0.001

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface PayoutSourceRow {
  rowNo: number
  firstName: string
  lastName: string
  displayName: string
  amount: number
}

export type PayoutDateSource = 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW' | 'MANUAL'

/**
 * Why a part carries a note. Coded rather than matched on text, so a UI can drop
 * the ones it already shows another way — e.g. SPLIT is redundant next to a
 * "2/3" badge, and UNMATCHED_EMPLOYEE next to a red employee name.
 */
export type PayoutWarningCode = 'UNMATCHED_EMPLOYEE' | 'SPLIT' | 'DATE_MOVED'

export interface PayoutWarning {
  code: PayoutWarningCode
  message: string
}

export interface PayoutPart {
  partKey: string
  sourceRow: number
  employee: Employee | null
  employeeName: string
  originalAmount: number
  amount: number
  /** '' when the scheduler found no legal slot — the user must fill it in. */
  date: string
  /** '' when the scheduler found no legal slot — the user must fill it in. */
  time: string
  /** "Zadeva" / namen of the BI. '' means the user still has to write it. */
  subject: string
  dateSource: PayoutDateSource
  potrdiloId: string | null
  /** Informational notes, coded. Do not block the import. */
  warnings: PayoutWarning[]
  /** All `warnings` joined with " · ". Kept so existing callers keep working. */
  warning?: string
  /**
   * Set when this part cannot be imported as it stands: no legal date/time was
   * found, or the amount/period/cash simply do not allow one. Date, time and
   * subject are left empty for the user. Any part carrying this blocks the
   * whole import until the user resolves it.
   */
  blockReason?: string
  /** Best cash position across all otherwise-legal slots, for diagnostics. */
  cashAvailable?: number
  cashAt?: string
  /** @deprecated replaced by `blockReason`. Still honoured if a caller sets it. */
  scheduleError?: string
  /** @deprecated replaced by `blockReason`. Still honoured if a caller sets it. */
  skipReason?: string
}

export interface CashEvent {
  at: string
  delta: number
  source?: 'DOC' | 'TRANSFER'
  id?: string
  label?: string
}

export interface PayoutScheduleContext {
  /**
   * Balance of the blagajna AFTER every event in `events` has been applied.
   * The opening balance is derived from it, so `events` must be the complete
   * set of movements that `currentBalance` accounts for.
   */
  currentBalance: number
  events: CashEvent[]
  /** Optional explicit opening balance; overrides the derivation above. */
  openingBalance?: number
}

export interface PayoutScheduleOptions {
  /** Default "Zadeva" for parts the scheduler could place. */
  defaultSubject?: string
  /** Override the workday spacing rule (defaults to MIN_GAP_WORKDAYS). */
  minGapWorkdays?: number
}

export type PayoutWindow = { start: string; end: string; days: string[] }

/* ------------------------------------------------------------------ *
 * Source file parsing (unchanged behaviour)
 * ------------------------------------------------------------------ */

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
  let firstIdx = -1, lastIdx = -1, displayIdx = -1, amountIdx = -1
  for (let h = 0; h < Math.min(matrix.length, 20); h++) {
    const candidate = (matrix[h] ?? []).map((x) => norm(String(x ?? '')))
    const find = (names: string[]) => candidate.findIndex((v) => names.map(norm).includes(v))
    const fi = find(headerNames.first), li = find(headerNames.last), di = find(headerNames.display), ai = find(headerNames.amount)
    if (ai >= 0 && (di >= 0 || (fi >= 0 && li >= 0))) {
      headerRow = h; firstIdx = fi; lastIdx = li; displayIdx = di; amountIdx = ai
      break
    }
  }
  if (headerRow < 0) {
    throw new Error('Excel mora imeti stolpca Ime + Priimek (ali Ime in priimek) ter Znesek/Vrednost.')
  }
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

/* ------------------------------------------------------------------ *
 * Amount splitting
 * ------------------------------------------------------------------ */

export function splitPayoutAmount(amount: number, seed = 1): { parts: number[]; split: boolean } {
  const totalCents = Math.round(amount * 100)
  const minPart = SPLIT_MIN_EUR * 100
  const maxPart = SPLIT_MAX_EUR * 100

  // Accountant rule: only amounts ABOVE 700 EUR are split.
  if (totalCents <= SPLIT_THRESHOLD_EUR * 100) return { parts: [totalCents / 100], split: false }

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
    const low = Math.max(minPart, remaining - remainingParts * maxPart)
    const high = Math.min(maxPart, remaining - remainingParts * minPart)
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

/* ------------------------------------------------------------------ *
 * Dates, workdays, holidays
 * ------------------------------------------------------------------ */

export function payoutWindow(monthKey: string): PayoutWindow {
  const [y, m] = monthKey.split('-').map(Number)
  const start = new Date(y, m - 1, 20)
  const end = new Date(y, m, 16)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const days: string[] = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(iso(d))
  return { start: iso(start), end: iso(end), days }
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

/**
 * Number of workdays strictly after `a`, up to and including `b`.
 * Negative when `b` is before `a`, NaN when either date is invalid.
 *
 * Monday -> Friday  = 4
 * Monday -> next Monday = 5
 * Friday -> next Monday = 1
 */
export function workdaysBetween(a: string, b: string): number {
  const calendar = daysBetween(a, b)
  if (!Number.isFinite(calendar)) return Number.NaN
  if (calendar === 0) return 0
  // Dates that far apart trivially satisfy any spacing rule; skip the walk.
  if (Math.abs(calendar) > 800) return calendar
  const step = calendar > 0 ? 1 : -1
  let cur = a
  let n = 0
  while (cur !== b) {
    cur = addIsoDays(cur, step)
    if (isSlovenianWorkday(cur)) n += step
  }
  return n
}

/** The `count`-th workday strictly after (count > 0) or before (count < 0) `date`. */
export function addWorkdays(date: string, count: number): string | null {
  if (!isoDateToUtc(date)) return null
  if (count === 0) return date
  const step = count > 0 ? 1 : -1
  let left = Math.abs(count)
  let cur = date
  let guard = 0
  while (left > 0) {
    if (guard++ > 800) return null
    cur = addIsoDays(cur, step)
    if (isSlovenianWorkday(cur)) left--
  }
  return cur
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

const round2 = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ *
 * Slovenian wording helpers
 *
 * The messages below land in front of an accountant, so they have to read
 * correctly: 1 izdatek, 2 izdatka, 3 izdatke, 5 izdatkov — and amounts in
 * Slovenian format (1.234,50 EUR), never 1234.50.
 * ------------------------------------------------------------------ */

/** Slovenian count agreement: 1 / 2 / 3-4 / 5+ (by the last two digits). */
export function sloPlural(n: number, one: string, two: string, few: string, many: string): string {
  const mod100 = Math.abs(Math.trunc(n)) % 100
  if (mod100 === 1) return one
  if (mod100 === 2) return two
  if (mod100 === 3 || mod100 === 4) return few
  return many
}

/** "na 3 dele", "na 5 delov" — accusative, as used after "razdeljen na". */
const delAcc = (n: number) => `${n} ${sloPlural(n, 'del', 'dela', 'dele', 'delov')}`
/** "na 3 izdatke", "za 5 izdatkov" — accusative. */
const izdatekAcc = (n: number) => `${n} ${sloPlural(n, 'izdatek', 'izdatka', 'izdatke', 'izdatkov')}`
/** "5 delovnih dni", "1 delovni dan", "2 delovna dneva". */
const delovniDan = (n: number) => `${n} ${sloPlural(n, 'delovni dan', 'delovna dneva', 'delovne dni', 'delovnih dni')}`

export function formatEur(amount: number): string {
  return `${amount.toLocaleString('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

/* ------------------------------------------------------------------ *
 * Employee matching (unchanged behaviour)
 * ------------------------------------------------------------------ */

function personNameTokens(...values: unknown[]): string[] {
  let value = values
    .map((v) => String(v ?? ''))
    .join(' ')
    .toLowerCase()
    .replace(/[đð]/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  value = value
    .replace(/\bnima preb v slo\b/g, ' ')
    .replace(/\bml\b/g, ' ')
    .replace(/\bjr\b/g, ' ')
    .replace(/\bjunior\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return [...new Set(value.split(' ').filter(Boolean))].sort()
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
  const rowParts = personNameTokens(row.firstName, row.lastName)
  const rowDisplay = personNameTokens(row.displayName)
  const rowAll = personNameTokens(row.firstName, row.lastName, row.displayName)
  if (rowAll.length < 2) return null

  const exactParts = employees.filter((e) => sameTokens(personNameTokens(e.firstName, e.lastName), rowParts))
  const exactPartsMatch = uniqueEmployee(exactParts)
  if (exactPartsMatch) return exactPartsMatch

  const exactDisplay = employees.filter((e) => sameTokens(personNameTokens(e.displayName), rowDisplay))
  const exactDisplayMatch = uniqueEmployee(exactDisplay)
  if (exactDisplayMatch) return exactDisplayMatch

  const exactAll = employees.filter((e) => sameTokens(personNameTokens(e.firstName, e.lastName, e.displayName), rowAll))
  const exactAllMatch = uniqueEmployee(exactAll)
  if (exactAllMatch) return exactAllMatch

  const subsetMatches = employees.filter((e) => {
    const employeeTokens = personNameTokens(e.firstName, e.lastName, e.displayName)
    if (employeeTokens.length < 2) return false
    return isSubset(rowParts, employeeTokens) || isSubset(employeeTokens, rowAll)
  })

  return uniqueEmployee(subsetMatches)
}

/* ------------------------------------------------------------------ *
 * Rule 1 — cash ledger
 *
 * The balance of a blagajna is a step function over time. A BI at moment T
 * lowers the balance for EVERY moment from T onwards, so the BI is legal iff
 *
 *     min { balance(x) : x >= T }  >=  amount
 *
 * That single inequality covers both halves of the rule: "on that day" (the
 * dips right after T) and "in general" (the tail of the function, i.e. the
 * closing balance of the blagajna). The ledger keeps a suffix-minimum over the
 * checkpoints so each test is a binary search instead of a full replay.
 * ------------------------------------------------------------------ */

export class CashLedger {
  readonly enabled: boolean
  private readonly opening: number
  private readonly baseByAt = new Map<string, number>()
  private readonly placedByAt = new Map<string, number>()
  private times: string[] = []
  private balanceAfter: number[] = []
  private suffixMin: number[] = []
  private dirty = true

  /**
   * @param context  cash history; when omitted the ledger allows everything
   * @param pruneFrom  collapse every event before this moment into the opening
   *                   balance. Safe as long as nothing is ever scheduled before
   *                   it, and keeps the checkpoint list short.
   */
  constructor(context?: PayoutScheduleContext, pruneFrom?: string) {
    this.enabled = !!context
    if (!context) {
      this.opening = Number.POSITIVE_INFINITY
      return
    }
    const events = [...context.events].sort((a, b) => a.at.localeCompare(b.at))
    const totalDelta = events.reduce((sum, e) => sum + e.delta, 0)
    const fullOpening = context.openingBalance ?? round2(context.currentBalance - totalDelta)
    let opening = fullOpening
    for (const e of events) {
      if (pruneFrom && e.at < pruneFrom) {
        opening += e.delta
        continue
      }
      this.baseByAt.set(e.at, round2((this.baseByAt.get(e.at) ?? 0) + e.delta))
    }
    this.opening = round2(opening)
    this.rebuild()
  }

  private rebuild(): void {
    const at = [...new Set([...this.baseByAt.keys(), ...this.placedByAt.keys()])].sort()
    const balanceAfter: number[] = new Array(at.length)
    let balance = this.opening
    for (let i = 0; i < at.length; i++) {
      balance = round2(balance + (this.baseByAt.get(at[i]) ?? 0) - (this.placedByAt.get(at[i]) ?? 0))
      balanceAfter[i] = balance
    }
    const suffixMin: number[] = new Array(at.length)
    for (let i = at.length - 1; i >= 0; i--) {
      suffixMin[i] = i === at.length - 1 ? balanceAfter[i] : Math.min(balanceAfter[i], suffixMin[i + 1])
    }
    this.times = at
    this.balanceAfter = balanceAfter
    this.suffixMin = suffixMin
    this.dirty = false
  }

  /** First index whose checkpoint is >= at. */
  private lowerBound(at: string): number {
    let lo = 0, hi = this.times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.times[mid] < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Lowest balance the blagajna reaches at or after `at` — i.e. how much a BI at `at` may take. */
  availableFrom(at: string): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY
    if (this.dirty) this.rebuild()
    const n = this.times.length
    const j = this.lowerBound(at)
    if (j < n && this.times[j] === at) return this.suffixMin[j]
    const before = j > 0 ? this.balanceAfter[j - 1] : this.opening
    return j < n ? Math.min(before, this.suffixMin[j]) : before
  }

  /** Balance of the blagajna at `at`, ignoring anything later. */
  balanceAt(at: string): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY
    if (this.dirty) this.rebuild()
    const j = this.lowerBound(at)
    if (j < this.times.length && this.times[j] === at) return this.balanceAfter[j]
    return j > 0 ? this.balanceAfter[j - 1] : this.opening
  }

  canPlace(at: string, amount: number): boolean {
    if (!this.enabled) return true
    return this.availableFrom(at) >= amount - EPS
  }

  place(at: string, amount: number): void {
    if (!this.enabled) return
    this.placedByAt.set(at, round2((this.placedByAt.get(at) ?? 0) + amount))
    this.dirty = true
  }

  unplace(at: string, amount: number): void {
    if (!this.enabled) return
    const next = round2((this.placedByAt.get(at) ?? 0) - amount)
    if (Math.abs(next) < EPS) this.placedByAt.delete(at)
    else this.placedByAt.set(at, next)
    this.dirty = true
  }

  /** Closing balance of the blagajna once every placed BI is applied. */
  closingBalance(): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY
    if (this.dirty) this.rebuild()
    return this.times.length ? this.balanceAfter[this.times.length - 1] : this.opening
  }

  totalPlaced(): number {
    let sum = 0
    for (const v of this.placedByAt.values()) sum += v
    return round2(sum)
  }
}

/* ------------------------------------------------------------------ *
 * Certificates ("dopust list" / potrdila)
 * ------------------------------------------------------------------ */

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

function employeeBounds(employee: Employee | null, potrdila: Potrdilo[], win: PayoutWindow): Boundary[] {
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

function findCoveringPotrdilo(employee: Employee | null, potrdila: Potrdilo[], date: string, time: string): Potrdilo | null {
  if (!employee || !date || !time) return null
  const at = `${date}T${time}:00`
  return potrdila.find((p) => p.employeeId === employee.id && at >= p.fromAt && at <= p.toAt) ?? null
}

function employeeEligibleBusinessDays(employee: Employee | null, potrdila: Potrdilo[], win: PayoutWindow): string[] {
  const workdays = win.days.filter(isSlovenianWorkday)
  if (!employee) return workdays
  const certs = potrdila.filter((p) => p.employeeId === employee.id && p.toAt.slice(0, 10) >= win.start && p.fromAt.slice(0, 10) <= win.end)
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

function candidateTimesForDate(
  date: string,
  preferred: string,
  timeFrom: string,
  timeTo: string,
  events: CashEvent[],
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
  // A BI placed one minute after cash comes in can use that cash.
  const afterIncoming = events
    .filter((e) => e.delta > 0 && e.at.startsWith(`${date}T`))
    .map((e) => {
      const t = normalizePayoutTime(e.at.slice(11, 16))
      return t ? timeToMinutes(t, -1) + 1 : -1
    })
    .filter((minute) => minute >= start && minute <= end)
    .sort((a, b) => a - b)
  afterIncoming.forEach(addMinute)
  addMinute(start)
  addMinute(end)
  return ordered.map(minutesToTime)
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

interface SlotCandidate {
  date: string
  dayIndex: number
  time: string
  at: string
  source: 'POTRDILO_START' | 'POTRDILO_END' | 'WINDOW'
  potrdiloId: string | null
}

interface ItemPlan {
  partKey: string
  partIndex: number
  amount: number
  slots: SlotCandidate[]
}

interface RowPlan {
  row: PayoutSourceRow
  employee: Employee | null
  employeeName: string
  amounts: number[]
  isSplit: boolean
  warnings: PayoutWarning[]
  items: ItemPlan[]
  /** Structural problem (no certificate, period too short, ...) — nothing to schedule. */
  blockReason: string | null
  earliestSlotAt: string
  totalAmount: number
}

interface Placement {
  partKey: string
  slot: SlotCandidate
  amount: number
}

const NODE_BUDGET_PER_ROW = 600
const NODE_BUDGET_TOTAL = 120_000

function planRows(
  rows: PayoutSourceRow[],
  employees: Employee[],
  potrdila: Potrdilo[],
  win: PayoutWindow,
  timeFrom: string,
  timeTo: string,
  events: CashEvent[],
  minGap: number,
): RowPlan[] {
  const windowWorkdays = win.days.filter(isSlovenianWorkday)
  const dayIndex = new Map(windowWorkdays.map((d, i) => [d, i]))
  const maxPartsInWindow = windowWorkdays.length ? Math.floor((windowWorkdays.length - 1) / minGap) + 1 : 0

  return rows.map((row) => {
    const employee = matchEmployee(row, employees)
    const split = splitPayoutAmount(row.amount, row.rowNo)
    const bounds = employeeBounds(employee, potrdila, win)
    const boundaryByDate = new Map(bounds.map((b) => [b.date, b]))
    const eligibleDays = employeeEligibleBusinessDays(employee, potrdila, win)
    const overlappingCertificates = employee
      ? potrdila.filter((p) => p.employeeId === employee.id && p.toAt.slice(0, 10) >= win.start && p.fromAt.slice(0, 10) <= win.end)
      : []

    const warnings: PayoutWarning[] = []
    if (!employee) warnings.push({ code: 'UNMATCHED_EMPLOYEE', message: 'Zaposleni ni enolično najden' })
    if (split.split) {
      warnings.push({
        code: 'SPLIT',
        message: `Znesek nad ${SPLIT_THRESHOLD_EUR} € je razdeljen na ${delAcc(split.parts.length)} po ${SPLIT_MIN_EUR}–${SPLIT_MAX_EUR} €; med njimi je najmanj ${delovniDan(minGap)}.`,
      })
    }

    const base: Omit<RowPlan, 'items' | 'blockReason' | 'earliestSlotAt'> = {
      row,
      employee,
      employeeName: employee?.displayName ?? row.displayName,
      amounts: split.parts,
      isSplit: split.split,
      warnings,
      totalAmount: round2(split.parts.reduce((s, x) => s + x, 0)),
    }

    // Structural blocker: the period simply cannot hold this many izdatki.
    if (split.parts.length > maxPartsInWindow) {
      return {
        ...base,
        items: [],
        earliestSlotAt: '',
        blockReason: `Znesek ${formatEur(row.amount)} se razdeli na ${izdatekAcc(split.parts.length)} po ${SPLIT_MIN_EUR}–${SPLIT_MAX_EUR} €, v obdobju ${formatSloDate(win.start)}–${formatSloDate(win.end)} pa je ob razmiku ${delovniDan(minGap)} prostora le za ${izdatekAcc(maxPartsInWindow)}. Vnesite datum, uro in Zadevo ročno ali razdelite znesek na več obdobij.`,
      }
    }

    // Structural blocker: matched employee with no usable certificate day.
    if (employee && !eligibleDays.length) {
      return {
        ...base,
        items: [],
        earliestSlotAt: '',
        blockReason: overlappingCertificates.length === 0
          ? `V obdobju ${formatSloDate(win.start)}–${formatSloDate(win.end)} zaposleni nima dopust lista. Datum, ura in Zadeva so prazni — izpolnite jih ročno.`
          : `Dopust list obstaja, vendar v prekrivanju z obdobjem ${formatSloDate(win.start)}–${formatSloDate(win.end)} ni nobenega delovnega dne. Datum, ura in Zadeva so prazni — izpolnite jih ročno.`,
      }
    }

    const items: ItemPlan[] = split.parts.map((amount, i) => {
      const remaining = split.parts.length - i - 1
      const latestIndex = windowWorkdays.length - 1 - minGap * remaining
      const preferredTime = payoutTime(row.rowNo, i, timeFrom, timeTo)
      const slots: SlotCandidate[] = []
      for (const date of eligibleDays) {
        const idx = dayIndex.get(date)
        if (idx === undefined || idx > latestIndex) continue
        const boundary = boundaryByDate.get(date)
        const certTimes = certificateTimesOnDate(employee, potrdila, date)
        for (const time of candidateTimesForDate(date, preferredTime, timeFrom, timeTo, events, certTimes)) {
          const covering = findCoveringPotrdilo(employee, potrdila, date, time)
          // A matched employee must ALWAYS have an active certificate at the exact payout moment.
          if (employee && !covering) continue
          slots.push({
            date,
            dayIndex: idx,
            time,
            at: `${date}T${time}:00`,
            source: boundary?.source ?? 'WINDOW',
            potrdiloId: covering?.id ?? boundary?.potrdiloId ?? null,
          })
        }
      }
      return { partKey: `${row.rowNo}-${i}`, partIndex: i, amount, slots }
    })

    const missingSlots = items.find((it) => !it.slots.length)
    if (missingSlots) {
      return {
        ...base,
        items,
        earliestSlotAt: '',
        blockReason: `Za ${missingSlots.partIndex + 1}. izdatek ni nobenega delovnega dne in ure znotraj dopust lista, ki bi ohranil razmik ${delovniDan(minGap)} do ostalih izdatkov. Datum, ura in Zadeva so prazni — izpolnite jih ročno.`,
      }
    }

    const earliest = items[0]?.slots[0]
    return {
      ...base,
      items,
      blockReason: null,
      earliestSlotAt: earliest ? earliest.at : '',
    }
  })
}

interface AttemptResult {
  placements: Map<string, Placement>
  failedRows: Set<number>
  failedAmount: number
}

function attemptSchedule(order: RowPlan[], context: PayoutScheduleContext | undefined, win: PayoutWindow, minGap: number): AttemptResult {
  const ledger = new CashLedger(context, `${win.start}T00:00:00`)
  const placements = new Map<string, Placement>()
  const failedRows = new Set<number>()
  let failedAmount = 0
  let totalNodes = 0

  for (const plan of order) {
    if (plan.blockReason) continue
    const rowPlacements: Placement[] = []
    let nodes = 0

    const step = (i: number, minDayIndex: number): boolean => {
      if (i >= plan.items.length) return true
      const item = plan.items[i]
      for (const slot of item.slots) {
        if (slot.dayIndex < minDayIndex) continue
        if (nodes++ > NODE_BUDGET_PER_ROW || totalNodes++ > NODE_BUDGET_TOTAL) return false
        if (!ledger.canPlace(slot.at, item.amount)) continue
        ledger.place(slot.at, item.amount)
        rowPlacements.push({ partKey: item.partKey, slot, amount: item.amount })
        if (step(i + 1, slot.dayIndex + minGap)) return true
        rowPlacements.pop()
        ledger.unplace(slot.at, item.amount)
      }
      return false
    }

    if (step(0, 0)) {
      for (const p of rowPlacements) placements.set(p.partKey, p)
    } else {
      // Leave the whole row unscheduled: half a split akontacija is worse than none.
      for (const p of rowPlacements) ledger.unplace(p.slot.at, p.amount)
      failedRows.add(plan.row.rowNo)
      failedAmount = round2(failedAmount + plan.totalAmount)
    }
  }

  return { placements, failedRows, failedAmount }
}

function orderings(plans: RowPlan[]): RowPlan[][] {
  const schedulable = plans.filter((p) => !p.blockReason)
  const byFile = [...schedulable]
  const byEarliest = [...schedulable].sort((a, b) =>
    a.earliestSlotAt.localeCompare(b.earliestSlotAt) || b.totalAmount - a.totalAmount || a.row.rowNo - b.row.rowNo)
  const byAmountDesc = [...schedulable].sort((a, b) => b.totalAmount - a.totalAmount || a.row.rowNo - b.row.rowNo)
  const byAmountAsc = [...schedulable].sort((a, b) => a.totalAmount - b.totalAmount || a.row.rowNo - b.row.rowNo)
  const byTightest = [...schedulable].sort((a, b) => {
    const sa = a.items.reduce((s, it) => s + it.slots.length, 0)
    const sb = b.items.reduce((s, it) => s + it.slots.length, 0)
    return sa - sb || b.totalAmount - a.totalAmount || a.row.rowNo - b.row.rowNo
  })
  return [byFile, byEarliest, byTightest, byAmountDesc, byAmountAsc]
}

/**
 * Build the BI parts for an import.
 *
 * Every returned part either has a legal date + time + Zadeva, or has `date`,
 * `time` and `subject` empty together with a `blockReason` explaining what the
 * user has to fix. Nothing in between.
 */
export function buildPayoutParts(
  rows: PayoutSourceRow[],
  employees: Employee[],
  potrdila: Potrdilo[],
  monthKey: string,
  timeFrom = '08:00',
  timeTo = '17:59',
  context?: PayoutScheduleContext,
  options: PayoutScheduleOptions = {},
): PayoutPart[] {
  const win = payoutWindow(monthKey)
  const minGap = options.minGapWorkdays ?? MIN_GAP_WORKDAYS
  const defaultSubject = (options.defaultSubject ?? 'Akontacija').trim() || 'Akontacija'
  const events = context?.events ?? []
  const plans = planRows(rows, employees, potrdila, win, timeFrom, timeTo, events, minGap)

  // Try a few row orderings and keep the one that leaves the least money
  // unscheduled. A single greedy pass in file order can starve later rows of
  // cash even when a perfectly legal schedule exists.
  let best: AttemptResult | null = null
  for (const order of orderings(plans)) {
    const result = attemptSchedule(order, context, win, minGap)
    if (!best || result.failedRows.size < best.failedRows.size || (result.failedRows.size === best.failedRows.size && result.failedAmount < best.failedAmount)) {
      best = result
    }
    if (best.failedRows.size === 0) break
  }
  const chosen: AttemptResult = best ?? { placements: new Map(), failedRows: new Set(), failedAmount: 0 }

  // Diagnostics for rows that failed on cash: report the best cash position
  // across their legal slots, measured against the schedule we actually kept.
  const diagnosticLedger = new CashLedger(context, `${win.start}T00:00:00`)
  for (const p of chosen.placements.values()) diagnosticLedger.place(p.slot.at, p.amount)

  const out: PayoutPart[] = []
  for (const plan of plans) {
    const rowFailed = chosen.failedRows.has(plan.row.rowNo)

    plan.amounts.forEach((amount, i) => {
      const partKey = `${plan.row.rowNo}-${i}`
      const base = {
        partKey,
        sourceRow: plan.row.rowNo,
        employee: plan.employee,
        employeeName: plan.employeeName,
        originalAmount: plan.row.amount,
        amount,
        warnings: plan.warnings,
        warning: plan.warnings.map((w) => w.message).join(' · ') || undefined,
      }

      if (plan.blockReason) {
        out.push({ ...base, date: '', time: '', subject: '', dateSource: 'WINDOW', potrdiloId: null, blockReason: plan.blockReason })
        return
      }

      if (rowFailed) {
        const item = plan.items[i]
        let cashAvailable: number | undefined
        let cashAt: string | undefined
        if (context) {
          for (const slot of item.slots) {
            const available = diagnosticLedger.availableFrom(slot.at)
            if (cashAvailable === undefined || available > cashAvailable) {
              cashAvailable = round2(available)
              cashAt = slot.at
            }
          }
        }
        const shortfall = cashAvailable === undefined ? undefined : Math.max(0, round2(amount - cashAvailable))
        const detail = cashAvailable !== undefined && cashAt
          ? ` Najboljši veljavni termin je ${formatSloDate(cashAt.slice(0, 10))} ${cashAt.slice(11, 16)}, kjer je na voljo ${formatEur(cashAvailable)} — izdatek potrebuje ${formatEur(amount)}${shortfall && shortfall > 0 ? `, manjka ${formatEur(shortfall)}` : ''}.`
          : ''
        out.push({
          ...base,
          date: '',
          time: '',
          subject: '',
          dateSource: 'WINDOW',
          potrdiloId: null,
          blockReason: `V blagajni ni dovolj denarja za vse izdatke te vrstice, ne da bi stanje kdaj padlo pod 0 €.${detail} Datum, ura in Zadeva so prazni — izpolnite jih ročno ali dodajte prejemek v blagajno.`,
          cashAvailable,
          cashAt,
        })
        return
      }

      const placement = chosen.placements.get(partKey)!
      const warnings = [...plan.warnings]
      if (placement.slot.source === 'WINDOW' && plan.items[i].slots.some((s) => s.source !== 'WINDOW')) {
        warnings.push({
          code: 'DATE_MOVED',
          message: `Datum je premaknjen z meje dopust lista zaradi razmika ${delovniDan(minGap)} ali stanja blagajne.`,
        })
      }
      out.push({
        ...base,
        warnings,
        warning: warnings.map((w) => w.message).join(' · ') || undefined,
        date: placement.slot.date,
        time: placement.slot.time,
        subject: defaultSubject,
        dateSource: placement.slot.source,
        potrdiloId: placement.slot.potrdiloId,
      })
    })
  }

  return out.sort((a, b) => a.sourceRow - b.sourceRow || a.partKey.localeCompare(b.partKey))
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Re-check every part, including the ones the user typed by hand.
 * Any part that appears in the returned map blocks the import (rule 3).
 */
export function validatePayoutSchedule(
  parts: PayoutPart[],
  win: PayoutWindow,
  timeFrom = '08:00',
  timeTo = '17:59',
  context?: PayoutScheduleContext,
  potrdila: Potrdilo[] = [],
  options: PayoutScheduleOptions = {},
): Map<string, string[]> {
  const minGap = options.minGapWorkdays ?? MIN_GAP_WORKDAYS
  const errors = new Map<string, string[]>()
  const add = (key: string, message: string) => errors.set(key, [...(errors.get(key) ?? []), message])
  const from = timeToMinutes(timeFrom, 8 * 60)
  const to = timeToMinutes(timeTo, 17 * 60 + 59)
  const minTime = Math.min(from, to), maxTime = Math.max(from, to)

  for (const p of parts) {
    // Rule 3: an unresolved part is an error, never a silently skipped row.
    const blocker = p.blockReason ?? p.scheduleError ?? p.skipReason
    if (blocker) {
      add(p.partKey, blocker)
      if (!p.date && !p.time) continue
    }
    if (!isoDateToUtc(p.date)) add(p.partKey, 'Datum manjka ali ni veljaven. Uporabite DD.MM.YYYY.')
    else {
      if (p.date < win.start || p.date > win.end) add(p.partKey, `Datum mora biti med ${formatSloDate(win.start)} in ${formatSloDate(win.end)}.`)
      if (!isSlovenianWorkday(p.date)) {
        const holiday = slovenianHolidayName(p.date)
        add(p.partKey, holiday ? `Datum je praznik (${holiday}).` : 'Datum je sobota ali nedelja.')
      }
    }
    const time = normalizePayoutTime(p.time)
    if (!time) add(p.partKey, 'Ura manjka ali ni veljavna. Uporabite HH:MM.')
    else {
      const minutes = timeToMinutes(time, -1)
      if (minutes < minTime || minutes > maxTime) add(p.partKey, `Ura mora biti med ${minutesToTime(minTime)} in ${minutesToTime(maxTime)}.`)
      if (p.employee && isoDateToUtc(p.date) && potrdila.length > 0) {
        const at = `${p.date}T${time}:00`
        const employeeCerts = potrdila.filter((cert) => cert.employeeId === p.employee!.id)
        if (employeeCerts.length > 0 && !employeeCerts.some((cert) => at >= cert.fromAt && at <= cert.toAt)) {
          add(p.partKey, 'Datum in ura nista znotraj nobenega dopust lista zaposlenega.')
        }
      }
    }
    if (!p.subject || !p.subject.trim()) add(p.partKey, 'Zadeva je prazna — vpišite jo pred uvozom.')
    if (!p.employee) add(p.partKey, 'Zaposleni ni enolično najden v seznamu zaposlenih.')
  }

  // Rule 2: parts of the same source row must be at least `minGap` WORKDAYS apart.
  const groups = new Map<number, PayoutPart[]>()
  for (const p of parts) {
    const group = groups.get(p.sourceRow) ?? []
    group.push(p)
    groups.set(p.sourceRow, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ordered = group
      .filter((p) => isoDateToUtc(p.date))
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    for (let i = 1; i < ordered.length; i++) {
      const gap = workdaysBetween(ordered[i - 1].date, ordered[i].date)
      if (!Number.isFinite(gap) || gap < minGap) {
        add(ordered[i].partKey, `Med razdeljenima izdatkoma mora biti najmanj ${delovniDan(minGap)} (trenutno ${Number.isFinite(gap) ? delovniDan(gap) : '?'}).`)
      }
    }
  }

  // Rule 1: the blagajna may never go below zero, at any moment or in total.
  if (context) {
    const valid = parts
      .filter((p) => isoDateToUtc(p.date) && normalizePayoutTime(p.time))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
    const earliest = valid[0]
    const pruneFrom = earliest ? `${[earliest.date, win.start].sort()[0]}T00:00:00` : `${win.start}T00:00:00`
    const ledger = new CashLedger(context, pruneFrom)
    for (const p of valid) {
      const at = `${p.date}T${normalizePayoutTime(p.time)}:00`
      if (!ledger.canPlace(at, p.amount)) {
        const available = ledger.availableFrom(at)
        add(p.partKey, `Na ta datum in uro v blagajni ni dovolj denarja: na voljo ${formatEur(available)}, izdatek je ${formatEur(p.amount)}. Stanje blagajne ne sme nikoli pasti pod 0 €.`)
      }
      ledger.place(at, p.amount)
    }
  }

  return errors
}

/* ------------------------------------------------------------------ *
 * Import gate (rule 3)
 * ------------------------------------------------------------------ */

export interface PayoutReadiness {
  total: number
  ready: number
  blocked: number
  blockedRows: number[]
  reasons: { partKey: string; sourceRow: number; employeeName: string; messages: string[] }[]
  /** Rule 3: akontacije may only be sent when every single part is ready. */
  canImport: boolean
}

export function payoutImportReadiness(parts: PayoutPart[], errors: Map<string, string[]>): PayoutReadiness {
  const reasons: PayoutReadiness['reasons'] = []
  for (const p of parts) {
    const messages = errors.get(p.partKey) ?? []
    if (messages.length) reasons.push({ partKey: p.partKey, sourceRow: p.sourceRow, employeeName: p.employeeName, messages })
  }
  const blockedRows = [...new Set(reasons.map((r) => r.sourceRow))].sort((a, b) => a - b)
  return {
    total: parts.length,
    ready: parts.length - reasons.length,
    blocked: reasons.length,
    blockedRows,
    reasons,
    canImport: parts.length > 0 && reasons.length === 0,
  }
}


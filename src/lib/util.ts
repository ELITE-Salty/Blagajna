import type { CashDocument, DocType, NumberFormat } from '../types'

export function uuid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

export const nowIso = () => new Date().toISOString()

const SLO_TIME_ZONE = 'Europe/Ljubljana'

function zonedParts(d: Date) {
  const parts = new Intl.DateTimeFormat('sl-SI', {
    timeZone: SLO_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') }
}

export const todayIso = () => {
  const p = zonedParts(new Date())
  return `${p.y}-${p.m}-${p.d}`
}
export const nowTime = () => {
  const p = zonedParts(new Date())
  return `${p.hh}:${p.mm}`
}
export const currentMonthKey = () => todayIso().slice(0, 7)
export const monthKeyOf = (dateStr: string) => (dateStr || '').slice(0, 7)

export const MESECI = [
  'januar', 'februar', 'marec', 'april', 'maj', 'junij',
  'julij', 'avgust', 'september', 'oktober', 'november', 'december',
]

export function monthLabel(monthKey: string): string {
  if (!monthKey || monthKey.length < 7) return monthKey
  const [y, m] = monthKey.split('-')
  return `${MESECI[parseInt(m, 10) - 1]} ${y}`
}

export function fmtDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/**
 * Prikaz datuma/časa po slovensko. Lokalni poslovni časi (brez Z/offseta)
 * se ne pretvarjajo; pravi ISO timestampi se pretvorijo v Europe/Ljubljana.
 */
export function fmtDateTime(value: string): string {
  if (!value) return ''
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  if (hasZone) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      const p = zonedParts(date)
      return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`
    }
  }
  const [d, t] = value.split('T')
  return `${fmtDate(d)} ${t ? t.slice(0, 5) : ''}`.trim()
}

export function parseSlDate(value: string): string | null {
  const raw = (value || '').trim()
  if (!raw) return ''
  let y = 0; let m = 0; let d = 0
  let hit = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (hit) {
    y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3])
  } else {
    hit = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\.?$/)
    if (hit) {
      d = Number(hit[1]); m = Number(hit[2]); y = Number(hit[3])
    } else {
      // Omogoči tudi hiter vnos 01082026 -> 01.08.2026 (koristno na numerični tipkovnici telefona).
      const compact = raw.match(/^(\d{2})(\d{2})(\d{4})$/)
      if (!compact) return null
      d = Number(compact[1]); m = Number(compact[2]); y = Number(compact[3])
    }
  }
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parse24hTime(value: string): string | null {
  const raw = (value || '').trim()
  if (!raw) return ''
  let hit = raw.match(/^(\d{1,2})[:.](\d{1,2})$/)
  if (!hit) hit = raw.match(/^(\d{2})(\d{2})$/)
  if (!hit) return null
  const hh = Number(hit[1]); const mm = Number(hit[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function parseSlDateTime(value: string): string | null {
  const raw = (value || '').trim()
  if (!raw) return ''
  const iso = raw.match(/^(\d{4}-\d{1,2}-\d{1,2})T(\d{1,2}:\d{1,2})$/)
  if (iso) {
    const date = parseSlDate(iso[1])
    const time = parse24hTime(iso[2])
    return date != null && time != null ? `${date}T${time}` : null
  }
  const hit = raw.match(/^(.+?)\s+(\d{1,2}[:.]\d{1,2}|\d{4})$/)
  if (!hit) return null
  const date = parseSlDate(hit[1])
  const time = parse24hTime(hit[2])
  return date != null && time != null ? `${date}T${time}` : null
}

const eurFmt = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export function fmtEur(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return ''
  return eurFmt.format(n) + ' €'
}
export function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return ''
  return eurFmt.format(n)
}

export function parseAmount(s: string): number | null {
  const t = (s || '').trim().replace(/\s|€/g, '').replace(/\./g, (m, i, str) =>
    // pika je lahko tisočica (1.234,56) ali decimalka (12.5) — če obstaja vejica, so pike tisočice
    str.includes(',') ? '' : m,
  ).replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return isNaN(n) ? null : Math.round(n * 100) / 100
}

export const txAt = (d: Pick<CashDocument, 'transactionDate' | 'transactionTime'>) =>
  `${d.transactionDate || '0000-00-00'}T${d.transactionTime || '00:00'}`

export function docNo(type: DocType, num: number | null, year: number | null, format: NumberFormat): string {
  if (num == null || year == null) return ''
  if (format === 'DASH') return `${type}-${year}-${String(num).padStart(4, '0')}`
  return `${type} ${num}/${year}`
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Slovenska sklanjatev: "1 dokument ima", "2 dokumenta imata", "3 dokumenti imajo", "5 dokumentov ima" */
export function nDokumentovIma(n: number): string {
  const m = n % 100
  if (m === 1) return `${n} dokument ima`
  if (m === 2) return `${n} dokumenta imata`
  if (m === 3 || m === 4) return `${n} dokumenti imajo`
  return `${n} dokumentov ima`
}

/** Pomanjša sliko na max 1400 px in vrne dataURL (JPEG). Ne-slike vrne nespremenjene. */
export async function fileToDataUrl(file: File): Promise<string> {
  const raw: string = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = rej
    r.readAsDataURL(file)
  })
  if (!file.type.startsWith('image/')) return raw
  try {
    const img = document.createElement('img')
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = rej
      img.src = raw
    })
    const max = 1400
    if (img.width <= max && img.height <= max && raw.length < 900_000) return raw
    const scale = Math.min(max / img.width, max / img.height, 1)
    const c = document.createElement('canvas')
    c.width = Math.round(img.width * scale)
    c.height = Math.round(img.height * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.82)
  } catch {
    return raw
  }
}

import type { BlagajnaDB } from '../db'
import type { CashDocument, CashTransfer, ManifestRow, MonthClose, Settings } from '../types'
import { nowIso, txAt, uuid } from './util'

// ---------- Validacija dokumenta ----------
export function docProblems(d: CashDocument, requirePurpose: boolean): string[] {
  const p: string[] = []
  if (!d.transactionDate) p.push('manjka datum transakcije')
  if (!d.transactionTime) p.push('manjka čas transakcije')
  if (!d.employeeId) p.push('manjka zaposleni')
  if (d.amount == null || isNaN(d.amount) || d.amount <= 0) p.push('neveljaven znesek')
  if (!d.deskId) p.push('manjka blagajna')
  if (requirePurpose && !(d.purpose || '').trim()) p.push('manjka namen (Za)')
  return p
}

export const isComplete = (d: CashDocument, requirePurpose: boolean) =>
  docProblems(d, requirePurpose).length === 0

// Determinističen vrstni red: transaction_at ASC, created_at ASC, id ASC
export function sortChrono(a: CashDocument, b: CashDocument): number {
  return (
    txAt(a).localeCompare(txAt(b)) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  )
}

// ---------- Obseg številčenja ----------
export const scopeKeyFor = (s: Settings, deskId: string) =>
  s.numberingScope === 'COMPANY' ? 'COMPANY' : deskId
export const closeIdFor = (s: Settings, deskId: string, monthKey: string) =>
  `${scopeKeyFor(s, deskId)}|${monthKey}`

export async function getClose(db: BlagajnaDB, s: Settings, deskId: string, monthKey: string) {
  return db.closes.get(closeIdFor(s, deskId, monthKey))
}

/** Dokumenti, ki jih zajame zaključek (glede na obseg številčenja). */
export async function docsInScope(db: BlagajnaDB, s: Settings, deskId: string, monthKey: string) {
  const all = await db.docs.where('monthKey').equals(monthKey).toArray()
  return all.filter(
    (d) => d.status !== 'STORNIRAN' && (s.numberingScope === 'COMPANY' || d.deskId === deskId),
  )
}

/** Zadnje dodeljene številke v letu za dani obseg (iz že zaključenih mesecev). */
export async function lastNumbers(db: BlagajnaDB, s: Settings, deskId: string, year: number) {
  const scope = scopeKeyFor(s, deskId)
  const closes = (await db.closes.toArray()).filter((c) => c.scopeKey === scope && c.year === year)
  return {
    bp: closes.reduce((m, c) => Math.max(m, c.bpEnd), 0),
    bi: closes.reduce((m, c) => Math.max(m, c.biEnd), 0),
  }
}

export interface PreviewRow {
  doc: CashDocument
  number: number
}
export interface ClosePreview {
  bp: PreviewRow[]
  bi: PreviewRow[]
  issues: { doc: CashDocument; problems: string[] }[]
  unsynced: (CashDocument | CashTransfer)[]
  alreadyClosed: MonthClose | null
  lastBp: number
  lastBi: number
}

/** Izračun predogleda številčenja — nič se ne shrani. */
export async function computePreview(
  db: BlagajnaDB, s: Settings, deskId: string, monthKey: string,
): Promise<ClosePreview> {
  const year = parseInt(monthKey.slice(0, 4), 10)
  const alreadyClosed = (await getClose(db, s, deskId, monthKey)) ?? null
  const docs = (await docsInScope(db, s, deskId, monthKey)).filter((d) => d.status === 'ODPRT')
  const issues = docs
    .map((doc) => ({ doc, problems: docProblems(doc, s.requirePurpose) }))
    .filter((x) => x.problems.length > 0)
  const transferScope = (await db.transfers.where('monthKey').equals(monthKey).toArray()).filter((t) =>
    s.numberingScope === 'COMPANY' || t.fromDeskId === deskId || t.toDeskId === deskId,
  )
  const unsynced = [
    ...docs.filter((d) => d.syncStatus === 'LOKALNO'),
    ...transferScope.filter((t) => t.syncStatus === 'LOKALNO'),
  ]
  const valid = docs.filter((d) => docProblems(d, s.requirePurpose).length === 0)
  const { bp: lastBp, bi: lastBi } = await lastNumbers(db, s, deskId, year)
  const bpDocs = valid.filter((d) => d.type === 'BP').sort(sortChrono)
  const biDocs = valid.filter((d) => d.type === 'BI').sort(sortChrono)
  return {
    bp: bpDocs.map((doc, i) => ({ doc, number: lastBp + i + 1 })),
    bi: biDocs.map((doc, i) => ({ doc, number: lastBi + i + 1 })),
    issues,
    unsynced,
    alreadyClosed,
    lastBp,
    lastBi,
  }
}

/**
 * Zaključi mesec — atomarno in idempotentno.
 * Vrne obstoječi zaključek, če je mesec že zaključen (brez novih številk).
 */
export async function closeMonth(
  db: BlagajnaDB, s: Settings, deskId: string, monthKey: string, closedBy: string,
): Promise<MonthClose> {
  const year = parseInt(monthKey.slice(0, 4), 10)
  const month = parseInt(monthKey.slice(5, 7), 10)
  const closeId = closeIdFor(s, deskId, monthKey)

  return db.transaction('rw', [db.docs, db.transfers, db.closes, db.audit], async () => {
    const existing = await db.closes.get(closeId)
    if (existing) return existing // idempotentno — druga zahteva vrne isti rezultat

    const docs = (await docsInScope(db, s, deskId, monthKey)).filter((d) => d.status === 'ODPRT')
    const withProblems = docs.filter((d) => docProblems(d, s.requirePurpose).length > 0)
    if (withProblems.length > 0) {
      throw new Error(`Meseca ni mogoče zaključiti: ${withProblems.length} dokumentov ima napake.`)
    }
    const transferScope = (await db.transfers.where('monthKey').equals(monthKey).toArray()).filter((t) =>
      s.numberingScope === 'COMPANY' || t.fromDeskId === deskId || t.toDeskId === deskId,
    )
    const unsynced = [
      ...docs.filter((d) => d.syncStatus === 'LOKALNO'),
      ...transferScope.filter((t) => t.syncStatus === 'LOKALNO'),
    ]
    if (unsynced.length > 0) {
      throw new Error('Meseca ni mogoče varno zaključiti, ker obstajajo nesinhronizirani zapisi.')
    }

    const scope = scopeKeyFor(s, deskId)
    const closes = (await db.closes.toArray()).filter((c) => c.scopeKey === scope && c.year === year)
    const lastBp = closes.reduce((m, c) => Math.max(m, c.bpEnd), 0)
    const lastBi = closes.reduce((m, c) => Math.max(m, c.biEnd), 0)

    const bpDocs = docs.filter((d) => d.type === 'BP').sort(sortChrono)
    const biDocs = docs.filter((d) => d.type === 'BI').sort(sortChrono)

    const at = nowIso()
    const manifest: ManifestRow[] = []
    const assign = async (list: CashDocument[], start: number) => {
      for (let i = 0; i < list.length; i++) {
        const d = list[i]
        const number = start + i + 1
        await db.docs.update(d.id, {
          officialNumber: number,
          seqYear: year,
          status: 'ZAKLJUCEN',
          finalizedAt: at,
          finalizedBy: closedBy,
          updatedAt: at,
          updatedBy: closedBy,
        })
        manifest.push({
          docId: d.id, type: d.type, number,
          transactionAt: txAt(d), employeeName: d.employeeName, amount: d.amount ?? 0,
        })
      }
    }
    await assign(bpDocs, lastBp)
    await assign(biDocs, lastBi)

    const close: MonthClose = {
      id: closeId, scopeKey: scope,
      deskId: s.numberingScope === 'COMPANY' ? null : deskId,
      year, month, monthKey,
      bpStart: bpDocs.length ? lastBp + 1 : lastBp,
      bpEnd: lastBp + bpDocs.length,
      biStart: biDocs.length ? lastBi + 1 : lastBi,
      biEnd: lastBi + biDocs.length,
      docCount: docs.length,
      closedBy, closedAt: at,
      idempotencyKey: uuid(),
      manifest,
    }
    await db.closes.put(close)
    await db.audit.add({
      id: uuid(), at, user: closedBy, role: s.currentRole,
      action: 'Zaključek meseca', entity: 'MesecniZakljucek', entityId: closeId,
      details: `${monthKey} · BP ${close.bpStart}–${close.bpEnd}, BI ${close.biStart}–${close.biEnd} (${docs.length} dokumentov)`,
    })
    return close
  })
}

/** Storno zaključenega dokumenta — številka ostane rezervirana, dokument je vidno označen. */
export async function stornoDoc(
  db: BlagajnaDB, s: Settings, docId: string, reason: string, by: string,
): Promise<void> {
  const at = nowIso()
  await db.transaction('rw', [db.docs, db.audit], async () => {
    const d = await db.docs.get(docId)
    if (!d) throw new Error('Dokument ne obstaja.')
    if (d.status !== 'ZAKLJUCEN') throw new Error('Stornirati je mogoče le zaključene dokumente.')
    await db.docs.update(docId, {
      status: 'STORNIRAN', cancelledAt: at, cancelledBy: by, cancelReason: reason, syncStatus: 'LOKALNO', updatedAt: at, updatedBy: by,
    })
    await db.audit.add({
      id: uuid(), at, user: by, role: s.currentRole,
      action: 'Storno / popravek', entity: 'BlagajniskiDokument', entityId: docId,
      details: `Razlog: ${reason}`,
    })
  })
}

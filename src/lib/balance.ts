// Stanje blagajne: začetno stanje + prejemki − izdatki ± interni prenosi (storno se ne šteje).
import type { BlagajnaDB } from '../db'
import type { CashDesk, CashDocument, CashTransfer } from '../types'

const r2 = (n: number) => Math.round(n * 100) / 100

export const docDelta = (d: CashDocument): number =>
  d.status === 'STORNIRAN' || d.amount == null || isNaN(d.amount) ? 0 : d.type === 'BP' ? d.amount : -d.amount

export const transferDelta = (t: CashTransfer, deskId: string): number =>
  t.toDeskId === deskId ? t.amount : t.fromDeskId === deskId ? -t.amount : 0

export interface BalanceInfo {
  opening: number
  prenos: number // stanje pred začetkom izbranega meseca
  mBP: number
  mBI: number
  nBP: number
  nBI: number
  mTransferIn: number
  mTransferOut: number
  nTransferIn: number
  nTransferOut: number
  konec: number // stanje ob koncu izbranega meseca
  current: number // trenutno stanje (vsi vnosi)
}

export function balanceInfo(desk: CashDesk | undefined, deskDocs: CashDocument[], monthKey: string, deskTransfers: CashTransfer[] = []): BalanceInfo {
  const opening = desk?.openingBalance ?? 0
  const deskId = desk?.id ?? ''
  let prenos = opening
  let current = opening
  let mBP = 0, mBI = 0, nBP = 0, nBI = 0
  let mTransferIn = 0, mTransferOut = 0, nTransferIn = 0, nTransferOut = 0
  for (const d of deskDocs) {
    const delta = docDelta(d)
    current += delta
    if (d.monthKey < monthKey) prenos += delta
    if (d.monthKey === monthKey && delta !== 0) {
      if (d.type === 'BP') { mBP += d.amount!; nBP++ }
      else { mBI += d.amount!; nBI++ }
    }
  }
  for (const t of deskTransfers) {
    const delta = transferDelta(t, deskId)
    current += delta
    if (t.monthKey < monthKey) prenos += delta
    if (t.monthKey === monthKey && delta !== 0) {
      if (delta > 0) { mTransferIn += delta; nTransferIn++ }
      else { mTransferOut += -delta; nTransferOut++ }
    }
  }
  const konec = prenos + mBP - mBI + mTransferIn - mTransferOut
  return {
    opening: r2(opening), prenos: r2(prenos), mBP: r2(mBP), mBI: r2(mBI), nBP, nBI,
    mTransferIn: r2(mTransferIn), mTransferOut: r2(mTransferOut), nTransferIn, nTransferOut,
    konec: r2(konec), current: r2(current),
  }
}

/** Trenutno razpoložljiva sredstva v blagajni (brez dokumenta, ki ga urejamo). */
export async function availableInDesk(db: BlagajnaDB, deskId: string, excludeDocId?: string): Promise<number> {
  const desk = await db.desks.get(deskId)
  const docs = await db.docs.where('deskId').equals(deskId).toArray()
  const transfers = await db.transfers.filter((t) => t.fromDeskId === deskId || t.toDeskId === deskId).toArray()
  const docsSum = docs.reduce((s, d) => s + (d.id === excludeDocId ? 0 : docDelta(d)), desk?.openingBalance ?? 0)
  const sum = transfers.reduce((s, t) => s + transferDelta(t, deskId), docsSum)
  return r2(sum)
}

/** Vrne napako, če izdatek presega razpoložljiva sredstva; sicer null. */
export async function checkBiCover(db: BlagajnaDB, doc: Pick<CashDocument, 'id' | 'type' | 'deskId' | 'amount' | 'status'>): Promise<string | null> {
  if (doc.type !== 'BI' || doc.status === 'STORNIRAN' || doc.amount == null || !doc.deskId) return null
  const avail = await availableInDesk(db, doc.deskId, doc.id)
  if (doc.amount > avail + 1e-9) {
    const f = (n: number) => n.toLocaleString('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return `V blagajni ni dovolj sredstev: na voljo ${f(avail)} €, izdatek pa znaša ${f(doc.amount)} €. Izdatek ne sme preseči stanja blagajne.`
  }
  return null
}

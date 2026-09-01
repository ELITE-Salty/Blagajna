// Stanje blagajne: začetno stanje + prejemki − izdatki (storno se ne šteje).
import type { BlagajnaDB } from '../db'
import type { CashDesk, CashDocument } from '../types'

const r2 = (n: number) => Math.round(n * 100) / 100

export const docDelta = (d: CashDocument): number =>
  d.status === 'STORNIRAN' || d.amount == null || isNaN(d.amount) ? 0 : d.type === 'BP' ? d.amount : -d.amount

export interface BalanceInfo {
  opening: number
  prenos: number // stanje pred začetkom izbranega meseca
  mBP: number
  mBI: number
  nBP: number
  nBI: number
  konec: number // stanje ob koncu izbranega meseca
  current: number // trenutno stanje (vsi vnosi)
}

export function balanceInfo(desk: CashDesk | undefined, deskDocs: CashDocument[], monthKey: string): BalanceInfo {
  const opening = desk?.openingBalance ?? 0
  let prenos = opening
  let current = opening
  let mBP = 0, mBI = 0, nBP = 0, nBI = 0
  for (const d of deskDocs) {
    const delta = docDelta(d)
    current += delta
    if (d.monthKey < monthKey) prenos += delta
    if (d.monthKey === monthKey && delta !== 0) {
      if (d.type === 'BP') { mBP += d.amount!; nBP++ }
      else { mBI += d.amount!; nBI++ }
    }
  }
  return { opening: r2(opening), prenos: r2(prenos), mBP: r2(mBP), mBI: r2(mBI), nBP, nBI, konec: r2(prenos + mBP - mBI), current: r2(current) }
}

/** Trenutno razpoložljiva sredstva v blagajni (brez dokumenta, ki ga urejamo). */
export async function availableInDesk(db: BlagajnaDB, deskId: string, excludeDocId?: string): Promise<number> {
  const desk = await db.desks.get(deskId)
  const docs = await db.docs.where('deskId').equals(deskId).toArray()
  const sum = docs.reduce((s, d) => s + (d.id === excludeDocId ? 0 : docDelta(d)), desk?.openingBalance ?? 0)
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

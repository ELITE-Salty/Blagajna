// Reprodukcija zaključka meseca v Node (fake-indexeddb)
import * as fakeIDB from 'fake-indexeddb'
import { BlagajnaDB } from './src/db'
import { closeMonth, computePreview } from './src/lib/numbering'
import type { Settings } from './src/types'

async function main() {
  const db = new BlagajnaDB({ indexedDB: (fakeIDB as any).indexedDB ?? (fakeIDB as any).default, IDBKeyRange: (fakeIDB as any).IDBKeyRange })
  await db.open()
  // ročno zasejemo prek initDb poti — seedIfEmpty je privaten, zato uporabimo initDb logiko:
  // najlažje: kopiramo klic prek odprtja druge instance ni mogoče — zato uvozimo initDb ne, ampak seed sprožimo tako, da odpremo prek modula db.ts ni izvozen.
  // Trik: db.ts izvaža samo initDb za pravi IDB; tu preverimo, ali je baza prazna in po potrebi ročno vstavimo minimalne podatke.
  const n = await db.desks.count()
  if (n === 0) {
    await db.desks.bulkPut([{ id: 'gb', name: 'Glavna', code: 'GB', description: '', active: true }])
    await db.settings.put({
      id: 'main',
      company: { name: 'X', street: '', postalCode: '', city: '', country: '', phone: '', fax: '', email: '', declarantName: '', declarantPosition: '' },
      numberingScope: 'PER_DESK', numberFormat: 'SLASH', financeCanClose: false, requirePurpose: true,
      currentRole: 'ADMIN', currentUserName: 'T', activeDeskId: 'gb',
    } as Settings)
    const mk = (id: string, type: 'BP' | 'BI', date: string, time: string, created: string, amount: number) => ({
      id, deskId: 'gb', type, officialNumber: null, seqYear: null,
      transactionDate: date, transactionTime: time, monthKey: date.slice(0, 7),
      employeeId: 'e1', employeeName: 'Test Oseba', amount, amountWordsOverride: '',
      paymentMethod: 'GOTOVINA' as const, purpose: 'test', rows: [], attachments: [], signatures: [],
      prejelStatus: 'NI_PODPISANO' as const, notes: '', potrdiloId: null,
      status: 'ODPRT' as const, syncStatus: 'SINHRONIZIRANO' as const,
      createdAt: created, createdBy: 'T', updatedAt: created, updatedBy: 'T', correctionOfId: null,
    })
    await db.docs.bulkPut([
      mk('a', 'BP', '2026-08-15', '14:00', '2026-08-22T10:00:00Z', 150),
      mk('b', 'BP', '2026-08-15', '16:00', '2026-08-27T09:00:00Z', 80),
      mk('c', 'BI', '2026-08-04', '06:30', '2026-08-04T07:00:00Z', 300),
    ])
    // že zaključen julij za nadaljevanje zaporedja
    await db.closes.put({
      id: 'gb|2026-07', scopeKey: 'gb', deskId: 'gb', year: 2026, month: 7, monthKey: '2026-07',
      bpStart: 1, bpEnd: 3, biStart: 1, biEnd: 2, docCount: 5, closedBy: 'T', closedAt: '2026-07-31T15:00:00Z',
      idempotencyKey: 'x', manifest: [],
    })
  }
  const settings = (await db.settings.get('main'))!
  const preview = await computePreview(db, settings, 'gb', '2026-08')
  console.log('PREVIEW BP:', preview.bp.map((r) => `${r.number}@${r.doc.transactionTime}`).join(', '))
  console.log('PREVIEW BI:', preview.bi.map((r) => `${r.number}@${r.doc.transactionTime}`).join(', '))
  const res = await closeMonth(db, settings, 'gb', '2026-08', 'Tester')
  console.log('CLOSE OK:', res.id, `BP ${res.bpStart}-${res.bpEnd}`, `BI ${res.biStart}-${res.biEnd}`, 'docs:', res.docCount)
  const res2 = await closeMonth(db, settings, 'gb', '2026-08', 'Tester')
  console.log('IDEMPOTENT:', res2.idempotencyKey === res.idempotencyKey)
  const docs = await db.docs.where('monthKey').equals('2026-08').toArray()
  console.log('NUMBERS:', docs.map((d) => `${d.type}${d.officialNumber}/${d.seqYear}:${d.status}`).sort().join(' '))
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

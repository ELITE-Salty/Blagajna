import Dexie, { type Table } from 'dexie'
import type {
  AuditEvent, CashDesk, CashDocument, DocType, Employee, MonthClose, Potrdilo, Settings,
} from './types'
import { uuid, nowIso, todayIso, nowTime, currentMonthKey } from './lib/util'

export interface OutboxRow {
  k?: number
  tbl: 'docs' | 'potrdila' | 'employees' | 'desks' | 'settings' | 'audit'
  id: string
  del?: boolean
}

export class BlagajnaDB extends Dexie {
  docs!: Table<CashDocument, string>
  desks!: Table<CashDesk, string>
  employees!: Table<Employee, string>
  potrdila!: Table<Potrdilo, string>
  closes!: Table<MonthClose, string>
  audit!: Table<AuditEvent, string>
  settings!: Table<Settings, string>
  outbox!: Table<OutboxRow, number>
  kv!: Table<{ k: string; v: string }, string>

  constructor(opts?: { indexedDB: any; IDBKeyRange: any }) {
    super('blagajna-blu', opts as any)
    this.version(1).stores({
      docs: 'id, monthKey, deskId, type, status, employeeId, syncStatus, potrdiloId',
      desks: 'id',
      employees: 'id',
      potrdila: 'id, employeeId',
      closes: 'id, monthKey',
      audit: 'id, at',
      settings: 'id',
    })
    this.version(2).stores({
      outbox: '++k, tbl',
      kv: 'k',
    })
    this.version(3).stores({
      outbox: '++k, tbl, [tbl+id]',
    })
  }
}

/** Odpri IndexedDB; če je v peskovniku blokiran, uporabi in-memory nadomestek. */
export async function initDb(seed: boolean): Promise<{ db: BlagajnaDB; ephemeral: boolean }> {
  try {
    const db = new BlagajnaDB()
    await Promise.race([
      db.open(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('idb-timeout')), 5000)),
    ])
    if (seed) await seedIfEmpty(db)
    return { db, ephemeral: false }
  } catch {
    const f: any = await import('fake-indexeddb')
    const db = new BlagajnaDB({ indexedDB: f.indexedDB ?? f.default, IDBKeyRange: f.IDBKeyRange })
    await db.open()
    if (seed) await seedIfEmpty(db)
    return { db, ephemeral: true }
  }
}

/** V strežniškem načinu poskrbi za privzete nastavitve (dokler jih strežnik ne prepiše). */
export async function ensureSettings(db: BlagajnaDB): Promise<void> {
  const s = await db.settings.get('main')
  if (s) return
  await db.settings.put({
    id: 'main',
    company: {
      name: 'Blu Logistics d.o.o.', street: '', postalCode: '1000', city: 'Ljubljana', country: 'Slovenija',
      phone: '', fax: '', email: '', declarantName: '', declarantPosition: '',
    },
    numberingScope: 'PER_DESK',
    numberFormat: 'SLASH',
    financeCanClose: false,
    requirePurpose: true,
    autoSync: true,
    currentRole: 'FINANCE',
    currentUserName: '',
    activeDeskId: '',
    updatedAt: nowIso(),
  })
}

export function emptyDoc(partial: Partial<CashDocument>): CashDocument {
  return {
    id: uuid(),
    deskId: '',
    type: 'BP',
    officialNumber: null,
    seqYear: null,
    transactionDate: todayIso(),
    transactionTime: nowTime(),
    monthKey: currentMonthKey(),
    employeeId: '',
    employeeName: '',
    amount: null,
    amountWordsOverride: '',
    paymentMethod: 'GOTOVINA',
    purpose: '',
    rows: [],
    attachments: [],
    signatures: [],
    prejelStatus: 'NI_PODPISANO',
    notes: '',
    potrdiloId: null,
    status: 'ODPRT',
    syncStatus: 'LOKALNO',
    createdAt: nowIso(),
    createdBy: '',
    updatedAt: nowIso(),
    updatedBy: '',
    correctionOfId: null,
    ...partial,
  }
}

// ---------------- Predstavitveni podatki ----------------

function seedDoc(
  id: string, deskId: string, type: DocType, date: string, time: string,
  empId: string, empName: string, amount: number | null, purpose: string,
  opts: Partial<CashDocument> = {},
): CashDocument {
  return emptyDoc({
    id, deskId, type,
    transactionDate: date, transactionTime: time, monthKey: date.slice(0, 7),
    employeeId: empId, employeeName: empName,
    amount, purpose,
    rows: opts.rows ?? (amount != null ? [{ opis: purpose, konto: type === 'BP' ? '1000' : '1001', znesek: amount }] : []),
    syncStatus: 'SINHRONIZIRANO',
    createdAt: `${date}T08:00:00.000Z`,
    createdBy: 'Demo',
    updatedAt: `${date}T08:00:00.000Z`,
    updatedBy: 'Demo',
    ...opts,
  })
}

async function seedIfEmpty(db: BlagajnaDB) {
  const n = await db.desks.count()
  if (n > 0) return

  const settings: Settings = {
    id: 'main',
    company: {
      name: 'Blu Logistics d.o.o.',
      street: '',
      postalCode: '1000',
      city: 'Ljubljana',
      country: 'Slovenija',
      phone: '',
      fax: '',
      email: '',
      declarantName: 'Nik Kopi',
      declarantPosition: 'Direktor',
    },
    numberingScope: 'PER_DESK',
    numberFormat: 'SLASH',
    financeCanClose: false,
    requirePurpose: true,
    autoSync: true,
    currentRole: 'ADMIN',
    currentUserName: 'Nik',
    activeDeskId: 'gb',
    updatedAt: nowIso(),
  }

  const desks: CashDesk[] = [
    { id: 'gb', name: 'Glavna blagajna', code: 'GB', description: 'Pisarna Ljubljana', active: true, openingBalance: 1000, updatedAt: nowIso() },
    { id: 'b2', name: 'Blagajna 2', code: 'B2', description: '', active: true, openingBalance: 250, updatedAt: nowIso() },
  ]

  const mkEmp = (id: string, fn: string, ln: string, dob: string, idn: string, start: string, vehicle: string): Employee => ({
    id, firstName: fn, lastName: ln, displayName: `${fn} ${ln}`,
    dateOfBirth: dob, idNumber: idn, employmentStart: start,
    employeeNumber: '', phone: '', vehicle, notes: '',
    active: true, createdAt: nowIso(), updatedAt: nowIso(),
  })
  const employees: Employee[] = [
    mkEmp('e1', 'Marko', 'Novak', '1984-03-12', 'VD 102934', '2019-04-01', 'LJ 45-8KD'),
    mkEmp('e2', 'Tomaž', 'Kovač', '1988-11-02', 'VD 558201', '2021-09-15', 'LJ 22-MTB'),
    mkEmp('e3', 'Peter', 'Zupan', '1979-06-25', 'VD 771435', '2015-02-01', 'LJ 90-PZL'),
    mkEmp('e4', 'Andrej', 'Horvat', '1992-01-30', 'VD 663310', '2023-05-10', 'LJ 11-AHT'),
    mkEmp('e5', 'Luka', 'Kranjc', '1995-08-17', 'VD 449072', '2024-01-08', 'LJ 63-LKR'),
    mkEmp('e6', 'Jože', 'Potočnik', '1976-12-05', 'VD 220584', '2012-11-20', 'LJ 77-JPO'),
  ]

  // — Julij 2026: že zaključen mesec (Glavna blagajna) —
  const julij: CashDocument[] = [
    seedDoc('jbp1', 'gb', 'BP', '2026-07-03', '09:00', 'e1', 'Marko Novak', 500, 'Polog gotovine — plačilo prevoznine', { officialNumber: 1, seqYear: 2026, status: 'ZAKLJUCEN', finalizedAt: '2026-07-31T15:00:00.000Z', finalizedBy: 'Demo' }),
    seedDoc('jbp2', 'gb', 'BP', '2026-07-10', '11:30', 'e3', 'Peter Zupan', 75, 'Vračilo neporabljene akontacije', { officialNumber: 2, seqYear: 2026, status: 'ZAKLJUCEN', finalizedAt: '2026-07-31T15:00:00.000Z', finalizedBy: 'Demo' }),
    seedDoc('jbp3', 'gb', 'BP', '2026-07-24', '14:10', 'e4', 'Andrej Horvat', 130, 'Polog — prodaja embalaže', { officialNumber: 3, seqYear: 2026, status: 'ZAKLJUCEN', finalizedAt: '2026-07-31T15:00:00.000Z', finalizedBy: 'Demo' }),
    seedDoc('jbi1', 'gb', 'BI', '2026-07-08', '08:45', 'e2', 'Tomaž Kovač', 250, 'Akontacija za službeno pot — Avstrija', { officialNumber: 1, seqYear: 2026, status: 'ZAKLJUCEN', prejelStatus: 'ROCNO', finalizedAt: '2026-07-31T15:00:00.000Z', finalizedBy: 'Demo' }),
    seedDoc('jbi2', 'gb', 'BI', '2026-07-21', '13:20', 'e5', 'Luka Kranjc', 64.3, 'Povračilo stroškov — cestnine', { officialNumber: 2, seqYear: 2026, status: 'ZAKLJUCEN', prejelStatus: 'ROCNO', finalizedAt: '2026-07-31T15:00:00.000Z', finalizedBy: 'Demo' }),
  ]
  const julijClose: MonthClose = {
    id: 'gb|2026-07', scopeKey: 'gb', deskId: 'gb', year: 2026, month: 7, monthKey: '2026-07',
    bpStart: 1, bpEnd: 3, biStart: 1, biEnd: 2, docCount: 5,
    closedBy: 'Demo (Računovodja)', closedAt: '2026-07-31T15:00:00.000Z', idempotencyKey: 'seed-julij',
    manifest: [
      { docId: 'jbp1', type: 'BP', number: 1, transactionAt: '2026-07-03T09:00', employeeName: 'Marko Novak', amount: 500 },
      { docId: 'jbp2', type: 'BP', number: 2, transactionAt: '2026-07-10T11:30', employeeName: 'Peter Zupan', amount: 75 },
      { docId: 'jbp3', type: 'BP', number: 3, transactionAt: '2026-07-24T14:10', employeeName: 'Andrej Horvat', amount: 130 },
      { docId: 'jbi1', type: 'BI', number: 1, transactionAt: '2026-07-08T08:45', employeeName: 'Tomaž Kovač', amount: 250 },
      { docId: 'jbi2', type: 'BI', number: 2, transactionAt: '2026-07-21T13:20', employeeName: 'Luka Kranjc', amount: 64.3 },
    ],
  }

  // — Potrdila o dejavnostih —
  const potrdila: Potrdilo[] = [
    {
      id: 'pot1', employeeId: 'e2', employeeName: 'Tomaž Kovač', employeeDateOfBirth: '1988-11-02',
      employeeIdNumber: 'VD 558201', employeeEmploymentStart: '2021-09-15',
      fromAt: '2026-08-01T21:30', toAt: '2026-08-05T07:00', activityType: 'ANNUAL_LEAVE',
      companyPlace: 'Ljubljana', companyDate: '2026-08-01', driverPlace: 'Ljubljana', driverDate: '2026-08-01',
      declarantName: 'Nik Kopi', declarantPosition: 'Direktor',
      signatures: [], syncStatus: 'SINHRONIZIRANO', createdAt: '2026-08-01T10:00:00.000Z', createdBy: 'Demo', updatedAt: '2026-08-01T10:00:00.000Z',
    },
    {
      id: 'pot2', employeeId: 'e6', employeeName: 'Jože Potočnik', employeeDateOfBirth: '1976-12-05',
      employeeIdNumber: 'VD 220584', employeeEmploymentStart: '2012-11-20',
      fromAt: '2026-08-20T08:00', toAt: '2026-08-28T20:00', activityType: 'AVAILABLE',
      companyPlace: 'Ljubljana', companyDate: '2026-08-19', driverPlace: 'Ljubljana', driverDate: '2026-08-19',
      declarantName: 'Nik Kopi', declarantPosition: 'Direktor',
      signatures: [], syncStatus: 'SINHRONIZIRANO', createdAt: '2026-08-19T09:00:00.000Z', createdBy: 'Demo', updatedAt: '2026-08-19T09:00:00.000Z',
    },
    {
      id: 'pot3', employeeId: 'e1', employeeName: 'Marko Novak', employeeDateOfBirth: '1984-03-12',
      employeeIdNumber: 'VD 102934', employeeEmploymentStart: '2019-04-01',
      fromAt: '2026-08-10T08:00', toAt: '2026-08-13T20:00', activityType: 'SICK_LEAVE',
      companyPlace: 'Ljubljana', companyDate: '2026-08-10', driverPlace: 'Ljubljana', driverDate: '2026-08-10',
      declarantName: 'Nik Kopi', declarantPosition: 'Direktor',
      signatures: [], syncStatus: 'SINHRONIZIRANO', createdAt: '2026-08-10T08:30:00.000Z', createdBy: 'Demo', updatedAt: '2026-08-10T08:30:00.000Z',
    },
  ]

  // — Avgust 2026: odprt mesec —
  const avgust: CashDocument[] = [
    seedDoc('abi0', 'gb', 'BI', '2026-08-04', '06:30', 'e2', 'Tomaž Kovač', 300, 'Akontacija za pot — Nemčija', { potrdiloId: 'pot1', createdAt: '2026-08-04T07:00:00.000Z' }),
    seedDoc('abp1', 'gb', 'BP', '2026-08-05', '09:15', 'e1', 'Marko Novak', 120, 'Vračilo akontacije — službena pot'),
    seedDoc('abp2', 'gb', 'BP', '2026-08-12', '11:00', 'e3', 'Peter Zupan', 260, 'Polog gotovine — prodaja palet'),
    // PRD primer: isti dan, vneseno v napačnem vrstnem redu → številčenje po času transakcije
    seedDoc('abi1', 'gb', 'BI', '2026-08-15', '14:00', 'e1', 'Marko Novak', 150, 'Dnevnice — julij', { createdAt: '2026-08-22T10:00:00.000Z' }),
    seedDoc('abi2', 'gb', 'BI', '2026-08-15', '16:00', 'e5', 'Luka Kranjc', 80, 'Povračilo stroškov — cestnine', { createdAt: '2026-08-27T09:00:00.000Z' }),
    seedDoc('abp3', 'gb', 'BP', '2026-08-16', '08:15', 'e4', 'Andrej Horvat', 45.5, 'Vračilo neporabljene akontacije'),
    seedDoc('abi3', 'gb', 'BI', '2026-08-24', '09:00', 'e6', 'Jože Potočnik', 22.8, 'Malica — refundacija', { potrdiloId: 'pot2', syncStatus: 'LOKALNO', createdAt: '2026-08-24T09:05:00.000Z' }),
    seedDoc('abp4', 'gb', 'BP', '2026-08-26', '10:00', 'e3', 'Peter Zupan', null, '', { syncStatus: 'LOKALNO', createdAt: '2026-08-26T10:05:00.000Z' }),
    seedDoc('bbp1', 'b2', 'BP', '2026-08-18', '13:00', 'e5', 'Luka Kranjc', 60, 'Polog — servisna storitev'),
  ]

  const audit: AuditEvent[] = [
    {
      id: uuid(), at: '2026-07-31T15:00:00.000Z', user: 'Demo', role: 'RACUNOVODJA',
      action: 'Zaključek meseca', entity: 'MesecniZakljucek', entityId: 'gb|2026-07',
      details: 'julij 2026 · Glavna blagajna · BP 1–3, BI 1–2 (5 dokumentov)',
    },
  ]

  await db.transaction('rw', [db.settings, db.desks, db.employees, db.potrdila, db.docs, db.closes, db.audit], async () => {
    await db.settings.put(settings)
    await db.desks.bulkPut(desks)
    await db.employees.bulkPut(employees)
    await db.potrdila.bulkPut(potrdila)
    await db.docs.bulkPut([...julij, ...avgust])
    await db.closes.put(julijClose)
    await db.audit.bulkPut(audit)
  })
}

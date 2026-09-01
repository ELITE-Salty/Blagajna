// E2E test strežnika: prijava, uporabniki, push/pull, atomaren zaključek, varovala.
const BASE = 'http://localhost:8090'
let failures = 0
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${label}`); if (!cond) failures++ }

const api = async (path, { method = 'GET', token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

const doc = (id, type, date, time, created, amount, extra = {}) => ({
  id, deskId: 'gb', type, officialNumber: null, seqYear: null,
  transactionDate: date, transactionTime: time, monthKey: date.slice(0, 7),
  employeeId: 'e1', employeeName: 'Test Voznik', amount, amountWordsOverride: '',
  paymentMethod: 'GOTOVINA', purpose: 'test namen', rows: [], attachments: [], signatures: [],
  prejelStatus: 'NI_PODPISANO', notes: '', potrdiloId: null,
  status: 'ODPRT', syncStatus: 'LOKALNO',
  createdAt: created, createdBy: 'T', updatedAt: created, updatedBy: 'T', correctionOfId: null,
  ...extra,
})

// 1) zdravje + prijava
const h = await api('/api/health')
ok(h.json.name === 'blagajna', 'health')
const bad = await api('/api/auth/login', { method: 'POST', body: { email: 'nik@test.si', password: 'napacno' } })
ok(bad.status === 401, 'napačno geslo zavrnjeno')
const login = await api('/api/auth/login', { method: 'POST', body: { email: 'nik@test.si', password: 'test-geslo-123' } })
ok(login.status === 200 && login.json.user.role === 'ADMIN', 'prijava admin')
const T = login.json.token

// 2) uporabniki
const nu = await api('/api/users', { method: 'POST', token: T, body: { email: 'fin@test.si', name: 'Fina Finance', role: 'FINANCE', password: 'finance-geslo1' } })
ok(nu.status === 200, 'nov uporabnik (finance)')
const finLogin = await api('/api/auth/login', { method: 'POST', body: { email: 'fin@test.si', password: 'finance-geslo1' } })
const TF = finLogin.json.token
const usersAsFin = await api('/api/users', { token: TF })
ok(usersAsFin.status === 403, 'finance ne vidi uporabnikov (403)')

// 3) push šifrantov (admin) + dokumentov
const settings = { id: 'main', company: { name: 'Blu Logistics d.o.o.' }, numberingScope: 'PER_DESK', numberFormat: 'SLASH', financeCanClose: false, requirePurpose: true, autoSync: true, updatedAt: '2026-09-01T06:00:00Z' }
const p1 = await api('/api/sync/push', { method: 'POST', token: T, body: {
  settings: [settings],
  desks: [{ id: 'gb', name: 'Glavna blagajna', code: 'GB', description: '', active: true, updatedAt: '2026-09-01T06:00:00Z' }],
  employees: [{ id: 'e1', firstName: 'Test', lastName: 'Voznik', displayName: 'Test Voznik', active: true, updatedAt: '2026-09-01T06:00:00Z' }],
} })
ok(p1.status === 200 && p1.json.conflicts.length === 0, 'push šifrantov (admin)')

const pOpening = await api('/api/sync/push', { method: 'POST', token: T, body: {
  desks: [{ id: 'gb', name: 'Glavna blagajna', code: 'GB', description: '', active: true, openingBalance: 1250, updatedAt: '2026-09-01T06:05:00Z' }],
} })
ok(pOpening.status === 200 && pOpening.json.accepted.desks.includes('gb'), 'ponovna sprememba blagajne / začetnega stanja se shrani')
const pullOpening = await api('/api/sync/pull?since=0', { token: T })
ok(pullOpening.json.desks.find((d) => d.id === 'gb')?.openingBalance === 1250, 'začetno stanje se po push/pull ohrani na strežniku')

const pFinDesk = await api('/api/sync/push', { method: 'POST', token: TF, body: { desks: [{ id: 'x1', name: 'Hack', updatedAt: '2026-09-01T07:00:00Z' }] } })
ok(pFinDesk.json.conflicts.length === 1, 'finance ne more pisati blagajn')
const pFinEmp = await api('/api/sync/push', { method: 'POST', token: TF, body: { employees: [{ id: 'ex', displayName: 'X', updatedAt: '2026-09-01T07:00:00Z' }] } })
ok(pFinEmp.json.conflicts.length === 1, 'finance ne more pisati zaposlenih')

// računovodja LAHKO ureja zaposlene
await api('/api/users', { method: 'POST', token: T, body: { email: 'rac@test.si', name: 'Rado Računovodja', role: 'RACUNOVODJA', password: 'racun-geslo-1' } })
const racLogin = await api('/api/auth/login', { method: 'POST', body: { email: 'rac@test.si', password: 'racun-geslo-1' } })
const TR = racLogin.json.token
const pRacEmp = await api('/api/sync/push', { method: 'POST', token: TR, body: { employees: [{ id: 'e2', firstName: 'Novi', lastName: 'Voznik', displayName: 'Novi Voznik', active: true, updatedAt: '2026-09-01T07:30:00Z' }] } })
ok(pRacEmp.status === 200 && pRacEmp.json.accepted.employees.includes('e2'), 'računovodja lahko dodaja zaposlene')

const p2 = await api('/api/sync/push', { method: 'POST', token: TF, body: { docs: [
  doc('d1', 'BP', '2026-08-15', '14:00', '2026-08-22T10:00:00Z', 150),
  doc('d2', 'BP', '2026-08-15', '16:00', '2026-08-27T09:00:00Z', 80),
  doc('d3', 'BI', '2026-08-04', '06:30', '2026-08-04T07:00:00Z', 300),
], audit: [{ id: 'a1', at: '2026-08-27T09:00:00Z', user: 'Fina', role: 'FINANCE', action: 'Nov dokument', entity: 'BlagajniskiDokument', entityId: 'd1', details: '' }] } })
ok(p2.status === 200 && p2.json.accepted.docs.length === 3, 'push dokumentov (finance)')

// 4) pull
const pull1 = await api('/api/sync/pull?since=0', { token: TF })
ok(pull1.json.docs.length === 3 && pull1.json.docs.every((d) => d.syncStatus === 'SINHRONIZIRANO'), 'pull vrne sinhronizirane dokumente')
ok(pull1.json.settings.length === 1 && pull1.json.settings[0].currentRole === undefined, 'pull settings brez lokalnih polj')

// 5) zaključek: finance zavrnjen, admin uspe
const cFin = await api('/api/close-month', { method: 'POST', token: TF, body: { deskId: 'gb', monthKey: '2026-08' } })
ok(cFin.status === 403, 'finance ne more zaključiti (pravilo izklopljeno)')
const c1 = await api('/api/close-month', { method: 'POST', token: T, body: { deskId: 'gb', monthKey: '2026-08' } })
const man = c1.json.close?.manifest ?? []
const bp1 = man.find((m) => m.docId === 'd1')
const bp2 = man.find((m) => m.docId === 'd2')
const bi1 = man.find((m) => m.docId === 'd3')
ok(c1.status === 200 && bp1?.number === 1 && bp2?.number === 2 && bi1?.number === 1, `zaključek: kronološke številke (BP ${bp1?.number},${bp2?.number} · BI ${bi1?.number})`)

// 6) idempotentnost
const c2 = await api('/api/close-month', { method: 'POST', token: T, body: { deskId: 'gb', monthKey: '2026-08' } })
ok(c2.json.alreadyClosed === true && c2.json.close.idempotencyKey === c1.json.close.idempotencyKey, 'ponovni zaključek vrne isti rezultat')

// 7) varovala po zaključku
const pull2 = await api('/api/sync/pull?since=0', { token: TF })
const fin1 = pull2.json.docs.find((d) => d.id === 'd1')
const tamper = { ...fin1, amount: 999, updatedAt: new Date().toISOString() }
const p3 = await api('/api/sync/push', { method: 'POST', token: TF, body: { docs: [tamper] } })
ok(p3.json.conflicts.length === 1 && p3.json.conflicts[0].reason.includes('zaklenjen'), 'sprememba zneska zaključenega dokumenta zavrnjena')

const p4 = await api('/api/sync/push', { method: 'POST', token: TF, body: { docs: [{ ...fin1, prejelStatus: 'ROCNO', updatedAt: new Date().toISOString() }] } })
ok(p4.status === 200 && p4.json.accepted.docs.includes('d1'), 'oznaka Prejel po zaključku dovoljena')

const storno = { ...fin1, status: 'STORNIRAN', cancelReason: 'test', cancelledBy: 'T', cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const p5 = await api('/api/sync/push', { method: 'POST', token: T, body: { docs: [storno] } })
ok(p5.status === 200 && p5.json.accepted.docs.includes('d1'), 'storno prehod dovoljen')

const pDel = await api('/api/sync/push', { method: 'POST', token: TF, body: { deletes: { docs: ['d2'] } } })
ok(pDel.json.conflicts.length === 1, 'brisanje zaključenega dokumenta zavrnjeno')

const late = await api('/api/sync/push', { method: 'POST', token: TF, body: { docs: [doc('d9', 'BP', '2026-08-20', '10:00', new Date().toISOString(), 50)] } })
ok(late.json.conflicts.length === 1 && late.json.conflicts[0].reason.includes('zaključen'), 'nov dokument v zaključen mesec zavrnjen')

// 8) naslednji mesec nadaljuje zaporedje
await api('/api/sync/push', { method: 'POST', token: TF, body: { docs: [doc('d10', 'BP', '2026-09-01', '08:00', new Date().toISOString(), 70)] } })
const c3 = await api('/api/close-month', { method: 'POST', token: T, body: { deskId: 'gb', monthKey: '2026-09' } })
ok(c3.json.close?.manifest?.[0]?.number === 3, `september nadaljuje BP zaporedje (dobil ${c3.json.close?.manifest?.[0]?.number}, pričakovano 3)`)

// 9) brez žetona
const noTok = await api('/api/sync/pull?since=0')
ok(noTok.status === 401, 'brez prijave ni dostopa')

console.log(failures === 0 ? '\nVSI TESTI USPEŠNI ✓' : `\n${failures} TESTOV NI USPELO ✗`)
process.exit(failures === 0 ? 0 : 1)

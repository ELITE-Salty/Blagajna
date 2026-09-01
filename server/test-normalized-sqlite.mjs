import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSqliteStore } from './store-sqlite.js'

let fail = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++ }
const dir = mkdtempSync(path.join(os.tmpdir(), 'blagajna-schema-'))
const file = path.join(dir, 'blagajna.sqlite')

// Simulacija baze iz prejšnje različice: samo records + meta.
{
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE records(tbl TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,server_seq INTEGER NOT NULL,PRIMARY KEY(tbl,id)); CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); INSERT INTO meta VALUES('seq','4');`)
  old.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('settings', 'main', JSON.stringify({ id:'main', company:{name:'Test d.o.o.',city:'Ljubljana'}, numberingScope:'PER_DESK', numberFormat:'SLASH', financeCanClose:false, requirePurpose:true, autoSync:true, updatedAt:'2026-08-31T08:00:00Z' }), '2026-08-31T08:00:00Z', 0, 3)
  old.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run('desks', 'gb', JSON.stringify({ id:'gb',name:'Glavna',code:'GB',description:'',active:true,openingBalance:500,updatedAt:'2026-08-31T08:01:00Z' }), '2026-08-31T08:01:00Z', 0, 4)
  old.close()
}

const store = createSqliteStore(dir)
const migrated = await store.getRecord('desks','gb')
ok(migrated?.json.openingBalance === 500, 'legacy začetno stanje se migrira v cash_desks.opening_balance')
await store.putRecord('desks','gb',{...migrated.json,openingBalance:1250.5,updatedAt:'2026-09-01T09:00:00Z'},'2026-09-01T09:00:00Z')
const after = await store.getRecord('desks','gb')
ok(after?.json.openingBalance === 1250.5, 'sprememba začetnega stanja se prebere nazaj')

await store.putRecord('docs','d1',{
  id:'d1',deskId:'gb',type:'BP',officialNumber:null,seqYear:null,transactionDate:'2026-09-01',transactionTime:'11:15',monthKey:'2026-09',
  employeeId:'e1',employeeName:'Ana Novak',amount:22.4,amountWordsOverride:'',paymentMethod:'GOTOVINA',purpose:'Test',
  rows:[{opis:'Storitev',konto:'1000',znesek:22.4}],attachments:[{id:'a1',name:'racun.jpg',mime:'image/jpeg',dataUrl:'data:image/jpeg;base64,AA',addedAt:'2026-09-01T09:00:00Z'}],
  signatures:[{role:'PREJEL_BLAGAJNIK',signerName:'Ana',type:'ROCNO',signedAt:'2026-09-01T09:00:00Z',capturedBy:'Admin'}],prejelStatus:'ROCNO',notes:'',potrdiloId:null,status:'ODPRT',syncStatus:'SINHRONIZIRANO',createdAt:'2026-09-01T09:00:00Z',createdBy:'Admin',updatedAt:'2026-09-01T09:00:00Z',updatedBy:'Admin',correctionOfId:null,
},'2026-09-01T09:00:00Z')
const doc=(await store.getRecord('docs','d1'))?.json
ok(doc?.rows?.[0]?.konto === '1000' && doc?.attachments?.length === 1 && doc?.signatures?.length === 1, 'dokument + vrstice/priloge/podpisi se sestavijo iz ločenih tabel')

const sql = new DatabaseSync(file)
const tables = new Set(sql.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r)=>r.name))
for (const t of ['company','app_settings','cash_desks','employees','cash_documents','cash_document_rows','cash_document_attachments','cash_document_signatures','activity_certificates','activity_certificate_signatures','month_closes','month_close_manifest']) ok(tables.has(t), `tabela ${t} obstaja`)
ok(Number(sql.prepare(`SELECT opening_balance FROM cash_desks WHERE id='gb'`).get().opening_balance) === 1250.5, 'opening_balance je pravi SQL stolpec, ne JSON')
ok(Number(sql.prepare(`SELECT COUNT(*) AS n FROM records`).get().n) === 2, 'legacy records ostane nespremenjen kot rollback vir')
const legacyOpening = JSON.parse(sql.prepare(`SELECT json FROM records WHERE tbl='desks' AND id='gb'`).get().json).openingBalance
ok(legacyOpening === 500, 'novi save ne piše nazaj v legacy JSON records')
sql.close()
rmSync(dir,{recursive:true,force:true})
console.log(fail ? `\n${fail} TESTOV NI USPELO` : '\nNORMALIZIRANA SQLITE SHEMA OK ✓')
process.exit(fail ? 1 : 0)

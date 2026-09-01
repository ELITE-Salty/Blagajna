// Enkratna selitev podatkov: SQLite -> PostgreSQL.
// Deluje tako s staro JSON shemo kot z novo normalizirano shemo, ker SQLite store
// ob odprtju najprej varno migrira legacy `records`, nato pa beremo kanonične tabele.
//
// Uporaba:
//   DATABASE_URL=postgres://uporabnik:geslo@gostitelj:5432/blagajna node server/migrate-sqlite-to-pg.js [pot-do-data-mape]
import path from 'node:path'
import { createSqliteStore } from './store-sqlite.js'
import { createPgStore } from './store-pg.js'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Nastavite DATABASE_URL (postgres://...).')
  process.exit(1)
}
const dataDir = process.argv[2] || path.join(process.cwd(), 'data')
const source = createSqliteStore(dataDir)
const pg = await import('pg')
const Pool = pg.default?.Pool ?? pg.Pool
const pool = new Pool({ connectionString: url })
const target = await createPgStore(pool)

let userCount = 0
let recordCount = 0
let auditCount = 0

try {
  // Uporabniki: upsert po e-naslovu, gesel ne spreminjamo v plaintext.
  for (const u of await source.listUsers()) {
    await pool.query(`
      INSERT INTO users (id,email,name,role,pass_hash,active,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (email) DO UPDATE SET
        name=EXCLUDED.name, role=EXCLUDED.role, pass_hash=EXCLUDED.pass_hash,
        active=EXCLUDED.active, updated_at=EXCLUDED.updated_at
    `, [u.id, u.email, u.name, u.role, u.pass_hash, !!Number(u.active), u.created_at, u.updated_at])
    userCount++
  }

  // pullSince(0) vrne trenutno stanje vseh normaliziranih top-level zapisov, tudi tombstone.
  const pulled = await source.pullSince(0)
  for (const r of pulled.records) {
    const src = await source.getRecord(r.tbl, r.id)
    if (!src) continue
    await target.putRecord(r.tbl, r.id, src.json, src.updatedAt || new Date().toISOString(), src.deleted)
    recordCount++
  }

  // Audit je namensko relacijska tabela. Preberemo vse (ne samo pull limit 2000).
  // SQLite store nima javnega "list all audit" API-ja, zato uporabimo pull po straneh sekvence.
  let cursor = 0
  while (true) {
    const page = await source.pullSince(cursor)
    const events = page.audit || []
    for (const a of events) {
      await target.addAudit({ ...a, entityId: a.entityId ?? a.entity_id ?? '' })
      auditCount++
      cursor = Math.max(cursor, Number(a.server_seq || 0))
    }
    if (events.length < 2000) break
  }

  console.log(`Selitev končana: ${userCount} uporabnikov, ${recordCount} poslovnih zapisov, ${auditCount} revizijskih dogodkov.`)
  console.log('Nova PostgreSQL baza uporablja normalizirane tabele; SQLite datoteka ostane varnostna kopija.')
} catch (e) {
  console.error('Selitev NI uspela:', e?.message ?? e)
  process.exitCode = 1
} finally {
  await pool.end().catch(() => {})
}

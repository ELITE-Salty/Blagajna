// Podatkovna plast — izbira gonilnika:
//   privzeto: SQLite datoteka v DATA_DIR (nič konfiguracije)
//   DATABASE_URL=postgres://... : PostgreSQL v drugem CT/VM/gostitelju
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createSqliteStore } from './store-sqlite.js'
import { createPgStore } from './store-pg.js'

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
mkdirSync(DATA_DIR, { recursive: true })

export const nowIso = () => new Date().toISOString()
export const uuid = () => randomUUID()

/** Ustvari shrambo glede na okolje. */
export async function initStore() {
  if (process.env.PG_MEM === '1') {
    // samo za teste: PostgreSQL gonilnik nad in-memory emulatorjem (pg-mem)
    const { newDb } = await import('pg-mem')
    const mem = newDb()
    const pgm = mem.adapters.createPg()
    const store = await createPgStore(new pgm.Pool())
    console.log('[blagajna] Baza: pg-mem (testni PostgreSQL emulator)')
    return store
  }
  if (process.env.DATABASE_URL) {
    const pg = await import('pg')
    const Pool = pg.default?.Pool ?? pg.Pool

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      ssl: {
        rejectUnauthorized: false,
      },
    })

    const store = await createPgStore(pool)
    console.log('[blagajna] Baza: PostgreSQL (DATABASE_URL)')
    return store
  }
  const store = createSqliteStore(DATA_DIR)
  console.log(`[blagajna] Baza: SQLite datoteka (${DATA_DIR})`)
  return store
}

// ---------- JWT skrivnost ----------
export function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  const f = path.join(DATA_DIR, 'jwt-secret')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const secret = randomBytes(48).toString('hex')
  writeFileSync(f, secret, { mode: 0o600 })
  return secret
}

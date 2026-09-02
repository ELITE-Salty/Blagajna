// Blagajna · Blu Logistics — produkcijski strežnik (2. faza)
// Express + JWT; shramba: SQLite (privzeto) ali PostgreSQL (DATABASE_URL). Streže tudi frontend (dist/).
import express from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, getJwtSecret, initStore, nowIso, uuid } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '8090', 10)
const JWT_SECRET = getJwtSecret()
const store = await initStore()
const app = express()
app.use(express.json({ limit: '25mb' }))

const getSettings = async (s = store) => (await s.getRecord('settings', 'main'))?.json ?? {}

// ---------------- zagon: prvi admin ----------------
async function bootstrapAdmin() {
  if ((await store.userCount()) > 0) return
  const email = process.env.ADMIN_EMAIL
  const pass = process.env.ADMIN_PASSWORD
  if (!email || !pass) {
    console.log('[blagajna] V bazi še ni uporabnikov. Nastavite ADMIN_EMAIL in ADMIN_PASSWORD ter ponovno zaženite strežnik.')
    return
  }
  const at = nowIso()
  await store.insertUser({
    id: uuid(), email: email.toLowerCase(), name: process.env.ADMIN_NAME || 'Admin',
    role: 'ADMIN', pass_hash: bcrypt.hashSync(pass, 10), active: true, created_at: at, updated_at: at,
  })
  console.log(`[blagajna] Ustvarjen prvi administrator: ${email}`)
}
await bootstrapAdmin()

// ---------------- avtentikacija ----------------
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!Number(u.active) })

async function auth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Prijava je potrebna.' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const u = await store.getUserById(payload.uid)
    if (!u || !Number(u.active)) return res.status(401).json({ error: 'Uporabnik ne obstaja ali je deaktiviran.' })
    req.user = publicUser(u)
    next()
  } catch {
    return res.status(401).json({ error: 'Neveljaven ali potekel žeton — prijavite se znova.' })
  }
}

const requireAdmin = (req, res, next) => (req.user.role === 'ADMIN' ? next() : res.status(403).json({ error: 'Potrebna je vloga Admin.' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'blagajna', version: 4, schema: 'normalized-v2', db: store.driver }))

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {}
  const u = await store.getUserByEmail(String(email || '').toLowerCase())
  if (!u || !Number(u.active) || !bcrypt.compareSync(String(password || ''), u.pass_hash)) {
    return res.status(401).json({ error: 'Napačen e-naslov ali geslo.' })
  }
  const token = jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' })
  await store.addAudit({ id: uuid(), at: nowIso(), user: u.name, role: u.role, action: 'Prijava', entity: 'Uporabnik', entityId: u.id, details: '' })
  res.json({ token, user: publicUser(u) })
})

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }))

// ---------------- upravljanje uporabnikov (Admin) ----------------
app.get('/api/users', auth, requireAdmin, async (_req, res) => {
  res.json({ users: (await store.listUsers()).map(publicUser) })
})

app.post('/api/users', auth, requireAdmin, async (req, res) => {
  const { email, name, role, password } = req.body || {}
  if (!email || !name || !password || !['ADMIN', 'RACUNOVODJA', 'FINANCE'].includes(role)) {
    return res.status(400).json({ error: 'Manjkajo podatki (e-naslov, ime, vloga, geslo).' })
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Geslo mora imeti vsaj 8 znakov.' })
  const at = nowIso()
  const id = uuid()
  try {
    await store.insertUser({ id, email: String(email).toLowerCase(), name, role, pass_hash: bcrypt.hashSync(password, 10), active: true, created_at: at, updated_at: at })
    await store.addAudit({ id: uuid(), at, user: req.user.name, role: req.user.role, action: 'Nov uporabnik', entity: 'Uporabnik', entityId: id, details: `${name} (${role})` })
    res.json({ user: publicUser(await store.getUserById(id)) })
  } catch (e) {
    const msg = String(e?.message ?? e)
    res.status(400).json({ error: /UNIQUE|duplicate/i.test(msg) ? 'Uporabnik s tem e-naslovom že obstaja.' : 'Napaka pri shranjevanju.' })
  }
})

app.patch('/api/users/:id', auth, requireAdmin, async (req, res) => {
  const u = await store.getUserById(req.params.id)
  if (!u) return res.status(404).json({ error: 'Uporabnik ne obstaja.' })
  const { name, role, password, active } = req.body || {}
  if (role && !['ADMIN', 'RACUNOVODJA', 'FINANCE'].includes(role)) return res.status(400).json({ error: 'Neveljavna vloga.' })
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Geslo mora imeti vsaj 8 znakov.' })
  await store.updateUser({
    id: u.id,
    name: name ?? u.name,
    role: role ?? u.role,
    active: active === undefined ? !!Number(u.active) : !!active,
    pass_hash: password ? bcrypt.hashSync(password, 10) : u.pass_hash,
    updated_at: nowIso(),
  })
  await store.addAudit({ id: uuid(), at: nowIso(), user: req.user.name, role: req.user.role, action: 'Sprememba uporabnika', entity: 'Uporabnik', entityId: u.id, details: name ?? u.name })
  res.json({ user: publicUser(await store.getUserById(u.id)) })
})

// ---------------- sinhronizacija ----------------
const SYNC_TABLES = ['docs', 'potrdila', 'employees', 'desks', 'settings', 'transfers']
const ADMIN_TABLES = new Set(['employees', 'desks', 'settings'])
const PROTECTED = ['officialNumber', 'seqYear', 'transactionDate', 'transactionTime', 'employeeId', 'deskId', 'amount', 'type', 'monthKey']
const LOCAL_ONLY_SETTINGS = ['currentRole', 'currentUserName', 'activeDeskId']

function sanitizeSettings(json) {
  const c = { ...json }
  for (const k of LOCAL_ONLY_SETTINGS) delete c[k]
  return c
}

app.post('/api/sync/push', auth, async (req, res) => {
  const body = req.body || {}
  const conflicts = []
  const accepted = { docs: [], potrdila: [], employees: [], desks: [], settings: [], transfers: [], deletes: [] }
  try {
    await store.tx(async (s) => {
      for (const tbl of SYNC_TABLES) {
        const rows = Array.isArray(body[tbl]) ? body[tbl] : []
        // zaposlene urejata Admin in Računovodja; blagajne in nastavitve le Admin
        const allowed =
          tbl === 'employees' ? (req.user.role === 'ADMIN' || req.user.role === 'RACUNOVODJA')
          : ADMIN_TABLES.has(tbl) ? req.user.role === 'ADMIN'
          : true
        if (rows.length && !allowed) {
          const reason = tbl === 'settings' ? 'Nastavitve lahko spreminja le Admin.' : tbl === 'desks' ? 'Blagajne lahko ureja le Admin.' : 'Ni pravice za urejanje.'
          for (const r of rows) conflicts.push({ tbl, id: r.id, reason, server: (await s.getRecord(tbl, r.id))?.json ?? null })
          continue
        }
        for (const incoming of rows) {
          if (!incoming || !incoming.id) continue
          const rec = tbl === 'settings' ? sanitizeSettings(incoming) : incoming
          const existing = await s.getRecord(tbl, rec.id)
          if (existing && !existing.deleted && (existing.updatedAt || '') > (rec.updatedAt || '')) {
            conflicts.push({ tbl, id: rec.id, reason: 'Na strežniku obstaja novejša različica.', server: existing.json })
            continue
          }
          if (tbl === 'docs' && existing && !existing.deleted && existing.json.status !== 'ODPRT') {
            const prev = existing.json
            const protectedChanged = PROTECTED.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(rec[k]))
            const statusOk = rec.status === prev.status || (prev.status === 'ZAKLJUCEN' && rec.status === 'STORNIRAN')
            if (protectedChanged || !statusOk) {
              conflicts.push({ tbl, id: rec.id, reason: 'Zaključen dokument je zaklenjen — finančnih podatkov ni mogoče spremeniti.', server: prev })
              continue
            }
          }
          if (tbl === 'docs' && (!existing || existing.deleted) && rec.status === 'ODPRT') {
            const closes = await s.listTable('closes')
            const hit = closes.find((c) => c.monthKey === rec.monthKey && (c.scopeKey === 'COMPANY' || c.scopeKey === rec.deskId))
            if (hit) {
              conflicts.push({ tbl, id: rec.id, reason: `Mesec ${rec.monthKey} je že zaključen.`, server: null })
              continue
            }
          }
          if (tbl === 'transfers') {
            const closes = await s.listTable('closes')
            const hit = closes.find((c) => c.monthKey === rec.monthKey && (c.scopeKey === 'COMPANY' || c.scopeKey === rec.fromDeskId || c.scopeKey === rec.toDeskId))
            if (hit) {
              conflicts.push({ tbl, id: rec.id, reason: `Mesec ${rec.monthKey} je že zaključen za eno od blagajn.`, server: existing?.json ?? null })
              continue
            }
          }
          await s.putRecord(tbl, rec.id, { ...rec, syncStatus: 'SINHRONIZIRANO' }, rec.updatedAt || nowIso())
          accepted[tbl].push(rec.id)
        }
      }

      const deletes = body.deletes || {}
      for (const tbl of SYNC_TABLES) {
        for (const id of deletes[tbl] || []) {
          const existing = await s.getRecord(tbl, id)
          if (!existing || existing.deleted) { accepted.deletes.push(`${tbl}:${id}`); continue }
          if (tbl === 'docs' && existing.json.status !== 'ODPRT') {
            conflicts.push({ tbl, id, reason: 'Zaključenega dokumenta ni mogoče izbrisati — uporabite storno.', server: existing.json })
            continue
          }
          if (tbl === 'transfers') {
            const closes = await s.listTable('closes')
            const rec = existing.json
            const hit = closes.find((c) => c.monthKey === rec.monthKey && (c.scopeKey === 'COMPANY' || c.scopeKey === rec.fromDeskId || c.scopeKey === rec.toDeskId))
            if (hit) {
              conflicts.push({ tbl, id, reason: 'Prenosa iz zaključenega meseca ni mogoče izbrisati.', server: existing.json })
              continue
            }
          }
          if (ADMIN_TABLES.has(tbl) && req.user.role !== 'ADMIN') {
            conflicts.push({ tbl, id, reason: 'Potrebna je vloga Admin.', server: existing.json })
            continue
          }
          await s.putRecord(tbl, id, existing.json, nowIso(), true)
          accepted.deletes.push(`${tbl}:${id}`)
        }
      }

      for (const a of Array.isArray(body.audit) ? body.audit : []) {
        if (a && a.id) await s.addAudit({ ...a, entityId: a.entityId ?? a.entity_id ?? '' })
      }
    })
  } catch (e) {
    console.error('[push]', e)
    return res.status(500).json({ error: 'Napaka pri sinhronizaciji.' })
  }
  res.json({ accepted, conflicts, serverTime: nowIso() })
})

app.get('/api/sync/pull', auth, async (req, res) => {
  const since = parseInt(String(req.query.since || '0'), 10) || 0
  const { records, audit } = await store.pullSince(since)
  const out = { docs: [], potrdila: [], employees: [], desks: [], settings: [], transfers: [], closes: [], deletes: [], audit }
  let cursor = since
  for (const r of records) {
    cursor = Math.max(cursor, Number(r.server_seq))
    if (Number(r.deleted)) { out.deletes.push({ tbl: r.tbl, id: r.id }); continue }
    if (out[r.tbl]) out[r.tbl].push(JSON.parse(r.json))
  }
  for (const a of audit) cursor = Math.max(cursor, Number(a.server_seq))
  res.json({ ...out, cursor, serverTime: nowIso() })
})

// ---------------- zaključek meseca (atomarno, strežniška resnica) ----------------
const txAt = (d) => `${d.transactionDate || '0000-00-00'}T${d.transactionTime || '00:00'}`
const sortChrono = (a, b) => txAt(a).localeCompare(txAt(b)) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id)

function docProblems(d, requirePurpose) {
  const p = []
  if (!d.transactionDate) p.push('manjka datum')
  if (!d.transactionTime) p.push('manjka čas')
  if (!d.employeeId) p.push('manjka zaposleni')
  if (d.amount == null || isNaN(d.amount) || d.amount <= 0) p.push('neveljaven znesek')
  if (!d.deskId) p.push('manjka blagajna')
  if (requirePurpose && !(d.purpose || '').trim()) p.push('manjka namen (Za)')
  return p
}

app.post('/api/close-month', auth, async (req, res) => {
  const { deskId, monthKey } = req.body || {}
  if (!deskId || !/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return res.status(400).json({ error: 'Manjka blagajna ali mesec.' })
  const settings = await getSettings()
  const mayClose = req.user.role === 'ADMIN' || req.user.role === 'RACUNOVODJA' || (req.user.role === 'FINANCE' && settings.financeCanClose)
  if (!mayClose) return res.status(403).json({ error: 'Vloga nima pravice za zaključek meseca.' })

  const scope = settings.numberingScope === 'COMPANY' ? 'COMPANY' : deskId
  const closeId = `${scope}|${monthKey}`
  const year = parseInt(monthKey.slice(0, 4), 10)

  try {
    const result = await store.tx(async (s) => {
      const existing = await s.getRecord('closes', closeId)
      if (existing && !existing.deleted) return { close: existing.json, alreadyClosed: true }

      const allDocs = (await s.listTable('docs')).filter((d) => d.monthKey === monthKey && d.status === 'ODPRT' && (scope === 'COMPANY' || d.deskId === deskId))
      const problems = allDocs.map((d) => ({ id: d.id, problems: docProblems(d, settings.requirePurpose !== false) })).filter((x) => x.problems.length)
      if (problems.length) {
        const err = new Error(`Meseca ni mogoče zaključiti: ${problems.length} dokumentov ima napake.`)
        err.status = 409
        err.problems = problems
        throw err
      }
      const closes = (await s.listTable('closes')).filter((c) => c.scopeKey === scope && c.year === year)
      const lastBp = closes.reduce((m, c) => Math.max(m, c.bpEnd || 0), 0)
      const lastBi = closes.reduce((m, c) => Math.max(m, c.biEnd || 0), 0)
      const bp = allDocs.filter((d) => d.type === 'BP').sort(sortChrono)
      const bi = allDocs.filter((d) => d.type === 'BI').sort(sortChrono)
      const at = nowIso()
      const closedBy = `${req.user.name} (${req.user.role})`
      const manifest = []
      for (const [list, start, type] of [[bp, lastBp, 'BP'], [bi, lastBi, 'BI']]) {
        for (let i = 0; i < list.length; i++) {
          const d = list[i]
          const number = start + i + 1
          await s.putRecord('docs', d.id, {
            ...d, officialNumber: number, seqYear: year, status: 'ZAKLJUCEN',
            finalizedAt: at, finalizedBy: closedBy, updatedAt: at, updatedBy: closedBy, syncStatus: 'SINHRONIZIRANO',
          }, at)
          manifest.push({ docId: d.id, type, number, transactionAt: txAt(d), employeeName: d.employeeName, amount: d.amount ?? 0 })
        }
      }
      const close = {
        id: closeId, scopeKey: scope, deskId: scope === 'COMPANY' ? null : deskId,
        year, month: parseInt(monthKey.slice(5, 7), 10), monthKey,
        bpStart: bp.length ? lastBp + 1 : lastBp, bpEnd: lastBp + bp.length,
        biStart: bi.length ? lastBi + 1 : lastBi, biEnd: lastBi + bi.length,
        docCount: allDocs.length, closedBy, closedAt: at, idempotencyKey: uuid(), manifest,
      }
      await s.putRecord('closes', closeId, close, at)
      await s.addAudit({
        id: uuid(), at, user: req.user.name, role: req.user.role,
        action: 'Zaključek meseca', entity: 'MesecniZakljucek', entityId: closeId,
        details: `${monthKey} · BP ${close.bpStart}–${close.bpEnd}, BI ${close.biStart}–${close.biEnd} (${allDocs.length} dokumentov)`,
      })
      return { close }
    })
    res.json(result)
  } catch (e) {
    if (e && e.status === 409) return res.status(409).json({ error: e.message, problems: e.problems })
    console.error('[close-month]', e)
    res.status(500).json({ error: 'Zaključek ni uspel — nobena številka ni bila dodeljena (atomarno).' })
  }
})

// ---------------- statika (zgrajeni frontend) ----------------
const DIST = process.env.DIST_DIR || path.join(__dirname, '..', 'dist')
// HTML se ne predpomni, da po ponovni gradnji Docker slike brskalnik ne obdrži stare aplikacije.
// Vite asseti imajo hash v imenu in se lahko varno predpomnijo za dalj časa.
app.use(express.static(DIST, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store')
    else if (/[/\\]assets[/\\].+\.[A-Za-z0-9_-]{8,}\./.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    else res.setHeader('Cache-Control', 'no-cache')
  },
}))
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(path.join(DIST, 'index.html'))
})

app.listen(PORT, () => console.log(`[blagajna] Strežnik teče na http://0.0.0.0:${PORT} (podatki: ${store.driver === 'postgres' ? 'PostgreSQL' : DATA_DIR})`))

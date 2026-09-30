// Blagajna · Blu Logistics — produkcijski strežnik (2. faza)
// Express + JWT; shramba: SQLite (privzeto) ali PostgreSQL (DATABASE_URL). Streže tudi frontend (dist/).
import express from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, getJwtSecret, initStore, nowIso, uuid } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '8090', 10)
const JWT_SECRET = getJwtSecret()
const store = await initStore()
const app = express()
app.set('trust proxy', 1)
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

// ---------------- začasne QR povezave za podpisovanje ----------------
const SIGN_ROLES = {
  BP: ['PREJEL_BLAGAJNIK', 'PREIZKUSIL', 'ODOBRIL', 'VPLACAL', 'KONTIRAL', 'VKNJIZIL'],
  BI: ['IZPLACAL_BLAGAJNIK', 'PREIZKUSIL', 'ODOBRIL', 'PREJEL', 'KONTIRAL', 'VKNJIZIL'],
}
const SIGN_ROLE_LABELS = {
  PREJEL_BLAGAJNIK: 'Prejel blagajnik',
  IZPLACAL_BLAGAJNIK: 'Izplačal blagajnik',
  PREIZKUSIL: 'Preizkusil',
  ODOBRIL: 'Odobril',
  VPLACAL: 'Vplačal',
  PREJEL: 'Prejel',
  KONTIRAL: 'Kontiral',
  VKNJIZIL: 'Vknjižil',
}
const signingKey = (token) => createHash('sha256').update(String(token)).digest('hex')
const signingState = (session) => {
  if (session.cancelledAt) return 'CANCELLED'
  if (session.completedAt) return 'COMPLETED'
  if (Date.now() >= new Date(session.expiresAt).getTime()) return 'EXPIRED'
  return 'ACTIVE'
}
const signingStatus = (session) => ({
  id: session.id,
  docId: session.docId,
  status: signingState(session),
  roles: session.roles,
  signedRoles: session.signedRoles || [],
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  completedAt: session.completedAt || null,
  cancelledAt: session.cancelledAt || null,
})
const publicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
  return configured || `${req.protocol}://${req.get('host')}`
}

const tabletTokenKey = (token) => createHash('sha256').update(`tablet:${String(token)}`).digest('hex')
const tabletPairKey = (token) => createHash('sha256').update(`tablet-pair:${String(token)}`).digest('hex')
const tabletPairState = (pairing) => {
  if (pairing.claimedAt) return 'PAIRED'
  if (Date.now() >= new Date(pairing.expiresAt).getTime()) return 'EXPIRED'
  return 'PENDING'
}
const tabletJobState = (job) => job.cancelledAt ? 'CANCELLED' : job.completedAt ? 'COMPLETED' : job.openedAt ? 'OPEN' : 'WAITING'
const tabletPublicDevice = (d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt || null, revokedAt: d.revokedAt || null })
const tabletPublicJob = (j) => ({
  id: j.id, docId: j.docId, tabletId: j.tabletId, roles: j.roles, signedRoles: j.signedRoles || [],
  status: tabletJobState(j), createdAt: j.createdAt, completedAt: j.completedAt || null, cancelledAt: j.cancelledAt || null,
})
const tabletDocLabel = (doc) => doc.officialNumber != null
  ? `${doc.type}-${doc.monthKey || String(doc.seqYear || '').padStart(4, '0')}-${String(doc.officialNumber).padStart(4, '0')}`
  : `${doc.type} · osnutek`

async function tabletAuth(req, res, next) {
  const token = String(req.headers['x-tablet-token'] || '')
  if (!token) return res.status(401).json({ error: 'Tablica ni povezana z Blagajno.' })
  const rec = await store.getRecord('tablet_devices', tabletTokenKey(token))
  if (!rec || rec.deleted || rec.json.revokedAt) return res.status(401).json({ error: 'Povezava tablice ni več veljavna.' })
  req.tablet = rec.json
  req.tabletTokenKey = tabletTokenKey(token)
  next()
}

// ---------------- stalna podpisna tablica ----------------
app.post('/api/tablets/pairing', auth, async (req, res) => {
  const token = randomBytes(24).toString('base64url')
  const id = tabletPairKey(token)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const pairing = { id, createdAt, expiresAt, createdBy: req.user.name, claimedAt: null, deviceId: null }
  await store.putRecord('tablet_pairings', id, pairing, createdAt)
  await store.addAudit({ id: uuid(), at: createdAt, user: req.user.name, role: req.user.role, action: 'Ustvarjeno povezovanje podpisne tablice', entity: 'PodpisnaTablica', entityId: id, details: 'QR velja 10 minut' })
  res.json({ id, url: `${publicBaseUrl(req)}/tablet/pair/${token}`, expiresAt })
})

app.get('/api/tablets/pairing/:id', auth, async (req, res) => {
  const rec = await store.getRecord('tablet_pairings', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Povezovanje tablice ne obstaja.' })
  const pairing = rec.json
  const state = tabletPairState(pairing)
  let device = null
  if (pairing.deviceId) {
    const d = await store.getRecord('tablet_devices', pairing.deviceId)
    if (d && !d.deleted) device = tabletPublicDevice(d.json)
  }
  res.json({ id: pairing.id, status: state, expiresAt: pairing.expiresAt, device })
})

app.get('/api/tablets', auth, async (_req, res) => {
  const tablets = (await store.listTable('tablet_devices')).filter((d) => !d.revokedAt).map(tabletPublicDevice).sort((a, b) => a.name.localeCompare(b.name))
  res.json({ tablets })
})

app.delete('/api/tablets/:id', auth, async (req, res) => {
  const rec = await store.getRecord('tablet_devices', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Tablica ne obstaja.' })
  const at = nowIso()
  const d = { ...rec.json, revokedAt: at }
  await store.putRecord('tablet_devices', d.id, d, at)
  await store.addAudit({ id: uuid(), at, user: req.user.name, role: req.user.role, action: 'Odstranjena podpisna tablica', entity: 'PodpisnaTablica', entityId: d.id, details: d.name })
  res.json({ ok: true })
})

app.post('/api/tablet/pair/:token', async (req, res) => {
  const pairRec = await store.getRecord('tablet_pairings', tabletPairKey(req.params.token))
  if (!pairRec || pairRec.deleted) return res.status(404).json({ error: 'QR za povezovanje ni veljaven.' })
  const pairing = pairRec.json
  const state = tabletPairState(pairing)
  if (state === 'EXPIRED') return res.status(410).json({ error: 'QR za povezovanje je potekel.' })
  if (state === 'PAIRED') return res.status(409).json({ error: 'Ta QR je bil že uporabljen.' })
  const deviceToken = randomBytes(32).toString('base64url')
  const id = tabletTokenKey(deviceToken)
  const at = nowIso()
  const device = { id, name: String(req.body?.name || 'Podpisna tablica').trim().slice(0, 80) || 'Podpisna tablica', pairedAt: at, lastSeenAt: at, revokedAt: null, pairedBy: pairing.createdBy }
  await store.tx(async (s) => {
    const fresh = await s.getRecord('tablet_pairings', pairing.id)
    if (!fresh || fresh.deleted || tabletPairState(fresh.json) !== 'PENDING') { const e = new Error('QR za povezovanje ni več veljaven.'); e.status = 409; throw e }
    await s.putRecord('tablet_devices', id, device, at)
    await s.putRecord('tablet_pairings', pairing.id, { ...fresh.json, claimedAt: at, deviceId: id }, at)
    await s.addAudit({ id: uuid(), at, user: device.name, role: 'TABLICA', action: 'Podpisna tablica povezana', entity: 'PodpisnaTablica', entityId: id, details: `Povezovanje ustvaril ${pairing.createdBy}` })
  })
  res.json({ tabletToken: deviceToken, device: tabletPublicDevice(device) })
})

app.post('/api/tablet-jobs', auth, async (req, res) => {
  const docId = String(req.body?.docId || '')
  const tabletId = String(req.body?.tabletId || '')
  const docRec = await store.getRecord('docs', docId)
  if (!docRec || docRec.deleted) return res.status(404).json({ error: 'Dokument ne obstaja.' })
  const doc = docRec.json
  if (doc.status === 'STORNIRAN' || (doc.status !== 'ODPRT' && doc.status !== 'ZAKLJUCEN')) return res.status(409).json({ error: 'Dokument ni na voljo za podpis.' })
  const tabletRec = await store.getRecord('tablet_devices', tabletId)
  if (!tabletRec || tabletRec.deleted || tabletRec.json.revokedAt) return res.status(404).json({ error: 'Izbrana tablica ni povezana.' })
  const allowed = new Set(SIGN_ROLES[doc.type] || [])
  const existing = new Set((doc.signatures || []).map((x) => x.role))
  const roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles.map(String) : [])].filter((r) => allowed.has(r) && !existing.has(r))
  if (!roles.length) return res.status(400).json({ error: 'Izberite vsaj eno nepodpisano podpisno polje.' })
  const at = nowIso()
  const job = { id: uuid(), docId, tabletId, roles, signedRoles: [], createdAt: at, createdBy: req.user.name, createdByRole: req.user.role, openedAt: null, completedAt: null, cancelledAt: null }
  await store.putRecord('tablet_jobs', job.id, job, at)
  await store.addAudit({ id: uuid(), at, user: req.user.name, role: req.user.role, action: 'Dokument poslan na podpisno tablico', entity: 'BlagajniskiDokument', entityId: docId, details: `${tabletRec.json.name} · ${roles.map((r) => SIGN_ROLE_LABELS[r] || r).join(', ')}` })
  res.json(tabletPublicJob(job))
})

app.get('/api/tablet-jobs/:id', auth, async (req, res) => {
  const rec = await store.getRecord('tablet_jobs', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Zahteva za podpis ne obstaja.' })
  res.json(tabletPublicJob(rec.json))
})

app.delete('/api/tablet-jobs/:id', auth, async (req, res) => {
  const rec = await store.getRecord('tablet_jobs', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Zahteva za podpis ne obstaja.' })
  const job = rec.json
  if (!job.completedAt && !job.cancelledAt) {
    const at = nowIso()
    job.cancelledAt = at
    await store.putRecord('tablet_jobs', job.id, job, at)
    await store.addAudit({ id: uuid(), at, user: req.user.name, role: req.user.role, action: 'Preklican podpis na tablici', entity: 'BlagajniskiDokument', entityId: job.docId, details: '' })
  }
  res.json(tabletPublicJob(job))
})

app.get('/api/tablet/inbox', tabletAuth, async (req, res) => {
  const at = nowIso()
  const device = { ...req.tablet, lastSeenAt: at }
  await store.putRecord('tablet_devices', device.id, device, at)
  const all = await store.listTable('tablet_jobs')
  const active = all.filter((j) => j.tabletId === device.id && !j.cancelledAt && !j.completedAt)
  const jobs = []
  for (const j of active) {
    const docRec = await store.getRecord('docs', j.docId)
    if (!docRec || docRec.deleted || docRec.json.status === 'STORNIRAN') continue
    const d = docRec.json
    jobs.push({ id: j.id, docId: j.docId, type: d.type, documentLabel: tabletDocLabel(d), employeeName: d.employeeName || '', amount: d.amount ?? null, roles: j.roles, signedRoles: j.signedRoles || [], status: tabletJobState(j), createdAt: j.createdAt })
  }
  jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ device: tabletPublicDevice(device), jobs })
})

app.get('/api/tablet/jobs/:id', tabletAuth, async (req, res) => {
  const rec = await store.getRecord('tablet_jobs', req.params.id)
  if (!rec || rec.deleted || rec.json.tabletId !== req.tablet.id) return res.status(404).json({ error: 'Dokument ni v čakalni vrsti te tablice.' })
  const job = rec.json
  if (job.cancelledAt) return res.status(410).json({ error: 'Zahteva za podpis je bila preklicana.' })
  if (job.completedAt) return res.status(410).json({ error: 'Podpisovanje je že zaključeno.' })
  const docRec = await store.getRecord('docs', job.docId)
  if (!docRec || docRec.deleted) return res.status(404).json({ error: 'Dokument ne obstaja več.' })
  const doc = docRec.json
  if (doc.status === 'STORNIRAN') return res.status(410).json({ error: 'Dokument je bil storniran.' })
  const at = nowIso()
  if (!job.openedAt) { job.openedAt = at; await store.putRecord('tablet_jobs', job.id, job, at) }
  const desk = (await store.getRecord('desks', doc.deskId))?.json ?? null
  const settings = await getSettings()
  const signedRoles = [...new Set([...(job.signedRoles || []), ...(doc.signatures || []).filter((s) => job.roles.includes(s.role)).map((s) => s.role)])]
  const publicDoc = { ...doc, employeeId: '', attachments: (doc.attachments || []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, dataUrl: '', addedAt: a.addedAt })) }
  res.setHeader('Cache-Control', 'no-store')
  res.json({ job: tabletPublicJob(job), requestedRoles: job.roles, signedRoles, doc: publicDoc, desk, settings })
})

app.post('/api/tablet/jobs/:id/signature', tabletAuth, async (req, res) => {
  const { role, signerName, dataUrl } = req.body || {}
  if (!String(signerName || '').trim()) return res.status(400).json({ error: 'Vnesite ime in priimek podpisnika.' })
  if (!String(dataUrl || '').startsWith('data:image/png;base64,') || String(dataUrl).length > 1_500_000) return res.status(400).json({ error: 'Podpis ni v veljavnem formatu ali je prevelik.' })
  try {
    const result = await store.tx(async (s) => {
      const rec = await s.getRecord('tablet_jobs', req.params.id)
      if (!rec || rec.deleted || rec.json.tabletId !== req.tablet.id) { const e = new Error('Zahteva za podpis ne obstaja.'); e.status = 404; throw e }
      const job = rec.json
      if (job.cancelledAt) { const e = new Error('Zahteva za podpis je bila preklicana.'); e.status = 410; throw e }
      if (job.completedAt) { const e = new Error('Podpisovanje je že zaključeno.'); e.status = 409; throw e }
      if (!job.roles.includes(role)) { const e = new Error('To podpisno polje ni zahtevano.'); e.status = 403; throw e }
      const docRec = await s.getRecord('docs', job.docId)
      if (!docRec || docRec.deleted) { const e = new Error('Dokument ne obstaja.'); e.status = 404; throw e }
      const doc = docRec.json
      if (doc.status !== 'ODPRT' && doc.status !== 'ZAKLJUCEN') { const e = new Error('Dokument ni več na voljo za podpis.'); e.status = 409; throw e }
      const already = (doc.signatures || []).find((x) => x.role === role)
      if (already) {
        if ((job.signedRoles || []).includes(role)) return { job, signature: already }
        const e = new Error('To polje je medtem že podpisano.'); e.status = 409; throw e
      }
      const signedAt = nowIso()
      const sig = { role, signerName: String(signerName).trim(), type: 'DIGITALNO', dataUrl, signedAt, capturedBy: `Podpisna tablica · ${req.tablet.name}` }
      const updatedDoc = { ...doc, signatures: [...(doc.signatures || []), sig], ...(role === 'PREJEL' ? { prejelStatus: 'DIGITALNO' } : {}), updatedAt: signedAt, updatedBy: `${sig.signerName} (tablica)`, syncStatus: 'SINHRONIZIRANO' }
      await s.putRecord('docs', doc.id, updatedDoc, signedAt)
      job.signedRoles = [...new Set([...(job.signedRoles || []), role])]
      if (job.roles.every((r) => job.signedRoles.includes(r))) job.completedAt = signedAt
      await s.putRecord('tablet_jobs', job.id, job, signedAt)
      await s.addAudit({ id: uuid(), at: signedAt, user: `${sig.signerName} (tablica)`, role: job.createdByRole, action: 'Podpis na povezani tablici', entity: 'BlagajniskiDokument', entityId: doc.id, details: `${SIGN_ROLE_LABELS[role] || role} · ${req.tablet.name}` })
      return { job, signature: sig }
    })
    res.json({ ok: true, status: result.job.completedAt ? 'COMPLETED' : 'OPEN', signedRoles: result.job.signedRoles || [], signature: result.signature })
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message })
    console.error('[tablet-signature]', e)
    res.status(500).json({ error: 'Podpisa ni bilo mogoče shraniti.' })
  }
})

app.post('/api/signing-sessions', auth, async (req, res) => {
  const { docId } = req.body || {}
  const minutesRaw = Number(req.body?.expiresInMinutes ?? 30)
  const expiresInMinutes = Math.max(5, Math.min(120, Number.isFinite(minutesRaw) ? minutesRaw : 30))
  const docRec = await store.getRecord('docs', String(docId || ''))
  if (!docRec || docRec.deleted) return res.status(404).json({ error: 'Dokument ne obstaja.' })
  const doc = docRec.json
  if (doc.status === 'STORNIRAN') return res.status(409).json({ error: 'Storniranega dokumenta ni mogoče poslati v podpis.' })
  if (doc.status !== 'ODPRT' && doc.status !== 'ZAKLJUCEN') {
    return res.status(409).json({ error: 'Dokument ni na voljo za QR podpis.' })
  }
  const allowed = new Set(SIGN_ROLES[doc.type] || [])
  const existing = new Set((doc.signatures || []).map((x) => x.role))
  const roles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles.map(String) : [])]
    .filter((r) => allowed.has(r) && !existing.has(r))
  if (!roles.length) return res.status(400).json({ error: 'Izberite vsaj eno nepodpisano podpisno polje.' })

  const token = randomBytes(24).toString('base64url')
  const id = signingKey(token)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
  const session = {
    id, docId: doc.id, roles, signedRoles: [], createdAt, expiresAt,
    createdBy: req.user.name, createdByRole: req.user.role,
    completedAt: null, cancelledAt: null,
  }
  await store.putRecord('signing_sessions', id, session, createdAt)
  await store.addAudit({
    id: uuid(), at: createdAt, user: req.user.name, role: req.user.role,
    action: 'Ustvarjena QR povezava za podpis', entity: 'BlagajniskiDokument', entityId: doc.id,
    details: `${roles.map((r) => SIGN_ROLE_LABELS[r] || r).join(', ')} · velja ${expiresInMinutes} min`,
  })
  res.json({ id, url: `${publicBaseUrl(req)}/sign/${token}`, expiresAt, roles })
})

app.get('/api/signing-sessions/:id', auth, async (req, res) => {
  const rec = await store.getRecord('signing_sessions', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Podpisna povezava ne obstaja.' })
  res.json(signingStatus(rec.json))
})

app.delete('/api/signing-sessions/:id', auth, async (req, res) => {
  const rec = await store.getRecord('signing_sessions', req.params.id)
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Podpisna povezava ne obstaja.' })
  const session = rec.json
  if (!session.cancelledAt && !session.completedAt) {
    session.cancelledAt = nowIso()
    await store.putRecord('signing_sessions', session.id, session, session.cancelledAt)
    await store.addAudit({
      id: uuid(), at: session.cancelledAt, user: req.user.name, role: req.user.role,
      action: 'Preklicana QR povezava za podpis', entity: 'BlagajniskiDokument', entityId: session.docId, details: '',
    })
  }
  res.json(signingStatus(session))
})

app.get('/api/sign/:token', async (req, res) => {
  const rec = await store.getRecord('signing_sessions', signingKey(req.params.token))
  if (!rec || rec.deleted) return res.status(404).json({ error: 'Povezava za podpis ni veljavna.' })
  const session = rec.json
  const state = signingState(session)
  if (state === 'CANCELLED') return res.status(410).json({ error: 'Povezava za podpis je bila preklicana.' })
  if (state === 'EXPIRED') return res.status(410).json({ error: 'Povezava za podpis je potekla.' })
  if (state === 'COMPLETED') return res.status(410).json({ error: 'Podpisovanje je že zaključeno. Povezava ni več aktivna.' })
  const docRec = await store.getRecord('docs', session.docId)
  if (!docRec || docRec.deleted) return res.status(404).json({ error: 'Dokument ne obstaja več.' })
  const doc = docRec.json
  if (doc.status === 'STORNIRAN') return res.status(410).json({ error: 'Dokument je bil storniran in ni več na voljo za podpis.' })
  if (doc.status !== 'ODPRT' && doc.status !== 'ZAKLJUCEN') return res.status(409).json({ error: 'Dokument ni več na voljo za podpis.' })
  const desk = (await store.getRecord('desks', doc.deskId))?.json ?? null
  const settings = await getSettings()
  const signedRoles = [...new Set([...(session.signedRoles || []), ...(doc.signatures || []).filter((s) => session.roles.includes(s.role)).map((s) => s.role)])]
  // Priponke na javni strani pokažemo le po imenih; vsebina skenov ni potrebna za podpis.
  const publicDoc = {
    ...doc,
    employeeId: '',
    attachments: (doc.attachments || []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, dataUrl: '', addedAt: a.addedAt })),
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json({ status: 'ACTIVE', expiresAt: session.expiresAt, requestedRoles: session.roles, signedRoles, doc: publicDoc, desk, settings })
})

app.post('/api/sign/:token/signature', async (req, res) => {
  const key = signingKey(req.params.token)
  const { role, signerName, dataUrl } = req.body || {}
  if (!String(signerName || '').trim()) return res.status(400).json({ error: 'Vnesite ime in priimek podpisnika.' })
  if (!String(dataUrl || '').startsWith('data:image/png;base64,') || String(dataUrl).length > 1_500_000) {
    return res.status(400).json({ error: 'Podpis ni v veljavnem formatu ali je prevelik.' })
  }
  try {
    const result = await store.tx(async (s) => {
      const rec = await s.getRecord('signing_sessions', key)
      if (!rec || rec.deleted) { const e = new Error('Povezava za podpis ni veljavna.'); e.status = 404; throw e }
      const session = rec.json
      const state = signingState(session)
      if (state === 'CANCELLED') { const e = new Error('Povezava za podpis je bila preklicana.'); e.status = 410; throw e }
      if (state === 'EXPIRED') { const e = new Error('Povezava za podpis je potekla.'); e.status = 410; throw e }
      if (state === 'COMPLETED') { const e = new Error('Podpisovanje tega dokumenta je že zaključeno.'); e.status = 409; throw e }
      if (!session.roles.includes(role)) { const e = new Error('To podpisno polje ni vključeno v povezavo.'); e.status = 403; throw e }

      const docRec = await s.getRecord('docs', session.docId)
      if (!docRec || docRec.deleted) { const e = new Error('Dokument ne obstaja.'); e.status = 404; throw e }
      const doc = docRec.json
      if (doc.status !== 'ODPRT' && doc.status !== 'ZAKLJUCEN') { const e = new Error('Dokument ni več na voljo za podpis.'); e.status = 409; throw e }
      const already = (doc.signatures || []).find((x) => x.role === role)
      if (already) {
        if ((session.signedRoles || []).includes(role)) return { session, already: true, signature: already }
        const e = new Error('To polje je medtem že podpisano.'); e.status = 409; throw e
      }

      const signedAt = nowIso()
      const sig = {
        role, signerName: String(signerName).trim(), type: 'DIGITALNO', dataUrl,
        signedAt, capturedBy: `QR povezava · ${session.createdBy}`,
      }
      const signatures = [...(doc.signatures || []), sig]
      const updatedDoc = {
        ...doc, signatures,
        ...(role === 'PREJEL' ? { prejelStatus: 'DIGITALNO' } : {}),
        updatedAt: signedAt, updatedBy: `${sig.signerName} (QR)`, syncStatus: 'SINHRONIZIRANO',
      }
      await s.putRecord('docs', doc.id, updatedDoc, signedAt)

      session.signedRoles = [...new Set([...(session.signedRoles || []), role])]
      if (session.roles.every((r) => session.signedRoles.includes(r))) session.completedAt = signedAt
      await s.putRecord('signing_sessions', session.id, session, signedAt)
      await s.addAudit({
        id: uuid(), at: signedAt, user: `${sig.signerName} (QR)`, role: session.createdByRole,
        action: 'Podpis preko QR povezave', entity: 'BlagajniskiDokument', entityId: doc.id,
        details: `${SIGN_ROLE_LABELS[role] || role} · povezavo ustvaril ${session.createdBy}`,
      })
      return { session, already: false, signature: sig }
    })
    const status = signingState(result.session)
    res.json({ ok: true, status: status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE', signedRoles: result.session.signedRoles || [], signature: result.signature })
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message })
    console.error('[qr-signature]', e)
    res.status(500).json({ error: 'Podpisa ni bilo mogoče shraniti.' })
  }
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
      // Mesečno številčenje: BP in BI se vsak mesec začneta pri 1.
      const lastBp = 0
      const lastBi = 0
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

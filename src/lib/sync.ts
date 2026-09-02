// Samodejna sinhronizacija: lokalna baza (Dexie) ⇄ strežnik.
// V DEMO načinu se sinhronizacija simulira (zapisi se označijo kot sinhronizirani).
import type { BlagajnaDB } from '../db'
import type { AppMode } from './api'
import { apiPull, apiPush, getToken } from './api'
import { nowIso, uuid } from './util'

export interface SyncState {
  online: boolean
  syncing: boolean
  pending: number
  lastSync: string | null
  error: string | null
}

const LOCAL_ONLY_SETTINGS = ['currentRole', 'currentUserName', 'activeDeskId'] as const

let db: BlagajnaDB | null = null
let mode: AppMode = 'demo'
let state: SyncState = { online: typeof navigator === 'undefined' ? true : navigator.onLine, syncing: false, pending: 0, lastSync: null, error: null }
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let lastPullAt = 0
let running = false

function emit() {
  for (const cb of subs) cb()
}
export const getSyncState = () => state
export function subscribeSync(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}
function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  emit()
}

export async function countPending(): Promise<number> {
  if (!db) return 0
  const d = await db.docs.where('syncStatus').equals('LOKALNO').count()
  const p = await db.potrdila.filter((x) => x.syncStatus === 'LOKALNO').count()
  const o = await db.outbox.filter((r) => r.tbl !== 'audit').count()
  return d + p + o
}

async function isAutoSync(): Promise<boolean> {
  if (!db) return true
  const s = await db.settings.get('main')
  return s?.autoSync !== false
}

/** Simulirana sinhronizacija v DEMO načinu. */
async function demoSync() {
  if (!db) return
  set({ syncing: true, error: null })
  await new Promise((r) => setTimeout(r, 700))
  await db.docs.where('syncStatus').equals('LOKALNO').modify({ syncStatus: 'SINHRONIZIRANO' })
  await db.potrdila.filter((x) => x.syncStatus === 'LOKALNO').modify({ syncStatus: 'SINHRONIZIRANO' })
  await db.transfers.where('syncStatus').equals('LOKALNO').modify({ syncStatus: 'SINHRONIZIRANO' })
  await db.outbox.filter((r) => r.tbl !== 'audit').delete()
  set({ syncing: false, lastSync: nowIso(), pending: await countPending() })
}

async function serverSync(force = false) {
  if (!db || !getToken()) return
  set({ syncing: true, error: null })
  try {
    // ---- PUSH ----
    const docs = await db.docs.where('syncStatus').equals('LOKALNO').toArray()
    const pots = await db.potrdila.filter((x) => x.syncStatus === 'LOKALNO').toArray()
    const ob = await db.outbox.toArray()
    const pick = async (tbl: 'employees' | 'desks' | 'settings' | 'transfers') => {
      const ids = [...new Set(ob.filter((r) => r.tbl === tbl && !r.del).map((r) => r.id))]
      const rows = await Promise.all(ids.map((id) => (db as any)[tbl].get(id)))
      return rows.filter(Boolean).map((r: any) => (tbl === 'settings' ? stripLocalOnly(r) : r))
    }
    const auditIds = [...new Set(ob.filter((r) => r.tbl === 'audit').map((r) => r.id))]
    const auditRows = (await Promise.all(auditIds.map((id) => db!.audit.get(id)))).filter(Boolean)
    const deletes: Record<string, string[]> = {}
    for (const r of ob.filter((x) => x.del)) {
      deletes[r.tbl] = deletes[r.tbl] || []
      deletes[r.tbl].push(r.id)
    }
    const payload = {
      docs, potrdila: pots,
      employees: await pick('employees'),
      desks: await pick('desks'),
      settings: await pick('settings'),
      transfers: await pick('transfers'),
      deletes,
      audit: auditRows,
    }
    const hasWork = docs.length || pots.length || payload.employees.length || payload.desks.length || payload.settings.length || payload.transfers.length || Object.keys(deletes).length || auditRows.length
    if (hasWork) {
      const res = await apiPush(payload)
      // sprejeto → označi sinhronizirano
      if (res.accepted) {
        if (res.accepted.docs?.length) await db.docs.where('id').anyOf(res.accepted.docs).modify({ syncStatus: 'SINHRONIZIRANO' })
        if (res.accepted.potrdila?.length) await db.potrdila.where('id').anyOf(res.accepted.potrdila).modify({ syncStatus: 'SINHRONIZIRANO' })
        if (res.accepted.transfers?.length) await db.transfers.where('id').anyOf(res.accepted.transfers).modify({ syncStatus: 'SINHRONIZIRANO' })
      }
      await db.outbox.bulkDelete(ob.map((r) => r.k!))
      // konflikti → strežnik zmaga; lokalno zabeleži revizijski dogodek
      for (const c of res.conflicts || []) {
        if (c.server) {
          if (c.tbl === 'docs') await db.docs.put(c.server)
          else if (c.tbl === 'potrdila') await db.potrdila.put(c.server)
          else if (c.tbl === 'employees') await db.employees.put(c.server)
          else if (c.tbl === 'desks') await db.desks.put(c.server)
          else if (c.tbl === 'transfers') await db.transfers.put(c.server)
          else if (c.tbl === 'settings') await mergeSettings(c.server)
        }
        await db.audit.put({
          id: uuid(), at: nowIso(), user: 'Sinhronizacija', role: 'ADMIN',
          action: 'Konflikt sinhronizacije', entity: c.tbl, entityId: c.id, details: c.reason,
        })
      }
      if ((res.conflicts || []).length) set({ error: `Sinhronizacija: ${res.conflicts.length} zapisov zavrnjenih (strežnik ima prednost).` })
    }

    // ---- PULL ----
    const now = Date.now()
    if (force || hasWork || now - lastPullAt > 20000) {
      lastPullAt = now
      const kv = await db.kv.get('sync-cursor')
      const since = kv ? parseInt(kv.v, 10) || 0 : 0
      const pulled = await apiPull(since)
      const pendingIds = new Set([
        ...(await db.docs.where('syncStatus').equals('LOKALNO').toArray()).map((d) => `docs:${d.id}`),
        ...(await db.potrdila.filter((x) => x.syncStatus === 'LOKALNO').toArray()).map((p) => `potrdila:${p.id}`),
        ...(await db.outbox.toArray()).map((r) => `${r.tbl}:${r.id}`),
      ])
      const apply = async (tbl: string, rows: any[]) => {
        for (const row of rows || []) {
          const key = `${tbl}:${row.id}`
          const isFinalDoc = tbl === 'docs' && row.status !== 'ODPRT'
          if (pendingIds.has(key) && !isFinalDoc) continue // lokalna sprememba čaka na push
          if (tbl === 'settings') await mergeSettings(row)
          else await (db as any)[tbl].put(row)
        }
      }
      await apply('docs', pulled.docs)
      await apply('potrdila', pulled.potrdila)
      await apply('employees', pulled.employees)
      await apply('desks', pulled.desks)
      await apply('transfers', pulled.transfers)
      await apply('settings', pulled.settings)
      for (const c of pulled.closes || []) await db.closes.put(c)
      if (pulled.audit?.length) await db.audit.bulkPut(pulled.audit.map((a: any) => ({ id: a.id, at: a.at, user: a.user, role: a.role, action: a.action, entity: a.entity, entityId: a.entityId, details: a.details || '' })))
      for (const del of pulled.deletes || []) {
        if (pendingIds.has(`${del.tbl}:${del.id}`)) continue
        await (db as any)[del.tbl]?.delete(del.id)
      }
      await db.kv.put({ k: 'sync-cursor', v: String(pulled.cursor ?? since) })
    }
    set({ syncing: false, lastSync: nowIso(), pending: await countPending(), error: state.error })
  } catch (e: any) {
    set({ syncing: false, error: String(e?.message ?? e), pending: await countPending() })
  }
}

function stripLocalOnly(s: any) {
  const c = { ...s }
  for (const k of LOCAL_ONLY_SETTINGS) delete c[k]
  return c
}
async function mergeSettings(server: any) {
  if (!db) return
  const local = await db.settings.get('main')
  await db.settings.put({
    ...server,
    id: 'main',
    currentRole: local?.currentRole ?? server.currentRole ?? 'FINANCE',
    currentUserName: local?.currentUserName ?? '',
    activeDeskId: local?.activeDeskId ?? server.activeDeskId ?? '',
  })
}

/** Ročna / takojšnja sinhronizacija. */
export async function syncNow(force = true): Promise<void> {
  if (!db || running) return
  running = true
  try {
    if (mode === 'server') await serverSync(force)
    else await demoSync()
  } finally {
    running = false
  }
}

/**
 * Ročna osvežitev podatkov. V strežniškem načinu namenoma ponastavi lokalni
 * pull-cursor in ponovno prebere trenutno stanje strežnika. To popravi tudi
 * primer, ko je bila strežniška baza obnovljena/uvezena in ima nižje sekvence
 * od cursorja, shranjenega v brskalniku. Lokalni nesinhronizirani zapisi se
 * pred pullom še vedno najprej pošljejo skozi običajni serverSync.
 */
export async function refreshData(): Promise<void> {
  if (!db || running) return
  if (mode === 'server') {
    await db.kv.delete('sync-cursor')
    lastPullAt = 0
  }
  await syncNow(true)
}

export function startSyncEngine(theDb: BlagajnaDB, theMode: AppMode) {
  db = theDb
  mode = theMode
  const onOnline = () => { set({ online: true }); void tick(true) }
  const onOffline = () => set({ online: false })
  const onFocus = () => void tick(true)
  const onVisibility = () => { if (document.visibilityState === 'visible') void tick(true) }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)

  async function tick(force = false) {
    if (!db) return
    const pending = await countPending()
    if (pending !== state.pending) set({ pending })
    if (!state.online || running) return
    const auto = await isAutoSync()
    if (mode === 'server' && !getToken()) return
    if (force || (auto && (pending > 0 || Date.now() - lastPullAt > 25000))) {
      await syncNow(force)
    }
  }
  void tick(true)
  timer = setInterval(() => void tick(false), 4000)
  return () => {
    if (timer) clearInterval(timer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

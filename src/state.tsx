import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BlagajnaDB, ensureSettings, initDb } from './db'
import type { Role, Settings } from './types'
import { nowIso, uuid } from './lib/util'
import {
  AppMode, AppUser, apiLogin, apiMe, detectServer, getToken, onAuthExpired, setToken,
} from './lib/api'
import { countPending, getSyncState, refreshData, startSyncEngine, subscribeSync, syncNow, type SyncState } from './lib/sync'
import { Login } from './views/Login'
import { putAudit, saveSettingsPatch } from './lib/persist'

export interface AppCtx {
  db: BlagajnaDB
  ephemeral: boolean
  mode: AppMode
  user: AppUser | null
  settings: Settings
  role: Role
  userLabel: string
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  audit: (action: string, entity: string, entityId: string, details?: string) => Promise<void>
  syncNow: () => Promise<void>
  refreshData: () => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AppCtx | null>(null)
export const useApp = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('AppCtx missing')
  return v
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState)
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen grid place-items-center text-slate-500 text-sm">{children}</div>
)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [boot, setBoot] = useState<{ db: BlagajnaDB; ephemeral: boolean; mode: AppMode } | null>(null)
  const [err, setErr] = useState('')
  const [user, setUser] = useState<AppUser | null | 'loading'>('loading')

  useEffect(() => {
    ;(async () => {
      try {
        const mode = await detectServer()
        const b = await initDb(mode === 'demo')
        if (mode === 'server') {
          await ensureSettings(b.db)
          if (getToken()) {
            try {
              const me = await apiMe()
              setUser(me.user)
            } catch {
              setUser(null)
            }
          } else setUser(null)
        } else {
          setUser(null)
        }
        setBoot({ ...b, mode })
      } catch (e) {
        setErr(String(e))
      }
    })()
  }, [])

  useEffect(() => {
    onAuthExpired(() => setUser(null))
  }, [])

  // zaženi sinhronizacijo: demo takoj, strežnik po prijavi
  useEffect(() => {
    if (!boot) return
    if (boot.mode === 'server' && (!user || user === 'loading')) return
    const stop = startSyncEngine(boot.db, boot.mode)
    return stop
  }, [boot, user && user !== 'loading' ? (user as AppUser).id : user])

  if (err)
    return (
      <div className="min-h-screen grid place-items-center p-8 text-center">
        <div>
          <div className="text-lg font-semibold text-red-700">Napaka pri zagonu</div>
          <div className="mt-2 text-sm text-slate-600">{err}</div>
        </div>
      </div>
    )
  if (!boot || (boot.mode === 'server' && user === 'loading')) return <Center>Nalaganje aplikacije …</Center>

  if (boot.mode === 'server' && !user) {
    return (
      <Login
        onLogin={async (email, pass) => {
          const res = await apiLogin(email, pass)
          setToken(res.token)
          setUser(res.user)
        }}
      />
    )
  }

  return (
    <Inner boot={boot} user={user === 'loading' ? null : user} onLogout={() => setUser(null)}>
      {children}
    </Inner>
  )
}

function Inner({
  boot, user, onLogout, children,
}: {
  boot: { db: BlagajnaDB; ephemeral: boolean; mode: AppMode }
  user: AppUser | null
  onLogout: () => void
  children: React.ReactNode
}) {
  const settings = useLiveQuery(() => boot.db.settings.get('main'), [])
  if (!settings) return <Center>Priprava podatkov …</Center>

  const isServer = boot.mode === 'server'
  const role: Role = isServer && user ? user.role : settings.currentRole
  const userLabel = isServer && user ? user.name : settings.currentUserName || 'Uporabnik'

  const api: AppCtx = {
    db: boot.db,
    ephemeral: boot.ephemeral,
    mode: boot.mode,
    user,
    settings,
    role,
    userLabel,
    async saveSettings(patch) {
      await saveSettingsPatch(boot.db, patch)
    },
    async audit(action, entity, entityId, details = '') {
      const id = uuid()
      await putAudit(boot.db, { id, at: nowIso(), user: userLabel, role, action, entity, entityId, details })
    },
    syncNow: () => syncNow(true),
    refreshData: () => refreshData(),
    async logout() {
      const pending = await countPending()
      if (pending > 0) {
        const ok = window.confirm(`Pozor: ${pending} zapisov še ni sinhroniziranih s strežnikom. Ob odjavi ostanejo samo na tej napravi, dokler se znova ne prijavite in sinhronizirate.\n\nRes želite odjavo?`)
        if (!ok) return
      }
      setToken(null)
      onLogout()
    },
  }
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

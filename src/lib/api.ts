// Strežniški način: zaznavanje, žeton, API klici. Če strežnika ni, aplikacija teče v DEMO načinu.
import type { Role } from '../types'

export interface AppUser {
  id: string
  email: string
  name: string
  role: Role
  active: boolean
}

export type AppMode = 'demo' | 'server'

const TOKEN_KEY = 'blagajna-token'
let memToken: string | null = null

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken
  } catch {
    return memToken
  }
}
export function setToken(t: string | null) {
  memToken = t
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* peskovnik brez shrambe */ }
}

let authExpiredCb: (() => void) | null = null
export const onAuthExpired = (cb: () => void) => { authExpiredCb = cb }

export async function detectServer(): Promise<AppMode> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const r = await fetch('/api/health', { signal: ctrl.signal })
    clearTimeout(t)
    if (r.ok) {
      const j = await r.json().catch(() => null)
      if (j && j.name === 'blagajna') return 'server'
    }
  } catch { /* ni strežnika */ }
  return 'demo'
}

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as any) }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(path, { ...opts, headers })
  if (r.status === 401) {
    setToken(null)
    authExpiredCb?.()
    throw new Error('Prijava je potekla — prijavite se znova.')
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `Napaka strežnika (${r.status})`)
  return j
}

export const apiLogin = (email: string, password: string) =>
  apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }) as Promise<{ token: string; user: AppUser }>
export const apiMe = () => apiFetch('/api/auth/me') as Promise<{ user: AppUser }>
export const apiPush = (payload: any) => apiFetch('/api/sync/push', { method: 'POST', body: JSON.stringify(payload) })
export const apiPull = (since: number) => apiFetch(`/api/sync/pull?since=${since}`)
export const apiCloseMonth = (deskId: string, monthKey: string) =>
  apiFetch('/api/close-month', { method: 'POST', body: JSON.stringify({ deskId, monthKey }) })
export const apiUsers = () => apiFetch('/api/users') as Promise<{ users: AppUser[] }>
export const apiCreateUser = (u: { email: string; name: string; role: Role; password: string }) =>
  apiFetch('/api/users', { method: 'POST', body: JSON.stringify(u) })
export const apiUpdateUser = (id: string, patch: Partial<{ name: string; role: Role; password: string; active: boolean }>) =>
  apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

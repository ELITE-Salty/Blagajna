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

export interface SigningSessionCreated {
  id: string
  url: string
  expiresAt: string
  roles: string[]
}

export interface SigningSessionStatus {
  id: string
  docId: string
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED'
  roles: string[]
  signedRoles: string[]
  createdAt: string
  expiresAt: string
  completedAt?: string | null
  cancelledAt?: string | null
}

export interface PublicSigningPayload {
  status: 'ACTIVE' | 'COMPLETED'
  expiresAt: string
  requestedRoles: string[]
  signedRoles: string[]
  doc: any
  desk: any
  settings: any
}

export const apiCreateSigningSession = (docId: string, roles: string[], expiresInMinutes = 30) =>
  apiFetch('/api/signing-sessions', { method: 'POST', body: JSON.stringify({ docId, roles, expiresInMinutes }) }) as Promise<SigningSessionCreated>

export const apiSigningSessionStatus = (id: string) =>
  apiFetch(`/api/signing-sessions/${encodeURIComponent(id)}`) as Promise<SigningSessionStatus>

export const apiCancelSigningSession = (id: string) =>
  apiFetch(`/api/signing-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }) as Promise<SigningSessionStatus>

async function publicApiFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as any) }
  const r = await fetch(path, { ...opts, headers })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `Napaka strežnika (${r.status})`)
  return j
}

export const apiPublicSigning = (token: string) =>
  publicApiFetch(`/api/sign/${encodeURIComponent(token)}`) as Promise<PublicSigningPayload>

export const apiSubmitPublicSignature = (token: string, role: string, signerName: string, dataUrl: string) =>
  publicApiFetch(`/api/sign/${encodeURIComponent(token)}/signature`, {
    method: 'POST', body: JSON.stringify({ role, signerName, dataUrl }),
  }) as Promise<{ ok: true; status: 'ACTIVE' | 'COMPLETED'; signedRoles: string[]; signature: any }>

export interface PairedTablet {
  id: string
  name: string
  pairedAt: string
  lastSeenAt?: string | null
  revokedAt?: string | null
}

export interface TabletPairingCreated {
  id: string
  url: string
  expiresAt: string
}

export interface TabletPairingStatus {
  id: string
  status: 'PENDING' | 'PAIRED' | 'EXPIRED'
  expiresAt: string
  device?: PairedTablet | null
}

export interface TabletJobCreated {
  id: string
  docId: string
  tabletId: string
  roles: string[]
  signedRoles: string[]
  status: 'WAITING' | 'OPEN' | 'COMPLETED' | 'CANCELLED'
  createdAt: string
  completedAt?: string | null
  cancelledAt?: string | null
}

export interface TabletInboxItem {
  id: string
  docId: string
  type: 'BP' | 'BI'
  documentLabel: string
  employeeName: string
  amount: number | null
  roles: string[]
  signedRoles: string[]
  status: 'WAITING' | 'OPEN'
  createdAt: string
}

export interface TabletJobPayload {
  job: TabletJobCreated
  requestedRoles: string[]
  signedRoles: string[]
  doc: any
  desk: any
  settings: any
}

export const apiCreateTabletPairing = () =>
  apiFetch('/api/tablets/pairing', { method: 'POST' }) as Promise<TabletPairingCreated>

export const apiTabletPairingStatus = (id: string) =>
  apiFetch(`/api/tablets/pairing/${encodeURIComponent(id)}`) as Promise<TabletPairingStatus>

export const apiTablets = () =>
  apiFetch('/api/tablets') as Promise<{ tablets: PairedTablet[] }>

export const apiRevokeTablet = (id: string) =>
  apiFetch(`/api/tablets/${encodeURIComponent(id)}`, { method: 'DELETE' }) as Promise<{ ok: true }>

export const apiCreateTabletJob = (docId: string, roles: string[], tabletId: string) =>
  apiFetch('/api/tablet-jobs', { method: 'POST', body: JSON.stringify({ docId, roles, tabletId }) }) as Promise<TabletJobCreated>

export const apiTabletJobStatus = (id: string) =>
  apiFetch(`/api/tablet-jobs/${encodeURIComponent(id)}`) as Promise<TabletJobCreated>

export const apiCancelTabletJob = (id: string) =>
  apiFetch(`/api/tablet-jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }) as Promise<TabletJobCreated>

export const apiClaimTabletPairing = (pairToken: string, name = 'Podpisna tablica') =>
  publicApiFetch(`/api/tablet/pair/${encodeURIComponent(pairToken)}`, { method: 'POST', body: JSON.stringify({ name }) }) as Promise<{ tabletToken: string; device: PairedTablet }>

function tabletApiFetch(path: string, tabletToken: string, opts: RequestInit = {}): Promise<any> {
  return publicApiFetch(path, {
    ...opts,
    headers: { ...(opts.headers as any), 'X-Tablet-Token': tabletToken },
  })
}

export const apiTabletInbox = (tabletToken: string) =>
  tabletApiFetch('/api/tablet/inbox', tabletToken) as Promise<{ device: PairedTablet; jobs: TabletInboxItem[] }>

export const apiTabletOpenJob = (tabletToken: string, id: string) =>
  tabletApiFetch(`/api/tablet/jobs/${encodeURIComponent(id)}`, tabletToken) as Promise<TabletJobPayload>

export const apiSubmitTabletSignature = (tabletToken: string, id: string, role: string, signerName: string, dataUrl: string) =>
  tabletApiFetch(`/api/tablet/jobs/${encodeURIComponent(id)}/signature`, tabletToken, {
    method: 'POST', body: JSON.stringify({ role, signerName, dataUrl }),
  }) as Promise<{ ok: true; status: 'OPEN' | 'COMPLETED'; signedRoles: string[]; signature: any }>

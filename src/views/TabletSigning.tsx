import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CashDocument } from '../types'
import { SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP, SIGNATURE_ROLE_LABELS } from '../types'
import { Btn, ErrBox, Modal, SignaturePad, Warn } from '../components/ui'
import { useApp } from '../state'
import {
  apiCancelTabletJob, apiClaimTabletPairing, apiCreateTabletJob, apiCreateTabletPairing,
  apiRevokeTablet, apiSubmitTabletSignature, apiTabletInbox, apiTabletJobStatus,
  apiTabletOpenJob, apiTabletPairingStatus, apiTablets,
  type PairedTablet, type TabletInboxItem, type TabletJobCreated, type TabletJobPayload, type TabletPairingCreated,
} from '../lib/api'
import { qrMatrix } from '../lib/qr'
import { docNo, fmtDateTime, fmtEur } from '../lib/util'
import { PaperDoc } from '../print'

const TABLET_TOKEN_KEY = 'blagajna_tablet_token_v1'

function QrCode({ value }: { value: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value])
  const quiet = 4
  const size = matrix.length + quiet * 2
  const path = matrix.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : ''))).join('')
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR koda za povezavo tablice" className="w-full h-full bg-white">
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  )
}

function timeLeft(expiresAt: string) {
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now())
  const sec = Math.ceil(ms / 1000)
  const min = Math.floor(sec / 60)
  return `${String(min).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}

export function TabletSettings() {
  const app = useApp()
  const [tablets, setTablets] = useState<PairedTablet[]>([])
  const [pairing, setPairing] = useState<TabletPairingCreated | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  async function load() {
    if (app.mode !== 'server') return
    try { setTablets((await apiTablets()).tablets); setErr('') }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  useEffect(() => { void load() }, [app.mode])
  useEffect(() => {
    if (!pairing) return
    let stopped = false
    const poll = async () => {
      try {
        const s = await apiTabletPairingStatus(pairing.id)
        if (stopped) return
        if (s.status === 'PAIRED') { setPairing(null); await load() }
        if (s.status === 'EXPIRED') setPairing(null)
      } catch (e: any) { if (!stopped) setErr(String(e?.message ?? e)) }
    }
    void poll()
    const t = setInterval(poll, 1500)
    return () => { stopped = true; clearInterval(t) }
  }, [pairing?.id])
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  void tick

  async function startPairing() {
    setBusy(true); setErr('')
    try { setPairing(await apiCreateTabletPairing()) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  async function revoke(t: PairedTablet) {
    if (!window.confirm(`Odstranim povezavo z napravo »${t.name}«? Na tej tablici bo treba ponovno skenirati povezovalni QR.`)) return
    setBusy(true); setErr('')
    try { await apiRevokeTablet(t.id); await load() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  if (app.mode !== 'server') return null
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-slate-800">Podpisna tablica</h2>
          <div className="text-[12px] text-slate-500 mt-0.5">Tablico povežete samo enkrat. Nato dokumente nanjo pošiljate z gumbom »Pošlji na tablico«.</div>
        </div>
        <Btn kind="primary" disabled={busy} onClick={() => void startPairing()}>📱 Poveži novo tablico</Btn>
      </div>
      {err && <div className="mt-3"><ErrBox>{err}</ErrBox></div>}

      {tablets.length > 0 ? (
        <div className="mt-3 space-y-2">
          {tablets.map((t) => (
            <div key={t.id} className="rounded-lg border border-slate-200 px-3 py-2 flex items-center gap-3 flex-wrap">
              <div className="text-2xl">📱</div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-800">{t.name}</div>
                <div className="text-[11px] text-slate-500">Povezana {fmtDateTime(t.pairedAt)}{t.lastSeenAt ? ` · nazadnje vidna ${fmtDateTime(t.lastSeenAt)}` : ''}</div>
              </div>
              <Btn kind="danger" disabled={busy} onClick={() => void revoke(t)}>Odstrani</Btn>
            </div>
          ))}
        </div>
      ) : <div className="mt-3 text-sm text-slate-500">Trenutno ni povezane podpisne tablice.</div>}

      {pairing && (
        <div className="mt-4 rounded-xl border border-blu-200 bg-blu-50 p-4 grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-4 items-center">
          <div className="bg-white rounded-lg border border-slate-200 p-2"><QrCode value={pairing.url} /></div>
          <div>
            <div className="font-semibold text-slate-800">Na Samsung tablici skenirajte ta QR samo enkrat</div>
            <div className="text-sm text-slate-600 mt-1">Po uspešni povezavi se na tablici odpre stalna čakalna vrsta za podpisovanje. QR poteče čez približno {timeLeft(pairing.expiresAt)}.</div>
            <div className="mt-3 text-[12px] text-slate-500">Tablica bo ostala povezana, dokler je tukaj ne odstranite ali dokler ne izbrišete podatkov brskalnika na tablici.</div>
          </div>
        </div>
      )}
    </section>
  )
}

export function SendToTabletModal({ doc, onClose, onDocumentUpdated }: { doc: CashDocument; onClose: () => void; onDocumentUpdated: (doc: CashDocument) => void }) {
  const app = useApp()
  const roles = doc.type === 'BP' ? [...SIGNATURE_ROLES_BP] : [...SIGNATURE_ROLES_BI]
  const alreadySigned = new Set(doc.signatures.map((s) => s.role))
  const unsigned = roles.filter((r) => !alreadySigned.has(r))
  const preferred = doc.type === 'BP' ? 'VPLACAL' : 'PREJEL'
  const initialRole = unsigned.includes(preferred as any) ? preferred : unsigned[0]
  const [selected, setSelected] = useState<string[]>(initialRole ? [initialRole] : [])
  const [tablets, setTablets] = useState<PairedTablet[]>([])
  const [tabletId, setTabletId] = useState('')
  const [job, setJob] = useState<TabletJobCreated | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const seenSigned = useRef(0)

  useEffect(() => {
    apiTablets().then(({ tablets }) => { setTablets(tablets); setTabletId((old) => old || tablets[0]?.id || '') }).catch((e) => setErr(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!job || job.status === 'COMPLETED' || job.status === 'CANCELLED') return
    let stopped = false
    const poll = async () => {
      try {
        const next = await apiTabletJobStatus(job.id)
        if (stopped) return
        setJob(next)
        if (next.signedRoles.length > seenSigned.current || next.status === 'COMPLETED') {
          seenSigned.current = next.signedRoles.length
          await app.syncNow()
          const fresh = await app.db.docs.get(doc.id)
          if (fresh) onDocumentUpdated(fresh)
        }
      } catch (e: any) { if (!stopped) setErr(String(e?.message ?? e)) }
    }
    void poll()
    const t = setInterval(poll, 2000)
    return () => { stopped = true; clearInterval(t) }
  }, [job?.id, job?.status])

  const toggle = (role: string) => setSelected((prev) => prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role])

  async function send() {
    if (!selected.length || !tabletId) return
    setBusy(true); setErr('')
    try {
      await app.syncNow()
      const created = await apiCreateTabletJob(doc.id, selected, tabletId)
      setJob(created)
      seenSigned.current = 0
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  async function cancel() {
    if (!job) return
    setBusy(true); setErr('')
    try { setJob(await apiCancelTabletJob(job.id)) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  const documentLabel = doc.officialNumber != null
    ? docNo(doc.type, doc.officialNumber, doc.seqYear, app.settings.numberFormat, doc.monthKey)
    : `${doc.type} · osnutek brez uradne številke`

  return (
    <Modal title="Pošlji na podpisno tablico" wide onClose={onClose} footer={<><div className="flex-1" />{job && job.status !== 'COMPLETED' && job.status !== 'CANCELLED' && <Btn kind="danger" disabled={busy} onClick={() => void cancel()}>Prekliči zahtevo</Btn>}<Btn onClick={onClose}>Zapri</Btn></>}>
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      {!job ? (
        <>
          {tablets.length === 0 ? (
            <Warn>Ni povezane podpisne tablice. Pojdite v <b>Nastavitve → Podpisna tablica → Poveži novo tablico</b> in na Samsung tablici enkrat skenirajte povezovalni QR.</Warn>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                <label className="block">
                  <div className="text-[11px] font-medium text-slate-500 mb-1">TABLICA</div>
                  <select className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={tabletId} onChange={(e) => setTabletId(e.target.value)}>
                    {tablets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
                  <div className="text-[11px] text-slate-500">DOKUMENT</div>
                  <div className="font-medium text-sm mt-0.5">{documentLabel} · {doc.employeeName} · {doc.amount != null ? fmtEur(doc.amount) : '—'}</div>
                </div>
              </div>
              <div className="text-sm text-slate-600 mb-3">Izberite podpisna polja. Po kliku »Pošlji na tablico« se dokument pojavi kot nova vrstica na tablici.</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {roles.map((role) => {
                  const signed = alreadySigned.has(role)
                  return (
                    <label key={role} className={`rounded-lg border p-3 flex items-center gap-3 ${signed ? 'bg-slate-50 text-slate-400' : selected.includes(role) ? 'border-blu-400 bg-blu-50' : 'border-slate-200 bg-white'}`}>
                      <input type="checkbox" checked={selected.includes(role)} disabled={signed} onChange={() => toggle(role)} />
                      <div><div className="font-medium text-sm">{SIGNATURE_ROLE_LABELS[role]}</div><div className="text-[11px]">{signed ? 'že podpisano' : role === preferred ? 'predlagano za osebo na dokumentu' : 'neobvezno'}</div></div>
                    </label>
                  )
                })}
              </div>
              <div className="mt-4 flex justify-end"><Btn kind="primary" disabled={!selected.length || !tabletId || busy} onClick={() => void send()}>{busy ? 'Pošiljam …' : '📲 Pošlji na tablico'}</Btn></div>
            </>
          )}
        </>
      ) : (
        <div>
          <div className={`rounded-xl border p-4 ${job.status === 'COMPLETED' ? 'border-emerald-200 bg-emerald-50' : job.status === 'CANCELLED' ? 'border-red-200 bg-red-50' : 'border-blu-200 bg-blu-50'}`}>
            <div className="font-semibold">{job.status === 'COMPLETED' ? '✓ Podpisovanje zaključeno' : job.status === 'CANCELLED' ? 'Zahteva je preklicana' : job.status === 'OPEN' ? 'Dokument je odprt na tablici' : 'Dokument čaka na tablici'}</div>
            <div className="text-sm mt-1 text-slate-600">{documentLabel} · {tablets.find((t) => t.id === job.tabletId)?.name}</div>
          </div>
          <div className="mt-3 space-y-2">
            {job.roles.map((role) => {
              const done = job.signedRoles.includes(role)
              return <div key={role} className={`rounded-lg border px-3 py-2 flex items-center gap-2 ${done ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200'}`}><span>{done ? '✓' : '○'}</span><span className="font-medium text-sm">{SIGNATURE_ROLE_LABELS[role]}</span><span className="ml-auto text-[11px]">{done ? 'podpisano' : 'čaka'}</span></div>
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-3">Ko so vsi izbrani podpisi oddani, vrstica na tablici samodejno izgine.</p>
        </div>
      )}
    </Modal>
  )
}

export function TabletPairPage({ token }: { token: string }) {
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  useEffect(() => {
    let active = true
    apiClaimTabletPairing(token, 'Samsung podpisna tablica').then((r) => {
      if (!active) return
      localStorage.setItem(TABLET_TOKEN_KEY, r.tabletToken)
      setDone(true)
      window.setTimeout(() => { window.location.href = '/tablet' }, 700)
    }).catch((e) => { if (active) setErr(String(e?.message ?? e)) })
    return () => { active = false }
  }, [token])
  return (
    <div className="min-h-screen bg-slate-100 grid place-items-center p-5">
      <div className="max-w-md w-full rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-5xl">📱</div>
        <div className="mt-3 text-xl font-semibold text-slate-800">Povezovanje podpisne tablice</div>
        {err ? <div className="mt-4"><ErrBox>{err}</ErrBox></div> : done ? <div className="mt-4 text-emerald-700 font-medium">✓ Tablica je povezana. Odpiram čakalno vrsto …</div> : <div className="mt-4 text-slate-500">Potrjujem varno povezavo z Blagajno …</div>}
      </div>
    </div>
  )
}

export function TabletInboxPage() {
  const token = typeof window !== 'undefined' ? localStorage.getItem(TABLET_TOKEN_KEY) || '' : ''
  const [device, setDevice] = useState<PairedTablet | null>(null)
  const [jobs, setJobs] = useState<TabletInboxItem[]>([])
  const [active, setActive] = useState<TabletJobPayload | null>(null)
  const [activeRole, setActiveRole] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [saveErr, setSaveErr] = useState('')

  async function loadInbox(showLoading = false) {
    if (!token) { setLoading(false); return }
    if (showLoading) setLoading(true)
    try {
      const r = await apiTabletInbox(token)
      setDevice(r.device); setJobs(r.jobs); setErr('')
      if (active && !r.jobs.some((j) => j.id === active.job.id)) setActive(null)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { if (showLoading) setLoading(false) }
  }

  useEffect(() => { void loadInbox(true) }, [token])
  useEffect(() => {
    if (!token) return
    const t = setInterval(() => void loadInbox(false), 2000)
    return () => clearInterval(t)
  }, [token, active?.job.id])

  async function openJob(id: string) {
    setErr(''); setSaveErr('')
    try { setActive(await apiTabletOpenJob(token, id)) }
    catch (e: any) { setErr(String(e?.message ?? e)); await loadInbox(false) }
  }

  async function saveSignature(name: string, dataUrl: string) {
    if (!active || !activeRole) return
    setSaveErr('')
    try {
      const role = activeRole
      const r = await apiSubmitTabletSignature(token, active.job.id, role, name, dataUrl)
      setActiveRole(null)
      if (r.status === 'COMPLETED') {
        setActive(null)
        await loadInbox(false)
      } else {
        setActive(await apiTabletOpenJob(token, active.job.id))
      }
    } catch (e: any) { setSaveErr(String(e?.message ?? e)) }
  }

  if (!token) return (
    <div className="min-h-screen bg-slate-100 grid place-items-center p-5"><div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center"><div className="text-5xl">📱</div><div className="mt-3 text-xl font-semibold">Tablica še ni povezana</div><div className="mt-2 text-sm text-slate-600">Na računalniku odprite Nastavitve → Podpisna tablica → Poveži novo tablico in tukaj skenirajte QR.</div></div></div>
  )
  if (loading) return <div className="min-h-screen bg-slate-100 grid place-items-center text-slate-500">Odpiram podpisno tablico …</div>

  const pending = active ? active.requestedRoles.filter((r) => !active.signedRoles.includes(r)) : []
  const defaultName = activeRole === 'PREJEL' || activeRole === 'VPLACAL' ? active?.doc.employeeName || '' : ''

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="bg-blu-800 text-white px-4 py-3 shadow-sm">
        <div className="max-w-[1000px] mx-auto flex items-center gap-3"><div className="w-10 h-10 rounded-lg bg-white/10 grid place-items-center text-xl">✍️</div><div><div className="font-semibold text-lg">Podpisna tablica</div><div className="text-[11px] text-blu-100/80">{device?.name || 'Povezana naprava'}</div></div><div className="flex-1" /><div className="text-sm bg-white/10 rounded-md px-3 py-1.5">{jobs.length} {jobs.length === 1 ? 'dokument' : 'dokumenti'}</div></div>
      </header>
      <main className="max-w-[1000px] mx-auto p-3 sm:p-5">
        {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
        {!active ? (
          <>
            <div className="mb-4"><div className="text-lg font-semibold">Čakalna vrsta za podpis</div><div className="text-sm text-slate-500">Dokument se tukaj pojavi samodejno, ko na računalniku kliknete »Pošlji na tablico«.</div></div>
            {jobs.length === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-10 text-center"><div className="text-5xl">✓</div><div className="mt-3 text-xl font-semibold text-slate-700">Ni dokumentov za podpis</div><div className="mt-1 text-sm text-slate-500">Tablico lahko pustite odprto na tej strani.</div></div>
            ) : (
              <div className="space-y-3">
                {jobs.map((j) => (
                  <button key={j.id} type="button" onClick={() => void openJob(j.id)} className="w-full rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm active:bg-slate-50 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-blu-50 text-blu-700 grid place-items-center font-bold">{j.type}</div>
                    <div className="min-w-0 flex-1"><div className="font-semibold text-lg">{j.documentLabel}</div><div className="text-sm text-slate-600 mt-0.5">{j.employeeName || 'Brez imena'} · {j.amount != null ? fmtEur(j.amount) : '—'}</div><div className="text-[12px] text-slate-500 mt-1">Podpis: {j.roles.map((r) => SIGNATURE_ROLE_LABELS[r] || r).join(', ')}</div></div>
                    <div className="text-right"><div className="text-2xl">›</div><div className="text-[11px] text-slate-400">{j.status === 'OPEN' ? 'odprto' : 'čaka'}</div></div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-3 flex-wrap"><Btn onClick={() => setActive(null)}>← Nazaj na čakalno vrsto</Btn><div className="font-semibold">{active.doc.officialNumber != null ? docNo(active.doc.type, active.doc.officialNumber, active.doc.seqYear, active.settings.numberFormat, active.doc.monthKey) : `${active.doc.type} · osnutek`}</div></div>
            {saveErr && <div className="mb-3"><ErrBox>{saveErr}</ErrBox></div>}
            <div className="rounded-xl border border-blu-200 bg-blu-50 p-4 mb-4"><div className="font-semibold">Preglejte dokument in izberite označeno mesto za podpis.</div><div className="text-sm text-slate-600 mt-1">Ko zaključite vse zahtevane podpise, se dokument samodejno odstrani iz čakalne vrste.</div></div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-5 shadow-sm overflow-x-auto"><div className="min-w-[680px]"><PaperDoc doc={active.doc} settings={active.settings} desk={active.desk ?? undefined} embedded signableRoles={pending} onSignatureClick={(role) => setActiveRole(role)} /></div></div>
            {pending.length > 0 && <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">{pending.map((role) => <button key={role} type="button" onClick={() => setActiveRole(role)} className="rounded-xl border-2 border-yellow-300 bg-yellow-50 p-4 text-left active:bg-yellow-100"><div className="text-[11px] uppercase tracking-wide text-yellow-800">Podpisno polje</div><div className="mt-1 text-lg font-semibold">✍️ {SIGNATURE_ROLE_LABELS[role]}</div><div className="text-sm text-slate-600 mt-1">Tapnite in podpišite s pisalom.</div></button>)}</div>}
          </>
        )}
      </main>
      {activeRole && <SignaturePad title={SIGNATURE_ROLE_LABELS[activeRole]} defaultName={defaultName} onClose={() => { setActiveRole(null); setSaveErr('') }} onSave={(name, dataUrl) => { void saveSignature(name, dataUrl) }} />}
    </div>
  )
}

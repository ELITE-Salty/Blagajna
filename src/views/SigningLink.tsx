import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CashDocument } from '../types'
import { SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP, SIGNATURE_ROLE_LABELS } from '../types'
import { Btn, ErrBox, Modal, SignaturePad, Warn } from '../components/ui'
import { useApp } from '../state'
import {
  apiCancelSigningSession, apiCreateSigningSession, apiPublicSigning, apiSigningSessionStatus, apiSubmitPublicSignature,
  type PublicSigningPayload, type SigningSessionCreated, type SigningSessionStatus,
} from '../lib/api'
import { qrMatrix } from '../lib/qr'
import { docNo, fmtDateTime } from '../lib/util'
import { PaperDoc } from '../print'

function QrCode({ value }: { value: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value])
  const quiet = 4
  const size = matrix.length + quiet * 2
  const path = matrix.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : ''))).join('')
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR koda za podpis" className="w-full h-full bg-white">
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

export function SigningLinkModal({
  doc, onClose, onDocumentUpdated,
}: {
  doc: CashDocument
  onClose: () => void
  onDocumentUpdated: (doc: CashDocument) => void
}) {
  const app = useApp()
  const roles = doc.type === 'BP' ? [...SIGNATURE_ROLES_BP] : [...SIGNATURE_ROLES_BI]
  const alreadySigned = new Set(doc.signatures.map((s) => s.role))
  const unsigned = roles.filter((r) => !alreadySigned.has(r))
  const preferred = doc.type === 'BP' ? 'VPLACAL' : 'PREJEL'
  const initialRole = unsigned.includes(preferred as any) ? preferred : unsigned[0]
  const [selected, setSelected] = useState<string[]>(initialRole ? [initialRole] : [])
  const [session, setSession] = useState<SigningSessionCreated | null>(null)
  const [status, setStatus] = useState<SigningSessionStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [nowTick, setNowTick] = useState(0)
  const seenSigned = useRef(0)

  useEffect(() => {
    const t = setInterval(() => setNowTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!session || status?.status === 'COMPLETED' || status?.status === 'CANCELLED' || status?.status === 'EXPIRED') return
    let stopped = false
    const poll = async () => {
      try {
        const next = await apiSigningSessionStatus(session.id)
        if (stopped) return
        setStatus(next)
        if (next.signedRoles.length > seenSigned.current) {
          seenSigned.current = next.signedRoles.length
          await app.syncNow()
          const fresh = await app.db.docs.get(doc.id)
          if (fresh) onDocumentUpdated(fresh)
        }
      } catch (e: any) {
        if (!stopped) setErr(String(e?.message ?? e))
      }
    }
    void poll()
    const t = setInterval(poll, 2000)
    return () => { stopped = true; clearInterval(t) }
  }, [session?.id, status?.status])

  const toggle = (role: string) => setSelected((prev) => prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role])

  async function generate() {
    if (!selected.length) return
    setBusy(true); setErr('')
    try {
      await app.syncNow()
      const created = await apiCreateSigningSession(doc.id, selected, 30)
      setSession(created)
      setStatus({
        id: created.id, docId: doc.id, status: 'ACTIVE', roles: created.roles, signedRoles: [],
        createdAt: new Date().toISOString(), expiresAt: created.expiresAt,
      })
      seenSigned.current = 0
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  async function cancel() {
    if (!session) return
    setBusy(true); setErr('')
    try { setStatus(await apiCancelSigningSession(session.id)) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  async function copyLink() {
    if (!session) return
    try { await navigator.clipboard.writeText(session.url) }
    catch { window.prompt('Kopirajte povezavo:', session.url) }
  }

  const state = status?.status ?? 'ACTIVE'
  const remaining = session ? timeLeft(session.expiresAt) : ''
  const documentLabel = doc.officialNumber != null
    ? docNo(doc.type, doc.officialNumber, doc.seqYear, app.settings.numberFormat, doc.monthKey)
    : `${doc.type} · osnutek brez uradne številke`
  void nowTick

  return (
    <Modal
      title="Podpis preko QR kode"
      wide
      onClose={onClose}
      footer={<><div className="flex-1" />{session && state === 'ACTIVE' && <Btn kind="danger" disabled={busy} onClick={cancel}>Prekliči povezavo</Btn>}<Btn onClick={onClose}>Zapri</Btn></>}
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      {!session ? (
        <>
          <div className="text-sm text-slate-600 mb-3">
            Izberite, katera podpisna polja naj oseba podpiše na tablici. Povezava bo veljala <b>30 minut</b> in bo uporabna samo za ta dokument.
          </div>
          {unsigned.length === 0 ? <Warn>Ta dokument ima že izpolnjena vsa podpisna polja.</Warn> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {roles.map((role) => {
                const signed = alreadySigned.has(role)
                return (
                  <label key={role} className={`rounded-lg border p-3 flex items-center gap-3 ${signed ? 'bg-slate-50 text-slate-400' : selected.includes(role) ? 'border-blu-400 bg-blu-50' : 'border-slate-200 bg-white'}`}>
                    <input type="checkbox" checked={selected.includes(role)} disabled={signed} onChange={() => toggle(role)} />
                    <div>
                      <div className="font-medium text-sm">{SIGNATURE_ROLE_LABELS[role]}</div>
                      <div className="text-[11px]">{signed ? 'že podpisano' : role === preferred ? 'predlagano za osebo na dokumentu' : 'lahko vključite v isti QR'}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Btn kind="primary" disabled={!selected.length || busy} onClick={generate}>{busy ? 'Ustvarjam …' : 'Ustvari QR kodo (30 min)'}</Btn>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-5 items-start">
          <div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><QrCode value={session.url} /></div>
            <div className="mt-2 text-center">
              {state === 'ACTIVE' && <div className="text-sm font-semibold text-slate-700">Velja še {remaining}</div>}
              {state === 'COMPLETED' && <div className="text-sm font-semibold text-emerald-700">✓ Vsi izbrani podpisi so oddani</div>}
              {state === 'CANCELLED' && <div className="text-sm font-semibold text-red-700">Povezava je preklicana</div>}
              {state === 'EXPIRED' && <div className="text-sm font-semibold text-amber-700">Povezava je potekla</div>}
              <div className="text-[11px] text-slate-400 mt-1">Skenirajte s kamero na Samsung tablici.</div>
            </div>
            <div className="mt-3 flex justify-center"><Btn onClick={copyLink}>Kopiraj povezavo</Btn></div>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-700">Čakam na podpis</div>
            <div className="text-[12px] text-slate-500 mt-1">Dokument: {documentLabel}</div>
            <div className="mt-3 space-y-2">
              {session.roles.map((role) => {
                const done = status?.signedRoles.includes(role)
                return <div key={role} className={`rounded-lg border px-3 py-2 flex items-center gap-2 ${done ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200'}`}><span>{done ? '✓' : '○'}</span><span className="font-medium text-sm">{SIGNATURE_ROLE_LABELS[role]}</span><span className="ml-auto text-[11px]">{done ? 'podpisano' : 'čaka'}</span></div>
              })}
            </div>
            {status?.completedAt && <div className="text-[11px] text-slate-500 mt-3">Zaključeno: {fmtDateTime(status.completedAt)}</div>}
            <p className="text-[11px] text-slate-400 mt-4">QR povezava se po vseh izbranih podpisih samodejno zaklene. Če jo prekličete, tablica z njo ne more več oddati podpisa.</p>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function PublicSigningPage({ token }: { token: string }) {
  const [payload, setPayload] = useState<PublicSigningPayload | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeRole, setActiveRole] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState('')
  const [nowTick, setNowTick] = useState(0)

  async function load(showLoading = false) {
    if (showLoading) setLoading(true)
    try { setPayload(await apiPublicSigning(token)); setErr('') }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { if (showLoading) setLoading(false) }
  }

  useEffect(() => { void load(true) }, [token])
  useEffect(() => {
    if (!payload || payload.status === 'COMPLETED') return
    const t = setInterval(() => void load(false), 5000)
    return () => clearInterval(t)
  }, [payload?.status, token])
  useEffect(() => {
    const t = setInterval(() => setNowTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (loading) return <div className="min-h-screen grid place-items-center bg-slate-100 text-slate-500">Odpiram dokument za podpis …</div>
  if (err || !payload) return (
    <div className="min-h-screen grid place-items-center bg-slate-100 p-6">
      <div className="max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">🔒</div><div className="mt-3 text-lg font-semibold text-slate-800">Povezava ni več na voljo</div>
        <div className="mt-2 text-sm text-slate-600">{err || 'Povezave ni bilo mogoče odpreti.'}</div>
      </div>
    </div>
  )

  const pending = payload.requestedRoles.filter((r) => !payload.signedRoles.includes(r))
  const remaining = timeLeft(payload.expiresAt)
  void nowTick
  const defaultName = activeRole === 'PREJEL' || activeRole === 'VPLACAL' ? payload.doc.employeeName : ''

  async function saveSignature(name: string, dataUrl: string) {
    if (!activeRole) return
    setSaveErr('')
    try {
      const result = await apiSubmitPublicSignature(token, activeRole, name, dataUrl)
      setActiveRole(null)
      if (result.status === 'COMPLETED') {
        setPayload((prev) => prev ? {
          ...prev,
          status: 'COMPLETED',
          signedRoles: result.signedRoles,
          doc: {
            ...prev.doc,
            signatures: [...(prev.doc.signatures || []).filter((s: any) => s.role !== activeRole), result.signature],
            ...(activeRole === 'PREJEL' ? { prejelStatus: 'DIGITALNO' } : {}),
          },
        } : prev)
      } else {
        await load(false)
      }
    } catch (e: any) {
      setSaveErr(String(e?.message ?? e))
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="bg-blu-800 text-white px-4 py-3 shadow-sm">
        <div className="max-w-[980px] mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/10 grid place-items-center font-bold">B</div>
          <div><div className="font-semibold">Blagajna · varen podpis</div><div className="text-[11px] text-blu-100/80">Začasna povezava samo za ta dokument</div></div>
          <div className="flex-1" />
          {payload.status === 'ACTIVE' && <div className="text-sm font-mono bg-white/10 rounded px-2 py-1">{remaining}</div>}
        </div>
      </header>
      <main className="max-w-[980px] mx-auto p-3 sm:p-5">
        {saveErr && <div className="mb-3"><ErrBox>{saveErr}</ErrBox></div>}
        {payload.status === 'COMPLETED' ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
            <div className="text-lg font-semibold">✓ Podpisovanje je zaključeno</div>
            <div className="text-sm mt-1">Vsi zahtevani podpisi so bili uspešno shranjeni. To stran lahko zaprete.</div>
          </div>
        ) : (
          <div className="mb-4 rounded-xl border border-blu-200 bg-blu-50 p-4">
            <div className="font-semibold">Preglejte dokument in tapnite označeno mesto za podpis.</div>
            <div className="text-sm text-slate-600 mt-1">Če je izbranih več podpisov, jih lahko oddate enega za drugim z isto povezavo.</div>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-5 shadow-sm overflow-x-auto">
          <div className="min-w-[680px]">
            <PaperDoc
              doc={payload.doc}
              settings={payload.settings}
              desk={payload.desk ?? undefined}
              embedded
              signableRoles={payload.status === 'ACTIVE' ? pending : []}
              onSignatureClick={(role) => setActiveRole(role)}
            />
          </div>
        </div>

        {pending.length > 0 && payload.status === 'ACTIVE' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pending.map((role) => (
              <button key={role} type="button" onClick={() => setActiveRole(role)} className="rounded-xl border-2 border-yellow-300 bg-yellow-50 p-4 text-left active:bg-yellow-100">
                <div className="text-[11px] uppercase tracking-wide text-yellow-800">Podpisno polje</div>
                <div className="mt-1 text-lg font-semibold">✍️ {SIGNATURE_ROLE_LABELS[role]}</div>
                <div className="text-sm text-slate-600 mt-1">Tapnite za podpis s pisalom ali prstom.</div>
              </button>
            ))}
          </div>
        )}
      </main>

      {activeRole && (
        <SignaturePad
          title={SIGNATURE_ROLE_LABELS[activeRole]}
          defaultName={defaultName}
          onClose={() => { setActiveRole(null); setSaveErr('') }}
          onSave={(name, dataUrl) => { void saveSignature(name, dataUrl) }}
        />
      )}
    </div>
  )
}

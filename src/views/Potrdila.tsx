import React, { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { ActivityType, CashDocument, Potrdilo } from '../types'
import { ACTIVITY_LABELS, ACTIVITY_FIELD_NO } from '../types'
import { cx, docNo, fmtDate, fmtDateTime, fmtEur, nowIso, todayIso, uuid } from '../lib/util'
import { Btn, Chip, ErrBox, Field, Modal, SignaturePad, Warn, inputCls } from '../components/ui'
import type { PrintJob } from '../print'

export function PotrdilaView({
  onOpenPotrdilo, onOpenDoc, onPrintPotrdilo,
}: {
  onOpenPotrdilo: (id: string | null, employeeId?: string) => void
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
  onPrintPotrdilo: (p: Potrdilo) => void
}) {
  const app = useApp()
  const { db } = app
  const potrdila = useLiveQuery(() => db.potrdila.toArray(), []) ?? []
  const docs = useLiveQuery(() => db.docs.toArray(), []) ?? []
  const [fltEmp, setFltEmp] = useState('')
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []

  const list = potrdila
    .filter((p) => !fltEmp || p.employeeId === fltEmp)
    .sort((a, b) => b.fromAt.localeCompare(a.fromAt))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-800">Potrdila o dejavnostih <span className="text-slate-400 font-normal">(»dopust listi«)</span></h1>
        <div className="flex-1" />
        <select className={cx(inputCls, 'w-auto')} value={fltEmp} onChange={(e) => setFltEmp(e.target.value)}>
          <option value="">Vsi zaposleni</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
        </select>
        <Btn kind="primary" onClick={() => onOpenPotrdilo(null)}>+ Novo potrdilo</Btn>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
              <th className="px-3 py-2">Voznik</th>
              <th className="px-3 py-2">Od</th>
              <th className="px-3 py-2">Do</th>
              <th className="px-3 py-2">Dejavnost</th>
              <th className="px-3 py-2">Povezani dokumenti</th>
              <th className="px-3 py-2 text-right">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Ni potrdil.</td></tr>}
            {list.map((p) => {
              const linked = docs.filter((d) => d.potrdiloId === p.id)
              return (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{p.employeeName}</td>
                  <td className="px-3 py-2 font-mono text-[12px]">{fmtDateTime(p.fromAt)}</td>
                  <td className="px-3 py-2 font-mono text-[12px]">{fmtDateTime(p.toAt)}</td>
                  <td className="px-3 py-2 text-[12px]">{ACTIVITY_LABELS[p.activityType]}</td>
                  <td className="px-3 py-2">
                    {linked.length === 0
                      ? <span className="text-slate-400 text-[12px]">—</span>
                      : linked.map((d) => (
                          <button key={d.id} className="mr-1 mb-0.5" onClick={() => onOpenDoc(d.id)}>
                            <Chip tone={d.type === 'BP' ? 'green' : 'red'}>
                              {d.officialNumber != null ? docNo(d.type, d.officialNumber, d.seqYear, app.settings.numberFormat) : `${d.type} osnutek`} · {fmtEur(d.amount)}
                            </Chip>
                          </button>
                        ))}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="text-blu-600 hover:underline text-[13px] mr-3" onClick={() => onOpenPotrdilo(p.id)}>Odpri</button>
                    <button className="text-slate-600 hover:underline text-[13px] mr-3" onClick={() => onPrintPotrdilo(p)}>🖨️ Natisni</button>
                    <button className="text-emerald-700 hover:underline text-[13px] mr-3" title="Nov blagajniški prejemek iz potrdila"
                      onClick={() => onOpenDoc(null, { type: 'BP', employeeId: p.employeeId, employeeName: p.employeeName, potrdiloId: p.id, deskId: app.settings.activeDeskId })}>+ BP</button>
                    <button className="text-orange-700 hover:underline text-[13px]" title="Nov blagajniški izdatek iz potrdila"
                      onClick={() => onOpenDoc(null, { type: 'BI', employeeId: p.employeeId, employeeName: p.employeeName, potrdiloId: p.id, deskId: app.settings.activeDeskId })}>+ BI</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-slate-400">
        Potrdilo pove, kdaj je voznik doma/dosegljiv — ob izbiri zaposlenega na BP/BI se ustrezna obdobja prikažejo kot kontekst. Finančnih zneskov aplikacija nikoli ne ustvari samodejno iz potrdila.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- obrazec
export function PotrdiloForm({
  potrdiloId, initialEmployeeId, onClose, onPrintPotrdilo, onOpenDoc,
}: {
  potrdiloId: string | null
  initialEmployeeId?: string
  onClose: () => void
  onPrintPotrdilo: (p: Potrdilo) => void
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
}) {
  const app = useApp()
  const { db, settings } = app
  const stored = useLiveQuery<Potrdilo | undefined>(() => (potrdiloId ? db.potrdila.get(potrdiloId) : undefined), [potrdiloId])
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  if (potrdiloId && !stored) return null

  const init: Potrdilo = stored ?? {
    id: uuid(),
    employeeId: initialEmployeeId ?? '',
    employeeName: '', employeeDateOfBirth: '', employeeIdNumber: '', employeeEmploymentStart: '',
    fromAt: '', toAt: '',
    activityType: 'ANNUAL_LEAVE',
    companyPlace: settings.company.city, companyDate: todayIso(),
    driverPlace: settings.company.city, driverDate: todayIso(),
    declarantName: settings.company.declarantName, declarantPosition: settings.company.declarantPosition,
    signatures: [], syncStatus: 'LOKALNO',
    createdAt: nowIso(), createdBy: app.userLabel, updatedAt: nowIso(),
  }
  return <PotrdiloFormInner key={potrdiloId ?? 'new'} init={init} isNew={!potrdiloId} employees={employees} onClose={onClose} onPrintPotrdilo={onPrintPotrdilo} onOpenDoc={onOpenDoc} />
}

function PotrdiloFormInner({
  init, isNew, employees, onClose, onPrintPotrdilo, onOpenDoc,
}: {
  init: Potrdilo
  isNew: boolean
  employees: any[]
  onClose: () => void
  onPrintPotrdilo: (p: Potrdilo) => void
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
}) {
  const app = useApp()
  const { db, settings } = app
  const [p, setP] = useState<Potrdilo>({ ...init })
  const [err, setErr] = useState('')
  const [warn, setWarn] = useState('')
  const [sign, setSign] = useState<null | 'PODJETJE' | 'VOZNIK'>(null)
  const [saved, setSaved] = useState(!isNew)
  const linkedDocs = useLiveQuery(() => db.docs.where('potrdiloId').equals(init.id).toArray(), [init.id]) ?? []

  const set = (patch: Partial<Potrdilo>) => setP((x) => ({ ...x, ...patch }))

  function pickEmployee(id: string) {
    const e = employees.find((x) => x.id === id)
    set({
      employeeId: id,
      employeeName: e?.displayName ?? '',
      employeeDateOfBirth: e?.dateOfBirth ?? '',
      employeeIdNumber: e?.idNumber ?? '',
      employeeEmploymentStart: e?.employmentStart ?? '',
    })
  }

  async function save(): Promise<boolean> {
    setErr('')
    if (!p.employeeId) { setErr('Izberite voznika.'); return false }
    if (!p.fromAt || !p.toAt) { setErr('Vnesite obdobje od–do (datum in uro).'); return false }
    if (p.toAt <= p.fromAt) { setErr('Konec obdobja mora biti kasnejši od začetka.'); return false }
    // opozorilo ob prekrivanju
    const others = (await db.potrdila.where('employeeId').equals(p.employeeId).toArray()).filter((x) => x.id !== p.id)
    const overlap = others.find((x) => p.fromAt < x.toAt && x.fromAt < p.toAt)
    if (overlap && !warn) {
      setWarn(`Obdobje se prekriva z obstoječim potrdilom (${fmtDateTime(overlap.fromAt)} → ${fmtDateTime(overlap.toAt)}). Kliknite »Shrani« še enkrat za potrditev.`)
      return false
    }
    const rec: Potrdilo = { ...p, syncStatus: 'LOKALNO', updatedAt: nowIso() }
    await db.potrdila.put(rec)
    await app.audit(isNew && !saved ? 'Novo potrdilo o dejavnostih' : 'Sprememba potrdila', 'Potrdilo', rec.id,
      `${rec.employeeName} · ${fmtDateTime(rec.fromAt)} → ${fmtDateTime(rec.toAt)} · ${ACTIVITY_LABELS[rec.activityType]}`)
    setSaved(true)
    setWarn('')
    return true
  }

  async function saveSignature(role: 'PODJETJE' | 'VOZNIK', name: string, dataUrl: string) {
    const signatures = [...p.signatures.filter((s) => s.role !== role), { role, signerName: name, type: 'DIGITALNO' as const, dataUrl, signedAt: nowIso(), capturedBy: app.userLabel }]
    set({ signatures })
    setSign(null)
  }

  const newDocFrom = (type: 'BP' | 'BI') => {
    onOpenDoc(null, {
      type, employeeId: p.employeeId, employeeName: p.employeeName,
      potrdiloId: p.id, deskId: settings.activeDeskId,
    })
  }

  return (
    <Modal
      title={<span className="flex items-center gap-2">Potrdilo o dejavnostih {p.employeeName && <Chip tone="blue">{p.employeeName}</Chip>}{p.syncStatus === 'LOKALNO' && <Chip tone="violet">Nesinhronizirano</Chip>}</span>}
      wide
      onClose={onClose}
      footer={<>
        <Btn onClick={async () => { if (await save()) onPrintPotrdilo(p) }}>🖨️ Shrani in natisni</Btn>
        <div className="flex-1" />
        <Btn onClick={onClose}>Zapri</Btn>
        <Btn kind="primary" onClick={async () => { if (await save()) onClose() }}>Shrani</Btn>
      </>}
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      {warn && <div className="mb-3"><Warn>{warn}</Warn></div>}

      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Podjetje (iz nastavitev)</div>
      <div className="grid md:grid-cols-3 gap-3">
        <Field label="Naziv podjetja"><input className={inputCls} value={settings.company.name} disabled /></Field>
        <Field label="Podpisani (izjavitelj)"><input className={inputCls} value={p.declarantName} onChange={(e) => set({ declarantName: e.target.value })} /></Field>
        <Field label="Delovno mesto"><input className={inputCls} value={p.declarantPosition} onChange={(e) => set({ declarantPosition: e.target.value })} /></Field>
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mt-4 mb-2">Voznik</div>
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="Voznik (zaposleni)">
          <select className={inputCls} value={p.employeeId} onChange={(e) => pickEmployee(e.target.value)}>
            <option value="">— izberi —</option>
            {employees.filter((e: any) => e.active || e.id === p.employeeId).map((e: any) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Datum rojstva"><input type="date" lang="sl-SI" className={inputCls} value={p.employeeDateOfBirth} onChange={(e) => set({ employeeDateOfBirth: e.target.value })} /></Field>
          <Field label="Št. dovoljenja / OI"><input className={cx(inputCls, 'font-mono')} value={p.employeeIdNumber} onChange={(e) => set({ employeeIdNumber: e.target.value })} /></Field>
          <Field label="Zaposlen od"><input type="date" lang="sl-SI" className={inputCls} value={p.employeeEmploymentStart} onChange={(e) => set({ employeeEmploymentStart: e.target.value })} /></Field>
        </div>
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mt-4 mb-2">Obdobje (točen datum in ura)</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Od (12)"><input type="datetime-local" lang="sl-SI" step="60" className={cx(inputCls, 'font-mono')} value={p.fromAt} onChange={(e) => set({ fromAt: e.target.value })} /></Field>
        <Field label="Do (13)"><input type="datetime-local" lang="sl-SI" step="60" className={cx(inputCls, 'font-mono')} value={p.toAt} onChange={(e) => set({ toAt: e.target.value })} /></Field>
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mt-4 mb-2">Dejavnost — izberite točno eno</div>
      <div className="grid md:grid-cols-2 gap-1.5">
        {(Object.keys(ACTIVITY_LABELS) as ActivityType[]).map((k) => (
          <label key={k} className={cx('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm cursor-pointer', p.activityType === k ? 'border-blu-600 bg-blu-50 font-medium' : 'border-slate-200 hover:bg-slate-50')}>
            <input type="radio" name="akt" checked={p.activityType === k} onChange={() => set({ activityType: k })} />
            <span><span className="text-slate-400 mr-1">{ACTIVITY_FIELD_NO[k]}.</span>{ACTIVITY_LABELS[k]}</span>
          </label>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-3 mt-4">
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Podjetje — kraj, datum, podpis</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kraj"><input className={inputCls} value={p.companyPlace} onChange={(e) => set({ companyPlace: e.target.value })} /></Field>
            <Field label="Datum"><input type="date" lang="sl-SI" className={inputCls} value={p.companyDate} onChange={(e) => set({ companyDate: e.target.value })} /></Field>
          </div>
          <SigLine sig={p.signatures.find((s) => s.role === 'PODJETJE')} onSign={() => setSign('PODJETJE')} />
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Voznik — izjava, kraj, datum, podpis</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kraj"><input className={inputCls} value={p.driverPlace} onChange={(e) => set({ driverPlace: e.target.value })} /></Field>
            <Field label="Datum"><input type="date" lang="sl-SI" className={inputCls} value={p.driverDate} onChange={(e) => set({ driverDate: e.target.value })} /></Field>
          </div>
          <SigLine sig={p.signatures.find((s) => s.role === 'VOZNIK')} onSign={() => setSign('VOZNIK')} />
          <div className="text-[11px] text-slate-400 mt-1">Izjava voznika (20): »V navedenem obdobju nisem vozil vozila, za katero se uporablja Uredba (ES) št. 561/2006 ali AETR.«</div>
        </div>
      </div>

      {/* Povezani blagajniški dokumenti */}
      <div className="mt-4 rounded-lg border border-blu-100 bg-blu-50 p-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-blu-700">Povezani blagajniški dokumenti ({linkedDocs.length})</div>
          <div className="flex gap-2">
            <Btn kind="success" onClick={async () => { if (await save()) newDocFrom('BP') }}>+ Blagajniški prejemek</Btn>
            <Btn kind="danger" onClick={async () => { if (await save()) newDocFrom('BI') }}>+ Blagajniški izdatek</Btn>
          </div>
        </div>
        {linkedDocs.length > 0 && (
          <div className="mt-2 space-y-1">
            {linkedDocs.map((d) => (
              <button key={d.id} className="flex w-full items-center gap-2 text-sm bg-white rounded-md border border-blu-100 px-2 py-1 hover:border-blu-600" onClick={() => onOpenDoc(d.id)}>
                <Chip tone={d.type === 'BP' ? 'green' : 'red'}>{d.type}</Chip>
                <span className="font-mono text-[12px]">{fmtDate(d.transactionDate)} {d.transactionTime}</span>
                <span className="flex-1 text-left truncate">{d.purpose || '—'}</span>
                <span className="font-mono">{fmtEur(d.amount)}</span>
                <span className="font-mono text-[12px] font-semibold">{d.officialNumber != null ? docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat) : 'osnutek'}</span>
              </button>
            ))}
          </div>
        )}
        <div className="text-[11px] text-blu-700/70 mt-2">Novi dokument dobi predizpolnjenega zaposlenega in povezavo na to potrdilo — datum, uro in znesek vedno izberete sami.</div>
      </div>

      {sign && (
        <SignaturePad
          title={sign === 'PODJETJE' ? 'Podpis podjetja' : 'Podpis voznika'}
          defaultName={sign === 'PODJETJE' ? p.declarantName : p.employeeName}
          onClose={() => setSign(null)}
          onSave={(name, dataUrl) => saveSignature(sign, name, dataUrl)}
        />
      )}
    </Modal>
  )
}

function SigLine({ sig, onSign }: { sig?: { signerName: string; dataUrl?: string; signedAt: string }; onSign: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-between">
      {sig ? (
        <div className="flex items-center gap-2">
          {sig.dataUrl && <img src={sig.dataUrl} alt="" className="h-8" />}
          <span className="text-[12px] text-slate-500">{sig.signerName}</span>
        </div>
      ) : <span className="text-[12px] text-slate-400">ni podpisano — lahko ostane prazno za fizični podpis</span>}
      <Btn kind="ghost" onClick={onSign}>Podpiši</Btn>
    </div>
  )
}

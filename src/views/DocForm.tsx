import React, { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { AccountingRow, CashDocument, Employee, Potrdilo, PrejelStatus } from '../types'
import {
  PREJEL_LABELS, SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP, SIGNATURE_ROLE_LABELS,
} from '../types'
import {
  cx, docNo, fileToDataUrl, fmtDateTime, fmtEur, monthKeyOf, monthLabel, nowIso, parseAmount, todayIso, nowTime, txAt, uuid,
} from '../lib/util'
import { znesekZBesedo } from '../lib/besede'
import { closeIdFor, stornoDoc } from '../lib/numbering'
import { availableInDesk, checkBiCover } from '../lib/balance'
import { can } from '../lib/perms'
import { Btn, Chip, ErrBox, Field, Modal, SignaturePad, Warn, inputCls } from '../components/ui'
import type { PrintJob } from '../print'
import { emptyDoc } from '../db'
import { EmployeeEdit } from './Employees'

export function DocForm({
  docId, initial, onClose, onPrint,
}: {
  docId: string | null
  initial?: Partial<CashDocument>
  onClose: () => void
  onPrint: (job: PrintJob) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const stored = useLiveQuery<CashDocument | undefined>(() => (docId ? db.docs.get(docId) : undefined), [docId])
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []

  if (docId && !stored) return null
  return (
    <DocFormInner
      key={docId ?? 'new'}
      doc={stored ?? emptyDoc({ deskId: settings.activeDeskId, createdBy: app.userLabel, updatedBy: app.userLabel, ...initial })}
      isNew={!docId}
      employees={employees}
      desks={desks}
      onClose={onClose}
      onPrint={onPrint}
    />
  )
}

function DocFormInner({
  doc, isNew, employees, desks, onClose, onPrint,
}: {
  doc: CashDocument
  isNew: boolean
  employees: Employee[]
  desks: { id: string; name: string; active: boolean; code: string; description: string }[]
  onClose: () => void
  onPrint: (job: PrintJob) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const [d, setD] = useState<CashDocument>({ ...doc, rows: doc.rows.map((r) => ({ ...r })) })
  const [amountText, setAmountText] = useState(doc.amount != null ? String(doc.amount).replace('.', ',') : '')
  const [overrideWords, setOverrideWords] = useState(!!doc.amountWordsOverride)
  const [err, setErr] = useState('')
  const [signRole, setSignRole] = useState<string | null>(null)
  const [storno, setStorno] = useState(false)
  const [newEmp, setNewEmp] = useState(false)

  const potrdila = useLiveQuery(
    () => (d.employeeId ? db.potrdila.where('employeeId').equals(d.employeeId).toArray() : Promise.resolve([] as Potrdilo[])),
    [d.employeeId],
  ) ?? []

  const isBP = d.type === 'BP'
  const finalized = d.status === 'ZAKLJUCEN'
  const cancelled = d.status === 'STORNIRAN'
  const editable = d.status === 'ODPRT'
  const roles = isBP ? SIGNATURE_ROLES_BP : SIGNATURE_ROLES_BI

  const set = (patch: Partial<CashDocument>) => setD((p) => ({ ...p, ...patch }))

  const words = d.amountWordsOverride || znesekZBesedo(d.amount)
  const avail = useLiveQuery(
    () => (d.type === 'BI' && d.deskId ? availableInDesk(db, d.deskId, d.id) : Promise.resolve(null)),
    [d.type, d.deskId, d.id],
  )
  const linked = potrdila.find((p) => p.id === d.potrdiloId) ?? null
  const tx = txAt(d)
  const outsideInterval = linked && (tx < linked.fromAt || tx > linked.toAt)

  async function save() {
    setErr('')
    const emp = employees.find((e) => e.id === d.employeeId)
    const monthKey = monthKeyOf(d.transactionDate)
    // varovalo: v zaključen mesec ni mogoče shranjevati
    const close = await db.closes.get(closeIdFor(settings, d.deskId, monthKey))
    if (close) {
      setErr(`Mesec ${monthLabel(monthKey)} je za to blagajno že zaključen — dokumenta ni mogoče shraniti vanj.`)
      return
    }
    // pravilo: izdatek ne sme preseči stanja blagajne
    if (d.status === 'ODPRT') {
      const cover = await checkBiCover(db, { id: d.id, type: d.type, deskId: d.deskId, amount: d.amount, status: d.status })
      if (cover) { setErr(cover); return }
    }
    const now = nowIso()
    const rec: CashDocument = {
      ...d,
      employeeName: emp?.displayName ?? d.employeeName,
      monthKey,
      amountWordsOverride: overrideWords ? d.amountWordsOverride : '',
      syncStatus: 'LOKALNO',
      updatedAt: now,
      updatedBy: app.userLabel,
      ...(isNew ? { createdAt: now, createdBy: app.userLabel } : {}),
    }
    await db.docs.put(rec)
    await app.audit(isNew ? 'Nov dokument' : 'Sprememba dokumenta', 'BlagajniskiDokument', rec.id,
      `${rec.type} · ${rec.employeeName || 'brez zaposlenega'} · ${rec.amount != null ? fmtEur(rec.amount) : 'brez zneska'} · ${fmtDateTime(txAt(rec))}`)
    onClose()
  }

  async function savePostCloseMeta(patch: Partial<CashDocument>, auditMsg: string) {
    await db.docs.update(d.id, { ...patch, syncStatus: 'LOKALNO', updatedAt: nowIso(), updatedBy: app.userLabel })
    setD((p) => ({ ...p, ...patch }))
    await app.audit(auditMsg, 'BlagajniskiDokument', d.id, '')
  }

  async function addAttachment(files: FileList | null) {
    if (!files || files.length === 0) return
    const list = [...d.attachments]
    for (const f of Array.from(files)) {
      const dataUrl = await fileToDataUrl(f)
      if (dataUrl.length > 2_500_000) {
        alert(`Priloga ${f.name} je prevelika za lokalno shrambo (max ~2 MB).`)
        continue
      }
      list.push({ id: uuid(), name: f.name, mime: f.type, dataUrl, addedAt: nowIso() })
    }
    if (editable) set({ attachments: list })
    else await savePostCloseMeta({ attachments: list }, 'Priloga dodana po zaključku')
  }

  async function saveSignature(sigRole: string, name: string, dataUrl: string) {
    const sig = { role: sigRole, signerName: name, type: 'DIGITALNO' as const, dataUrl, signedAt: nowIso(), capturedBy: app.userLabel }
    const signatures = [...d.signatures.filter((s) => s.role !== sigRole), sig]
    const patch: Partial<CashDocument> = { signatures }
    if (sigRole === 'PREJEL') patch.prejelStatus = 'DIGITALNO'
    if (editable) set(patch)
    else await savePostCloseMeta(patch, 'Podpis dodan po zaključku')
    await app.audit('Podpis zajet', 'BlagajniskiDokument', d.id, `${SIGNATURE_ROLE_LABELS[sigRole]} — ${name}`)
    setSignRole(null)
  }

  const numberLabel = d.officialNumber != null
    ? docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat)
    : 'Osnutek — brez uradne številke'

  const title = (
    <span className="flex items-center gap-2 flex-wrap">
      <span>{isBP ? 'Blagajniški prejemek' : 'Blagajniški izdatek'}</span>
      {d.officialNumber != null
        ? <Chip tone="blue">{numberLabel}</Chip>
        : <Chip tone="amber">Osnutek · brez uradne številke</Chip>}
      {cancelled && <Chip tone="red">STORNIRANO</Chip>}
      {finalized && !cancelled && <Chip tone="green">Zaključen</Chip>}
      {d.syncStatus === 'LOKALNO' && !finalized && !cancelled && <Chip tone="violet">Nesinhronizirano</Chip>}
    </span>
  )

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          {finalized && can(role, 'STORNO', settings) && (
            <Btn kind="danger" onClick={() => setStorno(true)}>Storno / popravek</Btn>
          )}
          <div className="flex-1" />
          <Btn onClick={() => onPrint({ title: numberLabel, docs: [{ doc: d, desk: desks.find((x) => x.id === d.deskId) }] })}>🖨️ Natisni</Btn>
          <Btn onClick={onClose}>Zapri</Btn>
          {editable && <Btn kind="primary" onClick={save}>Shrani</Btn>}
        </>
      }
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      {cancelled && (
        <div className="mb-3"><ErrBox>Dokument je storniran ({d.cancelledBy}, {fmtDateTime(d.cancelledAt ?? '')}). Razlog: {d.cancelReason}</ErrBox></div>
      )}
      {finalized && !cancelled && (
        <div className="mb-3"><Warn>Mesec je zaključen — finančni podatki so zaklenjeni. Dovoljeno je le dodajanje prilog, podpisov in oznake fizičnega podpisa.</Warn></div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Vrsta">
          <select className={inputCls} value={d.type} disabled={!editable} onChange={(e) => set({ type: e.target.value as any })}>
            <option value="BP">BP — prejemek</option>
            <option value="BI">BI — izdatek</option>
          </select>
        </Field>
        <Field label="Blagajna">
          <select className={inputCls} value={d.deskId} disabled={!editable} onChange={(e) => set({ deskId: e.target.value })}>
            <option value="">— izberi —</option>
            {desks.filter((x) => x.active || x.id === d.deskId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Datum transakcije">
          <input type="date" lang="sl-SI" className={inputCls} value={d.transactionDate} disabled={!editable} onChange={(e) => set({ transactionDate: e.target.value })} />
        </Field>
        <Field label="Čas transakcije">
          <input type="time" lang="sl-SI" step="60" className={inputCls} value={d.transactionTime} disabled={!editable} onChange={(e) => set({ transactionTime: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <Field label={isBP ? 'Vplačnik (zaposleni)' : 'Prejemnik (zaposleni)'} hint={editable ? 'Dvoklik ali »➕ Nov zaposleni« odpre vnos novega.' : undefined}>
          <select
            className={inputCls}
            value={d.employeeId}
            disabled={!editable}
            title="Dvoklik = nov zaposleni"
            onDoubleClick={() => editable && setNewEmp(true)}
            onChange={(e) => {
              if (e.target.value === '__new') { setNewEmp(true); return }
              set({ employeeId: e.target.value, potrdiloId: null })
            }}
          >
            <option value="">— izberi zaposlenega —</option>
            <option value="__new">➕ Nov zaposleni …</option>
            {employees.filter((e) => e.active || e.id === d.employeeId).map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
          </select>
        </Field>
        <Field label="Način plačila">
          <div className="flex gap-4 pt-1.5 text-sm">
            {(['GOTOVINA'] as const).map((m) => (
              <label key={m} className="inline-flex items-center gap-1.5">
                <input type="radio" name="pm" checked={d.paymentMethod === m} disabled={!editable} onChange={() => set({ paymentMethod: m })} />
                {'z gotovino'}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {/* Kontekst potrdila o dejavnostih */}
      {d.employeeId && potrdila.length > 0 && (
        <div className="mt-3 rounded-lg border border-blu-100 bg-blu-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-blu-700 mb-1.5">Obdobja dejavnosti zaposlenega (potrdila)</div>
          <div className="space-y-1.5">
            {potrdila.slice().sort((a, b) => b.fromAt.localeCompare(a.fromAt)).slice(0, 4).map((p) => {
              const active = tx >= p.fromAt && tx <= p.toAt
              return (
                <div key={p.id} className={cx('flex flex-wrap items-center gap-2 text-sm rounded-md px-2 py-1', active ? 'bg-white border border-blu-200' : '')}>
                  <span className="font-mono text-[12px]">{fmtDateTime(p.fromAt)} → {fmtDateTime(p.toAt)}</span>
                  {active && <Chip tone="green">pokriva čas transakcije</Chip>}
                  {d.potrdiloId === p.id && <Chip tone="blue">povezano</Chip>}
                  {editable && (
                    <span className="flex gap-1 ml-auto">
                      <Btn kind="ghost" onClick={() => set({ transactionDate: p.fromAt.slice(0, 10), transactionTime: p.fromAt.slice(11, 16) })}>Uporabi začetek</Btn>
                      <Btn kind="ghost" onClick={() => set({ transactionDate: p.toAt.slice(0, 10), transactionTime: p.toAt.slice(11, 16) })}>Uporabi konec</Btn>
                      <Btn kind="ghost" onClick={() => set({ potrdiloId: d.potrdiloId === p.id ? null : p.id })}>{d.potrdiloId === p.id ? 'Odveži' : 'Poveži'}</Btn>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {outsideInterval && (
            <div className="mt-2"><Warn>Čas transakcije je izven obdobja povezanega potrdila ({fmtDateTime(linked!.fromAt)} → {fmtDateTime(linked!.toAt)}). Preverite datum in čas — shranjevanje ni blokirano.</Warn></div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <Field
          label="Znesek (EUR)"
          hint={!isBP && editable && avail != null ? `Na voljo v blagajni: ${fmtEur(avail)} — izdatek ne sme preseči stanja.` : undefined}
        >
          <input
            className={cx(inputCls, 'font-mono text-right', !isBP && editable && avail != null && d.amount != null && d.amount > avail && 'border-red-400 bg-red-50')}
            inputMode="decimal"
            placeholder="0,00"
            value={amountText}
            disabled={!editable}
            onChange={(e) => {
              setAmountText(e.target.value)
              set({ amount: parseAmount(e.target.value) })
            }}
          />
        </Field>
        <Field label="Znesek z besedo" className="md:col-span-2" hint={overrideWords ? 'Ročni vnos — samodejni izračun je izklopljen.' : 'Samodejno iz zneska.'}>
          <div className="flex gap-2">
            <input
              className={cx(inputCls, 'font-mono')}
              value={overrideWords ? d.amountWordsOverride : words}
              disabled={!editable || !overrideWords}
              onChange={(e) => set({ amountWordsOverride: e.target.value })}
            />
            {editable && (
              <Btn onClick={() => { setOverrideWords(!overrideWords); if (overrideWords) set({ amountWordsOverride: '' }); else set({ amountWordsOverride: words }) }}>
                {overrideWords ? 'Samodejno' : 'Ročno'}
              </Btn>
            )}
          </div>
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Za (namen)">
          <input className={inputCls} value={d.purpose} disabled={!editable} onChange={(e) => set({ purpose: e.target.value })} placeholder="npr. Akontacija za službeno pot" />
        </Field>
      </div>

      {/* Knjigovodske vrstice */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Knjigovodske vrstice ({isBP ? 'v dobro' : 'v breme'})</span>
          {editable && <Btn kind="ghost" onClick={() => set({ rows: [...d.rows, { opis: '', konto: '', znesek: null }] })}>+ vrstica</Btn>}
        </div>
        {d.rows.length === 0 && <div className="text-sm text-slate-400">Ni vrstic — konto po potrebi dodajte z gumbom »+ vrstica« (ni obvezno).</div>}
        {d.rows.length > 0 && (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase text-slate-500">
                <th className="py-1 pr-2">Opis</th>
                <th className="py-1 pr-2 w-32">Konto</th>
                <th className="py-1 pr-2 w-32 text-right">EUR</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, i) => (
                <RowEdit key={i} r={r} disabled={!editable}
                  onChange={(nr) => set({ rows: d.rows.map((x, j) => (j === i ? nr : x)) })}
                  onRemove={() => set({ rows: d.rows.filter((_, j) => j !== i) })}
                />
              ))}
              <tr className="border-t border-slate-200 font-medium">
                <td className="py-1 pr-2 text-right" colSpan={2}>Skupaj vrstice</td>
                <td className={cx('py-1 pr-2 text-right font-mono', sumRows(d.rows) !== (d.amount ?? 0) && d.rows.length > 0 && 'text-amber-600')}>
                  {fmtEur(sumRows(d.rows))}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
        {d.rows.length > 0 && sumRows(d.rows) !== (d.amount ?? 0) && (
          <div className="mt-1 text-[12px] text-amber-600">Vsota vrstic se ne ujema z zneskom dokumenta — opozorilo, shranjevanje ni blokirano.</div>
        )}
      </div>

      {/* Prejel status (BI) */}
      {!isBP && (
        <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
          <Field label="Status polja »Prejel« (podpis prejemnika)">
            <select
              className={inputCls}
              value={d.prejelStatus}
              onChange={async (e) => {
                const v = e.target.value as PrejelStatus
                if (editable) set({ prejelStatus: v })
                else await savePostCloseMeta({ prejelStatus: v }, 'Sprememba statusa Prejel')
              }}
            >
              {(Object.keys(PREJEL_LABELS) as PrejelStatus[]).map((k) => <option key={k} value={k}>{PREJEL_LABELS[k]}</option>)}
            </select>
          </Field>
          <div className="text-[11px] text-orange-800 mt-1">Običajen potek: mesec se zaključi → dokument natisnete → voznik podpiše »Prejel« ročno → tukaj označite »Ročno podpisano« in po želji pripnete sken.</div>
        </div>
      )}

      {/* Podpisi */}
      <div className="mt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Podpisi (neobvezno)</span>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-1">
          {roles.map((r) => {
            const sig = d.signatures.find((s) => s.role === r)
            return (
              <div key={r} className={cx('rounded-md border p-2', r === 'PREJEL' ? 'border-orange-300' : 'border-slate-200')}>
                <div className="text-[11px] font-medium text-slate-600">{SIGNATURE_ROLE_LABELS[r]}</div>
                {sig ? (
                  <div className="mt-1">
                    {sig.dataUrl && <img src={sig.dataUrl} alt="" className="h-8" />}
                    <div className="text-[11px] text-slate-500">{sig.signerName} · {fmtDateTime(sig.signedAt)}</div>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">ni podpisano</span>
                    <Btn kind="ghost" onClick={() => setSignRole(r)}>Podpiši</Btn>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Priloge */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Priloge ({d.attachments.length})</span>
          <label className="text-sm text-blu-600 hover:bg-blu-50 rounded-md px-3 py-1.5 cursor-pointer font-medium">
            + Dodaj prilogo / fotografijo
            <input type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => addAttachment(e.target.files)} />
          </label>
        </div>
        {d.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {d.attachments.map((a) => (
              <div key={a.id} className="border border-slate-200 rounded-md p-1.5 w-28">
                {a.mime.startsWith('image/')
                  ? <img src={a.dataUrl} alt={a.name} className="h-16 w-full object-cover rounded" />
                  : <div className="h-16 grid place-items-center text-2xl">📄</div>}
                <div className="text-[10px] truncate mt-1" title={a.name}>{a.name}</div>
                {editable && <button className="text-[10px] text-red-600" onClick={() => set({ attachments: d.attachments.filter((x) => x.id !== a.id) })}>odstrani</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <Field label="Opombe">
          <textarea className={cx(inputCls, 'h-16')} value={d.notes} disabled={!editable} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>

      {signRole && (
        <SignaturePad
          title={SIGNATURE_ROLE_LABELS[signRole]}
          defaultName={signRole === 'PREJEL' || signRole === 'VPLACAL' ? d.employeeName : app.userLabel}
          onClose={() => setSignRole(null)}
          onSave={(name, dataUrl) => saveSignature(signRole, name, dataUrl)}
        />
      )}

      {storno && (
        <StornoModal
          doc={d}
          onClose={() => setStorno(false)}
          onDone={(nd) => { setD(nd); setStorno(false) }}
        />
      )}

      {newEmp && (
        <EmployeeEdit
          emp={null}
          onClose={() => setNewEmp(false)}
          onSaved={(emp) => { set({ employeeId: emp.id, employeeName: emp.displayName, potrdiloId: null }); setNewEmp(false) }}
        />
      )}
    </Modal>
  )
}

function sumRows(rows: AccountingRow[]): number {
  return Math.round(rows.reduce((s, r) => s + (r.znesek ?? 0), 0) * 100) / 100
}

function RowEdit({ r, disabled, onChange, onRemove }: { r: AccountingRow; disabled: boolean; onChange: (r: AccountingRow) => void; onRemove: () => void }) {
  const [z, setZ] = useState(r.znesek != null ? String(r.znesek).replace('.', ',') : '')
  return (
    <tr>
      <td className="py-0.5 pr-2"><input className={inputCls} value={r.opis} disabled={disabled} onChange={(e) => onChange({ ...r, opis: e.target.value })} /></td>
      <td className="py-0.5 pr-2"><input className={cx(inputCls, 'font-mono')} value={r.konto} disabled={disabled} onChange={(e) => onChange({ ...r, konto: e.target.value })} /></td>
      <td className="py-0.5 pr-2">
        <input className={cx(inputCls, 'font-mono text-right')} inputMode="decimal" value={z} disabled={disabled}
          onChange={(e) => { setZ(e.target.value); onChange({ ...r, znesek: parseAmount(e.target.value) }) }} />
      </td>
      <td>{!disabled && <button className="text-slate-400 hover:text-red-600" onClick={onRemove} title="Odstrani vrstico">✕</button>}</td>
    </tr>
  )
}

export function StornoModal({ doc, onClose, onDone }: { doc: CashDocument; onClose: () => void; onDone: (d: CashDocument) => void }) {
  const app = useApp()
  const { db, settings } = app
  const [reason, setReason] = useState('')
  const [makeCopy, setMakeCopy] = useState(true)
  const [err, setErr] = useState('')

  async function run() {
    if (!reason.trim()) { setErr('Vpišite razlog storna.'); return }
    try {
      await stornoDoc(db, settings, doc.id, reason.trim(), app.userLabel)
      if (makeCopy && doc.type === 'BI') {
        const cover = await checkBiCover(db, { id: '', type: 'BI', deskId: doc.deskId, amount: doc.amount, status: 'ODPRT' })
        if (cover) {
          alert(`Storno je izveden, popravek pa NI bil ustvarjen. ${cover}`)
          const nd0 = await db.docs.get(doc.id)
          onDone(nd0!)
          return
        }
      }
      if (makeCopy) {
        const draft = emptyDoc({
          deskId: doc.deskId, type: doc.type,
          transactionDate: todayIso(), transactionTime: nowTime(), monthKey: todayIso().slice(0, 7),
          employeeId: doc.employeeId, employeeName: doc.employeeName,
          amount: doc.amount, paymentMethod: doc.paymentMethod,
          purpose: `Popravek ${docNo(doc.type, doc.officialNumber, doc.seqYear, settings.numberFormat)}: ${doc.purpose}`,
          rows: doc.rows.map((r) => ({ ...r })),
          correctionOfId: doc.id,
          createdBy: app.userLabel, updatedBy: app.userLabel,
        })
        await db.docs.put(draft)
        await app.audit('Popravek ustvarjen', 'BlagajniskiDokument', draft.id, `Popravek za ${doc.id}`)
      }
      const nd = await db.docs.get(doc.id)
      onDone(nd!)
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    }
  }

  return (
    <Modal
      title="Storno / popravek zaključenega dokumenta"
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Prekliči</Btn>
        <Btn kind="danger" onClick={run}>Potrdi storno</Btn>
      </>}
    >
      {err && <div className="mb-2"><ErrBox>{err}</ErrBox></div>}
      <p className="text-sm text-slate-600">
        Uradna številka <b>{docNo(doc.type, doc.officialNumber, doc.seqYear, settings.numberFormat)}</b> ostane rezervirana,
        dokument bo vidno označen kot STORNIRAN. Številke se nikoli tiho ne spreminjajo.
      </p>
      <div className="mt-3">
        <Field label="Razlog storna (obvezno)">
          <textarea className={cx(inputCls, 'h-20')} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="npr. napačen znesek — pravilno 120,00 EUR" />
        </Field>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm">
        <input type="checkbox" checked={makeCopy} onChange={(e) => setMakeCopy(e.target.checked)} />
        Ustvari popravek kot nov osnutek v tekočem odprtem mesecu
      </label>
    </Modal>
  )
}

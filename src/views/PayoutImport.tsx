import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import { Btn, Chip, ErrBox, Field, Modal, Warn, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { availableInDesk } from '../lib/balance'
import { buildPayoutParts, payoutWindow, readPayoutSource, type PayoutSourceRow } from '../lib/payoutImport'
import { fmtEur, nowIso, uuid } from '../lib/util'
import { physicalDesks } from '../lib/desks'
import { closeIdFor } from '../lib/numbering'

export function PayoutImportModal({ initialMonth, initialDeskId, onClose, onDone }: {
  initialMonth: string
  initialDeskId: string
  onClose: () => void
  onDone: () => void
}) {
  const app = useApp()
  const { db, settings } = app
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  const potrdila = useLiveQuery(() => db.potrdila.toArray(), []) ?? []
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const closes = useLiveQuery(() => db.closes.toArray(), []) ?? []
  const locations = physicalDesks(desks).filter((d) => d.active)
  const [month, setMonth] = useState(initialMonth)
  const [deskId, setDeskId] = useState(() => locations.some((d) => d.id === initialDeskId) ? initialDeskId : '')
  const [source, setSource] = useState<PayoutSourceRow[]>([])
  const [fileName, setFileName] = useState('')
  const [purpose, setPurpose] = useState('Akontacija')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!deskId && locations.length) {
      const preferred = locations.find((d) => d.id === initialDeskId) ?? locations[0]
      setDeskId(preferred.id)
    }
  }, [deskId, initialDeskId, locations])

  const parts = useMemo(() => buildPayoutParts(source, employees, potrdila, month), [source, employees, potrdila, month])
  const win = payoutWindow(month)
  const total = parts.reduce((s, p) => s + p.amount, 0)
  const unmatched = parts.filter((p) => !p.employee).length
  const fallback = parts.filter((p) => p.dateSource === 'WINDOW').length
  const closedParts = parts.filter((p) => closes.some((c) => c.id === closeIdFor(settings, deskId, p.date.slice(0, 7))))

  async function load(file: File | null) {
    if (!file) return
    setErr('')
    try {
      const rows = await readPayoutSource(file)
      if (!rows.length) throw new Error('V datoteki ni veljavnih vrstic z imenom, priimkom in zneskom.')
      setSource(rows)
      setFileName(file.name)
    } catch (e: any) {
      setSource([])
      setFileName('')
      setErr(String(e?.message ?? e))
    }
  }

  async function save() {
    setErr('')
    if (!deskId) { setErr('Izberite interno lokacijo blagajne.'); return }
    if (!parts.length) { setErr('Najprej izberite Excel/CSV datoteko.'); return }
    if (unmatched) { setErr('Uvoz ni mogoč, dokler vsi zaposleni niso enolično najdeni v seznamu zaposlenih.'); return }
    if (closedParts.length) { setErr('Nekateri ustvarjeni datumi padejo v že zaključen mesec za izbrano blagajno. Izberite drugo obdobje ali lokacijo.'); return }
    const available = await availableInDesk(db, deskId)
    if (total > available + 0.001) { setErr(`V izbrani blagajni ni dovolj sredstev. Na voljo ${fmtEur(available)}, uvoz pa vsebuje ${fmtEur(total)}.`); return }
    setBusy(true)
    try {
      const at = nowIso()
      const docs = parts.map((p, i) => emptyDoc({
        id: uuid(),
        deskId,
        type: 'BI',
        transactionDate: p.date,
        transactionTime: p.time,
        monthKey: p.date.slice(0, 7),
        employeeId: p.employee!.id,
        employeeName: p.employee!.displayName,
        amount: p.amount,
        paymentMethod: 'GOTOVINA',
        purpose: purpose.trim() || 'Akontacija',
        rows: [],
        potrdiloId: p.potrdiloId,
        notes: `Uvoz akontacij: ${fileName} · vrstica ${p.sourceRow} · izvorni znesek ${p.originalAmount.toFixed(2)} EUR · razpored ${p.date} ${p.time}${p.dateSource === 'WINDOW' ? ' · datum iz okna 20.–16.' : ' · datum meja dopust lista'}`,
        status: 'ODPRT',
        syncStatus: 'LOKALNO',
        createdAt: at,
        createdBy: app.userLabel,
        updatedAt: at,
        updatedBy: app.userLabel,
      }))
      await db.docs.bulkPut(docs)
      await app.audit('Uvoz akontacij', 'BlagajniskiDokument', 'batch', `${fileName} · ${source.length} vrstic → ${docs.length} BI · ${fmtEur(total)} · ${win.start}–${win.end}`)
      if (app.mode === 'server') await app.syncNow()
      onDone()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Uvoz akontacij iz Excel-a / CSV" wide onClose={onClose} footer={<><Btn onClick={onClose}>Prekliči</Btn><div className="flex-1"/><Btn kind="primary" disabled={busy || !parts.length} onClick={save}>Ustvari {parts.length || ''} BI dokumentov</Btn></>}>
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      <div className="mb-3 rounded-lg border border-blu-200 bg-blu-50 px-3 py-2 text-[12px] text-blu-900">
        <b>To je ločen uvoz akontacij.</b> Ne dodaja in ne spreminja zaposlenih. Seznam zaposlenih se še naprej uvaža posebej v zavihku <b>Zaposleni → Uvoz zaposlenih CSV</b>.
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <Field label="Obdobje" hint="Datumi se določajo med 20. tega meseca in 16. naslednjega."><input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Field label="Interna blagajna / lokacija"><select className={inputCls} value={deskId} onChange={(e) => setDeskId(e.target.value)}><option value="">— izberi —</option>{locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Namen"><input className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">⇧ Izberi akontacije Excel (.xlsx) / CSV<input type="file" className="hidden" accept=".xlsx,.csv,text/csv" onChange={(e) => { void load(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} /></label>
        {fileName && <Chip tone="blue">{fileName}</Chip>}
        <Chip>{source.length} izvornih vrstic</Chip><Chip tone="red">{parts.length} BI</Chip><Chip tone="blue">skupaj {fmtEur(total)}</Chip>
      </div>
      <div className="mt-3"><Warn>Pravilo za akontacije: znesek do vključno 700 € ostane en BI. Znesek nad 700 € se razdeli na več delov med 300 € in 500 €, pri čemer je vsota delov vedno natančno enaka izvornemu znesku. Deli se razporedijo na različne dneve in različne ure znotraj obdobja {win.start}–{win.end}; meje dopust lista se uporabijo prednostno, preostali deli pa se razpršijo po oknu 20.–16.</Warn></div>
      {(unmatched > 0 || fallback > 0 || closedParts.length > 0) && <div className="mt-2 flex gap-2 flex-wrap">{unmatched > 0 && <Chip tone="red">{unmatched} brez ujemanja zaposlenega</Chip>}{fallback > 0 && <Chip tone="amber">{fallback} datumov brez meje dopust lista</Chip>}{closedParts.length > 0 && <Chip tone="red">{closedParts.length} v zaključenem mesecu</Chip>}</div>}
      <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm"><thead className="sticky top-0 bg-slate-50 text-[11px] uppercase text-slate-500"><tr><th className="px-2 py-2 text-left">Vrstica</th><th className="px-2 py-2 text-left">Zaposleni</th><th className="px-2 py-2 text-right">Izvorno</th><th className="px-2 py-2 text-right">BI znesek</th><th className="px-2 py-2 text-left">Datum</th><th className="px-2 py-2 text-left">Čas</th><th className="px-2 py-2 text-left">Vir datuma / opozorilo</th></tr></thead>
          <tbody>{parts.map((p, i) => <tr key={`${p.sourceRow}-${i}`} className="border-t border-slate-100"><td className="px-2 py-1 font-mono">{p.sourceRow}</td><td className="px-2 py-1">{p.employee ? p.employee.displayName : <span className="text-red-700 font-medium">{p.employeeName} — ni najden</span>}</td><td className="px-2 py-1 text-right font-mono">{fmtEur(p.originalAmount)}</td><td className="px-2 py-1 text-right font-mono font-semibold">{fmtEur(p.amount)}</td><td className="px-2 py-1 font-mono">{p.date}</td><td className="px-2 py-1 font-mono">{p.time}</td><td className="px-2 py-1 text-[12px]">{p.dateSource === 'POTRDILO_START' ? 'začetek dopust lista' : p.dateSource === 'POTRDILO_END' ? 'konec dopust lista' : 'okno 20.–16.'}{p.warning && <div className="text-amber-700">{p.warning}</div>}</td></tr>)}</tbody>
        </table>
        {!parts.length && <div className="p-8 text-center text-slate-400">Izberite datoteko. Pričakovani stolpci: <b>Ime</b>, <b>Priimek</b>, <b>Znesek/Vrednost</b>.</div>}
      </div>
    </Modal>
  )
}

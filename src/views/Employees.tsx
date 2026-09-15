import React, { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDocument, Employee } from '../types'
import { ACTIVITY_LABELS } from '../types'
import { cx, docNo, fmtDate, fmtDateTime, fmtEur, nowIso, nowTime, todayIso, uuid } from '../lib/util'
import { can } from '../lib/perms'
import { Btn, Chip, Field, Modal, inputCls } from '../components/ui'
import { putEmployee } from '../lib/persist'
import { downloadText, downloadXlsx, XLSX_STYLE, type XlsxCell, type XlsxWorkbook } from '../lib/xlsx'

export function EmployeesView({
  onOpenDoc, onOpenPotrdilo,
}: {
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
  onOpenPotrdilo: (id: string | null, employeeId?: string) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  const docs = useLiveQuery(() => db.docs.toArray(), []) ?? []
  const potrdila = useLiveQuery(() => db.potrdila.toArray(), []) ?? []
  const [sel, setSel] = useState<string | null>(null)
  const [edit, setEdit] = useState<Employee | null>(null)
  const [search, setSearch] = useState('')

  const manage = can(role, 'MANAGE_EMPLOYEES', settings)
  const list = employees
    .filter((e) => !search || e.displayName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.lastName.localeCompare(b.lastName))
  const selected = employees.find((e) => e.id === sel) ?? null

  function downloadEmployeeCsvTemplate() {
    const head = ['Ime', 'Priimek', 'Interna številka', 'Datum rojstva', 'Datum začetka zaposlitve', 'Št. dovoljenja / OI / potnega lista', 'Telefon', 'Vozilo', 'Opombe', 'Aktiven']
    downloadText('\uFEFF' + head.join(';') + '\r\n', 'zaposleni-import-vzorec.csv', 'text/csv;charset=utf-8')
  }

  function downloadEmployeeExcelTemplate() {
    const headers = ['Ime', 'Priimek', 'Interna številka', 'Datum rojstva', 'Datum začetka zaposlitve', 'Št. dovoljenja / OI / potnega lista', 'Telefon', 'Vozilo', 'Opombe', 'Aktiven']
    const rows: XlsxCell[][] = [headers.map((value) => ({ value, style: XLSX_STYLE.HEADER }))]
    for (let i = 0; i < 100; i++) {
      rows.push([
        { style: XLSX_STYLE.TEMPLATE_TEXT }, { style: XLSX_STYLE.TEMPLATE_TEXT }, { style: XLSX_STYLE.TEMPLATE_TEXT },
        { style: XLSX_STYLE.TEMPLATE_DATE }, { style: XLSX_STYLE.TEMPLATE_DATE }, { style: XLSX_STYLE.TEMPLATE_TEXT },
        { style: XLSX_STYLE.TEMPLATE_TEXT }, { style: XLSX_STYLE.TEMPLATE_TEXT }, { style: XLSX_STYLE.TEMPLATE_TEXT },
        { style: XLSX_STYLE.TEMPLATE_ACTIVE },
      ])
    }
    const instructions: XlsxCell[][] = [
      [{ value: 'Predloga za uvoz zaposlenih', style: XLSX_STYLE.TITLE }],
      [{ value: 'Kako uporabiti datoteko', style: XLSX_STYLE.SECTION }],
      [{ value: '1. Na listu »Zaposleni« vnesite zaposlene. Ime in priimek sta obvezna; ostala polja so neobvezna.', style: XLSX_STYLE.BODY }],
      [{ value: '2. Datum vnesite kot pravi Excel datum. Predloga ga prikaže v obliki dd.mm.yyyy.', style: XLSX_STYLE.BODY_ALT }],
      [{ value: '3. V stolpcu »Aktiven« uporabite Da ali Ne. Če pustite prazno, se zaposleni uvozi kot aktiven.', style: XLSX_STYLE.BODY }],
      [{ value: '4. Za uvoz v aplikacijo shranite list »Zaposleni« kot CSV UTF-8 (ločilo je lahko podpičje, vejica ali tabulator).', style: XLSX_STYLE.BODY_ALT }],
      [{ value: '5. Nato v aplikaciji kliknite »Uvozi CSV«. Obstoječe osebe se ujemajo po interni številki oziroma imenu in priimku.', style: XLSX_STYLE.BODY }],
      [],
      [{ value: 'Obvezno', style: XLSX_STYLE.SECTION }],
      [{ value: 'Ime, Priimek', style: XLSX_STYLE.BODY }],
      [{ value: 'Neobvezno', style: XLSX_STYLE.SECTION }],
      [{ value: 'Interna številka, datum rojstva, datum začetka zaposlitve, dokument, telefon, vozilo, opombe, aktivnost', style: XLSX_STYLE.BODY }],
    ]
    const book: XlsxWorkbook = {
      title: 'Predloga za uvoz zaposlenih', subject: 'Uvoz zaposlenih v blagajno', creator: 'Blagajna BLU', company: 'Bonta d.o.o.',
      sheets: [
        {
          name: 'Zaposleni', rows, widths: [18, 22, 18, 17, 24, 34, 20, 16, 34, 12], freezeRows: 1,
          autoFilter: 'A1:J101', rowHeights: { 1: 34 }, showGridLines: false, landscape: true,
          dataValidations: [{ sqref: 'J2:J101', formula1: '"Da,Ne"', allowBlank: true, promptTitle: 'Aktiven', prompt: 'Izberite Da ali Ne.', errorTitle: 'Neveljavna vrednost', error: 'Vnesite Da ali Ne.' }],
        },
        {
          name: 'Navodila', rows: instructions, widths: [110], rowHeights: { 1: 28, 2: 22, 9: 22, 11: 22 }, showGridLines: false, landscape: false,
        },
      ],
    }
    downloadXlsx(book, 'zaposleni-import-predloga.xlsx')
  }

  async function importEmployees(file: File | null) {
    if (!file) return
    try {
      const imported = parseEmployeesCsv(await file.text())
      if (imported.length === 0) { alert('V datoteki ni bilo mogoče najti zaposlenih. Preverite glavo CSV.'); return }

      const existing = await db.employees.toArray()
      let added = 0
      let updated = 0
      for (const row of imported) {
        const byNo = row.employeeNumber && existing.find((x) => x.employeeNumber && x.employeeNumber.toLowerCase() === row.employeeNumber.toLowerCase())
        const byName = existing.find((x) => x.displayName.toLowerCase() === row.displayName.toLowerCase())
        const old = byNo || byName
        const rec: Employee = {
          id: old?.id ?? uuid(),
          firstName: row.firstName || old?.firstName || '',
          lastName: row.lastName || old?.lastName || '',
          displayName: row.displayName || old?.displayName || '',
          dateOfBirth: row.dateOfBirth || old?.dateOfBirth || '',
          idNumber: row.idNumber || old?.idNumber || '',
          employmentStart: row.employmentStart || old?.employmentStart || '',
          employeeNumber: row.employeeNumber || old?.employeeNumber || '',
          phone: row.phone || old?.phone || '',
          vehicle: row.vehicle || old?.vehicle || '',
          notes: row.notes || old?.notes || '',
          active: row.active ?? old?.active ?? true,
          createdAt: old?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        }
        await putEmployee(db, rec)
        if (old) updated++; else { added++; existing.push(rec) }
      }
      await app.audit('Uvoz zaposlenih', 'Zaposleni', file.name, `${added} novih · ${updated} posodobljenih`)
      alert(`Uvoz končan: ${added} novih, ${updated} posodobljenih zaposlenih.`)
    } catch (e: any) {
      alert(`Uvoz ni uspel: ${String(e?.message ?? e)}`)
    }
  }

  return (
    <div className="grid md:grid-cols-[320px_1fr] gap-4 md:h-[620px]">
      <div className="min-h-0 flex flex-col">
        <div className="flex flex-wrap gap-2 items-center shrink-0">
          <input className={cx(inputCls, 'min-w-[160px] flex-1')} placeholder="Išči zaposlenega …" value={search} onChange={(e) => setSearch(e.target.value)} />
          {manage && (
            <label className="inline-flex shrink-0 cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50" title="Uvozi seznam zaposlenih iz CSV datoteke">
              ⇧ Uvozi CSV
              <input type="file" accept=".csv,.tsv,text/csv,text/plain,text/tab-separated-values" className="hidden" onChange={(e) => { void importEmployees(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} />
            </label>
          )}
          {manage && <Btn onClick={downloadEmployeeExcelTemplate} title="Prenesi lepo oblikovano Excel predlogo z navodili">⬇ Excel predloga</Btn>}
          {manage && <Btn onClick={downloadEmployeeCsvTemplate} title="Prenesi prazno CSV predlogo za neposreden uvoz">CSV predloga</Btn>}
          {manage && <Btn kind="primary" onClick={() => setEdit(newEmployee())}>+ Nov</Btn>}
        </div>
        <div className="mt-2 min-h-0 flex-1 rounded-lg border border-slate-200 bg-white divide-y divide-slate-100 overflow-y-auto overscroll-contain">
          {list.map((e) => (
            <button key={e.id} className={cx('w-full text-left px-3 py-2 hover:bg-blu-50 flex items-center gap-2', sel === e.id && 'bg-blu-50 border-l-2 border-blu-600')} onClick={() => setSel(e.id)}>
              <span className="flex-1">
                <span className="font-medium">{e.displayName}</span>
                {e.vehicle && <span className="block text-[11px] text-slate-400 font-mono">{e.vehicle}</span>}
              </span>
              {!e.active && <Chip tone="slate">neaktiven</Chip>}
            </button>
          ))}
          {list.length === 0 && <div className="px-3 py-6 text-center text-slate-400 text-sm">Ni zadetkov.</div>}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {!selected && <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-400">Izberite zaposlenega s seznama.</div>}
        {selected && (
          <EmployeeDetail
            e={selected}
            docs={docs.filter((d) => d.employeeId === selected.id)}
            potrdila={potrdila.filter((p) => p.employeeId === selected.id)}
            onEdit={manage ? () => setEdit({ ...selected }) : undefined}
            onOpenDoc={onOpenDoc}
            onOpenPotrdilo={onOpenPotrdilo}
          />
        )}
      </div>

      {edit && <EmployeeEdit emp={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}


type ImportedEmployee = Pick<Employee, 'firstName' | 'lastName' | 'displayName' | 'dateOfBirth' | 'idNumber' | 'employmentStart' | 'employeeNumber' | 'phone' | 'vehicle' | 'notes'> & { active?: boolean }

function normHeader(v: string) {
  return v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ }
      else quoted = !quoted
    } else if (ch === delimiter && !quoted) {
      out.push(cur.trim()); cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

function normalizeImportDate(value: string): string {
  const v = value.trim()
  if (!v) return ''
  let y: number, m: number, d: number
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  if (hit) {
    y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3])
  } else {
    hit = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\.?$/.exec(v)
    if (!hit) return v
    d = Number(hit[1]); m = Number(hit[2]); y = Number(hit[3])
  }
  const check = new Date(Date.UTC(y, m - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return v
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseEmployeesCsv(text: string): ImportedEmployee[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.trim())
  if (lines.length < 2) return []
  const first = lines[0]
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ','
  const headers = parseCsvLine(first, delimiter).map(normHeader)
  const idx = (...names: string[]) => {
    const n = names.map(normHeader)
    return headers.findIndex((h) => n.includes(h))
  }
  const col = {
    first: idx('ime', 'first name', 'firstname'),
    last: idx('priimek', 'last name', 'lastname'),
    display: idx('ime in priimek', 'zaposleni', 'display name', 'displayname', 'naziv'),
    dob: idx('datum rojstva', 'rojstni datum', 'date of birth', 'birth date'),
    id: idx('st dovoljenja oi potnega lista', 'st vozniskega dovoljenja oi potnega lista', 'stevilka dokumenta', 'st dokumenta', 'id number', 'document number'),
    start: idx('datum zacetka zaposlitve', 'zaposlen od', 'employment start', 'start date'),
    no: idx('interna stevilka', 'sifra zaposlenega', 'stevilka zaposlenega', 'employee number', 'employee no'),
    phone: idx('telefon', 'phone', 'telephone'),
    vehicle: idx('vozilo', 'vehicle', 'registracija'),
    notes: idx('opombe', 'notes', 'note'),
    active: idx('aktiven', 'active'),
  }
  const val = (r: string[], i: number) => i >= 0 ? (r[i] ?? '').trim() : ''
  const rows: ImportedEmployee[] = []
  for (const line of lines.slice(1)) {
    const r = parseCsvLine(line, delimiter)
    let firstName = val(r, col.first)
    let lastName = val(r, col.last)
    let displayName = val(r, col.display)
    if (!displayName) displayName = `${firstName} ${lastName}`.trim()
    if ((!firstName || !lastName) && displayName) {
      const parts = displayName.split(/\s+/)
      if (!lastName && parts.length > 1) lastName = parts.pop() ?? ''
      if (!firstName) firstName = parts.join(' ')
    }
    if (!firstName || !lastName) continue
    const activeRaw = val(r, col.active).toLowerCase()
    rows.push({
      firstName, lastName, displayName: `${firstName} ${lastName}`.trim(),
      dateOfBirth: normalizeImportDate(val(r, col.dob)), idNumber: val(r, col.id), employmentStart: normalizeImportDate(val(r, col.start)),
      employeeNumber: val(r, col.no), phone: val(r, col.phone), vehicle: val(r, col.vehicle), notes: val(r, col.notes),
      active: activeRaw ? !['0', 'ne', 'no', 'false', 'inactive', 'neaktiven'].includes(activeRaw) : undefined,
    })
  }
  return rows
}

function newEmployee(): Employee {
  return {
    id: uuid(), firstName: '', lastName: '', displayName: '',
    dateOfBirth: '', idNumber: '', employmentStart: '',
    employeeNumber: '', phone: '', vehicle: '', notes: '',
    active: true, createdAt: nowIso(), updatedAt: nowIso(),
  }
}

function EmployeeDetail({
  e, docs, potrdila, onEdit, onOpenDoc, onOpenPotrdilo,
}: {
  e: Employee
  docs: CashDocument[]
  potrdila: any[]
  onEdit?: () => void
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
  onOpenPotrdilo: (id: string | null, employeeId?: string) => void
}) {
  const app = useApp()
  const recent = docs.slice().sort((a, b) => (b.transactionDate + b.transactionTime).localeCompare(a.transactionDate + a.transactionTime))
  const now = `${todayIso()}T${nowTime()}`
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <h2 className="text-lg font-semibold">{e.displayName}</h2>
          <div className="text-[12px] text-slate-500 mt-0.5 space-x-3">
            <span>rojen: <b>{fmtDate(e.dateOfBirth) || '—'}</b></span>
            <span>dovoljenje/OI: <b className="font-mono">{e.idNumber || '—'}</b></span>
            <span>zaposlen od: <b>{fmtDate(e.employmentStart) || '—'}</b></span>
            {e.vehicle && <span>vozilo: <b className="font-mono">{e.vehicle}</b></span>}
          </div>
        </div>
        <div className="flex-1" />
        {onEdit && <Btn onClick={onEdit}>Uredi</Btn>}
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <Btn kind="success" onClick={() => onOpenDoc(null, { type: 'BP', employeeId: e.id, employeeName: e.displayName, deskId: app.settings.activeDeskId })}>+ BP</Btn>
        <Btn kind="danger" onClick={() => onOpenDoc(null, { type: 'BI', employeeId: e.id, employeeName: e.displayName, deskId: app.settings.activeDeskId })}>+ BI</Btn>
        <Btn onClick={() => onOpenPotrdilo(null, e.id)}>+ Potrdilo o dejavnostih</Btn>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Blagajniški dokumenti ({docs.length})</div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto overscroll-contain pr-1">
            {recent.slice(0, 8).map((d) => (
              <button key={d.id} className="flex w-full items-center gap-2 text-sm bg-slate-50 hover:bg-blu-50 rounded-md px-2 py-1 border border-slate-100" onClick={() => onOpenDoc(d.id)}>
                <Chip tone={d.type === 'BP' ? 'green' : 'red'}>{d.type}</Chip>
                <span className="font-mono text-[12px]">{fmtDate(d.transactionDate)} {d.transactionTime}</span>
                <span className="flex-1 text-left truncate">{d.purpose || '—'}</span>
                <span className="font-mono">{fmtEur(d.amount)}</span>
                {d.status === 'STORNIRAN' && <Chip tone="red">storno</Chip>}
                <span className="font-mono text-[11px] text-slate-500">{d.officialNumber != null ? docNo(d.type, d.officialNumber, d.seqYear, app.settings.numberFormat) : 'osnutek'}</span>
              </button>
            ))}
            {docs.length === 0 && <div className="text-sm text-slate-400">Ni dokumentov.</div>}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Potrdila o dejavnostih ({potrdila.length})</div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto overscroll-contain pr-1">
            {potrdila.slice().sort((a: any, b: any) => b.fromAt.localeCompare(a.fromAt)).map((p: any) => {
              const active = p.fromAt <= now && now <= p.toAt
              return (
                <button key={p.id} className="flex w-full items-center gap-2 text-sm bg-slate-50 hover:bg-blu-50 rounded-md px-2 py-1 border border-slate-100" onClick={() => onOpenPotrdilo(p.id)}>
                  <span className="font-mono text-[12px]">{fmtDateTime(p.fromAt)} → {fmtDateTime(p.toAt)}</span>
                  <span className="flex-1 text-left truncate text-[12px] text-slate-500">{ACTIVITY_LABELS[p.activityType as keyof typeof ACTIVITY_LABELS]}</span>
                  {active && <Chip tone="green">aktivno</Chip>}
                </button>
              )
            })}
            {potrdila.length === 0 && <div className="text-sm text-slate-400">Ni potrdil.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export function EmployeeEdit({ emp, onClose, onSaved }: { emp: Employee | null; onClose: () => void; onSaved?: (e: Employee) => void }) {
  const app = useApp()
  const { db } = app
  const [e, setE] = useState<Employee>({ ...(emp ?? newEmployee()) })
  const set = (patch: Partial<Employee>) => setE((x) => ({ ...x, ...patch }))
  const isNew = !emp || !emp.displayName

  async function save() {
    if (!e.firstName.trim() || !e.lastName.trim()) { alert('Vnesite ime in priimek.'); return }
    const rec = await putEmployee(db, { ...e, displayName: `${e.firstName.trim()} ${e.lastName.trim()}` })
    await app.audit(isNew ? 'Nov zaposleni' : 'Sprememba zaposlenega', 'Zaposleni', rec.id, rec.displayName)
    onSaved?.(rec)
    onClose()
  }

  return (
    <Modal
      title={isNew ? 'Nov zaposleni / voznik' : `Uredi — ${emp!.displayName}`}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Prekliči</Btn>
        <Btn kind="primary" onClick={save}>Shrani</Btn>
      </>}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ime"><input className={inputCls} value={e.firstName} onChange={(x) => set({ firstName: x.target.value })} /></Field>
        <Field label="Priimek"><input className={inputCls} value={e.lastName} onChange={(x) => set({ lastName: x.target.value })} /></Field>
        <Field label="Datum rojstva (neobvezno)" hint="Potrebno le, če boste uporabljali potrdilo o dejavnostih."><input type="date" lang="sl-SI" className={inputCls} value={e.dateOfBirth} onChange={(x) => set({ dateOfBirth: x.target.value })} /></Field>
        <Field label="Št. dovoljenja / OI / potnega lista (neobvezno)" hint="Potrebno le za obrazce, ki ta podatek zahtevajo."><input className={cx(inputCls, 'font-mono')} value={e.idNumber} onChange={(x) => set({ idNumber: x.target.value })} /></Field>
        <Field label="Datum začetka zaposlitve (neobvezno)" hint="Potrebno le za obrazce, ki ta podatek zahtevajo."><input type="date" lang="sl-SI" className={inputCls} value={e.employmentStart} onChange={(x) => set({ employmentStart: x.target.value })} /></Field>
        <Field label="Interna številka (neobvezno)"><input className={inputCls} value={e.employeeNumber} onChange={(x) => set({ employeeNumber: x.target.value })} /></Field>
        <Field label="Telefon (neobvezno)"><input className={inputCls} value={e.phone} onChange={(x) => set({ phone: x.target.value })} /></Field>
        <Field label="Vozilo (neobvezno)"><input className={cx(inputCls, 'font-mono')} value={e.vehicle} onChange={(x) => set({ vehicle: x.target.value })} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Opombe"><textarea className={cx(inputCls, 'h-16')} value={e.notes} onChange={(x) => set({ notes: x.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm">
        <input type="checkbox" checked={e.active} onChange={(x) => set({ active: x.target.checked })} /> Aktiven
      </label>
      <p className="text-[11px] text-slate-400 mt-2">Na obstoječih dokumentih ostane shranjeno ime, kot je bilo ob vnosu (zgodovina se ne prepisuje).</p>
    </Modal>
  )
}

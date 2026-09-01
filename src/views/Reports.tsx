import React, { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDocument, DocType } from '../types'
import { cx, currentMonthKey, docNo, fmtDate, fmtEur, fmtNum, todayIso, txAt } from '../lib/util'
import { docDelta } from '../lib/balance'
import { sortChrono } from '../lib/numbering'
import { Btn, Chip, Warn, inputCls } from '../components/ui'
import type { KnjigaJob, PrintJob } from '../print'

export function ReportsView({
  onOpenDoc, onPrint,
}: {
  onOpenDoc: (id: string) => void
  onPrint: (job: PrintJob) => void
}) {
  const app = useApp()
  const { db, settings } = app
  // privzeto: od prvega dne prejšnjega meseca do danes
  const [from, setFrom] = useState(() => {
    const [y, m] = currentMonthKey().split('-').map(Number)
    const py = m === 1 ? y - 1 : y
    const pm = m === 1 ? 12 : m - 1
    return `${py}-${String(pm).padStart(2, '0')}-01`
  })
  const [to, setTo] = useState(todayIso())
  const [deskId, setDeskId] = useState(settings.activeDeskId)
  const [tip, setTip] = useState<'' | DocType>('')
  const [emp, setEmp] = useState('')
  const [status, setStatus] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())

  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  const allDocs = useLiveQuery(() => db.docs.toArray(), []) ?? []

  const rows = useMemo(() => {
    return allDocs
      .filter((d) => d.transactionDate >= from && d.transactionDate <= to)
      .filter((d) => !deskId || d.deskId === deskId)
      .filter((d) => !tip || d.type === tip)
      .filter((d) => !emp || d.employeeId === emp)
      .filter((d) => !status || d.status === status)
      .sort(sortChrono)
  }, [allDocs, from, to, deskId, tip, emp, status])

  const sums = useMemo(() => {
    let bp = 0, bi = 0
    for (const d of rows) {
      if (d.status === 'STORNIRAN' || d.amount == null) continue
      if (d.type === 'BP') bp += d.amount
      else bi += d.amount
    }
    return { bp: Math.round(bp * 100) / 100, bi: Math.round(bi * 100) / 100, neto: Math.round((bp - bi) * 100) / 100 }
  }, [rows])

  const deskOf = (id: string) => desks.find((x) => x.id === id)
  const numOf = (d: CashDocument) => (d.officialNumber != null ? docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat) : 'osnutek')
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = rows.length > 0 && rows.every((d) => sel.has(d.id))
  const exportRows = sel.size > 0 ? rows.filter((d) => sel.has(d.id)) : rows

  // ---------- izvoz v Excel (CSV s podpičjem — privzeto za slovenski Excel) ----------
  function csvCell(v: string): string {
    return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }
  const num = (n: number | null | undefined) => (n == null ? '' : n.toFixed(2).replace('.', ','))

  async function exportCsv() {
    const head = ['Številka', 'Datum', 'Čas', 'Tip', 'Blagajna', 'Zaposleni', 'Za (namen)', 'Konto', 'Prejemek (EUR)', 'Izdatek (EUR)', 'Status', 'Opombe']
    const lines = [head.join(';')]
    for (const d of exportRows) {
      lines.push([
        csvCell(numOf(d)),
        d.transactionDate.split('-').reverse().join('.'),
        d.transactionTime,
        d.type,
        csvCell(deskOf(d.deskId)?.name ?? d.deskId),
        csvCell(d.employeeName),
        csvCell(d.purpose),
        csvCell(d.rows.map((r) => r.konto).filter(Boolean).join(', ')),
        d.type === 'BP' ? num(d.amount) : '',
        d.type === 'BI' ? num(d.amount) : '',
        d.status === 'STORNIRAN' ? 'STORNIRANO' : d.status === 'ZAKLJUCEN' ? 'zaključen' : 'osnutek',
        csvCell(d.notes || ''),
      ].join(';'))
    }
    lines.push('')
    lines.push(['', '', '', '', '', '', 'Skupaj prejemki (EUR)', '', num(sums.bp), '', '', ''].join(';'))
    lines.push(['', '', '', '', '', '', 'Skupaj izdatki (EUR)', '', '', num(sums.bi), '', ''].join(';'))
    const name = `blagajna-izvoz-${from}-do-${to}.csv`
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    await app.audit('Izvoz v Excel (CSV)', 'Porocilo', `${from}..${to}`, `${exportRows.length} vrstic`)
  }

  function printSelected() {
    const docs = rows.filter((d) => sel.has(d.id))
    if (docs.length === 0) return
    onPrint({ title: `Izbrani dokumenti (${docs.length})`, docs: docs.map((doc) => ({ doc, desk: deskOf(doc.deskId) })) })
  }

  async function printKnjiga() {
    if (!deskId) return
    const desk = deskOf(deskId)
    const deskDocs = allDocs.filter((d) => d.deskId === deskId)
    const fromT = `${from}T00:00`
    let saldo = (desk?.openingBalance ?? 0) + deskDocs.filter((d) => txAt(d) < fromT).reduce((s, d) => s + docDelta(d), 0)
    saldo = Math.round(saldo * 100) / 100
    const start = saldo
    const kRows = rows.filter((d) => d.deskId === deskId).map((d) => {
      const delta = docDelta(d)
      saldo = Math.round((saldo + delta) * 100) / 100
      return {
        num: numOf(d),
        date: d.transactionDate,
        time: d.transactionTime,
        opis: d.purpose || '—',
        emp: d.employeeName,
        bp: d.type === 'BP' && d.status !== 'STORNIRAN' ? d.amount : null,
        bi: d.type === 'BI' && d.status !== 'STORNIRAN' ? d.amount : null,
        saldo,
        storno: d.status === 'STORNIRAN',
      }
    })
    const k: KnjigaJob = {
      deskName: desk?.name ?? deskId,
      from, to, start, end: saldo,
      totBP: sums.bp, totBI: sums.bi,
      rows: kRows,
    }
    await app.audit('Izpis blagajniške knjige', 'Porocilo', `${from}..${to}`, `${kRows.length} vrstic · ${desk?.name}`)
    onPrint({ title: `Blagajniška knjiga — ${desk?.name}`, knjiga: k })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-800">Poročila in izvoz</h1>
        <div className="flex-1" />
        <Btn onClick={exportCsv} title="CSV s podpičjem — odpre se neposredno v Excelu">⬇️ Izvozi v Excel (CSV){sel.size > 0 ? ` — izbrane (${sel.size})` : ''}</Btn>
        <Btn onClick={printSelected} disabled={sel.size === 0} title="Natisne izbrane dokumente kot obrazce BP/BI">🖨️ Natisni izbrane ({sel.size})</Btn>
        <Btn kind="primary" onClick={printKnjiga} disabled={!deskId} title={deskId ? 'Klasična blagajniška knjiga s tekočim saldom' : 'Izberite eno blagajno'}>📒 Blagajniška knjiga</Btn>
      </div>

      {/* Filtri */}
      <div className="flex flex-wrap gap-2 mt-3 items-end">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Od<input type="date" lang="sl-SI" className={cx(inputCls, 'w-auto mt-1 font-normal normal-case')} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Do<input type="date" lang="sl-SI" className={cx(inputCls, 'w-auto mt-1 font-normal normal-case')} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <select className={cx(inputCls, 'w-auto')} value={deskId} onChange={(e) => setDeskId(e.target.value)}>
          <option value="">Vse blagajne</option>
          {desks.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className={cx(inputCls, 'w-auto')} value={tip} onChange={(e) => setTip(e.target.value as any)}>
          <option value="">Vsi tipi</option>
          <option value="BP">Samo BP</option>
          <option value="BI">Samo BI</option>
        </select>
        <select className={cx(inputCls, 'w-auto')} value={emp} onChange={(e) => setEmp(e.target.value)}>
          <option value="">Vsi zaposleni</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
        </select>
        <select className={cx(inputCls, 'w-auto')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Vsi statusi</option>
          <option value="ODPRT">Osnutki</option>
          <option value="ZAKLJUCEN">Zaključeni</option>
          <option value="STORNIRAN">Stornirani</option>
        </select>
      </div>

      {/* Povzetek */}
      <div className="flex flex-wrap gap-2 mt-3 items-center">
        <Chip>{rows.length} zapisov</Chip>
        <Chip tone="green">prejemki: {fmtEur(sums.bp)}</Chip>
        <Chip tone="red">izdatki: {fmtEur(sums.bi)}</Chip>
        <Chip tone={sums.neto < 0 ? 'red' : 'blue'}>razlika: {fmtEur(sums.neto)}</Chip>
        {!deskId && <span className="text-[11px] text-slate-400">· za izpis blagajniške knjige izberite eno blagajno</span>}
      </div>

      <div className="mt-2 text-[11px] text-slate-500">Osnutek se spremeni v zaključen dokument ob akciji <b>»Zaključi mesec«</b>; takrat dokument dobi tudi uradno številko.</div>

      {/* Tabela */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full table-fixed text-sm min-w-[1080px]">
          <thead>
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
              <th className="px-2 py-2 w-8">
                <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(rows.map((d) => d.id)))} title="Izberi vse" />
              </th>
              <th className="px-2 py-2 w-24">Številka</th>
              <th className="px-2 py-2 w-36">Datum · čas</th>
              <th className="px-2 py-2 w-16">Tip</th>
              <th className="px-2 py-2 w-36">Blagajna</th>
              <th className="px-2 py-2 w-44">Zaposleni</th>
              <th className="px-2 py-2 w-64">Za</th>
              <th className="px-2 py-2 w-32 text-right">Znesek EUR</th>
              <th className="px-2 py-2 w-28">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Ni zapisov za izbrane filtre.</td></tr>}
            {rows.map((d) => (
              <tr key={d.id} className={cx('border-t border-slate-100 hover:bg-blu-50/40 align-middle', d.status === 'STORNIRAN' && 'opacity-60')}>
                <td className="px-2 py-1"><input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>
                <td className="px-2 py-1 font-mono text-[12px] font-semibold whitespace-nowrap">
                  {d.officialNumber != null ? numOf(d) : <span className="text-amber-600 font-sans font-normal text-[11px]">osnutek</span>}
                </td>
                <td className="px-2 py-1 font-mono text-[12px] whitespace-nowrap">{fmtDate(d.transactionDate)} {d.transactionTime}</td>
                <td className="px-2 py-1"><Chip tone={d.type === 'BP' ? 'green' : 'red'}>{d.type}</Chip></td>
                <td className="px-2 py-1 text-[12px] truncate" title={deskOf(d.deskId)?.name ?? d.deskId}>{deskOf(d.deskId)?.name ?? d.deskId}</td>
                <td className="px-2 py-1 truncate" title={d.employeeName}>{d.employeeName}</td>
                <td className="px-2 py-1 text-[13px]">
                  <button className="hover:underline text-left block w-full truncate" title={d.purpose || '—'} onClick={() => onOpenDoc(d.id)}>{d.purpose || '—'}</button>
                </td>
                <td className={cx('px-2 py-1 text-right font-mono', d.type === 'BP' ? 'text-emerald-700' : 'text-red-700')}>
                  {d.type === 'BP' ? '+' : '−'} {fmtEur(d.amount ?? 0)}
                </td>
                <td className="px-2 py-1">
                  {d.status === 'STORNIRAN' ? <Chip tone="red">storno</Chip> : d.status === 'ZAKLJUCEN' ? <Chip tone="green">zaključen</Chip> : <Chip tone="amber">osnutek</Chip>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[11px] text-slate-400">
        Izvoz CSV uporablja podpičje in se pravilno odpre v slovenskem Excelu. »Natisni izbrane« natisne obrazce BP/BI; »Blagajniška knjiga« natisne klasičen dnevnik s tekočim saldom za izbrano blagajno in obdobje.
      </div>
      {app.mode === 'demo' && app.ephemeral && (
        <div className="mt-2"><Warn>V predogledu v peskovniku prenosi datotek morda niso dovoljeni — izvoz CSV preizkusite v nameščeni različici.</Warn></div>
      )}
    </div>
  )
}

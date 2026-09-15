import React, { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDocument, CashTransfer, DocType } from '../types'
import { cx, currentMonthKey, docNo, fmtDate, fmtEur, fmtNum, todayIso, txAt } from '../lib/util'
import { docDelta, transferDelta } from '../lib/balance'
import { sortChrono } from '../lib/numbering'
import { Btn, Chip, Warn, inputCls } from '../components/ui'
import type { KnjigaJob, PrintJob } from '../print'
import { downloadXlsx, excelDateSerial, XLSX_STYLE, type XlsxCell, type XlsxWorkbook } from '../lib/xlsx'

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
  const allTransfers = useLiveQuery(() => db.transfers.toArray(), []) ?? []

  const selectedDesk = desks.find((d) => d.id === deskId)
  const selectedDeskIds = deskId ? new Set(locationIdsForView(desks, deskId)) : null

  const rows = useMemo(() => {
    return allDocs
      .filter((d) => d.transactionDate >= from && d.transactionDate <= to)
      .filter((d) => !selectedDeskIds || selectedDeskIds.has(d.deskId))
      .filter((d) => !tip || d.type === tip)
      .filter((d) => !emp || d.employeeId === emp)
      .filter((d) => !status || d.status === status)
      .sort(sortChrono)
  }, [allDocs, from, to, deskId, desks, tip, emp, status])

  const transferRows = useMemo(() => allTransfers
    .filter((t) => t.transactionDate >= from && t.transactionDate <= to)
    .filter((t) => !selectedDeskIds || selectedDeskIds.has(t.fromDeskId) || selectedDeskIds.has(t.toDeskId))
    .sort((a, b) => `${a.transactionDate}T${a.transactionTime}`.localeCompare(`${b.transactionDate}T${b.transactionTime}`) || a.createdAt.localeCompare(b.createdAt)),
    [allTransfers, from, to, deskId, desks],
  )

  const transferSums = useMemo(() => {
    if (!selectedDeskIds) return { incoming: 0, outgoing: 0 }
    let incoming = 0, outgoing = 0
    for (const t of transferRows) {
      if (selectedDeskIds.has(t.toDeskId)) incoming += t.amount
      if (selectedDeskIds.has(t.fromDeskId)) outgoing += t.amount
    }
    return { incoming: Math.round(incoming * 100) / 100, outgoing: Math.round(outgoing * 100) / 100 }
  }, [transferRows, deskId, desks])

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

  // ---------- pravi Excel izvoz (.xlsx) ----------
  async function exportExcel() {
    if (exportRows.length === 0) { alert('Ni podatkov za izvoz.'); return }

    const firstDataRow = 6
    const lastDataRow = firstDataRow + exportRows.length - 1
    const totalRow = lastDataRow + 1
    let bp = 0, bi = 0

    const detailRows: XlsxCell[][] = [
      [{ value: 'Poročilo blagajne', style: XLSX_STYLE.TITLE }],
      [{ value: `Obdobje: ${fmtDate(from)} – ${fmtDate(to)}`, style: XLSX_STYLE.SUBTITLE }],
      [{ value: `Blagajna: ${deskId ? (deskOf(deskId)?.name ?? deskId) : 'vse'}  ·  Tip: ${tip || 'vsi'}  ·  Status: ${status || 'vsi'}${sel.size > 0 ? `  ·  Izbrane vrstice: ${exportRows.length}` : ''}`, style: XLSX_STYLE.SUBTITLE }],
      [],
      ['Številka', 'Datum', 'Čas', 'Tip', 'Blagajna', 'Zaposleni', 'Za (namen)', 'Konto', 'Prejemek (EUR)', 'Izdatek (EUR)', 'Status', 'Opombe'].map((value) => ({ value, style: XLSX_STYLE.HEADER })),
    ]

    for (let i = 0; i < exportRows.length; i++) {
      const d = exportRows[i]
      const alt = i % 2 === 1
      const base = alt ? XLSX_STYLE.BODY_ALT : XLSX_STYLE.BODY
      const dateStyle = alt ? XLSX_STYLE.DATE_ALT : XLSX_STYLE.DATE
      const inStyle = alt ? XLSX_STYLE.MONEY_IN_ALT : XLSX_STYLE.MONEY_IN
      const outStyle = alt ? XLSX_STYLE.MONEY_OUT_ALT : XLSX_STYLE.MONEY_OUT
      const statusText = d.status === 'STORNIRAN' ? 'STORNIRANO' : d.status === 'ZAKLJUCEN' ? 'zaključen' : 'osnutek'
      const statusStyle = d.status === 'STORNIRAN' ? XLSX_STYLE.STATUS_VOID : d.status === 'ZAKLJUCEN' ? XLSX_STYLE.STATUS_CLOSED : XLSX_STYLE.STATUS_DRAFT
      if (d.status !== 'STORNIRAN' && d.amount != null) {
        if (d.type === 'BP') bp += d.amount
        else bi += d.amount
      }
      detailRows.push([
        { value: numOf(d), style: base },
        { value: excelDateSerial(d.transactionDate) ?? d.transactionDate, style: dateStyle },
        { value: d.transactionTime || '', style: base },
        { value: d.type, style: d.type === 'BP' ? XLSX_STYLE.TYPE_BP : XLSX_STYLE.TYPE_BI },
        { value: deskOf(d.deskId)?.name ?? d.deskId, style: base },
        { value: d.employeeName || '', style: base },
        { value: d.purpose || '', style: base },
        { value: (d.rows ?? []).map((r) => r.konto).filter(Boolean).join(', '), style: base },
        { value: d.type === 'BP' ? (d.amount ?? 0) : null, style: inStyle },
        { value: d.type === 'BI' ? (d.amount ?? 0) : null, style: outStyle },
        { value: statusText, style: statusStyle },
        { value: d.notes || '', style: base },
      ])
    }
    bp = Math.round(bp * 100) / 100
    bi = Math.round(bi * 100) / 100

    detailRows.push([
      { value: '', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL },
      { value: '', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL },
      { value: 'SKUPAJ (brez storniranih)', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL },
      { formula: `SUMIFS(I${firstDataRow}:I${lastDataRow},K${firstDataRow}:K${lastDataRow},"<>STORNIRANO")`, result: bp, style: XLSX_STYLE.TOTAL_MONEY },
      { formula: `SUMIFS(J${firstDataRow}:J${lastDataRow},K${firstDataRow}:K${lastDataRow},"<>STORNIRANO")`, result: bi, style: XLSX_STYLE.TOTAL_MONEY },
      { value: '', style: XLSX_STYLE.TOTAL_LABEL }, { value: '', style: XLSX_STYLE.TOTAL_LABEL },
    ])

    const neto = Math.round((bp - bi) * 100) / 100
    const summaryRows: XlsxCell[][] = [
      [{ value: 'Povzetek blagajne', style: XLSX_STYLE.TITLE }],
      [{ value: `Obdobje ${fmtDate(from)} – ${fmtDate(to)}`, style: XLSX_STYLE.SUBTITLE }],
      [],
      [{ value: 'Število dokumentov', style: XLSX_STYLE.HEADER }, { formula: `COUNTA(Podrobnosti!A${firstDataRow}:A${lastDataRow})`, result: exportRows.length, style: XLSX_STYLE.KPI_TEAL }],
      [{ value: 'Prejemki', style: XLSX_STYLE.HEADER }, { formula: `SUMIFS(Podrobnosti!I${firstDataRow}:I${lastDataRow},Podrobnosti!K${firstDataRow}:K${lastDataRow},"<>STORNIRANO")`, result: bp, style: XLSX_STYLE.KPI_GREEN }],
      [{ value: 'Izdatki', style: XLSX_STYLE.HEADER }, { formula: `SUMIFS(Podrobnosti!J${firstDataRow}:J${lastDataRow},Podrobnosti!K${firstDataRow}:K${lastDataRow},"<>STORNIRANO")`, result: bi, style: XLSX_STYLE.KPI_RED }],
      [{ value: 'Razlika', style: XLSX_STYLE.HEADER }, { formula: 'B5-B6', result: neto, style: XLSX_STYLE.KPI_BLUE }],
      [],
      [{ value: 'Namig', style: XLSX_STYLE.SECTION }],
      [{ value: 'Na listu »Podrobnosti« so v glavi stolpcev vključeni Excel filtri. Glava ostane zamrznjena med drsenjem, zneski pa so prave številčne EUR celice za nadaljnje seštevanje in analizo.', style: XLSX_STYLE.SUBTITLE }],
    ]

    const book: XlsxWorkbook = {
      title: `Blagajna ${from}–${to}`,
      subject: 'Izvoz blagajniških prejemkov in izdatkov',
      creator: 'Blagajna BLU',
      company: 'Bonta d.o.o.',
      sheets: [
        {
          name: 'Povzetek', rows: summaryRows, widths: [26, 22], merges: ['A1:B1', 'A2:B2', 'A9:B9', 'A10:B10'],
          rowHeights: { 1: 28, 4: 24, 5: 24, 6: 24, 7: 24 }, showGridLines: false, landscape: false,
        },
        {
          name: 'Podrobnosti', rows: detailRows, widths: [16, 13, 9, 8, 22, 24, 34, 18, 18, 18, 15, 34],
          merges: ['A1:L1', 'A2:L2', 'A3:L3'], freezeRows: 5, autoFilter: `A5:L${lastDataRow}`,
          rowHeights: { 1: 28, 5: 30, [totalRow]: 24 }, showGridLines: false, landscape: true,
        },
      ],
    }

    downloadXlsx(book, `blagajna-izvoz-${from}-do-${to}.xlsx`)
    await app.audit('Izvoz v Excel (.xlsx)', 'Porocilo', `${from}..${to}`, `${exportRows.length} vrstic`)
  }

  async function exportTransfersCsv() {
    const head = ['Datum', 'Čas', 'Iz blagajne', 'V blagajno', 'Znesek (EUR)', 'Opomba']
    const lines = [head.join(';')]
    for (const t of transferRows) {
      lines.push([
        t.transactionDate.split('-').reverse().join('.'),
        t.transactionTime,
        csvCell(deskOf(t.fromDeskId)?.name ?? t.fromDeskId),
        csvCell(deskOf(t.toDeskId)?.name ?? t.toDeskId),
        num(t.amount),
        csvCell(t.notes || ''),
      ].join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `interni-prenosi-${from}-do-${to}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    await app.audit('Izvoz internih prenosov (CSV)', 'Porocilo', `${from}..${to}`, `${transferRows.length} prenosov`)
  }

  function printSelected() {
    const docs = rows.filter((d) => sel.has(d.id))
    if (docs.length === 0) return
    onPrint({ title: `Izbrani dokumenti (${docs.length})`, docs: docs.map((doc) => ({ doc, desk: deskOf(doc.deskId) })) })
  }

  async function printKnjiga() {
    if (!deskId || selectedDesk?.isGroup) return
    const desk = deskOf(deskId)
    const deskDocs = allDocs.filter((d) => d.deskId === deskId)
    const deskTransfers = allTransfers.filter((t) => t.fromDeskId === deskId || t.toDeskId === deskId)
    const fromT = `${from}T00:00`
    let saldo = (desk?.openingBalance ?? 0)
      + deskDocs.filter((d) => txAt(d) < fromT).reduce((sum, d) => sum + docDelta(d), 0)
      + deskTransfers.filter((t) => `${t.transactionDate}T${t.transactionTime}` < fromT).reduce((sum, t) => sum + transferDelta(t, deskId), 0)
    saldo = Math.round(saldo * 100) / 100
    const start = saldo

    const events: Array<{ at: string; createdAt: string; id: string; doc?: CashDocument; transfer?: CashTransfer }> = [
      ...rows.filter((d) => d.deskId === deskId).map((doc) => ({ at: txAt(doc), createdAt: doc.createdAt, id: doc.id, doc })),
      ...transferRows.filter((t) => t.fromDeskId === deskId || t.toDeskId === deskId).map((transfer) => ({ at: `${transfer.transactionDate}T${transfer.transactionTime}`, createdAt: transfer.createdAt, id: transfer.id, transfer })),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

    let totIn = 0, totOut = 0
    const kRows = events.map((event) => {
      if (event.doc) {
        const d = event.doc
        const delta = docDelta(d)
        saldo = Math.round((saldo + delta) * 100) / 100
        if (delta > 0) totIn += delta
        if (delta < 0) totOut += -delta
        return {
          num: numOf(d), date: d.transactionDate, time: d.transactionTime,
          opis: d.purpose || '—', emp: d.employeeName,
          bp: d.type === 'BP' && d.status !== 'STORNIRAN' ? d.amount : null,
          bi: d.type === 'BI' && d.status !== 'STORNIRAN' ? d.amount : null,
          saldo, storno: d.status === 'STORNIRAN',
        }
      }
      const t = event.transfer!
      const delta = transferDelta(t, deskId)
      saldo = Math.round((saldo + delta) * 100) / 100
      if (delta > 0) totIn += delta
      else totOut += -delta
      const fromName = deskOf(t.fromDeskId)?.name ?? t.fromDeskId
      const toName = deskOf(t.toDeskId)?.name ?? t.toDeskId
      return {
        num: 'PRENOS', date: t.transactionDate, time: t.transactionTime,
        opis: `Interni prenos: ${fromName} → ${toName}${t.notes ? ` · ${t.notes}` : ''}`,
        emp: '—', bp: delta > 0 ? t.amount : null, bi: delta < 0 ? t.amount : null, saldo,
      }
    })

    const k: KnjigaJob = {
      deskName: desk?.name ?? deskId,
      from, to, start, end: saldo,
      totBP: Math.round(totIn * 100) / 100, totBI: Math.round(totOut * 100) / 100,
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
        <Btn onClick={exportExcel} title="Pravi Excel .xlsx z oblikovanjem, filtri in povzetkom">⬇️ Izvozi Excel (.xlsx){sel.size > 0 ? ` — izbrane (${sel.size})` : ''}</Btn>
        <Btn onClick={printSelected} disabled={sel.size === 0} title="Natisne izbrane dokumente kot obrazce BP/BI">🖨️ Natisni izbrane ({sel.size})</Btn>
        <Btn kind="primary" onClick={printKnjiga} disabled={!deskId || !!selectedDesk?.isGroup} title={selectedDesk?.isGroup ? 'Za klasično blagajniško knjigo izberite eno interno lokacijo.' : deskId ? 'Klasična blagajniška knjiga s tekočim saldom' : 'Izberite eno blagajno'}>📒 Blagajniška knjiga</Btn>
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
          {desks.filter((x) => x.isGroup).map((g) => <React.Fragment key={g.id}><option value={g.id}>🏦 {g.name} — SKUPAJ</option>{desks.filter((d) => d.parentId === g.id && !d.isGroup).map((d) => <option key={d.id} value={d.id}>　↳ {d.name}</option>)}</React.Fragment>)}
          {desks.filter((d) => !d.isGroup && !d.parentId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
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
        {selectedDeskIds && transferRows.length > 0 && <Chip tone="green">interni prenosi noter: {fmtEur(transferSums.incoming)}</Chip>}
        {selectedDeskIds && transferRows.length > 0 && <Chip tone="red">interni prenosi ven: {fmtEur(transferSums.outgoing)}</Chip>}
        {(!deskId || selectedDesk?.isGroup) && <span className="text-[11px] text-slate-400">· za klasično blagajniško knjigo izberite eno interno lokacijo; globalna blagajna je skupni pregled</span>}
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

      <div className="mt-4">
        <div className="flex items-center gap-2 mb-1.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">↔ Interni prenosi</span><Chip>{transferRows.length}</Chip></div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left"><tr><th className="px-2 py-2">Datum · čas</th><th className="px-2 py-2">Iz blagajne</th><th className="px-2 py-2">V blagajno</th><th className="px-2 py-2 text-right">Znesek</th><th className="px-2 py-2">Opomba</th></tr></thead>
            <tbody>
              {transferRows.length === 0 && <tr><td colSpan={5} className="px-3 py-5 text-center text-slate-400">Ni internih prenosov v izbranem obdobju.</td></tr>}
              {transferRows.map((t) => <tr key={t.id} className="border-t border-slate-100"><td className="px-2 py-1.5 font-mono text-[12px]">{fmtDate(t.transactionDate)} {t.transactionTime}</td><td className="px-2 py-1.5 text-red-700 font-medium">{deskOf(t.fromDeskId)?.name ?? t.fromDeskId}</td><td className="px-2 py-1.5 text-emerald-700 font-medium">{deskOf(t.toDeskId)?.name ?? t.toDeskId}</td><td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtEur(t.amount)}</td><td className="px-2 py-1.5">{t.notes || '—'}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-2 text-[11px] text-slate-400">
        Excel izvoz ustvari oblikovan .xlsx s povzetkom, filtri, zamrznjeno glavo in pravimi EUR celicami. »Natisni izbrane« natisne obrazce BP/BI; »Blagajniška knjiga« natisne klasičen dnevnik s tekočim saldom za izbrano blagajno in obdobje.
      </div>
      {app.mode === 'demo' && app.ephemeral && (
        <div className="mt-2"><Warn>V predogledu v peskovniku prenosi datotek morda niso dovoljeni — Excel izvoz preizkusite v nameščeni različici.</Warn></div>
      )}
    </div>
  )
}

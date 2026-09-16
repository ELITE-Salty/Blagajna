

import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import { Btn, Chip, ErrBox, Field, Modal, Warn, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { balanceInfo } from '../lib/balance'
import {
  MIN_GAP_WORKDAYS,
  buildPayoutParts,
  formatSloDate,
  normalizePayoutTime,
  parseSloDate,
  payoutImportReadiness,
  payoutWindow,
  readPayoutSource,
  validatePayoutSchedule,
  CashLedger,
  type CashEvent,
  type PayoutPart,
  type PayoutSourceRow,
} from '../lib/payoutImport'
import { fmtEur, nowIso, uuid } from '../lib/util'
import { physicalDesks } from '../lib/desks'
import { closeIdFor } from '../lib/numbering'

type PartEdit = {
  dateText?: string
  time?: string
  subject?: string
}

function buildCashEvents(docs: any[], transfers: any[], deskId: string): CashEvent[] {
  if (!deskId) return []
  const events: CashEvent[] = []
  for (const d of docs) {
    if (d.deskId !== deskId || d.status === 'STORNIRAN' || d.amount == null) continue
    const amount = Number(d.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    events.push({
      at: `${d.transactionDate}T${d.transactionTime || '00:00'}:00`,
      delta: d.type === 'BP' ? amount : -amount,
      source: 'DOC',
      id: d.id,
      label: `${d.type} ${d.officialNumber ?? d.id}`,
    })
  }
  for (const t of transfers) {
    if (t.fromDeskId !== deskId && t.toDeskId !== deskId) continue
    const amount = Number(t.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    events.push({
      at: `${t.transactionDate}T${t.transactionTime || '00:00'}:00`,
      delta: t.toDeskId === deskId ? amount : -amount,
      source: 'TRANSFER',
      id: t.id,
      label: t.toDeskId === deskId ? 'interni prenos prejeto' : 'interni prenos oddano',
    })
  }
  return events.sort((a, b) => a.at.localeCompare(b.at))
}

function sourceLabel(p: PayoutPart): string {
  if (p.dateSource === 'POTRDILO_START') return 'začetek dopust lista'
  if (p.dateSource === 'POTRDILO_END') return 'konec dopust lista'
  if (p.dateSource === 'MANUAL') return 'ročno popravljeno'
  return 'okno 20.–16.'
}

function PayoutImportModal({ initialMonth, initialDeskId, onClose, onDone }: {
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
  const [defaultSubject, setDefaultSubject] = useState('Akontacija')
  const [timeFrom, setTimeFrom] = useState('08:00')
  const [timeTo, setTimeTo] = useState('17:59')
  const [partEdits, setPartEdits] = useState<Record<string, PartEdit>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!deskId && locations.length) {
      const preferred = locations.find((d) => d.id === initialDeskId) ?? locations[0]
      setDeskId(preferred.id)
    }
  }, [deskId, initialDeskId, locations])

  useEffect(() => {
    // A different period/location/time window gets a fresh automatic schedule.
    setPartEdits({})
  }, [month, deskId, timeFrom, timeTo])

  // Use the same balance calculation as MonthWorkspace. This is important because
  // internal transfers are part of the real cash balance of an internal blagajna.
  const cashContext = useLiveQuery(async () => {
    if (!deskId) return { currentBalance: 0, events: [] as CashEvent[] }
    const [docs, transfers] = await Promise.all([
      db.docs.where('deskId').equals(deskId).toArray(),
      db.transfers.filter((t) => t.fromDeskId === deskId || t.toDeskId === deskId).toArray(),
    ])
    const desk = desks.find((d) => d.id === deskId)
    const currentBalance = balanceInfo(desk, docs, month, transfers).current
    return { currentBalance, events: buildCashEvents(docs, transfers, deskId) }
  }, [deskId, month, desks])
  const available = cashContext?.currentBalance
  const cashEvents = cashContext?.events

  const win = payoutWindow(month)

  const generatedParts = useMemo(
    () => buildPayoutParts(source, employees, potrdila, month, timeFrom, timeTo, cashContext, { defaultSubject }),
    [source, employees, potrdila, month, timeFrom, timeTo, cashContext, defaultSubject],
  )

  const cashDiagnostics = useMemo(() => {
    if (!cashContext) return null
    const ledger = new CashLedger(cashContext)
    const windowStartAt = `${win.start}T00:00:00`
    const windowEndAt = `${win.end}T23:59:59`
    const inWindow = cashContext.events.filter((e) => e.at >= windowStartAt && e.at <= windowEndAt)
    const transferIn = inWindow.filter((e) => e.source === 'TRANSFER' && e.delta > 0).reduce((sum, e) => sum + e.delta, 0)
    const transferOut = -inWindow.filter((e) => e.source === 'TRANSFER' && e.delta < 0).reduce((sum, e) => sum + e.delta, 0)
    return {
      startBalance: ledger.balanceAt(windowStartAt),
      // Rule 1 in one number: the most that may leave the blagajna from the start
      // of the window onwards without the balance ever going below zero.
      spendableInWindow: ledger.availableFrom(windowStartAt),
      transferIn,
      transferOut,
      transferEvents: inWindow.filter((e) => e.source === 'TRANSFER').length,
    }
  }, [cashContext, win.start, win.end])

  // Manual edits win over the automatic schedule. Touching the date or the hour
  // means the user has taken the row over, so the scheduler's blockReason is
  // dropped and whatever they typed is judged by validatePayoutSchedule instead.
  const parts = useMemo<PayoutPart[]>(() => generatedParts.map((p) => {
    const edit = partEdits[p.partKey]
    const hasManualDate = edit?.dateText !== undefined
    const hasManualTime = edit?.time !== undefined
    const manuallyAdjusted = hasManualDate || hasManualTime
    const date = hasManualDate ? (parseSloDate(edit.dateText!) ?? '') : p.date
    const timeRaw = hasManualTime ? edit.time! : p.time
    const normalizedTime = normalizePayoutTime(timeRaw)
    const time = normalizedTime ?? timeRaw.trim()
    const subject = edit?.subject !== undefined ? edit.subject : p.subject
    const at = date && normalizedTime ? `${date}T${normalizedTime}:00` : ''
    const covering = at && p.employee
      ? potrdila.find((cert) => cert.employeeId === p.employee!.id && at >= cert.fromAt && at <= cert.toAt)
      : null
    return {
      ...p,
      date,
      time,
      subject,
      dateSource: manuallyAdjusted ? 'MANUAL' as const : p.dateSource,
      potrdiloId: covering?.id ?? (manuallyAdjusted ? null : p.potrdiloId),
      blockReason: manuallyAdjusted ? undefined : p.blockReason,
    }
  }), [generatedParts, partEdits, potrdila])

  const scheduleErrors = useMemo(
    () => validatePayoutSchedule(parts, win, timeFrom, timeTo, cashContext, potrdila),
    [parts, win.start, win.end, timeFrom, timeTo, cashContext, potrdila],
  )

  // One single error map feeds both the table and the import gate, so nothing can
  // be red in the table yet still importable (or the other way round).
  const allErrors = useMemo(() => {
    const merged = new Map(scheduleErrors)
    const addTo = (key: string, message: string) => merged.set(key, [...(merged.get(key) ?? []), message])
    for (const p of parts) {
      if (!p.date) continue
      if (closes.some((c) => c.id === closeIdFor(settings, deskId, p.date.slice(0, 7)))) {
        addTo(p.partKey, `Mesec ${p.date.slice(0, 7)} je za to blagajno že zaključen — izberite drug datum, obdobje ali lokacijo.`)
      }
    }
    return merged
  }, [scheduleErrors, parts, closes, settings, deskId])

  const readiness = useMemo(() => payoutImportReadiness(parts, allErrors), [parts, allErrors])

  const total = parts.reduce((s, p) => s + p.amount, 0)
  const unmatched = parts.filter((p) => !p.employee).length
  const fallback = parts.filter((p) => !p.blockReason && p.dateSource === 'WINDOW').length
  const balanceLoading = !!deskId && (available === undefined || cashEvents === undefined)
  const insufficientFunds = !!deskId && available !== undefined && total > available + 0.001
  const invalidTimeRange = !normalizePayoutTime(timeFrom) || !normalizePayoutTime(timeTo) || timeFrom > timeTo

  // Rule 3: nothing is sent until EVERY row has a datum, an ura, a Zadeva and no errors.
  const cannotCreate = busy || balanceLoading || invalidTimeRange || !deskId || !readiness.canImport

  function editPart(partKey: string, patch: PartEdit) {
    setPartEdits((prev) => ({ ...prev, [partKey]: { ...prev[partKey], ...patch } }))
  }

  function resetPart(partKey: string) {
    setPartEdits((prev) => {
      const next = { ...prev }
      delete next[partKey]
      return next
    })
  }

  async function load(file: File | null) {
    if (!file) return
    setErr('')
    try {
      const rows = await readPayoutSource(file)
      if (!rows.length) throw new Error('V datoteki ni veljavnih vrstic z imenom, priimkom in zneskom.')
      setPartEdits({})
      setSource(rows)
      setFileName(file.name)
    } catch (e: any) {
      setSource([])
      setFileName('')
      setPartEdits({})
      setErr(String(e?.message ?? e))
    }
  }

  async function save() {
    setErr('')
    if (!deskId) { setErr('Izberite interno lokacijo blagajne.'); return }
    if (!parts.length) { setErr('Najprej izberite Excel/CSV datoteko.'); return }
    if (invalidTimeRange) { setErr('Čas od mora biti enak ali pred časom do.'); return }
    if (!readiness.canImport) {
      const rows = readiness.blockedRows.join(', ')
      setErr(`Uvoz ni mogoč: ${readiness.blocked} od ${readiness.total} izdatkov še ni pripravljenih (vrstice ${rows}). Vsak izdatek mora imeti datum, uro in Zadevo ter biti brez napak.`)
      return
    }

    // Re-check the cash history immediately before saving, so a concurrent change
    // cannot create a historical negative balance.
    const [freshDocs, freshTransfers] = await Promise.all([
      db.docs.where('deskId').equals(deskId).toArray(),
      db.transfers.filter((t) => t.fromDeskId === deskId || t.toDeskId === deskId).toArray(),
    ])
    const freshDesk = desks.find((d) => d.id === deskId)
    const currentAvailable = balanceInfo(freshDesk, freshDocs, month, freshTransfers).current
    if (total > currentAvailable + 0.001) {
      setErr(`V izbrani blagajni ni dovolj sredstev. Na voljo ${fmtEur(currentAvailable)}, uvoz pa vsebuje ${fmtEur(total)}.`)
      return
    }
    const freshContext = { currentBalance: currentAvailable, events: buildCashEvents(freshDocs, freshTransfers, deskId) }
    const freshErrors = validatePayoutSchedule(parts, win, timeFrom, timeTo, freshContext, potrdila)
    if (!payoutImportReadiness(parts, freshErrors).canImport) {
      setErr('Stanje blagajne se je med pripravo uvoza spremenilo. Razpored ni več varen; preverite označene datume in ure.')
      return
    }

    setBusy(true)
    try {
      const at = nowIso()
      const docs = parts.map((p) => emptyDoc({
        id: uuid(),
        deskId,
        type: 'BI',
        transactionDate: p.date,
        transactionTime: normalizePayoutTime(p.time)!,
        monthKey: p.date.slice(0, 7),
        employeeId: p.employee!.id,
        employeeName: p.employee!.displayName,
        amount: p.amount,
        paymentMethod: 'GOTOVINA',
        purpose: p.subject.trim(),
        rows: [],
        potrdiloId: p.potrdiloId,
        notes: `Uvoz akontacij: ${fileName} · vrstica ${p.sourceRow} · izvorni znesek ${p.originalAmount.toFixed(2)} EUR · razpored ${formatSloDate(p.date)} ${normalizePayoutTime(p.time)} · ${sourceLabel(p)}`,
        status: 'ODPRT',
        syncStatus: 'LOKALNO',
        createdAt: at,
        createdBy: app.userLabel,
        updatedAt: at,
        updatedBy: app.userLabel,
      }))
      await db.docs.bulkPut(docs)
      await app.audit('Uvoz akontacij', 'BlagajniskiDokument', 'batch', `${fileName} · ${source.length} vrstic → ${docs.length} BI · ${fmtEur(total)} · ${formatSloDate(win.start)}–${formatSloDate(win.end)} · čas ${timeFrom}–${timeTo}`)
      if (app.mode === 'server') await app.syncNow()
      onDone()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  return (
    <Modal
      title="Uvoz akontacij iz Excel-a / CSV"
      wide
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Prekliči</Btn>
        <div className="flex-1" />
        {parts.length > 0 && (
          <span className={`mr-3 text-[12px] font-semibold ${readiness.canImport ? 'text-emerald-700' : 'text-red-700'}`}>
            {readiness.canImport
              ? `${readiness.ready} / ${readiness.total} pripravljenih`
              : `${readiness.blocked} od ${readiness.total} še ni pripravljenih`}
          </span>
        )}
        <Btn kind="primary" disabled={cannotCreate} onClick={save}>Ustvari {parts.length || ''} BI dokumentov</Btn>
      </>}
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      <div className="mb-3 rounded-lg border border-blu-200 bg-blu-50 px-3 py-2 text-[12px] text-blu-900">
        <b>To je ločen uvoz akontacij.</b> Razpored upošteva dejansko zgodovino denarja v izbrani blagajni, meje dopust listov, delovne dni ter najmanj {MIN_GAP_WORKDAYS} <b>delovnih dni</b> med razdeljenimi izdatki. Uvoz je mogoč samo, ko so <b>vsi</b> izdatki pripravljeni.
      </div>
      <div className="grid md:grid-cols-5 gap-3">
        <Field label="Obdobje" hint={`Razpored ${formatSloDate(win.start)}–${formatSloDate(win.end)}.`}><input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Field label="Interna blagajna / lokacija"><select className={inputCls} value={deskId} onChange={(e) => setDeskId(e.target.value)}><option value="">— izberi —</option>{locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Privzeta zadeva" hint="Vsak izdatek jo lahko spodaj ročno spremeni."><input className={inputCls} value={defaultSubject} onChange={(e) => setDefaultSubject(e.target.value)} /></Field>
        <Field label="Čas od" hint="Najzgodnejša ura izdatka."><input type="time" className={inputCls} value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} /></Field>
        <Field label="Čas do" hint="Najpoznejša ura izdatka."><input type="time" className={inputCls} value={timeTo} onChange={(e) => setTimeTo(e.target.value)} /></Field>
      </div>
      {invalidTimeRange && <div className="mt-2"><ErrBox>Čas od mora biti enak ali pred časom do.</ErrBox></div>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">⇧ Izberi akontacije Excel (.xlsx) / CSV<input type="file" className="hidden" accept=".xlsx,.csv,text/csv" onChange={(e) => { void load(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} /></label>
        {fileName && <Chip tone="blue">{fileName}</Chip>}
        <Chip>{source.length} izvornih vrstic</Chip>
        <Chip tone="blue">{parts.length} izdatkov · {fmtEur(total)}</Chip>
        {parts.length > 0 && <Chip tone="green">{readiness.ready} pripravljenih</Chip>}
        {readiness.blocked > 0 && <Chip tone="red">{readiness.blocked} za popravek</Chip>}
        {deskId && available !== undefined && <Chip tone={insufficientFunds ? 'red' : 'blue'}>trenutno v blagajni {fmtEur(available)}</Chip>}
      </div>

      {cashDiagnostics && (cashDiagnostics.transferEvents > 0 || readiness.blocked > 0 || insufficientFunds) && (
        <div className="mt-2 flex flex-wrap gap-2 items-center text-[12px]">
          <span className="font-semibold text-slate-500">Diagnostika blagajne:</span>
          <Chip>stanje {formatSloDate(win.start)}: {fmtEur(cashDiagnostics.startBalance)}</Chip>
          <Chip tone={cashDiagnostics.spendableInWindow < total ? 'red' : 'green'}>za izdatke na voljo {fmtEur(cashDiagnostics.spendableInWindow)}</Chip>
          {cashDiagnostics.transferIn > 0 && <Chip tone="green">interni prenosi prejeto: + {fmtEur(cashDiagnostics.transferIn)}</Chip>}
          {cashDiagnostics.transferOut > 0 && <Chip tone="red">interni prenosi oddano: − {fmtEur(cashDiagnostics.transferOut)}</Chip>}
          <span className="text-slate-400">{cashDiagnostics.transferEvents} internih prenosov v oknu</span>
        </div>
      )}

      <div className="mt-3"><Warn>
        Vsak izdatek mora imeti <b>datum, uro in Zadevo</b>, datum in ura pa morata biti <b>znotraj dopust lista zaposlenega</b>. Sobote, nedelje in slovenski dela prosti prazniki se preskočijo. Če je en znesek razdeljen na več izdatkov, je med njimi najmanj <b>{MIN_GAP_WORKDAYS} delovnih dni</b>. Stanje blagajne ne sme nikoli pasti pod 0 € — ne na posamezen dan ne skupno. Kjer samodejni razpored ni našel veljavnega termina, sta datum in ura <b>prazna</b>, Zadeva pa je prepuščena vam.
      </Warn></div>

      {readiness.blocked > 0 && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
          <div className="font-semibold">Uvoz je zaklenjen, dokler ni urejenih {readiness.blocked} izdatkov (vrstice {readiness.blockedRows.join(', ')}).</div>
          <ul className="mt-1 list-disc pl-5">
            {readiness.reasons.slice(0, 6).map((r) => (
              <li key={r.partKey}>
                <b>vrstica {r.sourceRow}</b> · {r.employeeName} — {r.messages[0]}
              </li>
            ))}
          </ul>
          {readiness.reasons.length > 6 && <div className="mt-1 text-red-700">… in še {readiness.reasons.length - 6}. Podrobnosti so v tabeli.</div>}
        </div>
      )}

      {(unmatched > 0 || fallback > 0 || insufficientFunds) && (
        <div className="mt-2 flex gap-2 flex-wrap">
          {unmatched > 0 && <Chip tone="red">{unmatched} brez ujemanja zaposlenega</Chip>}
          {fallback > 0 && <Chip tone="amber">{fallback} datumov znotraj dopust lista, vendar ne na njegovi meji</Chip>}
          {insufficientFunds && available !== undefined && <Chip tone="red">Premalo sredstev: manjka {fmtEur(total - available)}</Chip>}
        </div>
      )}
      {insufficientFunds && available !== undefined && <div className="mt-2"><ErrBox>Uvoz vsebuje {fmtEur(total)}, v izbrani blagajni pa je trenutno na voljo samo {fmtEur(available)}. Pri stanju so upoštevani tudi interni prenosi. Stanje po uvozu ne sme biti negativno.</ErrBox></div>}

      <div className="mt-3 max-h-[480px] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[1360px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase text-slate-500">
            <tr>
              <th className="px-2 py-2 text-left w-14">Stanje</th>
              <th className="px-2 py-2 text-left w-20">Vrstica</th>
              <th className="px-2 py-2 text-left min-w-[200px]">Zaposleni</th>
              <th className="px-2 py-2 text-right w-28">Izvorno</th>
              <th className="px-2 py-2 text-right w-28">Znesek</th>
              <th className="px-2 py-2 text-left w-40">Datum</th>
              <th className="px-2 py-2 text-left w-28">Ura</th>
              <th className="px-2 py-2 text-left min-w-[220px]">Zadeva</th>
              <th className="px-2 py-2 text-left min-w-[300px]">Vir / opozorilo</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => {
              const rowErrors = allErrors.get(p.partKey) ?? []
              const edit = partEdits[p.partKey]
              const dateText = edit?.dateText ?? (p.date ? formatSloDate(p.date) : '')
              const timeText = edit?.time ?? p.time
              const ready = rowErrors.length === 0
              const needsUser = !!p.blockReason
              return (
                <tr key={p.partKey} className={`border-t border-slate-100 ${ready ? '' : needsUser ? 'bg-amber-50/80' : 'bg-red-50/60'}`}>
                  <td className="px-2 py-1 text-center text-base" title={ready ? 'Pripravljeno za uvoz' : 'Zahteva vašo pozornost'}>
                    {ready ? <span className="text-emerald-600">✓</span> : <span className="text-red-600">⚠</span>}
                  </td>
                  <td className="px-2 py-1 font-mono">{p.sourceRow}</td>
                  <td className="px-2 py-1">{p.employee ? p.employee.displayName : <span className="text-red-700 font-medium">{p.employeeName} — ni najden</span>}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmtEur(p.originalAmount)}</td>
                  <td className="px-2 py-1 text-right font-mono font-semibold">{fmtEur(p.amount)}</td>
                  <td className="px-2 py-1">
                    <input
                      className={`${inputCls} font-mono min-w-[130px] ${rowErrors.some((x) => x.startsWith('Datum')) || (needsUser && !p.date) ? 'border-red-400 bg-red-50' : ''}`}
                      value={dateText}
                      placeholder="DD.MM.YYYY"
                      onChange={(e) => editPart(p.partKey, { dateText: e.target.value })}
                      onBlur={(e) => {
                        const parsed = parseSloDate(e.target.value)
                        if (parsed) editPart(p.partKey, { dateText: formatSloDate(parsed) })
                      }}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className={`${inputCls} font-mono min-w-[90px] ${rowErrors.some((x) => x.startsWith('Ura')) || (needsUser && !p.time) ? 'border-red-400 bg-red-50' : ''}`}
                      value={timeText}
                      placeholder="HH:MM"
                      onChange={(e) => editPart(p.partKey, { time: e.target.value })}
                      onBlur={(e) => {
                        const normalized = normalizePayoutTime(e.target.value)
                        if (normalized) editPart(p.partKey, { time: normalized })
                      }}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className={`${inputCls} min-w-[210px] ${rowErrors.some((x) => x.startsWith('Zadeva')) ? 'border-red-400 bg-red-50' : ''}`}
                      value={p.subject}
                      placeholder="Zadeva (obvezno)"
                      onChange={(e) => editPart(p.partKey, { subject: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1 text-[12px]">
                    <div className="font-medium text-slate-600">{sourceLabel(p)}</div>
                    {p.warning && <div className="text-amber-700">{p.warning}</div>}
                    {p.blockReason && <div className="text-amber-900 font-semibold">⚠ Ročno dopolnite: {p.blockReason}</div>}
                    {p.cashAvailable !== undefined && p.cashAt && (
                      <div className="text-red-700 font-medium">
                        Najboljši veljavni termin: {formatSloDate(p.cashAt.slice(0, 10))} {p.cashAt.slice(11, 16)} · na voljo {fmtEur(p.cashAvailable)} · izdatek {fmtEur(p.amount)} · manjka {fmtEur(Math.max(0, p.amount - p.cashAvailable))}
                      </div>
                    )}
                    {rowErrors.filter((message) => message !== p.blockReason).map((message, index) => <div key={index} className="text-red-700 font-medium">{message}</div>)}
                    {edit && (
                      <button type="button" className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-800" onClick={() => resetPart(p.partKey)}>
                        povrni samodejni predlog
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!parts.length && <div className="p-8 text-center text-slate-400">Izberite datoteko. Pričakovani stolpci: <b>Ime</b>, <b>Priimek</b>, <b>Znesek/Vrednost</b>.</div>}
      </div>
    </Modal>
  )
}

export { PayoutImportModal }
export default PayoutImportModal

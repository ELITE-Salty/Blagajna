

import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import { Btn, ErrBox, Field, Modal, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { balanceInfo } from '../lib/balance'
import {
  MIN_GAP_WORKDAYS,
  SPLIT_MAX_EUR,
  SPLIT_MIN_EUR,
  SPLIT_THRESHOLD_EUR,
  buildPayoutParts,
  formatSloDate,
  normalizePayoutTime,
  parseSloDate,
  payoutImportReadiness,
  payoutWindow,
  readPayoutSource,
  splitPayoutAmount,
  validatePayoutSchedule,
  CashLedger,
  type CashEvent,
  type PayoutPart,
  type PayoutSourceRow,
} from '../lib/payoutImport'
import { fmtEur, monthLabel, nowIso, parseAmount, uuid } from '../lib/util'
import { physicalDesks } from '../lib/desks'
import { closeIdFor } from '../lib/numbering'

type PartEdit = {
  dateText?: string
  time?: string
  subject?: string
}

type SplitEditorState = {
  rowNo: number
  amounts: string[]
  error?: string
}

const amountText = (value: number) => value.toLocaleString('sl-SI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const batchName = (month: string) => `Akontacije dodatki za ${monthLabel(month)}`

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
  if (p.dateSource === 'MANUAL') return 'ročno'
  return 'okno 18.–16.'
}

/** Compact label + value pair for the single status bar. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-slate-800'
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9.5px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <span className={`font-mono text-[12.5px] font-medium tabular-nums ${color}`}>{value}</span>
    </div>
  )
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
  const [defaultSubject, setDefaultSubject] = useState(() => batchName(initialMonth))
  const [subjectCustomized, setSubjectCustomized] = useState(false)
  const [timeFrom, setTimeFrom] = useState('08:00')
  const [timeTo, setTimeTo] = useState('17:59')
  const [partEdits, setPartEdits] = useState<Record<string, PartEdit>>({})
  const [splitOverrides, setSplitOverrides] = useState<Record<number, number[]>>({})
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({})
  const [splitEditor, setSplitEditor] = useState<SplitEditorState | null>(null)
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Presentation state: the setup fields are a one-time act, so they fold away
  // once a file is loaded. Everything else the user needs is per-row.
  const [setupOpen, setSetupOpen] = useState(true)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)

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

  useEffect(() => {
    if (!subjectCustomized) setDefaultSubject(batchName(month))
  }, [month, subjectCustomized])

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
    () => buildPayoutParts(source, employees, potrdila, month, timeFrom, timeTo, cashContext, { defaultSubject, amountsBySourceRow: splitOverrides }),
    [source, employees, potrdila, month, timeFrom, timeTo, cashContext, defaultSubject, splitOverrides],
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

  // One single error map feeds the table, the status bar and the import gate, so
  // nothing can be red in the table yet still importable (or the other way round).
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
  const balanceLoading = !!deskId && (available === undefined || cashEvents === undefined)
  const insufficientFunds = !!deskId && available !== undefined && total > available + 0.001
  const invalidTimeRange = !normalizePayoutTime(timeFrom) || !normalizePayoutTime(timeTo) || timeFrom > timeTo

  // Rule 3: nothing is sent until EVERY row has a datum, an ura, a Zadeva and no errors.
  const cannotCreate = busy || balanceLoading || invalidTimeRange || !deskId || !readiness.canImport

  // How many parts belong to each source row — used for the "2/3" badge so split
  // akontacije read as one thing instead of three unrelated rows.
  const partsPerRow = useMemo(() => {
    const counts = new Map<number, number>()
    for (const p of parts) counts.set(p.sourceRow, (counts.get(p.sourceRow) ?? 0) + 1)
    return counts
  }, [parts])

  const visibleParts = onlyProblems ? parts.filter((p) => (allErrors.get(p.partKey) ?? []).length > 0) : parts
  const deskName = locations.find((d) => d.id === deskId)?.name ?? ''
  const sourceByRow = useMemo(() => new Map(source.map((row) => [row.rowNo, row])), [source])

  function requestClose() {
    if (busy) return
    setLeaveConfirmOpen(true)
  }

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

  function setPartAmount(p: PayoutPart, raw: string) {
    const parsed = parseAmount(raw)
    const siblings = parts
      .filter((part) => part.sourceRow === p.sourceRow)
      .sort((a, b) => Number(a.partKey.split('-')[1]) - Number(b.partKey.split('-')[1]))
    const amounts = siblings.map((part) => part.amount)
    const index = Number(p.partKey.split('-')[1])
    amounts[index] = parsed != null && parsed > 0 ? parsed : 0
    setSplitOverrides((prev) => ({ ...prev, [p.sourceRow]: amounts }))
    setAmountDrafts((prev) => {
      const next = { ...prev }
      delete next[p.partKey]
      return next
    })
  }

  function openSplitEditor(rowNo: number) {
    const row = sourceByRow.get(rowNo)
    if (!row) return
    const current = splitOverrides[rowNo] ?? splitPayoutAmount(row.amount, row.rowNo).parts
    setSplitEditor({ rowNo, amounts: current.map(amountText) })
  }

  function suggestSplit(total: number, count: number): string[] {
    if (count <= 1) return [amountText(total)]
    let base = Math.floor((total / count) / 5) * 5
    if (base <= 0) base = Math.floor((total / count) * 100) / 100
    const amounts = Array.from({ length: count }, () => base)
    amounts[count - 1] = Math.round((total - base * (count - 1)) * 100) / 100
    return amounts.map(amountText)
  }

  function setSplitCount(raw: string) {
    if (!splitEditor) return
    const row = sourceByRow.get(splitEditor.rowNo)
    if (!row) return
    const count = Math.max(1, Math.min(20, Math.trunc(Number(raw) || 1)))
    setSplitEditor({ ...splitEditor, amounts: suggestSplit(row.amount, count), error: undefined })
  }

  function setSplitEditorAmount(index: number, value: string) {
    if (!splitEditor) return
    const amounts = [...splitEditor.amounts]
    amounts[index] = value
    setSplitEditor({ ...splitEditor, amounts, error: undefined })
  }

  function applySplitEditor() {
    if (!splitEditor) return
    const row = sourceByRow.get(splitEditor.rowNo)
    if (!row) return
    const parsed = splitEditor.amounts.map(parseAmount)
    if (parsed.some((amount) => amount == null || amount <= 0)) {
      setSplitEditor({ ...splitEditor, error: 'Vsak del mora imeti veljaven znesek, večji od 0 €.' })
      return
    }
    const amounts = parsed as number[]
    const sum = Math.round(amounts.reduce((total, amount) => total + amount, 0) * 100) / 100
    if (Math.abs(sum - row.amount) > 0.001) {
      setSplitEditor({ ...splitEditor, error: `Vsota delov mora biti ${fmtEur(row.amount)}. Trenutno je ${fmtEur(sum)}.` })
      return
    }
    setSplitOverrides((prev) => ({ ...prev, [row.rowNo]: amounts }))
    setPartEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${row.rowNo}-`))))
    setAmountDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${row.rowNo}-`))))
    setSplitEditor(null)
  }

  function resetSplit(rowNo: number) {
    setSplitOverrides((prev) => {
      const next = { ...prev }
      delete next[rowNo]
      return next
    })
    setPartEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${rowNo}-`))))
    setAmountDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${rowNo}-`))))
    setSplitEditor(null)
  }

  async function load(file: File | null) {
    if (!file) return
    setErr('')
    try {
      const rows = await readPayoutSource(file)
      if (!rows.length) throw new Error('V datoteki ni veljavnih vrstic z imenom, priimkom in zneskom.')
      setPartEdits({})
      setSplitOverrides({})
      setAmountDrafts({})
      setSource(rows)
      setFileName(file.name)
      setSetupOpen(false)
      setOnlyProblems(false)
    } catch (e: any) {
      setSource([])
      setFileName('')
      setPartEdits({})
      setSplitOverrides({})
      setAmountDrafts({})
      setSetupOpen(true)
      setErr(String(e?.message ?? e))
    }
  }

  async function save() {
    setErr('')
    if (!deskId) { setErr('Izberite interno lokacijo blagajne.'); return }
    if (!parts.length) { setErr('Najprej izberite Excel/CSV datoteko.'); return }
    if (invalidTimeRange) { setErr('Čas od mora biti enak ali pred časom do.'); return }
    if (!readiness.canImport) {
      setOnlyProblems(true)
      setErr(`Uvoz ni mogoč: ${readiness.blocked} od ${readiness.total} izdatkov še ni pripravljenih (vrstice ${readiness.blockedRows.join(', ')}). Vsak izdatek mora imeti datum, uro in Zadevo ter biti brez napak.`)
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
      setOnlyProblems(true)
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
        notes: `${batchName(month)}: ${fileName} · vrstica ${p.sourceRow} · izvorni znesek ${p.originalAmount.toFixed(2)} EUR · razpored ${formatSloDate(p.date)} ${normalizePayoutTime(p.time)} · ${sourceLabel(p)}`,
        status: 'ODPRT',
        syncStatus: 'LOKALNO',
        createdAt: at,
        createdBy: app.userLabel,
        updatedAt: at,
        updatedBy: app.userLabel,
      }))
      await db.docs.bulkPut(docs)
      await app.audit(batchName(month), 'BlagajniskiDokument', 'batch', `${fileName} · ${source.length} vrstic → ${docs.length} BI · ${fmtEur(total)} · ${formatSloDate(win.start)}–${formatSloDate(win.end)} · čas ${timeFrom}–${timeTo}`)
      if (app.mode === 'server') await app.syncNow()
      onDone()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  const statusTone = !parts.length ? 'idle' : readiness.canImport ? 'ok' : 'bad'
  const statusClasses = statusTone === 'ok'
    ? 'border-emerald-200 bg-emerald-50'
    : statusTone === 'bad' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50'
  const splitEditorRow = splitEditor ? sourceByRow.get(splitEditor.rowNo) : undefined
  const splitEditorTotal = splitEditor
    ? Math.round(splitEditor.amounts.reduce((sum, raw) => sum + (parseAmount(raw) ?? 0), 0) * 100) / 100
    : 0

  return (
    <>
    <Modal
      title={batchName(month)}
      wide
      onClose={requestClose}
      footer={<>
        <Btn onClick={requestClose}>Prekliči</Btn>
        <div className="flex-1" />
        {parts.length > 0 && !readiness.canImport && (
          <span className="mr-3 text-[12px] font-medium text-red-700">
            {readiness.blocked} {readiness.blocked === 1 ? 'izdatek' : readiness.blocked === 2 ? 'izdatka' : 'izdatkov'} za popravek
          </span>
        )}
        <Btn kind="primary" disabled={cannotCreate} onClick={save}>
          {parts.length ? `Ustvari ${parts.length} BI` : 'Ustvari BI'}
        </Btn>
      </>}
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}

      {/* ---------- 1 · setup: expanded until a file is loaded, then a single line ---------- */}
      {setupOpen ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="grid gap-3 md:grid-cols-5">
            <Field label="Obdobje" hint={`${formatSloDate(win.start)}–${formatSloDate(win.end)}`}>
              <input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </Field>
            <Field label="Blagajna">
              <select className={inputCls} value={deskId} onChange={(e) => setDeskId(e.target.value)}>
                <option value="">— izberi —</option>
                {locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Privzeta zadeva" hint="Po vrsticah spremenljiva.">
              <input className={inputCls} value={defaultSubject} onChange={(e) => { setSubjectCustomized(true); setDefaultSubject(e.target.value) }} />
            </Field>
            <Field label="Čas od"><input type="time" className={inputCls} value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} /></Field>
            <Field label="Čas do"><input type="time" className={inputCls} value={timeTo} onChange={(e) => setTimeTo(e.target.value)} /></Field>
          </div>
          {invalidTimeRange && <div className="mt-2"><ErrBox>Čas od mora biti enak ali pred časom do.</ErrBox></div>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
              ⇧ Izberi Excel (.xlsx) ali CSV
              <input type="file" className="hidden" accept=".xlsx,.csv,text/csv" onChange={(e) => { void load(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} />
            </label>
            <span className="text-[12px] text-slate-500">
              {fileName ? <><b className="text-slate-700">{fileName}</b> · {source.length} vrstic</> : <>Stolpci: <b>Ime</b>, <b>Priimek</b>, <b>Znesek</b>.</>}
            </span>
            {!!parts.length && (
              <button type="button" className="ml-auto text-[12px] font-medium text-blu-700 underline hover:text-blu-900" onClick={() => setSetupOpen(false)}>
                Skrij nastavitve
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-[12px] text-slate-600">
          <b className="text-slate-800">{fileName}</b>
          <span className="text-slate-300">|</span>
          <span>{deskName}</span>
          <span className="text-slate-300">|</span>
          <span className="font-mono">{formatSloDate(win.start)}–{formatSloDate(win.end)}</span>
          <span className="text-slate-300">|</span>
          <span className="font-mono">{timeFrom}–{timeTo}</span>
          <span className="text-slate-300">|</span>
          <span>{defaultSubject}</span>
          <button type="button" className="ml-auto font-medium text-blu-700 underline hover:text-blu-900" onClick={() => setSetupOpen(true)}>
            Spremeni
          </button>
        </div>
      )}

      {/* ---------- 2 · one status bar, replacing four overlapping banners ---------- */}
      <div className={`mt-3 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border px-3 py-2.5 ${statusClasses}`}>
        <div className="flex items-center gap-2.5">
          <span className={`text-lg leading-none ${statusTone === 'ok' ? 'text-emerald-600' : statusTone === 'bad' ? 'text-red-600' : 'text-slate-400'}`}>
            {statusTone === 'ok' ? '✓' : statusTone === 'bad' ? '⚠' : '·'}
          </span>
          <div className="leading-tight">
            <div className={`text-[13px] font-semibold ${statusTone === 'ok' ? 'text-emerald-800' : statusTone === 'bad' ? 'text-red-800' : 'text-slate-600'}`}>
              {!parts.length ? 'Izberite datoteko'
                : readiness.canImport ? 'Vse pripravljeno za uvoz'
                : `${readiness.blocked} od ${readiness.total} izdatkov za popravek`}
            </div>
            {!!parts.length && (
              <div className="text-[11.5px] text-slate-500">
                {readiness.canImport
                  ? 'Vsak izdatek ima datum, uro in Zadevo.'
                  : `Vrstice ${readiness.blockedRows.join(', ')} — dopolnite jih spodaj.`}
              </div>
            )}
          </div>
        </div>

        {!!parts.length && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Stat label="izdatkov" value={String(parts.length)} />
            <Stat label="skupaj" value={fmtEur(total)} tone={insufficientFunds ? 'bad' : undefined} />
            {available !== undefined && <Stat label="v blagajni" value={fmtEur(available)} tone={insufficientFunds ? 'bad' : undefined} />}
            {cashDiagnostics && (
              <Stat
                label="za izdatke na voljo"
                value={fmtEur(cashDiagnostics.spendableInWindow)}
                tone={cashDiagnostics.spendableInWindow + 0.001 < total ? 'bad' : 'ok'}
              />
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {readiness.blocked > 0 && (
            <button
              type="button"
              className={`rounded-md border px-2.5 py-1 text-[12px] font-medium ${onlyProblems ? 'border-red-300 bg-red-100 text-red-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setOnlyProblems((v) => !v)}
            >
              {onlyProblems ? `Pokaži vse (${parts.length})` : `Samo za popravek (${readiness.blocked})`}
            </button>
          )}
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => setRulesOpen((v) => !v)}
          >
            Pravila {rulesOpen ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {/* ---------- 3 · the long explanation, on demand only ---------- */}
      {rulesOpen && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
          <ul className="list-disc space-y-1 pl-4">
            <li>Vsak izdatek mora imeti <b>datum, uro in Zadevo</b>; datum in ura morata biti <b>znotraj dopust lista</b> zaposlenega.</li>
            <li>Sobote, nedelje in slovenski dela prosti prazniki se preskočijo.</li>
            <li>Znesek nad <b>{SPLIT_THRESHOLD_EUR} €</b> se samodejno razdeli na dele približno <b>{SPLIT_MIN_EUR}–{SPLIT_MAX_EUR} €</b>, praviloma zaokrožene na <b>5 €</b>; med deli je najmanj <b>{MIN_GAP_WORKDAYS} delovnih dni</b>.</li>
            <li>Število delov in zneske lahko ročno spremenite. Ročni deli so lahko tudi zunaj samodejnega razpona, vendar morajo biti vsi pozitivni in njihova vsota mora ostati enaka izvornemu znesku.</li>
            <li>Stanje blagajne ne sme <b>nikoli</b> pasti pod 0 € — ne ob posameznem izdatku ne skupno. Upoštevani so tudi interni prenosi.</li>
            <li>Kjer samodejni razpored ni našel veljavnega termina, sta datum in ura <b>prazna</b>, Zadevo pa vpišete sami. Uvoz je zaklenjen, dokler ni urejena <b>vsaka</b> vrstica.</li>
          </ul>
          {cashDiagnostics && cashDiagnostics.transferEvents > 0 && (
            <div className="mt-2 border-t border-slate-100 pt-2 font-mono text-[11.5px] text-slate-500">
              stanje {formatSloDate(win.start)}: {fmtEur(cashDiagnostics.startBalance)}
              {cashDiagnostics.transferIn > 0 && <> · prenosi prejeto +{fmtEur(cashDiagnostics.transferIn)}</>}
              {cashDiagnostics.transferOut > 0 && <> · prenosi oddano −{fmtEur(cashDiagnostics.transferOut)}</>}
              <> · {cashDiagnostics.transferEvents} internih prenosov v oknu</>
            </div>
          )}
        </div>
      )}

      {/* ---------- 4 · the table gets the room ---------- */}
      <div className="mt-3 max-h-[520px] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[1040px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="w-9 px-2 py-2"></th>
              <th className="min-w-[210px] px-2 py-2 text-left">Zaposleni</th>
              <th className="w-28 px-2 py-2 text-right">Znesek</th>
              <th className="w-36 px-2 py-2 text-left">Datum</th>
              <th className="w-24 px-2 py-2 text-left">Ura</th>
              <th className="min-w-[170px] px-2 py-2 text-left">Zadeva</th>
              <th className="min-w-[300px] px-2 py-2 text-left">Opombe</th>
            </tr>
          </thead>
          <tbody>
            {visibleParts.map((p) => {
              const rowErrors = allErrors.get(p.partKey) ?? []
              const edit = partEdits[p.partKey]
              const dateText = edit?.dateText ?? (p.date ? formatSloDate(p.date) : '')
              const timeText = edit?.time ?? p.time
              const ok = rowErrors.length === 0
              const needsUser = !!p.blockReason
              const siblings = partsPerRow.get(p.sourceRow) ?? 1
              const partNo = Number(p.partKey.split('-')[1]) + 1
              return (
                <tr key={p.partKey} className={`border-t border-slate-100 ${ok ? '' : needsUser ? 'bg-amber-50/70' : 'bg-red-50/60'}`}>
                  <td className="px-2 py-1.5 text-center align-top text-base leading-5" title={ok ? 'Pripravljeno' : 'Zahteva vašo pozornost'}>
                    {ok ? <span className="text-emerald-600">✓</span> : <span className="text-red-600">⚠</span>}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <div className="font-medium">
                      {p.employee ? p.employee.displayName : <span className="text-red-700">{p.employeeName} — ni najden</span>}
                      {siblings > 1 && <span className="ml-1.5 rounded bg-slate-200 px-1 py-0.5 font-mono text-[10px] text-slate-600">{partNo}/{siblings}</span>}
                      {splitOverrides[p.sourceRow] && <span className="ml-1.5 rounded bg-blu-50 px-1 py-0.5 text-[10px] font-medium text-blu-700">ročno</span>}
                    </div>
                    <div className="font-mono text-[10.5px] text-slate-400">
                      vr. {p.sourceRow}
                      {siblings > 1 && <> · iz {fmtEur(p.originalAmount)}</>}
                    </div>
                    {partNo === 1 && (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10.5px]">
                        <button type="button" className="font-medium text-blu-700 underline hover:text-blu-900" onClick={() => openSplitEditor(p.sourceRow)}>
                          Spremeni delitev
                        </button>
                        {splitOverrides[p.sourceRow] && (
                          <button type="button" className="text-slate-500 underline hover:text-slate-800" onClick={() => resetSplit(p.sourceRow)}>
                            samodejno
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right align-top">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        className={`${inputCls} w-[92px] text-right font-mono font-semibold tabular-nums ${rowErrors.some((x) => x.startsWith('Znesek') || x.startsWith('Vsota delov')) ? 'border-red-400 bg-red-50' : ''}`}
                        inputMode="decimal"
                        value={amountDrafts[p.partKey] ?? amountText(p.amount)}
                        onChange={(e) => setAmountDrafts((prev) => ({ ...prev, [p.partKey]: e.target.value }))}
                        onBlur={(e) => setPartAmount(p, e.target.value)}
                        aria-label={`Znesek za ${p.employeeName}, del ${partNo}`}
                      />
                      <span className="text-[11px] text-slate-500">€</span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <input
                      className={`${inputCls} min-w-[118px] font-mono ${rowErrors.some((x) => x.startsWith('Datum')) || (needsUser && !p.date) ? 'border-red-400 bg-red-50' : ''}`}
                      value={dateText}
                      placeholder="DD.MM.YYYY"
                      onChange={(e) => editPart(p.partKey, { dateText: e.target.value })}
                      onBlur={(e) => {
                        const parsed = parseSloDate(e.target.value)
                        if (parsed) editPart(p.partKey, { dateText: formatSloDate(parsed) })
                      }}
                    />
                    <div className="mt-0.5 pl-0.5 text-[10.5px] text-slate-400">{sourceLabel(p)}</div>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <input
                      className={`${inputCls} min-w-[74px] font-mono ${rowErrors.some((x) => x.startsWith('Ura')) || (needsUser && !p.time) ? 'border-red-400 bg-red-50' : ''}`}
                      value={timeText}
                      placeholder="HH:MM"
                      onChange={(e) => editPart(p.partKey, { time: e.target.value })}
                      onBlur={(e) => {
                        const normalized = normalizePayoutTime(e.target.value)
                        if (normalized) editPart(p.partKey, { time: normalized })
                      }}
                    />
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <input
                      className={`${inputCls} min-w-[160px] ${rowErrors.some((x) => x.startsWith('Zadeva')) ? 'border-red-400 bg-red-50' : ''}`}
                      value={p.subject}
                      placeholder="Zadeva (obvezno)"
                      onChange={(e) => editPart(p.partKey, { subject: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5 align-top text-[11.5px] leading-snug">
                    {p.blockReason && <div className="font-medium text-amber-900">{p.blockReason}</div>}
                    {rowErrors.filter((m) => m !== p.blockReason).map((m, i) => <div key={i} className="font-medium text-red-700">{m}</div>)}
                    {/* SPLIT is already shown by the "2/3" badge and "iz <amount>";
                        UNMATCHED_EMPLOYEE by the red name. Only show the rest. */}
                    {p.warnings
                      .filter((w) => w.code !== 'SPLIT' && w.code !== 'UNMATCHED_EMPLOYEE')
                      .map((w, i) => <div key={i} className="text-slate-400">{w.message}</div>)}
                    {edit && (
                      <button type="button" className="mt-0.5 text-[11px] text-slate-500 underline hover:text-slate-800" onClick={() => resetPart(p.partKey)}>
                        povrni predlog
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!parts.length && (
          <div className="p-10 text-center text-slate-400">
            Izberite Excel ali CSV datoteko. Pričakovani stolpci: <b>Ime</b>, <b>Priimek</b>, <b>Znesek</b>.
          </div>
        )}
        {!!parts.length && !visibleParts.length && (
          <div className="p-8 text-center text-slate-400">Ni vrstic za popravek.</div>
        )}
      </div>
    </Modal>
    {splitEditor && splitEditorRow && (
      <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4 backdrop-blur-[1px] no-print" onMouseDown={(e) => e.target === e.currentTarget && setSplitEditor(null)}>
        <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div>
              <div className="font-semibold text-slate-800">Spremeni delitev</div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                {splitEditorRow.displayName} · izvorni znesek <b>{fmtEur(splitEditorRow.amount)}</b>
              </div>
            </div>
            <button type="button" className="px-1 text-xl leading-none text-slate-400 hover:text-slate-700" onClick={() => setSplitEditor(null)} title="Zapri">×</button>
          </div>
          <div className="space-y-4 px-5 py-4">
            <Field label="Število delov" hint="Lahko zmanjšate ali povečate samodejni predlog.">
              <input type="number" min={1} max={20} step={1} className={`${inputCls} max-w-28`} value={splitEditor.amounts.length} onChange={(e) => setSplitCount(e.target.value)} />
            </Field>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Zneski delov</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {splitEditor.amounts.map((amount, index) => (
                  <label key={index} className="flex items-center gap-2">
                    <span className="w-12 text-[12px] text-slate-500">{index + 1}. del</span>
                    <input
                      className={`${inputCls} text-right font-mono`}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setSplitEditorAmount(index, e.target.value)}
                      autoFocus={index === 0}
                    />
                    <span className="text-sm text-slate-500">€</span>
                  </label>
                ))}
              </div>
            </div>
            <div className={`rounded-md border px-3 py-2 text-[12px] ${Math.abs(splitEditorTotal - splitEditorRow.amount) <= 0.001 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              Vsota: <b>{fmtEur(splitEditorTotal)}</b> / {fmtEur(splitEditorRow.amount)}
            </div>
            {splitEditor.error && <ErrBox>{splitEditor.error}</ErrBox>}
            <div className="text-[11.5px] leading-relaxed text-slate-500">
              Samodejna delitev uporablja dele približno {SPLIT_MIN_EUR}–{SPLIT_MAX_EUR} € in korak 5 €. Pri ročni delitvi lahko vnesete tudi drugačne zneske; pomembno je, da so pozitivni in da seštevek ostane enak izvornemu znesku.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-slate-200 bg-slate-50 px-5 py-3">
            {splitOverrides[splitEditor.rowNo] && <Btn onClick={() => resetSplit(splitEditor.rowNo)}>Povrni samodejno</Btn>}
            <div className="flex-1" />
            <Btn onClick={() => setSplitEditor(null)}>Prekliči</Btn>
            <Btn kind="primary" onClick={applySplitEditor}>Uporabi delitev</Btn>
          </div>
        </div>
      </div>
    )}
    {leaveConfirmOpen && (
      <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/50 p-4 backdrop-blur-[1px] no-print" onMouseDown={(e) => e.target === e.currentTarget && setLeaveConfirmOpen(false)}>
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="border-b border-slate-200 px-5 py-3 font-semibold text-slate-800">Želite zapustiti okno?</div>
          <div className="px-5 py-4 text-sm leading-relaxed text-slate-600">
            Če zapustite okno <b>{batchName(month)}</b>, bodo neshranjene spremembe uvoza izgubljene.
          </div>
          <div className="flex justify-end gap-2 rounded-b-xl border-t border-slate-200 bg-slate-50 px-5 py-3">
            <Btn onClick={() => setLeaveConfirmOpen(false)}>Ostani</Btn>
            <Btn kind="danger" onClick={onClose}>Zapusti</Btn>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

export { PayoutImportModal }
export default PayoutImportModal


import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import { Btn, Chip, ErrBox, Field, Modal, Warn, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { balanceInfo } from '../lib/balance'
import {
  buildPayoutParts,
  formatSloDate,
  normalizePayoutTime,
  parseSloDate,
  payoutWindow,
  readPayoutSource,
  validatePayoutSchedule,
  type CashEvent,
  type PayoutPart,
  type PayoutSourceRow,
} from '../lib/payoutImport'
import { fmtEur, nowIso, uuid } from '../lib/util'
import { physicalDesks } from '../lib/desks'
import { closeIdFor } from '../lib/numbering'

type PayoutImportPart = PayoutPart & {
  skipReason?: string
}

type PartEdit = {
  dateText?: string
  time?: string
  purpose?: string
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

function historicalBalanceAt(context: { currentBalance: number; events: CashEvent[] }, at: string): number {
  let balance = context.currentBalance
  for (const event of context.events) {
    if (event.at > at) balance -= event.delta
  }
  return Math.round(balance * 100) / 100
}

function sourceLabel(p: PayoutImportPart): string {
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
  const [purpose, setPurpose] = useState('Akontacija')
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

  const generatedParts = useMemo<PayoutImportPart[]>(
    () => buildPayoutParts(source, employees, potrdila, month, timeFrom, timeTo, cashContext) as PayoutImportPart[],
    [source, employees, potrdila, month, timeFrom, timeTo, cashContext],
  )
  const win = payoutWindow(month)
  const cashDiagnostics = useMemo(() => {
    if (!cashContext) return null
    const windowStartAt = `${win.start}T00:00:00`
    const windowEndAt = `${win.end}T23:59:59`
    const inWindow = cashContext.events.filter((e) => e.at >= windowStartAt && e.at <= windowEndAt)
    const transferIn = inWindow.filter((e) => e.source === 'TRANSFER' && e.delta > 0).reduce((sum, e) => sum + e.delta, 0)
    const transferOut = -inWindow.filter((e) => e.source === 'TRANSFER' && e.delta < 0).reduce((sum, e) => sum + e.delta, 0)
    return {
      startBalance: historicalBalanceAt(cashContext, windowStartAt),
      transferIn,
      transferOut,
      transferEvents: inWindow.filter((e) => e.source === 'TRANSFER').length,
    }
  }, [cashContext, win.start, win.end])

  const parts = useMemo(() => generatedParts.map((p) => {
    const edit = partEdits[p.partKey]
    const hasManualDate = edit?.dateText !== undefined
    const hasManualTime = edit?.time !== undefined
    const manuallyAdjusted = hasManualDate || hasManualTime
    const date = hasManualDate ? (parseSloDate(edit.dateText!) ?? '') : p.date
    const timeRaw = hasManualTime ? edit.time! : p.time
    const normalizedTime = normalizePayoutTime(timeRaw)
    const time = normalizedTime ?? timeRaw.trim()
    const at = date && normalizedTime ? `${date}T${normalizedTime}:00` : ''
    const covering = at && p.employee
      ? potrdila.find((cert) => cert.employeeId === p.employee!.id && at >= cert.fromAt && at <= cert.toAt)
      : null
    const skipReason = manuallyAdjusted && p.employee
      ? (covering ? undefined : 'Datum/čas ni znotraj dopust lista zaposlenega. Ta BI ne bo uvožen.')
      : p.skipReason
    return {
      ...p,
      date,
      time,
      dateSource: manuallyAdjusted ? 'MANUAL' as const : p.dateSource,
      potrdiloId: covering?.id ?? (manuallyAdjusted ? null : p.potrdiloId),
      scheduleError: manuallyAdjusted ? undefined : p.scheduleError,
      skipReason,
    }
  }), [generatedParts, partEdits, potrdila])

  const scheduleErrors = useMemo(
    () => validatePayoutSchedule(parts, win, timeFrom, timeTo, cashContext, potrdila),
    [parts, win.start, win.end, timeFrom, timeTo, cashContext],
  )

  const importParts = parts.filter((p) => !p.skipReason)
  const skippedParts = parts.filter((p) => !!p.skipReason)
  const total = importParts.reduce((s, p) => s + p.amount, 0)
  const skippedTotal = skippedParts.reduce((s, p) => s + p.amount, 0)
  const unmatched = importParts.filter((p) => !p.employee).length
  const fallback = importParts.filter((p) => p.dateSource === 'WINDOW').length
  const closedParts = importParts.filter((p) => p.date && closes.some((c) => c.id === closeIdFor(settings, deskId, p.date.slice(0, 7))))
  const balanceLoading = !!deskId && (available === undefined || cashEvents === undefined)
  const insufficientFunds = !!deskId && available !== undefined && total > available + 0.001
  const invalidTimeRange = !normalizePayoutTime(timeFrom) || !normalizePayoutTime(timeTo) || timeFrom > timeTo
  const invalidSchedule = scheduleErrors.size > 0
  const cannotCreate = busy || !importParts.length || unmatched > 0 || closedParts.length > 0 || invalidTimeRange || balanceLoading || insufficientFunds || invalidSchedule

  function editPart(partKey: string, patch: PartEdit) {
    setPartEdits((prev) => ({ ...prev, [partKey]: { ...prev[partKey], ...patch } }))
  }

  function partPurpose(p: PayoutImportPart): string {
    const edited = partEdits[p.partKey]?.purpose
    return (edited !== undefined ? edited : purpose).trim() || 'Akontacija'
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
    if (!importParts.length) { setErr('Ni nobenega BI z veljavnim datumom in časom znotraj dopust lista. Rumene vrstice se ne uvozijo.'); return }
    if (unmatched) { setErr('Uvoz ni mogoč, dokler vsi zaposleni niso enolično najdeni v seznamu zaposlenih.'); return }
    if (invalidTimeRange) { setErr('Čas od mora biti enak ali pred časom do.'); return }
    if (closedParts.length) { setErr('Nekateri ustvarjeni datumi padejo v že zaključen mesec za izbrano blagajno. Izberite drugo obdobje ali lokacijo.'); return }
    if (invalidSchedule) { setErr('Razpored vsebuje napake. Popravite rdeče označene vrstice pred ustvarjanjem BI dokumentov.'); return }

    // Re-check the cash history immediately before saving, so a concurrent change cannot create a historical negative balance.
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
    const freshErrors = validatePayoutSchedule(importParts, win, timeFrom, timeTo, freshContext, potrdila)
    if (freshErrors.size > 0) {
      setErr('Stanje blagajne se je med pripravo uvoza spremenilo. Razpored ni več varen; preverite označene datume in čase.')
      return
    }

    setBusy(true)
    try {
      const at = nowIso()
      const docs = importParts.map((p) => emptyDoc({
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
        purpose: partPurpose(p),
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
    <Modal title="Uvoz akontacij iz Excel-a / CSV" wide onClose={onClose} footer={<><Btn onClick={onClose}>Prekliči</Btn><div className="flex-1"/><Btn kind="primary" disabled={cannotCreate} onClick={save}>Ustvari {importParts.length || ''} BI dokumentov</Btn></>}>
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      <div className="mb-3 rounded-lg border border-blu-200 bg-blu-50 px-3 py-2 text-[12px] text-blu-900">
        <b>To je ločen uvoz akontacij.</b> Razpored upošteva dejansko zgodovino denarja v izbrani blagajni, meje dopust listov, delovne dni ter najmanj 7 dni med razdeljenimi BI.
      </div>
      <div className="grid md:grid-cols-5 gap-3">
        <Field label="Obdobje" hint={`Razpored ${formatSloDate(win.start)}–${formatSloDate(win.end)}.`}><input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Field label="Interna blagajna / lokacija"><select className={inputCls} value={deskId} onChange={(e) => setDeskId(e.target.value)}><option value="">— izberi —</option>{locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Privzeti namen" hint="Vsak BI ga lahko spodaj ročno spremeni."><input className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <Field label="Čas od" hint="Najzgodnejši čas BI."><input type="time" className={inputCls} value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} /></Field>
        <Field label="Čas do" hint="Najpoznejši čas BI."><input type="time" className={inputCls} value={timeTo} onChange={(e) => setTimeTo(e.target.value)} /></Field>
      </div>
      {invalidTimeRange && <div className="mt-2"><ErrBox>Čas od mora biti enak ali pred časom do.</ErrBox></div>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">⇧ Izberi akontacije Excel (.xlsx) / CSV<input type="file" className="hidden" accept=".xlsx,.csv,text/csv" onChange={(e) => { void load(e.target.files?.[0] ?? null); e.currentTarget.value = '' }} /></label>
        {fileName && <Chip tone="blue">{fileName}</Chip>}
        <Chip>{source.length} izvornih vrstic</Chip>
        <Chip tone="red">{importParts.length} BI za uvoz</Chip>
        {skippedParts.length > 0 && <Chip tone="amber">{skippedParts.length} preskočenih · {fmtEur(skippedTotal)}</Chip>}
        <Chip tone="blue">skupaj {fmtEur(total)}</Chip>
        {deskId && available !== undefined && <Chip tone={insufficientFunds ? 'red' : 'blue'}>trenutno v blagajni {fmtEur(available)}</Chip>}
      </div>

      {cashDiagnostics && (cashDiagnostics.transferEvents > 0 || invalidSchedule || insufficientFunds) && (
        <div className="mt-2 flex flex-wrap gap-2 items-center text-[12px]">
          <span className="font-semibold text-slate-500">Diagnostika blagajne:</span>
          <Chip>stanje {formatSloDate(win.start)}: {fmtEur(cashDiagnostics.startBalance)}</Chip>
          <Chip tone="green">interni prenosi prejeto: + {fmtEur(cashDiagnostics.transferIn)}</Chip>
          {cashDiagnostics.transferOut > 0 && <Chip tone="red">interni prenosi oddano: − {fmtEur(cashDiagnostics.transferOut)}</Chip>}
          <span className="text-slate-400">{cashDiagnostics.transferEvents} internih prenosov v oknu</span>
        </div>
      )}

      <div className="mt-3"><Warn>
        Vsak BI mora imeti <b>datum in čas znotraj dopust lista zaposlenega</b>. Če takega termina ni, vrstica ostane rumena in se ne uvozi. Sobote, nedelje in slovenski dela prosti prazniki se preskočijo. Če je en znesek razdeljen na več BI, je med njimi najmanj <b>7 dni</b>. Razpored upošteva tudi interne prenose in dejansko zgodovino stanja izbrane blagajne. Datum, čas in namen lahko pred uvozom še ročno popravite.
      </Warn></div>

      {(unmatched > 0 || fallback > 0 || skippedParts.length > 0 || closedParts.length > 0 || insufficientFunds || invalidSchedule) && (
        <div className="mt-2 flex gap-2 flex-wrap">
          {unmatched > 0 && <Chip tone="red">{unmatched} brez ujemanja zaposlenega</Chip>}
          {skippedParts.length > 0 && <Chip tone="amber">{skippedParts.length} brez veljavnega termina v dopust listu — preskočeno</Chip>}
          {fallback > 0 && <Chip tone="amber">{fallback} datumov znotraj dopust lista, vendar ne na njegovi meji</Chip>}
          {closedParts.length > 0 && <Chip tone="red">{closedParts.length} v zaključenem mesecu</Chip>}
          {insufficientFunds && available !== undefined && <Chip tone="red">Premalo sredstev: manjka {fmtEur(total - available)}</Chip>}
          {invalidSchedule && <Chip tone="red">{scheduleErrors.size} vrstic za popravek</Chip>}
        </div>
      )}
      {insufficientFunds && available !== undefined && <div className="mt-2"><ErrBox>Uvoz vsebuje {fmtEur(total)}, v izbrani blagajni pa je trenutno na voljo samo {fmtEur(available)}. Pri stanju so upoštevani tudi interni prenosi. Končno stanje po uvozu ne sme biti negativno.</ErrBox></div>}
      {skippedParts.length > 0 && <div className="mt-2"><Warn>Rumene vrstice nimajo veljavnega delovnega datuma in časa znotraj dopust lista. Ne bodo ustvarjene kot BI, ostale veljavne vrstice pa lahko uvozite.</Warn></div>}

      <div className="mt-3 max-h-[480px] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[1280px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase text-slate-500">
            <tr>
              <th className="px-2 py-2 text-left w-20">Vrstica</th>
              <th className="px-2 py-2 text-left min-w-[220px]">Zaposleni</th>
              <th className="px-2 py-2 text-right w-28">Izvorno</th>
              <th className="px-2 py-2 text-right w-28">BI znesek</th>
              <th className="px-2 py-2 text-left w-40">Datum</th>
              <th className="px-2 py-2 text-left w-28">Čas</th>
              <th className="px-2 py-2 text-left min-w-[220px]">Namen</th>
              <th className="px-2 py-2 text-left min-w-[300px]">Vir / opozorilo</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => {
              const rowErrors = scheduleErrors.get(p.partKey) ?? []
              const edit = partEdits[p.partKey]
              const dateText = edit?.dateText ?? formatSloDate(p.date)
              const timeText = edit?.time ?? p.time
              const skipped = !!p.skipReason
              return (
                <tr key={p.partKey} className={`border-t border-slate-100 ${skipped ? 'bg-amber-50/80' : rowErrors.length ? 'bg-red-50/60' : ''}`}>
                  <td className="px-2 py-1 font-mono">{p.sourceRow}</td>
                  <td className="px-2 py-1">{p.employee ? p.employee.displayName : <span className="text-red-700 font-medium">{p.employeeName} — ni najden</span>}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmtEur(p.originalAmount)}</td>
                  <td className="px-2 py-1 text-right font-mono font-semibold">{fmtEur(p.amount)}</td>
                  <td className="px-2 py-1">
                    <input
                      className={`${inputCls} font-mono min-w-[130px] ${rowErrors.some((x) => x.startsWith('Datum')) ? 'border-red-400 bg-red-50' : ''}`}
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
                      className={`${inputCls} font-mono min-w-[90px] ${rowErrors.some((x) => x.includes('Čas')) ? 'border-red-400 bg-red-50' : ''}`}
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
                      className={`${inputCls} min-w-[210px]`}
                      value={edit?.purpose ?? purpose}
                      onChange={(e) => editPart(p.partKey, { purpose: e.target.value })}
                      onBlur={(e) => { if (!e.target.value.trim()) editPart(p.partKey, { purpose: purpose.trim() || 'Akontacija' }) }}
                    />
                  </td>
                  <td className="px-2 py-1 text-[12px]">
                    <div className="font-medium text-slate-600">{sourceLabel(p)}</div>
                    {p.warning && <div className="text-amber-700">{p.warning}</div>}
                    {p.skipReason && <div className="text-amber-800 font-semibold">⚠ Preskočeno: {p.skipReason}</div>}
                    {p.cashAvailable !== undefined && p.cashAt && (
                      <div className="text-red-700 font-medium">
                        Najboljši veljavni termin: {formatSloDate(p.cashAt.slice(0, 10))} {p.cashAt.slice(11, 16)} · na voljo {fmtEur(p.cashAvailable)} · BI {fmtEur(p.amount)} · manjka {fmtEur(Math.max(0, p.amount - p.cashAvailable))}
                      </div>
                    )}
                    {rowErrors.map((message, index) => <div key={index} className="text-red-700 font-medium">{message}</div>)}
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

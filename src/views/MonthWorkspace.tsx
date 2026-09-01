import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp, useSyncState } from '../state'
import { EmployeeEdit } from './Employees'
import type { CashDocument, DocType } from '../types'
import { PREJEL_LABELS } from '../types'
import { cx, docNo, fmtDate, fmtDateTime, fmtEur, monthLabel, nDokumentovIma, nowIso, nowTime, parseAmount, todayIso, currentMonthKey, uuid } from '../lib/util'
import { closeIdFor, docProblems, sortChrono } from '../lib/numbering'
import { balanceInfo, checkBiCover } from '../lib/balance'
import { can } from '../lib/perms'
import { Btn, Chip, Warn, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { deleteDocument } from '../lib/persist'
import { CloseWizard, ManifestView } from './CloseWizard'
import type { PrintJob } from '../print'

export function MonthWorkspace({
  onOpenDoc, onPrint,
}: {
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
  onPrint: (job: PrintJob) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const [month, setMonth] = useState(currentMonthKey())
  const [fltType, setFltType] = useState<'' | DocType>('')
  const [fltEmp, setFltEmp] = useState('')
  const [search, setSearch] = useState('')
  const [wizard, setWizard] = useState<null | 'preview' | 'close'>(null)
  const [showManifest, setShowManifest] = useState(false)
  const [newEmpForDoc, setNewEmpForDoc] = useState<string | null>(null)
  const sync = useSyncState()

  const ALL_DESKS = '__all__'
  const VIEW_DESK_KEY = 'blagajna-workspace-desk'
  const [viewDeskId, setViewDeskId] = useState(() => {
    try { return localStorage.getItem(VIEW_DESK_KEY) || settings.activeDeskId || ALL_DESKS }
    catch { return settings.activeDeskId || ALL_DESKS }
  })

  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const employees = useLiveQuery(() => db.employees.toArray(), []) ?? []
  const docsAll = useLiveQuery(() => db.docs.where('monthKey').equals(month).toArray(), [month]) ?? []
  const monthCloses = useLiveQuery(() => db.closes.where('monthKey').equals(month).toArray(), [month]) ?? []
  const isAllDesks = viewDeskId === ALL_DESKS

  // If a remembered desk was removed, fall back to the current active desk (or All).
  useEffect(() => {
    if (isAllDesks || desks.length === 0 || desks.some((d) => d.id === viewDeskId)) return
    const fallback = desks.some((d) => d.id === settings.activeDeskId) ? settings.activeDeskId : ALL_DESKS
    setViewDeskId(fallback)
    try { localStorage.setItem(VIEW_DESK_KEY, fallback) } catch { /* storage can be blocked */ }
  }, [desks, isAllDesks, settings.activeDeskId, viewDeskId])

  const actionDeskId = isAllDesks
    ? (desks.some((d) => d.id === settings.activeDeskId) ? settings.activeDeskId : desks[0]?.id ?? '')
    : viewDeskId
  const close = !isAllDesks
    ? monthCloses.find((c) => c.id === closeIdFor(settings, viewDeskId, month)) ?? null
    : null
  const isClosed = !!close
  const actionIsClosed = !!actionDeskId && monthCloses.some((c) => c.id === closeIdFor(settings, actionDeskId, month))
  const docIsClosed = (d: CashDocument) => monthCloses.some((c) => c.id === closeIdFor(settings, d.deskId, month))

  const docs = useMemo(() => {
    return docsAll
      .filter((d) => isAllDesks || d.deskId === viewDeskId)
      .filter((d) => !fltType || d.type === fltType)
      .filter((d) => !fltEmp || d.employeeId === fltEmp)
      .filter((d) => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return (
          d.employeeName.toLowerCase().includes(q) ||
          d.purpose.toLowerCase().includes(q) ||
          String(d.amount ?? '').includes(q.replace(',', '.')) ||
          (d.officialNumber != null && String(d.officialNumber).includes(q))
        )
      })
      .sort(sortChrono)
  }, [docsAll, isAllDesks, viewDeskId, fltType, fltEmp, search])

  const deskDocs = useMemo(() => docsAll.filter((d) => isAllDesks || d.deskId === viewDeskId), [docsAll, isAllDesks, viewDeskId])
  const incomplete = deskDocs.filter((d) => d.status === 'ODPRT' && !docIsClosed(d) && docProblems(d, settings.requirePurpose).length > 0)
  const unsyncedHere = deskDocs.filter((d) => d.syncStatus === 'LOKALNO').length

  // Stanje blagajne: for All desks aggregate each desk separately so opening balances remain correct.
  const selectedAllDocs = useLiveQuery(
    () => isAllDesks ? db.docs.toArray() : db.docs.where('deskId').equals(viewDeskId).toArray(),
    [isAllDesks, viewDeskId],
  ) ?? []
  const bal = useMemo(() => {
    if (!isAllDesks) return balanceInfo(desks.find((x) => x.id === viewDeskId), selectedAllDocs, month)
    return desks.reduce((sum, desk) => {
      const part = balanceInfo(desk, selectedAllDocs.filter((d) => d.deskId === desk.id), month)
      return {
        opening: sum.opening + part.opening, prenos: sum.prenos + part.prenos,
        mBP: sum.mBP + part.mBP, mBI: sum.mBI + part.mBI, nBP: sum.nBP + part.nBP, nBI: sum.nBI + part.nBI,
        konec: sum.konec + part.konec, current: sum.current + part.current,
      }
    }, { opening: 0, prenos: 0, mBP: 0, mBI: 0, nBP: 0, nBI: 0, konec: 0, current: 0 })
  }, [desks, isAllDesks, month, selectedAllDocs, viewDeskId])

  function selectDesk(value: string) {
    setViewDeskId(value)
    try { localStorage.setItem(VIEW_DESK_KEY, value) } catch { /* storage can be blocked */ }
    // Only a concrete desk becomes the default for creating a new document.
    if (value !== ALL_DESKS && value !== settings.activeDeskId) void app.saveSettings({ activeDeskId: value })
    // A desk switch should immediately pull remote changes instead of waiting for the periodic sync tick.
    if (app.mode === 'server' && !sync.syncing) void app.syncNow()
  }

  function shiftMonth(delta: number) {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  /** »+« odpre poln obrazec (popup) — dokument se ustvari šele ob »Shrani«. */
  function newDoc(type: DocType) {
    if (!actionDeskId || actionIsClosed) return
    const inMonth = currentMonthKey() === month
    onOpenDoc(null, {
      deskId: actionDeskId,
      type,
      transactionDate: inMonth ? todayIso() : `${month}-01`,
      transactionTime: nowTime(),
      monthKey: month,
    })
  }

  // ---- inline urejanje ----
  async function commit(d: CashDocument, patch: Partial<CashDocument>, auditMsg?: string) {
    if (patch.transactionDate && patch.transactionDate !== d.transactionDate) {
      const mk = patch.transactionDate.slice(0, 7)
      const targetClose = await db.closes.get(closeIdFor(settings, d.deskId, mk))
      if (targetClose) {
        alert(`Mesec ${monthLabel(mk)} je že zaključen — datuma ni mogoče premakniti vanj.`)
        return
      }
      patch.monthKey = mk
    }
    if (patch.employeeId !== undefined) {
      patch.employeeName = employees.find((e) => e.id === patch.employeeId)?.displayName ?? ''
    }
    // pravilo: izdatek ne sme preseči stanja blagajne
    const next = { ...d, ...patch }
    if (next.status === 'ODPRT') {
      const cover = await checkBiCover(db, next)
      if (cover) { alert(cover); return }
    }
    await db.docs.update(d.id, { ...patch, syncStatus: 'LOKALNO', updatedAt: nowIso(), updatedBy: app.userLabel })
    if (auditMsg) await app.audit(auditMsg, 'BlagajniskiDokument', d.id, '')
  }

  function focusNext(rowId: string, col: string) {
    const idx = docs.findIndex((x) => x.id === rowId)
    const next = docs[idx + 1]
    if (next) document.querySelector<HTMLElement>(`[data-row="${next.id}"][data-col="${col}"]`)?.focus()
  }

  async function copyPrev(d: CashDocument) {
    const idx = docs.findIndex((x) => x.id === d.id)
    const prev = docs[idx - 1]
    if (!prev) return
    await commit(d, {
      transactionDate: prev.transactionDate,
      type: d.status === 'ODPRT' ? prev.type : d.type,
      employeeId: prev.employeeId,
      purpose: prev.purpose,
      amount: prev.amount,
      rows: prev.rows.map((r) => ({ ...r })),
      paymentMethod: prev.paymentMethod,
    }, 'Kopiranje prejšnje vrstice')
  }

  async function duplicate(d: CashDocument) {
    if (d.type === 'BI') {
      const cover = await checkBiCover(db, { id: '', type: 'BI', deskId: d.deskId, amount: d.amount, status: 'ODPRT' })
      if (cover) { alert(`Podvajanje ni mogoče. ${cover}`); return }
    }
    const copy = emptyDoc({
      ...d,
      id: uuid(),
      officialNumber: null,
      seqYear: null,
      status: 'ODPRT',
      signatures: [],
      attachments: [],
      prejelStatus: 'NI_PODPISANO',
      syncStatus: 'LOKALNO',
      createdAt: nowIso(),
      createdBy: app.userLabel,
      updatedAt: nowIso(),
      updatedBy: app.userLabel,
      finalizedAt: undefined,
      finalizedBy: undefined,
    })
    await db.docs.put(copy)
    await app.audit('Podvojena vrstica', 'BlagajniskiDokument', copy.id, `kopija ${d.id}`)
  }

  async function remove(d: CashDocument) {
    if (d.status !== 'ODPRT') return
    if (!window.confirm(`Izbrišem osnutek (${d.type} · ${d.employeeName || 'brez zaposlenega'} · ${d.amount != null ? fmtEur(d.amount) : 'brez zneska'})?`)) return
    await deleteDocument(db, d.id)
    await app.audit('Osnutek izbrisan', 'BlagajniskiDokument', d.id, '')
  }

  const keyHandler = (d: CashDocument, col: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
      focusNext(d.id, col)
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      copyPrev(d)
    }
  }

  const deskName = isAllDesks ? 'Vse blagajne' : desks.find((x) => x.id === viewDeskId)?.name ?? '—'
  const actionDeskName = desks.find((x) => x.id === actionDeskId)?.name ?? '—'

  return (
    <div>
      {/* Vrstica z izbirami */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-slate-300 bg-white overflow-hidden">
          <button className="px-2.5 py-1.5 hover:bg-slate-100" onClick={() => shiftMonth(-1)} title="Prejšnji mesec">‹</button>
          <input type="month" lang="sl-SI" className="px-1 py-1.5 text-sm font-medium outline-none w-40 text-center" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <button className="px-2.5 py-1.5 hover:bg-slate-100" onClick={() => shiftMonth(1)} title="Naslednji mesec">›</button>
        </div>
        <select
          className={cx(inputCls, 'w-auto font-medium')}
          value={viewDeskId}
          onChange={(e) => selectDesk(e.target.value)}
          title="Prikaz blagajne"
        >
          <option value={ALL_DESKS}>💶 Vse blagajne</option>
          {desks.map((x) => <option key={x.id} value={x.id}>💶 {x.name}</option>)}
        </select>
        {isAllDesks
          ? <Chip tone="blue">Vse blagajne</Chip>
          : isClosed
            ? <Chip tone="green">✓ Mesec zaključen</Chip>
            : <Chip tone="amber">Mesec odprt</Chip>}
        <div className="flex-1" />
        <Btn
          kind="default"
          disabled={sync.syncing}
          onClick={() => app.refreshData()}
          title={app.mode === 'server' ? 'Pošlje lokalne spremembe in ponovno prebere trenutno stanje s strežnika.' : 'Osveži lokalno predstavitveno stanje.'}
        >
          {sync.syncing ? '⟳ Osvežujem …' : '⟳ Osveži podatke'}
          {sync.pending > 0 && <span className="rounded-full bg-violet-100 text-violet-700 px-1.5 text-[11px] font-bold">{sync.pending}</span>}
        </Btn>
        {!isAllDesks && can(role, 'PREVIEW_NUMBERING', settings) && !isClosed && (
          <Btn onClick={() => setWizard('preview')}>Predogled številčenja</Btn>
        )}
        {!isAllDesks && (isClosed
          ? <Btn onClick={() => setShowManifest(true)}>Zapisnik zaključka</Btn>
          : can(role, 'CLOSE_MONTH', settings) && <Btn kind="primary" onClick={() => setWizard('close')}>Zaključi mesec</Btn>)}
      </div>

      {/* Stanje blagajne */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatCard
          big
          label="Stanje v blagajni"
          value={fmtEur(bal.current)}
          tone={bal.current < 0 ? 'red' : 'blue'}
          sub={`${deskName} · začetno stanje ${fmtEur(bal.opening)}`}
        />
        <StatCard label="Prenos pred mesecem" value={fmtEur(bal.prenos)} sub={`stanje pred ${monthLabel(month)}`} />
        <StatCard label={`Prejemki · ${monthLabel(month)}`} value={`+ ${fmtEur(bal.mBP)}`} tone="green" sub={`${bal.nBP} × BP`} />
        <StatCard label={`Izdatki · ${monthLabel(month)}`} value={`− ${fmtEur(bal.mBI)}`} tone="red" sub={`${bal.nBI} × BI`} />
        <StatCard label="Stanje ob koncu meseca" value={fmtEur(bal.konec)} tone={bal.konec < 0 ? 'red' : undefined} sub="prenos + mesečna razlika" />
      </div>

      {/* Statistika */}
      <div className="flex flex-wrap gap-2 mt-2 text-sm items-center">
        {incomplete.length > 0 && <Chip tone="red">nepopolni: {incomplete.length}</Chip>}
        {unsyncedHere > 0 && <Chip tone="violet">nesinhronizirano: {unsyncedHere}</Chip>}
        <span className="text-slate-400 text-[12px]">
          {monthLabel(month)} · {deskName}
          {isAllDesks ? ` · novi dokumenti: ${actionDeskName}` : (settings.numberingScope === 'COMPANY' ? ' · skupno številčenje podjetja' : ' · številčenje po blagajni')}
          {' · izdatek ne more preseči stanja blagajne'}
        </span>
      </div>

      {isClosed && (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 flex flex-wrap items-center gap-2">
          <span>✓ Mesec {monthLabel(month)} je zaključen ({close!.closedBy}, {fmtDateTime(close!.closedAt)}). Dokumenti so zaklenjeni — spremembe le prek storna.</span>
        </div>
      )}
      {!isClosed && incomplete.length > 0 && (
        <div className="mt-3">
          <Warn>
            {nDokumentovIma(incomplete.length)} manjkajoče podatke ({incomplete.slice(0, 3).map((d) => d.employeeName || d.type).join(', ')}{incomplete.length > 3 ? ', …' : ''}).
            {isAllDesks ? 'V posamezni blagajni je treba napake popraviti pred zaključkom meseca.' : 'Zaključek meseca do popravka ni mogoč — vnos lahko nadaljujete.'}
          </Warn>
        </div>
      )}

      {/* Filtri */}
      <div className="flex flex-wrap gap-2 mt-3">
        <select className={cx(inputCls, 'w-auto')} value={fltType} onChange={(e) => setFltType(e.target.value as any)}>
          <option value="">Vsi tipi</option>
          <option value="BP">Samo BP</option>
          <option value="BI">Samo BI</option>
        </select>
        <select className={cx(inputCls, 'w-auto')} value={fltEmp} onChange={(e) => setFltEmp(e.target.value)}>
          <option value="">Vsi zaposleni</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
        </select>
        <input className={cx(inputCls, 'w-56')} placeholder="Išči (namen, zaposleni, znesek, št.)" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        {!actionIsClosed && actionDeskId && (
          <>
            <Btn kind="success" onClick={() => newDoc('BP')} title={isAllDesks ? `Nov dokument bo dodan v: ${actionDeskName}` : undefined}>+ Prejemek (BP)</Btn>
            <Btn kind="danger" onClick={() => newDoc('BI')} title={isAllDesks ? `Nov dokument bo dodan v: ${actionDeskName}` : undefined}>+ Izdatek (BI)</Btn>
          </>
        )}
      </div>

      {/* Tabela */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm min-w-[1100px]">
          <thead>
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
              <th className="px-2 py-2 w-24">Številka</th>
              <th className="px-2 py-2 w-32">Datum</th>
              <th className="px-2 py-2 w-20">Čas</th>
              <th className="px-2 py-2 w-16">Tip</th>
              <th className="px-2 py-2 w-36">Blagajna</th>
              <th className="px-2 py-2 w-44">Zaposleni</th>
              <th className="px-2 py-2">Za</th>
              <th className="px-2 py-2 w-28 text-right">Znesek</th>
              <th className="px-2 py-2 w-20">Konto</th>
              <th className="px-2 py-2 w-24">Stanje</th>
              <th className="px-2 py-2 w-32 text-right">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">
                Ni dokumentov za izbrane filtre. {!actionIsClosed && actionDeskId && 'Dodajte vrstico z gumboma »+ Prejemek« / »+ Izdatek«.'}
              </td></tr>
            )}
            {docs.map((d) => {
              const problems = d.status === 'ODPRT' ? docProblems(d, settings.requirePurpose) : []
              const editable = d.status === 'ODPRT' && !docIsClosed(d)
              return (
                <tr key={d.id} className={cx('border-t border-slate-100 align-middle', problems.length > 0 && 'bg-red-50/60', d.status === 'STORNIRAN' && 'opacity-60')} title={problems.join('; ')}>
                  <td className="px-2 py-1 font-mono text-[12px] font-semibold whitespace-nowrap">
                    {d.officialNumber != null
                      ? docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat)
                      : <span className="text-amber-600 font-sans font-normal text-[11px]">osnutek</span>}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <input type="date" lang="sl-SI" data-row={d.id} data-col="datum" className={cellCls} defaultValue={d.transactionDate} key={`${d.id}d${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'datum')} onBlur={(e) => e.target.value !== d.transactionDate && commit(d, { transactionDate: e.target.value }, 'Sprememba datuma transakcije')} />
                      : <span className="font-mono text-[12px]">{fmtDate(d.transactionDate)}</span>}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <input type="time" lang="sl-SI" step="60" data-row={d.id} data-col="cas" className={cellCls} defaultValue={d.transactionTime} key={`${d.id}t${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'cas')} onBlur={(e) => e.target.value !== d.transactionTime && commit(d, { transactionTime: e.target.value }, 'Sprememba časa transakcije')} />
                      : <span className="font-mono text-[12px]">{d.transactionTime}</span>}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <select
                            data-row={d.id}
                            data-col="tip"
                            className={cx(
                              cellCls,
                              'font-bold border',
                              d.type === 'BP'
                                ? 'bg-emerald-200 text-emerald-700 border-emerald-300'
                                : 'bg-red-200 text-red-700 border-red-300'
                            )}
                            value={d.type}
                            onKeyDown={keyHandler(d, 'tip')}
                            onChange={(e) => commit(d, { type: e.target.value as DocType })}
                          >
                            <option value="BP">BP</option>
                            <option value="BI">BI</option>
                          </select>
                      : <Chip tone={d.type === 'BP' ? 'green' : 'red'}>{d.type}</Chip>}
                  </td>
                  <td className="px-2 py-1 text-[12px] whitespace-nowrap">
                    {desks.find((x) => x.id === d.deskId)?.name ?? d.deskId}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <select data-row={d.id} data-col="emp" className={cx(cellCls, !d.employeeId && 'border-red-300')} value={d.employeeId}
                          title="Dvoklik = nov zaposleni"
                          onKeyDown={keyHandler(d, 'emp')}
                          onDoubleClick={() => setNewEmpForDoc(d.id)}
                          onChange={(e) => {
                            if (e.target.value === '__new') { setNewEmpForDoc(d.id); return }
                            commit(d, { employeeId: e.target.value }, 'Sprememba zaposlenega')
                          }}>
                          <option value="">—</option>
                          <option value="__new">➕ Nov zaposleni …</option>
                          {employees.filter((e) => e.active || e.id === d.employeeId).map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
                        </select>
                      : <span>{d.employeeName}</span>}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <input data-row={d.id} data-col="za" className={cx(cellCls, settings.requirePurpose && !d.purpose.trim() && 'border-red-300')} defaultValue={d.purpose} key={`${d.id}p${d.updatedAt}`} placeholder="namen …"
                          onKeyDown={keyHandler(d, 'za')} onBlur={(e) => e.target.value !== d.purpose && commit(d, { purpose: e.target.value })} />
                      : <span className="text-[13px]">{d.purpose}</span>}
                  </td>
                  <td className="px-1 py-0.5 text-right">
                    {editable
                      ? <input data-row={d.id} data-col="znesek" inputMode="decimal" className={cx(cellCls, 'text-right font-mono', (d.amount == null || d.amount <= 0) && 'border-red-300')} placeholder="0,00"
                          defaultValue={d.amount != null ? String(d.amount).replace('.', ',') : ''} key={`${d.id}a${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'znesek')} onBlur={(e) => { const v = parseAmount(e.target.value); if (v !== d.amount) commit(d, { amount: v }, 'Sprememba zneska') }} />
                      : <span className="font-mono">{fmtEur(d.amount)}</span>}
                  </td>
                  <td className="px-1 py-0.5">
                    {editable
                      ? <input data-row={d.id} data-col="konto" className={cx(cellCls, 'font-mono')} defaultValue={d.rows[0]?.konto ?? ''} key={`${d.id}k${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'konto')} onBlur={(e) => {
                            const konto = e.target.value
                            if (konto === (d.rows[0]?.konto ?? '')) return
                            const rows = d.rows.length > 0
                              ? d.rows.map((r, i) => (i === 0 ? { ...r, konto } : r))
                              : konto ? [{ opis: d.purpose, konto, znesek: d.amount }] : []
                            commit(d, { rows })
                          }} />
                      : <span className="font-mono text-[12px]">{d.rows[0]?.konto ?? ''}</span>}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex flex-col gap-0.5 items-start">
                      {d.status === 'STORNIRAN' && <Chip tone="red">storno</Chip>}
                      {d.status === 'ZAKLJUCEN' && <Chip tone="green">zaključen</Chip>}
                      {d.status === 'ODPRT' && <Chip tone="amber">osnutek</Chip>}
                      {d.status === 'ODPRT' && problems.length > 0 && <Chip tone="red">nepopoln</Chip>}
                      {d.status === 'ODPRT' && problems.length === 0 && <Chip tone="green">pripravljen za zaključek</Chip>}
                      {d.status === 'ODPRT' && d.syncStatus === 'LOKALNO' && <Chip tone="violet">lokalno</Chip>}
                      {d.type === 'BI' && d.status !== 'ODPRT' && d.status !== 'STORNIRAN' && (
                        <Chip tone={d.prejelStatus === 'NI_PODPISANO' ? 'amber' : 'green'}>{PREJEL_LABELS[d.prejelStatus]}</Chip>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {d.attachments.length > 0 && <span className="mr-1 text-[12px]" title={`${d.attachments.length} prilog`}>📎{d.attachments.length}</span>}
                    {d.potrdiloId && <span className="mr-1 text-[12px]" title="Povezan dopust list">🧾</span>}
                    <button className="text-blu-600 hover:underline text-[13px] mr-2" onClick={() => onOpenDoc(d.id)}>Odpri</button>
                    {editable && <button className="text-slate-500 hover:text-blu-600 text-[13px] mr-2" title="Podvoji vrstico" onClick={() => duplicate(d)}>⎘</button>}
                    {editable && <button className="text-slate-400 hover:text-red-600 text-[13px]" title="Izbriši osnutek" onClick={() => remove(d)}>🗑</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[11px] text-slate-400">
        Status dokumenta: <b>osnutek</b> ostane do akcije <b>»Zaključi mesec«</b>. Takrat dobi uradno številko in status <b>zaključen</b>. · Hitri vnos: <b>Enter</b> = naslednja vrstica · <b>Ctrl+D</b> = kopiraj prejšnjo vrstico · ⎘ = podvoji.
      </div>

      {wizard && !isAllDesks && (
        <CloseWizard
          deskId={viewDeskId}
          monthKey={month}
          mode={wizard}
          onClose={() => setWizard(null)}
          onPrint={onPrint}
          onOpenDoc={(id) => { setWizard(null); onOpenDoc(id) }}
        />
      )}
      {showManifest && close && (
        <ManifestView close={close} onClose={() => setShowManifest(false)} onPrint={onPrint} />
      )}
      {newEmpForDoc && (
        <EmployeeEdit
          emp={null}
          onClose={() => setNewEmpForDoc(null)}
          onSaved={async (emp) => {
            const d = docs.find((x) => x.id === newEmpForDoc)
            if (d) await commit(d, { employeeId: emp.id }, 'Sprememba zaposlenega')
            setNewEmpForDoc(null)
          }}
        />
      )}
    </div>
  )
}

const cellCls =
  'w-full rounded border border-transparent hover:border-slate-300 focus:border-blu-600 focus:ring-1 focus:ring-blu-600/30 bg-transparent px-1.5 py-1 text-[13px] outline-none'

function StatCard({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: 'green' | 'red' | 'blue'; big?: boolean }) {
  const tones = { green: 'text-emerald-700', red: 'text-red-700', blue: 'text-blu-800' }
  return (
    <div className={cx('rounded-lg border bg-white px-3 py-2', big ? 'border-blu-200 shadow-sm' : 'border-slate-200')}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 truncate" title={label}>{label}</div>
      <div className={cx('font-mono font-bold leading-6', big ? 'text-xl' : 'text-base', tone ? tones[tone] : 'text-slate-800')}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 truncate" title={sub}>{sub}</div>}
    </div>
  )
}

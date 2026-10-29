import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp, useSyncState } from '../state'
import { EmployeeEdit } from './Employees'
import type { CashDesk, CashDocument, CashTransfer, DocType } from '../types'
import { PREJEL_LABELS, SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP } from '../types'
import { cx, docNo, fmtDate, fmtDateTime, fmtEur, monthLabel, nDokumentovIma, nowIso, nowTime, parseAmount, todayIso, currentMonthKey, uuid } from '../lib/util'
import { closeIdFor, docProblems } from '../lib/numbering'
import { availableInDesk, balanceInfo, checkBiCover } from '../lib/balance'
import { can } from '../lib/perms'
import { Btn, Chip, Modal, Warn, inputCls } from '../components/ui'
import { emptyDoc } from '../db'
import { deleteDocument, deleteTransfer } from '../lib/persist'
import { CloseWizard, ManifestView } from './CloseWizard'
import type { PrintJob } from '../print'
import { childDesks, locationIdsForView, physicalDesks } from '../lib/desks'
import { PayoutImportModal } from './PayoutImport'
import { InternalTransferModal } from './InternalTransfer'

function surnameFirst(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  const surname = parts.pop() ?? ''
  return `${surname} ${parts.join(' ')}`.trim()
}

function surnameSort(a: { displayName?: string }, b: { displayName?: string }) {
  return surnameFirst(a.displayName).localeCompare(surnameFirst(b.displayName), 'sl', { sensitivity: 'base' })
}

// Only two recorded signatures are needed for the dashboard to consider a BP/BI
// signed. Count distinct signing roles, including a manually confirmed BI
// 'Prejel'; printing for a future signature does not count.
const REQUIRED_SIGNATURES = 2
function signingProgress(doc: CashDocument) {
  const roles = doc.type === 'BP' ? SIGNATURE_ROLES_BP : SIGNATURE_ROLES_BI
  const signed = roles.filter((role) =>
    doc.signatures?.some((sig) => sig.role === role) ||
    (doc.type === 'BI' && role === 'PREJEL' && (doc.prejelStatus === 'ROCNO' || doc.prejelStatus === 'DIGITALNO')),
  ).length
  return { signed, complete: signed >= REQUIRED_SIGNATURES }
}

type TableFilters = {
  number: string
  dateFrom: string
  dateTo: string
  timeFrom: string
  timeTo: string
  type: '' | DocType
  deskId: string
  employeeId: string
  purpose: string
  incomingMin: string
  incomingMax: string
  outgoingMin: string
  outgoingMax: string
  status: '' | 'ODPRT' | 'ZAKLJUCEN' | 'STORNIRAN' | 'LOKALNO'
  signing: '' | 'MISSING' | 'NONE' | 'PARTIAL' | 'COMPLETE'
}
type SortColumn = 'number' | 'date' | 'time' | 'type' | 'desk' | 'employee' | 'purpose' | 'incoming' | 'outgoing' | 'status' | 'signing'
type SortDirection = 'asc' | 'desc'
const EMPTY_TABLE_FILTERS: TableFilters = {
  number: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', type: '',
  deskId: '', employeeId: '', purpose: '', incomingMin: '', incomingMax: '',
  outgoingMin: '', outgoingMax: '', status: '', signing: '',
}

// Filters are optional: the table starts uncluttered, and users pick only the
// controls they want. Removing a control also clears its value.
type OptionalFilter = 'date' | 'type' | 'signing' | 'status' | 'employee' | 'desk' | 'number' | 'purpose' | 'incoming' | 'outgoing' | 'time'
const FILTER_CHOICES: { id: OptionalFilter; label: string }[] = [
  { id: 'date', label: 'Datum' }, { id: 'type', label: 'Tip (BP / BI)' },
  { id: 'signing', label: 'Podpisi' }, { id: 'status', label: 'Stanje' },
  { id: 'employee', label: 'Zaposleni' }, { id: 'desk', label: 'Blagajna' },
  { id: 'number', label: 'Številka' }, { id: 'purpose', label: 'Namen' },
  { id: 'incoming', label: 'Prejemek (€)' }, { id: 'outgoing', label: 'Izdatek (€)' },
  { id: 'time', label: 'Čas' },
]
const FILTER_FIELDS: Record<OptionalFilter, (keyof TableFilters)[]> = {
  date: ['dateFrom', 'dateTo'], type: ['type'], signing: ['signing'], status: ['status'],
  employee: ['employeeId'], desk: ['deskId'], number: ['number'], purpose: ['purpose'],
  incoming: ['incomingMin', 'incomingMax'], outgoing: ['outgoingMin', 'outgoingMax'],
  time: ['timeFrom', 'timeTo'],
}
const VISIBLE_FILTERS_KEY = 'blagajna-workspace-visible-filters-v1'

type AttachmentPreview = {
  name: string
  mime: string
  src: string
  downloadName: string
}

function attachmentPreview(att: any): AttachmentPreview | null {
  if (!att) return null
  const name = att.name ?? att.fileName ?? att.filename ?? 'priponka'
  const mime = att.mime ?? att.mimeType ?? att.type ?? ''
  let src = att.dataUrl ?? att.dataURL ?? att.url ?? att.href ?? att.objectUrl ?? ''

  if (!src && typeof att.base64 === 'string') src = `data:${mime || 'application/octet-stream'};base64,${att.base64}`
  if (!src && typeof att.content === 'string') {
    src = att.content.startsWith('data:') ? att.content : `data:${mime || 'application/octet-stream'};base64,${att.content}`
  }
  if (!src && typeof Blob !== 'undefined' && att.blob instanceof Blob) src = URL.createObjectURL(att.blob)
  if (!src) return null
  return { name, mime, src, downloadName: name }
}

export function MonthWorkspace({
  onOpenDoc, onPrint,
}: {
  onOpenDoc: (id: string | null, initial?: Partial<CashDocument>) => void
  onPrint: (job: PrintJob) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const [month, setMonth] = useState(currentMonthKey())
  const [filters, setFilters] = useState<TableFilters>({ ...EMPTY_TABLE_FILTERS })
  const [selectedFilters, setSelectedFilters] = useState<OptionalFilter[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VISIBLE_FILTERS_KEY) ?? '[]')
      if (Array.isArray(saved)) return FILTER_CHOICES.map((choice) => choice.id).filter((id) => saved.includes(id))
    } catch { /* storage can be unavailable or malformed */ }
    return []
  })
  const [showFilterPicker, setShowFilterPicker] = useState(false)
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [search, setSearch] = useState('')
  const setFilter = <K extends keyof TableFilters>(key: K, value: TableFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }))
  }
  const removeFilter = (option: OptionalFilter) => {
    setSelectedFilters((previous) => previous.filter((item) => item !== option))
    setFilters((previous) => {
      const next = { ...previous }
      for (const field of FILTER_FIELDS[option]) next[field] = ''
      return next
    })
  }
  const toggleFilter = (option: OptionalFilter) => {
    if (selectedFilters.includes(option)) removeFilter(option)
    else setSelectedFilters((previous) => [...previous, option])
  }
  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')
    else { setSortColumn(column); setSortDirection(column === 'date' || column === 'time' ? 'desc' : 'asc') }
  }
  const resetTable = () => {
    setFilters({ ...EMPTY_TABLE_FILTERS })
    setSelectedFilters([])
    setShowFilterPicker(false)
    setSearch('')
    setSortColumn('date')
    setSortDirection('desc')
  }
  useEffect(() => {
    try { localStorage.setItem(VISIBLE_FILTERS_KEY, JSON.stringify(selectedFilters)) }
    catch { /* storage can be unavailable */ }
  }, [selectedFilters])
  const [wizard, setWizard] = useState<null | 'preview' | 'close'>(null)
  const [showManifest, setShowManifest] = useState(false)
  const [newEmpForDoc, setNewEmpForDoc] = useState<string | null>(null)
  const [showPayoutImport, setShowPayoutImport] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [attachmentDoc, setAttachmentDoc] = useState<CashDocument | null>(null)
  const [attachmentIndex, setAttachmentIndex] = useState(0)
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
  const transfersAll = useLiveQuery(() => db.transfers.where('monthKey').equals(month).toArray(), [month]) ?? []
  const monthCloses = useLiveQuery(() => db.closes.where('monthKey').equals(month).toArray(), [month]) ?? []
  const isAllDesks = viewDeskId === ALL_DESKS
  const viewDesk = desks.find((d) => d.id === viewDeskId)
  const isGroupView = !!viewDesk?.isGroup
  const parentDesk = viewDesk?.parentId ? desks.find((d) => d.id === viewDesk.parentId) : undefined
  const groupChildren = isGroupView && viewDesk ? childDesks(desks, viewDesk.id).filter((d) => !d.isGroup) : []
  const siblingLocations = parentDesk ? childDesks(desks, parentDesk.id).filter((d) => !d.isGroup) : []
  const transferGroups = useMemo(() => {
    const groups = new Map<string, CashDesk[]>()
    for (const d of desks.filter((x) => !x.isGroup && x.active && !!x.parentId)) {
      const rows = groups.get(d.parentId!) ?? []
      rows.push(d)
      groups.set(d.parentId!, rows)
    }
    return groups
  }, [desks])
  const canInternalTransfer = [...transferGroups.values()].some((rows) => rows.length >= 2)
  const canTransferFromCurrentGroup = isGroupView
    ? (transferGroups.get(viewDeskId)?.length ?? 0) >= 2
    : parentDesk
      ? (transferGroups.get(parentDesk.id)?.length ?? 0) >= 2
      : false
  const viewLocationIds = isAllDesks ? physicalDesks(desks).map((d) => d.id) : locationIdsForView(desks, viewDeskId)
  const viewLocationSet = new Set(viewLocationIds)
  const transfers = useMemo(() => transfersAll
    .filter((t) => viewLocationSet.has(t.fromDeskId) || viewLocationSet.has(t.toDeskId))
    .sort((a, b) => `${a.transactionDate}T${a.transactionTime}`.localeCompare(`${b.transactionDate}T${b.transactionTime}`) || a.createdAt.localeCompare(b.createdAt)),
    [transfersAll, viewDeskId, desks],
  )

  // If a remembered desk was removed, fall back to the current active desk (or All).
  useEffect(() => {
    if (isAllDesks || desks.length === 0 || desks.some((d) => d.id === viewDeskId)) return
    const fallback = desks.some((d) => d.id === settings.activeDeskId) ? settings.activeDeskId : ALL_DESKS
    setViewDeskId(fallback)
    try { localStorage.setItem(VIEW_DESK_KEY, fallback) } catch { /* storage can be blocked */ }
  }, [desks, isAllDesks, settings.activeDeskId, viewDeskId])

  const physical = physicalDesks(desks)
  const actionCandidates = isAllDesks ? physical : isGroupView ? physical.filter((d) => viewLocationSet.has(d.id)) : physical.filter((d) => d.id === viewDeskId)
  const actionDeskId = actionCandidates.some((d) => d.id === settings.activeDeskId) ? settings.activeDeskId : actionCandidates[0]?.id ?? ''
  const close = !isAllDesks && !isGroupView
    ? monthCloses.find((c) => c.id === closeIdFor(settings, viewDeskId, month)) ?? null
    : null
  const isClosed = !!close
  const actionIsClosed = !!actionDeskId && monthCloses.some((c) => c.id === closeIdFor(settings, actionDeskId, month))
  const docIsClosed = (d: CashDocument) => monthCloses.some((c) => c.id === closeIdFor(settings, d.deskId, month))

  const docs = useMemo(() => {
    const deskNames = new Map(desks.map((desk) => [desk.id, desk.name]))
    const minIn = parseAmount(filters.incomingMin)
    const maxIn = parseAmount(filters.incomingMax)
    const minOut = parseAmount(filters.outgoingMin)
    const maxOut = parseAmount(filters.outgoingMax)
    const normalized = (text: string) => text.toLocaleLowerCase('sl').trim()
    const q = normalized(search)

    return docsAll
      .filter((d) => viewLocationSet.has(d.deskId))
      .filter((d) => !filters.type || d.type === filters.type)
      .filter((d) => !filters.deskId || d.deskId === filters.deskId)
      .filter((d) => !filters.employeeId || d.employeeId === filters.employeeId)
      .filter((d) => !filters.number || normalized(d.officialNumber == null ? 'osnutek' : docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat, d.monthKey)).includes(normalized(filters.number)))
      .filter((d) => (!filters.dateFrom || d.transactionDate >= filters.dateFrom) && (!filters.dateTo || d.transactionDate <= filters.dateTo))
      .filter((d) => (!filters.timeFrom || d.transactionTime >= filters.timeFrom) && (!filters.timeTo || d.transactionTime <= filters.timeTo))
      .filter((d) => !filters.purpose || normalized(d.purpose).includes(normalized(filters.purpose)))
      .filter((d) => {
        if (minIn == null && maxIn == null) return true
        return d.type === 'BP' && d.amount != null && (minIn == null || d.amount >= minIn) && (maxIn == null || d.amount <= maxIn)
      })
      .filter((d) => {
        if (minOut == null && maxOut == null) return true
        return d.type === 'BI' && d.amount != null && (minOut == null || d.amount >= minOut) && (maxOut == null || d.amount <= maxOut)
      })
      .filter((d) => !filters.status || (filters.status === 'LOKALNO' ? d.syncStatus === 'LOKALNO' : d.status === filters.status))
      .filter((d) => {
        if (!filters.signing) return true
        // Cancelled documents must not appear in a list of pending signatures.
        if (d.status === 'STORNIRAN') return false
        const progress = signingProgress(d)
        if (filters.signing === 'MISSING') return !progress.complete
        if (filters.signing === 'NONE') return progress.signed === 0
        if (filters.signing === 'PARTIAL') return progress.signed > 0 && !progress.complete
        return progress.complete
      })
      .filter((d) => !q || (
        normalized(d.employeeName).includes(q) ||
        normalized(d.purpose).includes(q) ||
        String(d.amount ?? '').includes(q.replace(',', '.')) ||
        (d.officialNumber != null && String(d.officialNumber).includes(q))
      ))
      .sort((a, b) => {
        const value = (d: CashDocument): string | number => {
          switch (sortColumn) {
            case 'number': return d.officialNumber ?? -1
            case 'date': return `${d.transactionDate}T${d.transactionTime}`
            case 'time': return d.transactionTime
            case 'type': return d.type
            case 'desk': return deskNames.get(d.deskId) ?? d.deskId
            case 'employee': return surnameFirst(d.employeeName)
            case 'purpose': return d.purpose
            case 'incoming': return d.type === 'BP' ? d.amount ?? -1 : -1
            case 'outgoing': return d.type === 'BI' ? d.amount ?? -1 : -1
            case 'status': return d.status
            case 'signing': return signingProgress(d).signed
          }
        }
        const left = value(a)
        const right = value(b)
        const compared = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right), 'sl', { numeric: true, sensitivity: 'base' })
        return (sortDirection === 'asc' ? compared : -compared) || b.createdAt.localeCompare(a.createdAt)
      })
  }, [docsAll, viewDeskId, desks, filters, search, sortColumn, sortDirection, settings.numberFormat])

  const deskDocs = useMemo(() => docsAll.filter((d) => viewLocationSet.has(d.deskId)), [docsAll, viewDeskId, desks])
  const incomplete = deskDocs.filter((d) => d.status === 'ODPRT' && !docIsClosed(d) && docProblems(d, settings.requirePurpose).length > 0)
  const unsignedCount = deskDocs.filter((d) => d.status !== 'STORNIRAN' && !signingProgress(d).complete).length
  const unsyncedHere = deskDocs.filter((d) => d.syncStatus === 'LOKALNO').length + transfers.filter((t) => t.syncStatus === 'LOKALNO').length

  // Stanje blagajne: for All desks aggregate each desk separately so opening balances remain correct.
  const selectedAllDocs = useLiveQuery(
    () => (isAllDesks || isGroupView) ? db.docs.toArray() : db.docs.where('deskId').equals(viewDeskId).toArray(),
    [isAllDesks, isGroupView, viewDeskId],
  ) ?? []
  const selectedAllTransfers = useLiveQuery(
    () => (isAllDesks || isGroupView)
      ? db.transfers.toArray()
      : db.transfers.filter((t) => t.fromDeskId === viewDeskId || t.toDeskId === viewDeskId).toArray(),
    [isAllDesks, isGroupView, viewDeskId],
  ) ?? []
  const bal = useMemo(() => {
    if (!isAllDesks && !isGroupView) return balanceInfo(desks.find((x) => x.id === viewDeskId), selectedAllDocs, month, selectedAllTransfers)
    return physical.filter((desk) => isAllDesks || viewLocationSet.has(desk.id)).reduce((sum, desk) => {
      const part = balanceInfo(desk, selectedAllDocs.filter((d) => d.deskId === desk.id), month, selectedAllTransfers.filter((t) => t.fromDeskId === desk.id || t.toDeskId === desk.id))
      return {
        opening: sum.opening + part.opening, prenos: sum.prenos + part.prenos,
        mBP: sum.mBP + part.mBP, mBI: sum.mBI + part.mBI, nBP: sum.nBP + part.nBP, nBI: sum.nBI + part.nBI,
        mTransferIn: sum.mTransferIn + part.mTransferIn, mTransferOut: sum.mTransferOut + part.mTransferOut,
        nTransferIn: sum.nTransferIn + part.nTransferIn, nTransferOut: sum.nTransferOut + part.nTransferOut,
        konec: sum.konec + part.konec, current: sum.current + part.current,
      }
    }, { opening: 0, prenos: 0, mBP: 0, mBI: 0, nBP: 0, nBI: 0, mTransferIn: 0, mTransferOut: 0, nTransferIn: 0, nTransferOut: 0, konec: 0, current: 0 })
  }, [desks, isAllDesks, isGroupView, month, selectedAllDocs, selectedAllTransfers, viewDeskId])

  function selectDesk(value: string) {
    setViewDeskId(value)
    try { localStorage.setItem(VIEW_DESK_KEY, value) } catch { /* storage can be blocked */ }
    // Only a concrete desk becomes the default for creating a new document.
    const selected = desks.find((d) => d.id === value)
    if (value !== ALL_DESKS && !selected?.isGroup && value !== settings.activeDeskId) void app.saveSettings({ activeDeskId: value })
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

  const transferIsClosed = (t: CashTransfer) =>
    monthCloses.some((c) => c.id === closeIdFor(settings, t.fromDeskId, t.monthKey) || c.id === closeIdFor(settings, t.toDeskId, t.monthKey))

  async function removeTransfer(t: CashTransfer) {
    if (transferIsClosed(t)) return
    const from = desks.find((d) => d.id === t.fromDeskId)?.name ?? t.fromDeskId
    const to = desks.find((d) => d.id === t.toDeskId)?.name ?? t.toDeskId
    const targetBalance = await availableInDesk(db, t.toDeskId)
    if (targetBalance - t.amount < -1e-9) {
      alert(`Prenosa ni mogoče izbrisati, ker bi blagajna ${to} po izbrisu imela negativno stanje.`)
      return
    }
    if (!window.confirm(`Izbrišem interni prenos ${from} → ${to} (${fmtEur(t.amount)})?`)) return
    await deleteTransfer(db, t.id)
    await app.audit('Interni prenos izbrisan', 'InterniPrenos', t.id, `${from} → ${to} · ${fmtEur(t.amount)}`)
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

  const selectedAttachment = attachmentDoc?.attachments?.[attachmentIndex] as any
  const selectedAttachmentPreview = attachmentPreview(selectedAttachment)

  function showAttachments(d: CashDocument) {
    setAttachmentDoc(d)
    setAttachmentIndex(0)
  }

  function openAttachment(preview: AttachmentPreview | null) {
    if (!preview) return
    window.open(preview.src, '_blank', 'noopener,noreferrer')
  }

  function downloadAttachment(preview: AttachmentPreview | null) {
    if (!preview) return
    const a = document.createElement('a')
    a.href = preview.src
    a.download = preview.downloadName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const deskName = isAllDesks ? 'Vse blagajne' : `${desks.find((x) => x.id === viewDeskId)?.name ?? '—'}${isGroupView ? ' · skupaj' : ''}`
  const actionDeskName = desks.find((x) => x.id === actionDeskId)?.name ?? '—'

  return (
    <div className="relative left-1/2 w-[90vw] max-w-none -translate-x-1/2">
      {/* Vrstica z izbirami */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-slate-300 bg-white overflow-hidden">
          <button className="px-2.5 py-1.5 hover:bg-slate-100" onClick={() => shiftMonth(-1)} title="Prejšnji mesec">‹</button>
          <input type="month" lang="sl-SI" className="px-1 py-1.5 text-sm font-medium outline-none w-40 text-center" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <button className="px-2.5 py-1.5 hover:bg-slate-100" onClick={() => shiftMonth(1)} title="Naslednji mesec">›</button>
        </div>
        <select
          className={cx(inputCls, 'w-auto min-w-[250px] font-medium')}
          value={viewDeskId}
          onChange={(e) => selectDesk(e.target.value)}
          title="Izberite globalno blagajno za skupni pogled ali interno blagajno za njen lasten pregled"
        >
          <option value={ALL_DESKS}>💶 Vse blagajne podjetja</option>
          {desks.filter((x) => x.isGroup).map((g) => (
            <optgroup key={g.id} label={`🏦 ${g.name} — GLOBALNA`}>
              <option value={g.id}>🏦 {g.name} — SKUPAJ</option>
              {desks.filter((d) => d.parentId === g.id && !d.isGroup).map((d) => <option key={d.id} value={d.id}>↳ 💶 {d.name} — interna</option>)}
            </optgroup>
          ))}
          {desks.filter((d) => !d.isGroup && !d.parentId).length > 0 && (
            <optgroup label="Samostojne blagajne">
              {desks.filter((d) => !d.isGroup && !d.parentId).map((d) => <option key={d.id} value={d.id}>💶 {d.name}</option>)}
            </optgroup>
          )}
        </select>
        {isAllDesks
          ? <Chip tone="blue">Vse blagajne</Chip>
          : isGroupView ? <Chip tone="blue">Globalna blagajna · skupaj</Chip>
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
        {!isAllDesks && !isGroupView && can(role, 'PREVIEW_NUMBERING', settings) && !isClosed && (
          <Btn onClick={() => setWizard('preview')}>Predogled številčenja</Btn>
        )}
        {!isAllDesks && !isGroupView && (isClosed
          ? <Btn onClick={() => setShowManifest(true)}>Zapisnik zaključka</Btn>
          : can(role, 'CLOSE_MONTH', settings) && <Btn kind="primary" onClick={() => setWizard('close')}>Zaključi mesec</Btn>)}
      </div>

      {!isAllDesks && viewDesk && (
        <div className="mt-3 rounded-lg border border-blu-200 bg-blu-50/70 px-3 py-2.5">
          {isGroupView ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-blu-700">Glavna / globalna blagajna</span>
              <span className="font-semibold text-slate-800">🏦 {viewDesk.name}</span>
              <Chip tone="blue">SKUPAJ {fmtEur(bal.current)}</Chip>
              <span className="text-[12px] text-slate-500">Vse spodnje blagajne se seštevajo v ta pregled:</span>
              {groupChildren.map((d) => {
                const info = balanceInfo(d, selectedAllDocs.filter((x) => x.deskId === d.id), month, selectedAllTransfers.filter((t) => t.fromDeskId === d.id || t.toDeskId === d.id))
                return <button key={d.id} className="rounded-md border border-blu-200 bg-white px-2.5 py-1 text-[12px] font-medium text-blu-800 hover:bg-blu-100" onClick={() => selectDesk(d.id)}>↳ {d.name} · {fmtEur(info.current)}</button>
              })}
              {groupChildren.length === 0 && <span className="text-[12px] text-slate-400">Ni dodeljenih internih blagajn.</span>}
              {/*<Btn kind="violet" onClick={() => setShowTransfer(true)} title="Prenos gotovine med internima blagajnama; brez BP/BI.">↔ Interni prenos</Btn>*/}
            </div>
          ) : parentDesk ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-blu-700">Hierarhija blagajne</span>
              <button className="rounded-md border border-blu-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-blu-800 hover:bg-blu-100" onClick={() => selectDesk(parentDesk.id)}>🏦 {parentDesk.name} · POGLEJ SKUPAJ</button>
              <span className="text-slate-400">›</span>
              <span className="rounded-md bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-800 border border-slate-200">💶 {viewDesk.name} · interna</span>
              {siblingLocations.filter((d) => d.id !== viewDesk.id).map((d) => <button key={d.id} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-100" onClick={() => selectDesk(d.id)}>Druga lokacija: {d.name}</button>)}
              {<Btn kind="violet" onClick={() => setShowTransfer(true)} title="Prenos gotovine iz te interne blagajne v drugo interno blagajno iste glavne blagajne; brez BP/BI.">↔ Interni prenos</Btn>}
            </div>
          ) : (
            <div className="text-[12px] text-slate-600"><b>Samostojna blagajna:</b> {viewDesk.name}. V Nastavitvah jo lahko povežete z glavno/globalno blagajno.</div>
          )}
        </div>
      )}

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
      {(bal.nTransferIn > 0 || bal.nTransferOut > 0) && (
        <div className="mt-2 flex flex-wrap gap-2 items-center text-[12px]">
          <span className="text-slate-400 font-semibold uppercase tracking-wide">Interni prenosi v mesecu:</span>
          {bal.nTransferIn > 0 && <Chip tone="green">prejeto + {fmtEur(bal.mTransferIn)} · {bal.nTransferIn} prenosov</Chip>}
          {bal.nTransferOut > 0 && <Chip tone="red">oddano − {fmtEur(bal.mTransferOut)} · {bal.nTransferOut} prenosov</Chip>}
          {(isAllDesks || isGroupView) && <span className="text-slate-400">Prenosi znotraj iste glavne blagajne se v skupnem stanju med seboj izničijo.</span>}
        </div>
      )}
      {isGroupView && (
        <div className="mt-2 flex flex-wrap gap-2 items-center text-[12px]">
          <span className="text-slate-400 font-semibold uppercase tracking-wide">Po lokacijah:</span>
          {physical.filter((d) => viewLocationSet.has(d.id)).map((d) => {
            const info = balanceInfo(d, selectedAllDocs.filter((x) => x.deskId === d.id), month, selectedAllTransfers.filter((t) => t.fromDeskId === d.id || t.toDeskId === d.id))
            return <Chip key={d.id} tone={info.current < 0 ? 'red' : 'blue'}>{d.name}: {fmtEur(info.current)}</Chip>
          })}
        </div>
      )}

      {/* Statistika */}
      <div className="flex flex-wrap gap-2 mt-2 text-sm items-center">
        {incomplete.length > 0 && <Chip tone="red">nepopolni: {incomplete.length}</Chip>}
        {unsyncedHere > 0 && <Chip tone="violet">nesinhronizirano: {unsyncedHere}</Chip>}
        <span className="text-slate-400 text-[12px]">
          {monthLabel(month)} · {deskName}
          {(isAllDesks || isGroupView) ? ` · novi dokumenti: ${actionDeskName}` : (settings.numberingScope === 'COMPANY' ? ' · skupno številčenje podjetja' : ' · številčenje po blagajni')}
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
            {(isAllDesks || isGroupView) ? 'V posamezni interni blagajni je treba napake popraviti pred zaključkom meseca.' : 'Zaključek meseca do popravka ni mogoč — vnos lahko nadaljujete.'}
          </Warn>
        </div>
      )}

      {/* Filtri */}
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          className={cx('rounded-md border px-3 py-1.5 text-[12px] font-semibold', filters.signing === 'MISSING' ? 'border-amber-400 bg-amber-100 text-amber-900' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}
          onClick={() => setFilter('signing', filters.signing === 'MISSING' ? '' : 'MISSING')}
          aria-pressed={filters.signing === 'MISSING'}
          title="Prikaži dokumente z manj kot dvema evidentiranima podpisoma (tudi osnutke). Stornirani so izključeni."
        >✍ Čaka na podpis ({unsignedCount})</button>
        <input className={cx(inputCls, 'w-56')} placeholder="Išči (namen, zaposleni, znesek, št.)" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className={cx('rounded-md border px-3 py-1.5 text-[12px] font-semibold', showFilterPicker || selectedFilters.length ? 'border-blu-300 bg-blu-50 text-blu-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')} onClick={() => setShowFilterPicker((visible) => !visible)} aria-expanded={showFilterPicker} aria-controls="optional-filter-picker">
          {showFilterPicker ? '− Skrij izbiro filtrov' : `+ Dodaj filter${selectedFilters.length ? ` (${selectedFilters.length})` : ''}`}
        </button>
        <Btn onClick={resetTable} title="Počisti vse filtre, iskanje in razvrščanje">Počisti filtre</Btn>
        <span className="self-center text-[12px] text-slate-500">Prikazano: <b>{docs.length}</b> / {deskDocs.length}</span>
        <div className="flex-1" />
        {!actionIsClosed && actionDeskId && (
          <Btn onClick={() => setShowPayoutImport(true)} title="Uvoz dodatkov akontacij iz Excel/CSV; uvoz zaposlenih ostaja v zavihku Zaposleni.">⇧ Akontacije dodatki za {monthLabel(month)}</Btn>
        )}
        {/*<Btn kind="violet" onClick={() => setShowTransfer(true)} title="Interni prenos gotovine med blagajnami; brez BP/BI. Gumb je vedno viden na zaslonu Blagajna.">↔ Interni prenos</Btn>*/}
        {!actionIsClosed && actionDeskId && (
          <>
            <Btn kind="success" onClick={() => newDoc('BP')} title={(isAllDesks || isGroupView) ? `Nov dokument bo dodan v: ${actionDeskName}` : undefined}>+ Prejemek (BP)</Btn>
            <Btn kind="danger" onClick={() => newDoc('BI')} title={(isAllDesks || isGroupView) ? `Nov dokument bo dodan v: ${actionDeskName}` : undefined}>+ Izdatek (BI)</Btn>
          </>
        )}
      </div>

      {/* The table headers remain sortable; only requested filters appear here. */}
      {showFilterPicker && (
        <div id="optional-filter-picker" className="mt-2 rounded-lg border border-blu-200 bg-blu-50/50 p-3">
          <div className="mb-2 text-[12px] text-slate-600">Izberite filtre, ki jih želite uporabljati. Neizbrani filtri ne zasedajo prostora.</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {FILTER_CHOICES.map(({ id, label }) => (
              <label key={id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-700 cursor-pointer hover:bg-slate-50">
                <input type="checkbox" className="accent-blue-700" checked={selectedFilters.includes(id)} onChange={() => toggleFilter(id)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {selectedFilters.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Izbrani filtri">
          {selectedFilters.map((option) => (
            <div key={option} className="min-w-[220px] max-w-[360px] flex-1 rounded-md border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold text-slate-700">{FILTER_CHOICES.find((choice) => choice.id === option)?.label}</span>
                <button type="button" className="rounded px-1.5 text-slate-500 hover:bg-slate-200 hover:text-red-700" aria-label={`Odstrani filter ${option}`} title="Odstrani filter in počisti njegovo vrednost" onClick={() => removeFilter(option)}>×</button>
              </div>
              {option === 'number' && <input aria-label="Filtriraj po številki" className={filterCls} placeholder="Št. / osnutek" value={filters.number} onChange={(e) => setFilter('number', e.target.value)} />}
              {option === 'date' && <div className="flex gap-2"><label className="min-w-0 flex-1 text-[11px] text-slate-500">Od<input aria-label="Datum od" type="date" className={filterCls} value={filters.dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} /></label><label className="min-w-0 flex-1 text-[11px] text-slate-500">Do<input aria-label="Datum do" type="date" className={filterCls} value={filters.dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} /></label></div>}
              {option === 'time' && <div className="flex gap-2"><label className="min-w-0 flex-1 text-[11px] text-slate-500">Od<input aria-label="Čas od" type="time" className={filterCls} value={filters.timeFrom} onChange={(e) => setFilter('timeFrom', e.target.value)} /></label><label className="min-w-0 flex-1 text-[11px] text-slate-500">Do<input aria-label="Čas do" type="time" className={filterCls} value={filters.timeTo} onChange={(e) => setFilter('timeTo', e.target.value)} /></label></div>}
              {option === 'type' && <select aria-label="Filtriraj po tipu" className={filterCls} value={filters.type} onChange={(e) => setFilter('type', e.target.value as TableFilters['type'])}><option value="">Vsi</option><option value="BP">BP</option><option value="BI">BI</option></select>}
              {option === 'desk' && <select aria-label="Filtriraj po blagajni" className={filterCls} value={filters.deskId} onChange={(e) => setFilter('deskId', e.target.value)}><option value="">Vse blagajne</option>{physical.filter((desk) => viewLocationSet.has(desk.id)).map((desk) => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select>}
              {option === 'employee' && <select aria-label="Filtriraj po zaposlenem" className={filterCls} value={filters.employeeId} onChange={(e) => setFilter('employeeId', e.target.value)}><option value="">Vsi zaposleni</option>{[...employees].sort(surnameSort).map((emp) => <option key={emp.id} value={emp.id}>{surnameFirst(emp.displayName)}</option>)}</select>}
              {option === 'purpose' && <input aria-label="Filtriraj po namenu" className={filterCls} placeholder="Išči namen …" value={filters.purpose} onChange={(e) => setFilter('purpose', e.target.value)} />}
              {option === 'incoming' && <div className="flex gap-2"><input aria-label="Prejemek najmanj EUR" className={filterCls} inputMode="decimal" placeholder="Od €" value={filters.incomingMin} onChange={(e) => setFilter('incomingMin', e.target.value)} /><input aria-label="Prejemek največ EUR" className={filterCls} inputMode="decimal" placeholder="Do €" value={filters.incomingMax} onChange={(e) => setFilter('incomingMax', e.target.value)} /></div>}
              {option === 'outgoing' && <div className="flex gap-2"><input aria-label="Izdatek najmanj EUR" className={filterCls} inputMode="decimal" placeholder="Od €" value={filters.outgoingMin} onChange={(e) => setFilter('outgoingMin', e.target.value)} /><input aria-label="Izdatek največ EUR" className={filterCls} inputMode="decimal" placeholder="Do €" value={filters.outgoingMax} onChange={(e) => setFilter('outgoingMax', e.target.value)} /></div>}
              {option === 'status' && <select aria-label="Filtriraj po stanju" className={filterCls} value={filters.status} onChange={(e) => setFilter('status', e.target.value as TableFilters['status'])}><option value="">Vsa stanja</option><option value="ODPRT">Osnutek</option><option value="ZAKLJUCEN">Zaključen</option><option value="STORNIRAN">Storniran</option><option value="LOKALNO">Nesinhroniziran</option></select>}
              {option === 'signing' && <select aria-label="Filtriraj po podpisih" className={filterCls} value={filters.signing} onChange={(e) => setFilter('signing', e.target.value as TableFilters['signing'])}><option value="">Vsi podpisi</option><option value="MISSING">Čaka na podpis (manj kot 2)</option><option value="NONE">Brez podpisov</option><option value="PARTIAL">1 podpis</option><option value="COMPLETE">Podpisano (vsaj 2)</option></select>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 text-[11px] text-slate-500">Kliknite naslov stolpca za razvrščanje. Za status »podpisano« zadostujeta dva evidentirana podpisa (tudi ročno potrjeni »Prejel« pri BI).</div>
      <div className="mt-2 h-[520px] w-full overflow-auto overscroll-contain rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm min-w-[1780px]">
          <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm">
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
              {([
                ['number', 'Številka'], ['date', 'Datum'], ['time', 'Čas'], ['type', 'Tip'],
                ['desk', 'Blagajna'], ['employee', 'Zaposleni'], ['purpose', 'Za'],
                ['incoming', '+'], ['outgoing', '−'], ['status', 'Stanje'], ['signing', 'Podpisi'],
              ] as [SortColumn, string][]).map(([column, label]) => (
                <th key={column} scope="col" className={cx('px-2 py-2 whitespace-nowrap', column === 'purpose' ? 'min-w-[230px]' : column === 'employee' ? 'min-w-[205px]' : 'min-w-[110px]')}>
                  <button type="button" onClick={() => toggleSort(column)} title={`Razvrsti po stolpcu ${label}`} className={cx('w-full flex items-center gap-1 hover:text-blu-700', column === 'incoming' || column === 'outgoing' ? 'justify-end' : 'text-left')}>
                    {label} <span aria-hidden="true" className={cx(sortColumn === column ? 'text-blu-700 font-bold' : 'text-slate-300')}>{sortColumn === column ? sortDirection === 'asc' ? '↑' : '↓' : '↕'}</span>
                  </button>
                </th>
              ))}
              <th scope="col" className="px-2 py-2 min-w-[135px] text-right">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-slate-400">
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
                      ? docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat, d.monthKey)
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
                  <td className="px-2 py-0.5 min-w-[250px]">
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
                          {employees.filter((e) => e.active || e.id === d.employeeId).sort(surnameSort).map((e) => <option key={e.id} value={e.id}>{surnameFirst(e.displayName)}</option>)}
                        </select>
                      : <span>{surnameFirst(d.employeeName)}</span>}
                  </td>
                  <td className="px-2 py-0.5 min-w-[280px]">
                    {editable
                      ? <input data-row={d.id} data-col="za" className={cx(cellCls, settings.requirePurpose && !d.purpose.trim() && 'border-red-300')} defaultValue={d.purpose} key={`${d.id}p${d.updatedAt}`} placeholder="namen …"
                          onKeyDown={keyHandler(d, 'za')} onBlur={(e) => e.target.value !== d.purpose && commit(d, { purpose: e.target.value })} />
                      : <span className="text-[13px]">{d.purpose}</span>}
                  </td>
                  <td className="px-1 py-0.5 text-right font-mono font-semibold text-emerald-700 whitespace-nowrap">
                    {d.type === 'BP' && (editable
                      ? <input data-row={d.id} data-col="znesek" inputMode="decimal" className={cx(cellCls, 'text-right font-mono text-emerald-700 font-semibold', (d.amount == null || d.amount <= 0) && 'border-red-300')} placeholder="0,00"
                          defaultValue={d.amount != null ? String(d.amount).replace('.', ',') : ''} key={`${d.id}a${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'znesek')} onBlur={(e) => { const v = parseAmount(e.target.value); if (v !== d.amount) commit(d, { amount: v }, 'Sprememba zneska') }} />
                      : d.amount != null ? `+ ${fmtEur(d.amount)}` : '')}
                  </td>
                  <td className="px-1 py-0.5 text-right font-mono font-semibold text-red-700 whitespace-nowrap">
                    {d.type === 'BI' && (editable
                      ? <input data-row={d.id} data-col="znesek" inputMode="decimal" className={cx(cellCls, 'text-right font-mono text-red-700 font-semibold', (d.amount == null || d.amount <= 0) && 'border-red-300')} placeholder="0,00"
                          defaultValue={d.amount != null ? String(d.amount).replace('.', ',') : ''} key={`${d.id}a${d.updatedAt}`}
                          onKeyDown={keyHandler(d, 'znesek')} onBlur={(e) => { const v = parseAmount(e.target.value); if (v !== d.amount) commit(d, { amount: v }, 'Sprememba zneska') }} />
                      : d.amount != null ? `− ${fmtEur(d.amount)}` : '')}
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
                        <Chip tone={d.prejelStatus === 'ROCNO' || d.prejelStatus === 'DIGITALNO' ? 'green' : 'amber'}>{PREJEL_LABELS[d.prejelStatus]}</Chip>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-[11px] whitespace-nowrap">
                    {(() => {
                      const progress = signingProgress(d)
                      return (
                        <span title={`Evidentiranih podpisov: ${progress.signed}. Za status podpisano zadostujeta 2.`} className={cx('inline-block rounded px-2 py-1 font-semibold', d.status === 'STORNIRAN' ? 'bg-slate-100 text-slate-400' : progress.complete ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800')}>
                          {d.status === 'STORNIRAN' ? '—' : `${Math.min(progress.signed, REQUIRED_SIGNATURES)}/${REQUIRED_SIGNATURES} ${progress.complete ? '✓' : 'čaka'}`}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {d.attachments.length > 0 && <button className="mr-2 text-[12px] text-blu-700 hover:underline" title={`${d.attachments.length} priponk — klik za predogled`} onClick={() => showAttachments(d)}>📎{d.attachments.length}</button>}
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

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">↔ Interni prenosi gotovine</div>
          <Chip>{transfers.length} prenosov</Chip>
          <span className="text-[11px] text-slate-400">Ločeno od BP/BI; prikazano v izvorni in ciljni blagajni.</span>
        </div>
        <div className="h-[260px] overflow-auto overscroll-contain rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm min-w-[780px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left shadow-sm">
              <tr>
                <th className="px-2 py-2 w-28">Datum</th>
                <th className="px-2 py-2 w-20">Čas</th>
                <th className="px-2 py-2">Iz blagajne</th>
                <th className="px-2 py-2">V blagajno</th>
                <th className="px-2 py-2 w-28 text-right">Znesek</th>
                <th className="px-2 py-2">Opomba</th>
                <th className="px-2 py-2 w-28 text-right">Stanje</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && <tr><td colSpan={7} className="px-3 py-5 text-center text-slate-400">V tem mesecu ni internih prenosov za izbrani pogled.</td></tr>}
              {transfers.map((t) => {
                const from = desks.find((d) => d.id === t.fromDeskId)?.name ?? t.fromDeskId
                const to = desks.find((d) => d.id === t.toDeskId)?.name ?? t.toDeskId
                const closedTransfer = transferIsClosed(t)
                return (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 font-mono text-[12px]">{fmtDate(t.transactionDate)}</td>
                    <td className="px-2 py-1.5 font-mono text-[12px]">{t.transactionTime}</td>
                    <td className="px-2 py-1.5"><span className="font-medium text-red-700">{from}</span></td>
                    <td className="px-2 py-1.5"><span className="font-medium text-emerald-700">{to}</span></td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtEur(t.amount)}</td>
                    <td className="px-2 py-1.5 text-slate-600">{t.notes || '—'}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {closedTransfer ? <Chip tone="green">zaklenjen</Chip> : t.syncStatus === 'LOKALNO' ? <Chip tone="violet">lokalno</Chip> : <Chip tone="blue">prenos</Chip>}
                      {!closedTransfer && <button className="ml-2 text-slate-400 hover:text-red-600 text-[13px]" title="Izbriši interni prenos" onClick={() => removeTransfer(t)}>🗑</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-2 text-[11px] text-slate-400">
        Status dokumenta: <b>osnutek</b> ostane do akcije <b>»Zaključi mesec«</b>. Takrat dobi uradno številko in status <b>zaključen</b>. · Hitri vnos: <b>Enter</b> = naslednja vrstica · <b>Ctrl+D</b> = kopiraj prejšnjo vrstico · ⎘ = podvoji.
      </div>

      {attachmentDoc && (
        <Modal
          title={`Priponke · ${attachmentDoc.employeeName || attachmentDoc.type}`}
          wide
          onClose={() => setAttachmentDoc(null)}
          footer={<>
            <Btn onClick={() => openAttachment(selectedAttachmentPreview)} disabled={!selectedAttachmentPreview}>Odpri v novem zavihku</Btn>
            <Btn onClick={() => downloadAttachment(selectedAttachmentPreview)} disabled={!selectedAttachmentPreview}>Prenesi</Btn>
            <div className="flex-1" />
            <Btn kind="primary" onClick={() => setAttachmentDoc(null)}>Zapri</Btn>
          </>}
        >
          <div className="grid md:grid-cols-[220px_1fr] gap-3 min-h-[420px]">
            <div className="space-y-1">
              {attachmentDoc.attachments.map((att: any, index: number) => {
                const preview = attachmentPreview(att)
                const name = preview?.name ?? att?.name ?? att?.fileName ?? att?.filename ?? `Priponka ${index + 1}`
                return (
                  <button
                    key={att?.id ?? `${name}-${index}`}
                    className={cx('w-full rounded-md border px-2.5 py-2 text-left text-sm', index === attachmentIndex ? 'border-blu-600 bg-blu-50' : 'border-slate-200 hover:bg-slate-50')}
                    onClick={() => setAttachmentIndex(index)}
                  >
                    <div className="font-medium truncate">📎 {name}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{preview?.mime || 'priponka'}</div>
                  </button>
                )
              })}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
              {!selectedAttachmentPreview ? (
                <div className="p-6 text-center text-sm text-slate-500">Predogled te priponke ni na voljo. Uporabite »Odpri v novem zavihku« ali odprite dokument.</div>
              ) : selectedAttachmentPreview.mime.startsWith('image/') || selectedAttachmentPreview.src.startsWith('data:image/') ? (
                <img src={selectedAttachmentPreview.src} alt={selectedAttachmentPreview.name} className="max-h-[70vh] max-w-full object-contain" />
              ) : selectedAttachmentPreview.mime === 'application/pdf' || selectedAttachmentPreview.src.startsWith('data:application/pdf') || selectedAttachmentPreview.name.toLowerCase().endsWith('.pdf') ? (
                <iframe src={selectedAttachmentPreview.src} title={selectedAttachmentPreview.name} className="w-full h-[70vh] bg-white" />
              ) : (
                <div className="p-6 text-center">
                  <div className="text-4xl mb-2">📎</div>
                  <div className="font-medium text-slate-700">{selectedAttachmentPreview.name}</div>
                  <div className="text-sm text-slate-500 mt-1">Ta tip datoteke nima vgrajenega predogleda.</div>
                  <div className="mt-3 flex justify-center gap-2">
                    <Btn onClick={() => openAttachment(selectedAttachmentPreview)}>Odpri</Btn>
                    <Btn onClick={() => downloadAttachment(selectedAttachmentPreview)}>Prenesi</Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {showTransfer && <InternalTransferModal initialMonth={month} initialDeskId={!isAllDesks && !isGroupView ? viewDeskId : actionDeskId} onClose={() => setShowTransfer(false)} onDone={() => setShowTransfer(false)} />}
      {showPayoutImport && <PayoutImportModal initialMonth={month} initialDeskId={actionDeskId} onClose={() => setShowPayoutImport(false)} onDone={() => setShowPayoutImport(false)} />}
      {wizard && !isAllDesks && !isGroupView && (
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

const filterCls = 'w-full min-w-0 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-normal text-slate-700 outline-none focus:border-blu-500 focus:ring-1 focus:ring-blu-200'

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

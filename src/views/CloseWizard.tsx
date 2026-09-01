import React, { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDesk, MonthClose } from '../types'
import { computePreview, closeMonth } from '../lib/numbering'
import { can } from '../lib/perms'
import { apiCloseMonth } from '../lib/api'
import { getSyncState } from '../lib/sync'
import { cx, docNo, fmtDate, fmtDateTime, fmtEur, monthLabel, nDokumentovIma } from '../lib/util'
import { Btn, Chip, ErrBox, Modal, Warn } from '../components/ui'
import type { PrintJob } from '../print'

export function CloseWizard({
  deskId, monthKey, mode, onClose, onPrint, onOpenDoc,
}: {
  deskId: string
  monthKey: string
  mode: 'preview' | 'close'
  onClose: () => void
  onPrint: (job: PrintJob) => void
  onOpenDoc: (id: string) => void
}) {
  const app = useApp()
  const { db, settings, role } = app
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const preview = useLiveQuery(() => computePreview(db, settings, deskId, monthKey), [deskId, monthKey, settings.numberingScope, settings.requirePurpose])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<MonthClose | null>(null)

  const desk = desks.find((d) => d.id === deskId)
  const scopeLabel = settings.numberingScope === 'COMPANY' ? 'vse blagajne (skupno številčenje)' : desk?.name ?? deskId

  if (!preview) return null

  const closed = result ?? preview.alreadyClosed
  if (closed) {
    return <ManifestView close={closed} onClose={onClose} onPrint={onPrint} justClosed={!!result} />
  }

  const blockers: string[] = []
  if (app.mode === 'server' && !getSyncState().online) blockers.push('Za zaključek meseca potrebujete povezavo s strežnikom.')
  if (preview.unsynced.length > 0) blockers.push('Meseca ni mogoče varno zaključiti, ker obstajajo nesinhronizirani zapisi.')
  if (preview.issues.length > 0) blockers.push(`${nDokumentovIma(preview.issues.length)} manjkajoče ali neveljavne podatke.`)
  const total = preview.bp.length + preview.bi.length

  async function doClose() {
    setBusy(true)
    setErr('')
    try {
      if (app.mode === 'server') {
        // 1) izprazni čakalno vrsto, 2) strežnik atomarno zaključi, 3) povleci dodeljene številke
        await app.syncNow()
        const st = getSyncState()
        if (st.pending > 0) throw new Error('Meseca ni mogoče varno zaključiti, ker obstajajo nesinhronizirani zapisi.')
        const res = await apiCloseMonth(deskId, monthKey)
        await app.syncNow()
        setResult(res.close)
      } else {
        const res = await closeMonth(db, settings, deskId, monthKey, `${app.userLabel} (${role})`)
        setResult(res)
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={<>Predogled številčenja — {monthLabel(monthKey)} · {scopeLabel}</>}
      wide
      onClose={onClose}
      footer={
        <>
          <div className="text-[12px] text-slate-500 mr-auto self-center">
            Predogledne številke niso uradne — dokončne postanejo šele z akcijo »Zaključi mesec«.
          </div>
          <Btn onClick={onClose}>Zapri</Btn>
          {mode === 'close' && can(role, 'CLOSE_MONTH', settings) && (
            <Btn kind="danger" disabled={blockers.length > 0 || !confirmed || busy} onClick={doClose}>
              {busy ? 'Zaključujem …' : 'Zaključi mesec — dokončno'}
            </Btn>
          )}
        </>
      }
    >
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}

      {/* Predpogoji */}
      <div className="grid md:grid-cols-2 gap-2 mb-3">
        <div className={cx('rounded-lg border p-3 text-sm', preview.unsynced.length ? 'border-red-300 bg-red-50' : 'border-emerald-200 bg-emerald-50')}>
          <div className="font-semibold mb-0.5">{preview.unsynced.length ? '⛔ Nesinhronizirani zapisi' : '✓ Sinhronizacija'}</div>
          {preview.unsynced.length
            ? <>Meseca ni mogoče varno zaključiti, ker obstajajo nesinhronizirani zapisi ({preview.unsynced.length}). Uporabite »Sinhroniziraj« v delovnem prostoru meseca.</>
            : 'Vsi zapisi v obsegu so sinhronizirani.'}
        </div>
        <div className={cx('rounded-lg border p-3 text-sm', preview.issues.length ? 'border-red-300 bg-red-50' : 'border-emerald-200 bg-emerald-50')}>
          <div className="font-semibold mb-0.5">{preview.issues.length ? '⛔ Nepopolni dokumenti' : '✓ Vsi dokumenti popolni'}</div>
          {preview.issues.length === 0 && 'Obvezna polja so izpolnjena, zneski veljavni, časi znotraj meseca.'}
          {preview.issues.map(({ doc, problems }) => (
            <div key={doc.id} className="flex items-center gap-2 py-0.5">
              <button className="text-blu-600 underline decoration-dotted" onClick={() => onOpenDoc(doc.id)}>
                {doc.type} · {doc.employeeName || 'brez zaposlenega'} · {fmtDate(doc.transactionDate)}
              </button>
              <span className="text-red-700">{problems.join(', ')}</span>
            </div>
          ))}
        </div>
      </div>

      {total === 0 && <Warn>V tem mesecu ni dokumentov za številčenje. Zaključek bo mesec le zaklenil.</Warn>}

      <div className="grid md:grid-cols-2 gap-4 mt-2">
        <PreviewTable label="Blagajniški prejemki (BP)" rows={preview.bp} last={preview.lastBp} year={monthKey.slice(0, 4)} onOpenDoc={onOpenDoc} />
        <PreviewTable label="Blagajniški izdatki (BI)" rows={preview.bi} last={preview.lastBi} year={monthKey.slice(0, 4)} onOpenDoc={onOpenDoc} />
      </div>

      <div className="mt-4 text-[12px] text-slate-500">
        Vrstni red: čas transakcije (naraščajoče) → čas vnosa → ID. Čas vnosa nikoli ne določa uradne številke, uporabi se le kot determinističen izenačevalec.
      </div>

      {mode === 'close' && can(role, 'CLOSE_MONTH', settings) && (
        <label className={cx('mt-4 flex items-start gap-2 text-sm rounded-lg border p-3', blockers.length ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-amber-300 bg-amber-50')}>
          <input type="checkbox" className="mt-0.5" disabled={blockers.length > 0} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            Potrjujem, da so vse pisarniške naprave sinhronizirane in da so podatki pregledani.
            Po zaključku bodo dokumenti dobili dokončne uradne številke in bodo <b>zaklenjeni</b> — popravki so možni le še prek storna.
          </span>
        </label>
      )}
      {mode === 'close' && !can(role, 'CLOSE_MONTH', settings) && (
        <div className="mt-4"><Warn>Vloga {role} nima pravice za zaključek meseca. Zaključek lahko izvede Računovodja ali Admin{settings.financeCanClose ? ' ali Finance' : ''}.</Warn></div>
      )}
    </Modal>
  )
}

function PreviewTable({
  label, rows, last, year, onOpenDoc,
}: {
  label: string
  rows: { doc: any; number: number }[]
  last: number
  year: string
  onOpenDoc: (id: string) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <Chip>zadnja dodeljena: {last || '—'}</Chip>
      </div>
      <table className="w-full text-sm border border-slate-200 rounded-md overflow-hidden">
        <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
          <tr>
            <th className="text-left px-2 py-1 w-16">Št.</th>
            <th className="text-left px-2 py-1">Čas transakcije</th>
            <th className="text-left px-2 py-1">Zaposleni</th>
            <th className="text-right px-2 py-1">Znesek</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="px-2 py-2 text-slate-400">ni dokumentov</td></tr>}
          {rows.map(({ doc, number }) => (
            <tr key={doc.id} className="border-t border-slate-100 hover:bg-blu-50/50 cursor-pointer" onClick={() => onOpenDoc(doc.id)}>
              <td className="px-2 py-1 font-mono font-semibold">{number}</td>
              <td className="px-2 py-1 font-mono text-[12px]">{fmtDateTime(`${doc.transactionDate}T${doc.transactionTime}`)}</td>
              <td className="px-2 py-1">{doc.employeeName}</td>
              <td className="px-2 py-1 text-right font-mono">{fmtEur(doc.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 0 && (
        <div className="text-[11px] text-slate-400 mt-1">→ {rows[0].number}–{rows[rows.length - 1].number}/{year}</div>
      )}
    </div>
  )
}

export function ManifestView({
  close, onClose, onPrint, justClosed,
}: {
  close: MonthClose
  onClose: () => void
  onPrint: (job: PrintJob) => void
  justClosed?: boolean
}) {
  const app = useApp()
  const { db, settings } = app
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []

  async function printAll(type?: 'BP' | 'BI') {
    const ids = close.manifest.filter((m) => !type || m.type === type).map((m) => m.docId)
    const docs = (await db.docs.bulkGet(ids)).filter(Boolean) as any[]
    const deskOf = (d: any) => desks.find((x: CashDesk) => x.id === d.deskId)
    onPrint({ title: `${monthLabel(close.monthKey)} — vsi dokumenti${type ? ` (${type})` : ''}`, docs: docs.map((doc) => ({ doc, desk: deskOf(doc) })) })
  }

  return (
    <Modal
      title={<>Zapisnik zaključka — {monthLabel(close.monthKey)}</>}
      wide
      onClose={onClose}
      footer={<>
        <Btn onClick={() => printAll('BP')}>🖨️ Natisni vse BP</Btn>
        <Btn onClick={() => printAll('BI')}>🖨️ Natisni vse BI</Btn>
        <Btn kind="primary" onClick={() => printAll()}>🖨️ Natisni vse</Btn>
        <Btn onClick={onClose}>Zapri</Btn>
      </>}
    >
      {justClosed && (
        <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 px-3 py-2 text-sm font-medium">
          ✓ Mesec je uspešno zaključen. Uradne številke so dodeljene, dokumenti so zaklenjeni.
        </div>
      )}
      <div className="flex flex-wrap gap-2 mb-3 text-sm">
        <Chip tone="blue">BP {close.bpStart}–{close.bpEnd}</Chip>
        <Chip tone="blue">BI {close.biStart}–{close.biEnd}</Chip>
        <Chip>{close.docCount} dokumentov</Chip>
        <Chip>zaključil: {close.closedBy}</Chip>
        <Chip>{fmtDateTime(close.closedAt)}</Chip>
      </div>
      <table className="w-full text-sm border border-slate-200 rounded-md overflow-hidden">
        <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
          <tr>
            <th className="text-left px-2 py-1">Številka</th>
            <th className="text-left px-2 py-1">Čas transakcije</th>
            <th className="text-left px-2 py-1">Zaposleni</th>
            <th className="text-right px-2 py-1">Znesek</th>
          </tr>
        </thead>
        <tbody>
          {close.manifest
            .slice()
            .sort((a, b) => a.type.localeCompare(b.type) || a.number - b.number)
            .map((m) => (
              <tr key={m.docId} className="border-t border-slate-100">
                <td className="px-2 py-1 font-mono font-semibold">{docNo(m.type, m.number, close.year, settings.numberFormat)}</td>
                <td className="px-2 py-1 font-mono text-[12px]">{fmtDateTime(m.transactionAt)}</td>
                <td className="px-2 py-1">{m.employeeName}</td>
                <td className="px-2 py-1 text-right font-mono">{fmtEur(m.amount)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Modal>
  )
}

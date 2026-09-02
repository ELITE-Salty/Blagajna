import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDesk, CashTransfer } from '../types'
import { availableInDesk } from '../lib/balance'
import { closeIdFor } from '../lib/numbering'
import { putTransfer } from '../lib/persist'
import { fmtEur, nowIso, nowTime, parseAmount, todayIso, uuid } from '../lib/util'
import { Btn, ErrBox, Field, Modal, inputCls } from '../components/ui'

export function InternalTransferModal({
  initialMonth,
  initialDeskId,
  onClose,
  onDone,
}: {
  initialMonth: string
  initialDeskId?: string
  onClose: () => void
  onDone: () => void
}) {
  const app = useApp()
  const { db, settings } = app
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const eligible = useMemo(() => desks.filter((d) => !d.isGroup && d.active && !!d.parentId), [desks])

  const initialSource = eligible.some((d) => d.id === initialDeskId) ? initialDeskId! : eligible[0]?.id ?? ''
  const [fromDeskId, setFromDeskId] = useState(initialSource)
  const fromDesk = desks.find((d) => d.id === fromDeskId)
  const destinations = eligible.filter((d) => d.parentId === fromDesk?.parentId && d.id !== fromDeskId)
  const [toDeskId, setToDeskId] = useState('')
  const [date, setDate] = useState(() => (todayIso().startsWith(initialMonth) ? todayIso() : `${initialMonth}-01`))
  const [time, setTime] = useState(nowTime())
  const [amountText, setAmountText] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!destinations.some((d) => d.id === toDeskId)) setToDeskId(destinations[0]?.id ?? '')
  }, [fromDeskId, desks.length])

  const available = useLiveQuery(
    () => (fromDeskId ? availableInDesk(db, fromDeskId) : Promise.resolve(0)),
    [fromDeskId],
  ) ?? 0

  const groupsWithTwo = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of eligible) counts.set(d.parentId!, (counts.get(d.parentId!) ?? 0) + 1)
    return new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([id]) => id))
  }, [eligible])
  const sourceOptions = eligible.filter((d) => groupsWithTwo.has(d.parentId!))

  useEffect(() => {
    if (sourceOptions.some((d) => d.id === fromDeskId)) return
    const next = sourceOptions.find((d) => d.id === initialDeskId)?.id ?? sourceOptions[0]?.id ?? ''
    setFromDeskId(next)
  }, [sourceOptions.map((d) => d.id).join('|'), initialDeskId, fromDeskId])

  async function save() {
    setErr('')
    const amount = parseAmount(amountText)
    const source = desks.find((d) => d.id === fromDeskId)
    const target = desks.find((d) => d.id === toDeskId)
    if (!source || !target) return setErr('Izberite izvorno in ciljno interno blagajno.')
    if (source.isGroup || target.isGroup || !source.parentId || source.parentId !== target.parentId) {
      return setErr('Interni prenos je dovoljen samo med internima blagajnama iste glavne/globalne blagajne.')
    }
    if (!date || !time) return setErr('Vnesite datum in čas prenosa.')
    if (amount == null || amount <= 0) return setErr('Vnesite veljaven znesek prenosa.')
    if (amount > available + 1e-9) return setErr(`V blagajni ${source.name} ni dovolj gotovine. Na voljo je ${fmtEur(available)}.`)

    const monthKey = date.slice(0, 7)
    const [sourceClose, targetClose] = await Promise.all([
      db.closes.get(closeIdFor(settings, source.id, monthKey)),
      db.closes.get(closeIdFor(settings, target.id, monthKey)),
    ])
    if (sourceClose || targetClose) return setErr('Prenosa ni mogoče vnesti, ker je izbrani mesec pri eni od blagajn že zaključen.')

    setBusy(true)
    try {
      const at = nowIso()
      const transfer: CashTransfer = {
        id: uuid(),
        fromDeskId: source.id,
        toDeskId: target.id,
        transactionDate: date,
        transactionTime: time,
        monthKey,
        amount,
        notes: notes.trim(),
        syncStatus: 'LOKALNO',
        createdAt: at,
        createdBy: app.userLabel,
        updatedAt: at,
        updatedBy: app.userLabel,
      }
      await putTransfer(db, transfer)
      await app.audit(
        'Interni prenos gotovine',
        'InterniPrenos',
        transfer.id,
        `${source.name} → ${target.name} · ${fmtEur(amount)} · ${date} ${time}`,
      )
      onDone()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="↔ Interni prenos med blagajnami"
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Prekliči</Btn>
        <Btn kind="primary" disabled={busy || sourceOptions.length === 0} onClick={save}>{busy ? 'Prenašam …' : 'Potrdi interni prenos'}</Btn>
      </>}
    >
      <div className="mb-3 rounded-lg border border-blu-200 bg-blu-50 px-3 py-2 text-sm text-blu-800">
        Ta prenos <b>ni BP in ni BI</b> ter ne dobi blagajniške številke. Znesek se samo odšteje iz izvorne interne blagajne in prišteje ciljni interni blagajni.
      </div>
      {err && <div className="mb-3"><ErrBox>{err}</ErrBox></div>}
      {sourceOptions.length === 0 ? (
        <ErrBox>Za interni prenos potrebujete vsaj dve aktivni interni blagajni pod isto glavno/globalno blagajno.</ErrBox>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Iz blagajne" hint={`Razpoložljivo: ${fmtEur(available)}`}>
            <select className={inputCls} value={fromDeskId} onChange={(e) => setFromDeskId(e.target.value)}>
              {sourceOptions.map((d) => <option key={d.id} value={d.id}>{deskLabel(d, desks)}</option>)}
            </select>
          </Field>
          <Field label="V blagajno">
            <select className={inputCls} value={toDeskId} onChange={(e) => setToDeskId(e.target.value)}>
              {destinations.map((d) => <option key={d.id} value={d.id}>{deskLabel(d, desks)}</option>)}
            </select>
          </Field>
          <Field label="Datum">
            <input type="date" lang="sl-SI" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Čas">
            <input type="time" lang="sl-SI" step="60" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Znesek (EUR)">
            <input className={inputCls} inputMode="decimal" placeholder="0,00" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          </Field>
          <Field label="Opomba" hint="Neobvezno; npr. dopolnitev gotovine v pisarni.">
            <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

function deskLabel(d: CashDesk, desks: CashDesk[]) {
  const parent = desks.find((x) => x.id === d.parentId)
  return `${parent?.name ? `${parent.name} → ` : ''}${d.name}`
}

import React, { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import { ROLE_LABELS } from '../types'
import { cx, fmtDateTime } from '../lib/util'
import { inputCls } from '../components/ui'

export function AuditView() {
  const { db } = useApp()
  const events = useLiveQuery(() => db.audit.orderBy('at').reverse().limit(500).toArray(), []) ?? []
  const [q, setQ] = useState('')
  const list = events.filter((e) => {
    if (!q.trim()) return true
    const s = q.toLowerCase()
    return e.action.toLowerCase().includes(s) || e.details.toLowerCase().includes(s) || e.user.toLowerCase().includes(s) || e.entityId.toLowerCase().includes(s)
  })
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-800">Revizijska sled</h1>
        <div className="flex-1" />
        <input className={cx(inputCls, 'w-64')} placeholder="Išči po dogodkih …" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 text-left">
              <th className="px-3 py-2 w-40">Čas</th>
              <th className="px-3 py-2 w-40">Uporabnik</th>
              <th className="px-3 py-2 w-48">Dogodek</th>
              <th className="px-3 py-2">Podrobnosti</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-1.5 font-mono text-[12px] whitespace-nowrap">{fmtDateTime(e.at)}</td>
                <td className="px-3 py-1.5">{e.user} <span className="text-slate-400 text-[11px]">({ROLE_LABELS[e.role]})</span></td>
                <td className="px-3 py-1.5 font-medium">{e.action}</td>
                <td className="px-3 py-1.5 text-slate-600">{e.details}<span className="text-slate-300 text-[11px] ml-2 font-mono">{e.entityId}</span></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">Ni dogodkov.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-slate-400">Revizijski dogodki so nespremenljivi. Prikazanih je zadnjih 500 dogodkov.</div>
    </div>
  )
}

import React, { useState } from 'react'
import { AppProvider, useApp, useSyncState } from './state'
import type { CashDocument, Potrdilo, Role } from './types'
import { ROLE_LABELS } from './types'
import { cx, docNo, fmtDateTime } from './lib/util'
import { can } from './lib/perms'
import { MonthWorkspace } from './views/MonthWorkspace'
import { ReportsView } from './views/Reports'
import { PotrdilaView, PotrdiloForm } from './views/Potrdila'
import { EmployeesView } from './views/Employees'
import { SettingsView } from './views/SettingsView'
import { AuditView } from './views/AuditView'
import { DocForm } from './views/DocForm'
import { PrintOverlay, type PrintJob } from './print'

type Tab = 'blagajna' | 'potrdila' | 'porocila' | 'zaposleni' | 'nastavitve' | 'revizija'

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}

function Shell() {
  const app = useApp()
  const { settings, role, db } = app
  const [tab, setTab] = useState<Tab>('blagajna')
  const [docModal, setDocModal] = useState<{ id: string | null; initial?: Partial<CashDocument> } | null>(null)
  const [potModal, setPotModal] = useState<{ id: string | null; employeeId?: string } | null>(null)
  const [printJob, setPrintJob] = useState<PrintJob | null>(null)
  const [demoHint, setDemoHint] = useState(true)

  const openDoc = (id: string | null, initial?: Partial<CashDocument>) => setDocModal({ id, initial })
  const openPotrdilo = (id: string | null, employeeId?: string) => setPotModal({ id, employeeId })

  async function openPrint(job: PrintJob) {
    // ob tisku: zaključen BI brez podpisa → status »Natisnjeno za podpis« + revizijski dogodek
    for (const item of job.docs ?? []) {
      const d = item.doc
      if (d.status === 'ZAKLJUCEN') {
        if (d.type === 'BI' && d.prejelStatus === 'NI_PODPISANO') {
          await db.docs.update(d.id, { prejelStatus: 'NATISNJENO', syncStatus: 'LOKALNO' })
          item.doc = { ...d, prejelStatus: 'NATISNJENO' }
        }
        await app.audit('Dokument natisnjen', 'BlagajniskiDokument', d.id, docNo(d.type, d.officialNumber, d.seqYear, settings.numberFormat))
      }
    }
    for (const p of job.potrdila ?? []) {
      await app.audit('Potrdilo natisnjeno', 'Potrdilo', p.id, p.employeeName)
    }
    setPrintJob(job)
  }
  const printPotrdilo = (p: Potrdilo) => openPrint({ title: `Potrdilo o dejavnostih — ${p.employeeName}`, potrdila: [p] })

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'blagajna', label: '💶 Blagajna', show: true },
    { id: 'potrdila', label: '🧾 Potrdila o dejavnostih', show: true },
    { id: 'porocila', label: '📊 Poročila in izvoz', show: true },
    { id: 'zaposleni', label: '👤 Zaposleni', show: true },
    { id: 'nastavitve', label: '⚙️ Nastavitve', show: can(role, 'MANAGE_SETTINGS', settings) },
    { id: 'revizija', label: '📜 Revizijska sled', show: can(role, 'VIEW_AUDIT', settings) },
  ]

  return (
    <>
      <div className={cx('min-h-screen bg-slate-100', printJob && 'print:hidden')}>
        {/* Glava */}
        <header className="bg-blu-800 text-white">
          <div className="max-w-[1200px] mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-white/10 grid place-items-center font-extrabold text-[15px] tracking-tight">B</div>
              <div>
                <div className="font-bold leading-4 tracking-tight">Blagajna</div>
                <div className="text-[10px] text-blu-100/80 leading-3">Blu Logistics · prejemki · izdatki · dopust listi</div>
              </div>
            </div>
            <nav className="flex gap-1 flex-wrap ml-2">
              {tabs.filter((t) => t.show).map((t) => (
                <button
                  key={t.id}
                  className={cx('px-3 py-1.5 rounded-md text-[13px] font-medium transition', tab === t.id ? 'bg-white text-blu-800' : 'text-blu-50/90 hover:bg-white/10')}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-[13px]">
              <SyncBadge />
              {app.mode === 'demo' ? (
                <>
                  <span className="text-blu-100/80 hidden sm:inline">{settings.currentUserName} ·</span>
                  <select
                    className="bg-white/10 border border-white/20 rounded-md px-2 py-1 text-[13px] text-white [&>option]:text-slate-900"
                    value={role}
                    title="Preklop vloge (demo — v nameščeni različici je tu prava prijava)"
                    onChange={async (e) => {
                      const r = e.target.value as Role
                      await app.saveSettings({ currentRole: r })
                      await app.audit('Preklop vloge', 'Sistem', 'role', ROLE_LABELS[r])
                      if ((r !== 'ADMIN') && (tab === 'nastavitve' || tab === 'revizija')) setTab('blagajna')
                    }}
                  >
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <span className="text-blu-100/90 hidden sm:inline font-medium">{app.user?.name}</span>
                  <span className="bg-white/10 border border-white/20 rounded-md px-2 py-0.5 text-[11px]">{ROLE_LABELS[role]}</span>
                  <button className="text-blu-100/80 hover:text-white underline decoration-dotted text-[12px]" onClick={() => app.logout()}>Odjava</button>
                </>
              )}
            </div>
          </div>
        </header>

        {app.ephemeral && (
          <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-[12px] px-4 py-1.5 text-center">
            Predogledni način: shramba brskalnika v tem oknu ni na voljo, zato se podatki ob osvežitvi ponastavijo. Nameščena/izvožena aplikacija podatke trajno hrani na napravi.
          </div>
        )}
        {app.mode === 'demo' && demoHint && (
          <div className="bg-blu-50 border-b border-blu-100 text-blu-800 text-[12px] px-4 py-1.5 flex items-center gap-2 justify-center">
            <span>
              DEMO s predstavitvenimi podatki: <b>julij 2026</b> je že zaključen (BP 1–3, BI 1–2), <b>avgust 2026</b> je odprt — preizkusite »Predogled številčenja« in »Zaključi mesec«. Prijava, uporabniki in prava sinhronizacija delujejo v nameščeni različici.
            </span>
            <button className="underline decoration-dotted" onClick={() => setDemoHint(false)}>skrij</button>
          </div>
        )}

        <main className="max-w-[1200px] mx-auto px-4 py-4">
          {tab === 'blagajna' && <MonthWorkspace onOpenDoc={openDoc} onPrint={openPrint} />}
          {tab === 'potrdila' && <PotrdilaView onOpenPotrdilo={openPotrdilo} onOpenDoc={openDoc} onPrintPotrdilo={printPotrdilo} />}
          {tab === 'porocila' && <ReportsView onOpenDoc={openDoc} onPrint={openPrint} />}
          {tab === 'zaposleni' && <EmployeesView onOpenDoc={openDoc} onOpenPotrdilo={openPotrdilo} />}
          {tab === 'nastavitve' && can(role, 'MANAGE_SETTINGS', settings) && <SettingsView />}
          {tab === 'revizija' && can(role, 'VIEW_AUDIT', settings) && <AuditView />}
        </main>

        <footer className="max-w-[1200px] mx-auto px-4 pb-6 text-[11px] text-slate-400">
          Blagajna · Blu Logistics — 1. faza (lokalna različica brez strežnika). Uradne številke nastanejo šele ob zaključku meseca, kronološko po času transakcije. BP in BI imata ločeni zaporedji, ponastavitev vsako leto.
        </footer>

        {/* Modali */}
        {docModal && (
          <DocForm
            docId={docModal.id}
            initial={docModal.initial}
            onClose={() => setDocModal(null)}
            onPrint={openPrint}
          />
        )}
        {potModal && (
          <PotrdiloForm
            potrdiloId={potModal.id}
            initialEmployeeId={potModal.employeeId}
            onClose={() => setPotModal(null)}
            onPrintPotrdilo={printPotrdilo}
            onOpenDoc={(id, initial) => { setPotModal(null); openDoc(id, initial) }}
          />
        )}
      </div>

      {printJob && <PrintOverlay job={printJob} settings={settings} onClose={() => setPrintJob(null)} />}
    </>
  )
}

function SyncBadge() {
  const app = useApp()
  const s = useSyncState()
  if (app.mode === 'demo') {
    return <span title="Predstavitveni način — brez strežnika. Sinhronizacija je simulirana." className="bg-amber-400/20 border border-amber-300/40 text-amber-100 rounded-md px-2 py-0.5 text-[11px] font-semibold">DEMO</span>
  }
  const cls = 'rounded-md px-2 py-0.5 text-[11px] font-medium border whitespace-nowrap '
  if (!s.online) return <span className={cls + 'bg-orange-500/25 border-orange-300/40 text-orange-100'} title="Delo brez povezave: zapisi se shranjujejo lokalno in se samodejno sinhronizirajo ob povezavi.">⚠ Brez povezave{s.pending > 0 ? ` · čaka ${s.pending}` : ''}</span>
  if (s.syncing) return <span className={cls + 'bg-white/10 border-white/20 text-blu-100'}>⇅ Sinhroniziram …</span>
  if (s.error) return <span className={cls + 'bg-red-500/25 border-red-300/40 text-red-100'} title={s.error}>⚠ Sinhronizacija — napaka</span>
  if (s.pending > 0) return <span className={cls + 'bg-violet-500/25 border-violet-300/40 text-violet-100'}>⇅ čaka {s.pending}</span>
  return <span className={cls + 'bg-emerald-500/25 border-emerald-300/40 text-emerald-100'} title={s.lastSync ? `Zadnja sinhronizacija: ${fmtDateTime(s.lastSync)}` : ''}>✓ Sinhronizirano</span>
}

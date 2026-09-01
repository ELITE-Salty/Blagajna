import React from 'react'
import type { CashDesk, CashDocument, Potrdilo, Settings } from './types'
import {
  ACTIVITY_FIELD_NO, ACTIVITY_LABELS, SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP, SIGNATURE_ROLE_LABELS,
} from './types'
import { docNo, fmtDate, fmtDateTime, fmtNum, cx, todayIso } from './lib/util'
import { znesekZBesedo } from './lib/besede'
import { Btn } from './components/ui'

// ---------------------------------------------------------------- pomožno
function Line({ label, value, mono = true, className }: { label?: string; value?: React.ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cx('flex items-end gap-2', className)}>
      {label && <span className="shrink-0 text-[9px] leading-3">{label}</span>}
      <span className={cx('flex-1 border-b border-dotted border-current min-h-[16px] px-1 text-[11px] leading-4', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

function SigBox({ label, sig, accent }: { label: string; sig?: { signerName: string; dataUrl?: string; signedAt: string } | null; accent?: boolean }) {
  return (
    <div className={cx('flex-1 border-t px-1 pt-0.5 min-w-0', accent ? 'border-t-2 border-current' : 'border-current')}>
      <div className={cx('text-[8px] leading-3', accent && 'font-bold')}>{label}</div>
      <div className="h-9 flex items-center justify-center overflow-hidden">
        {sig?.dataUrl ? <img src={sig.dataUrl} alt="" className="max-h-9" /> : null}
      </div>
      {sig && <div className="text-[7px] font-mono text-center truncate">{sig.signerName} · {fmtDateTime(sig.signedAt).split(' ')[0]}</div>}
    </div>
  )
}

function Watermark({ text, color }: { text: string; color: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center pointer-events-none overflow-hidden">
      <div className={cx('rotate-[-18deg] text-4xl font-extrabold tracking-widest opacity-20 border-4 rounded px-6 py-2', color)}>{text}</div>
    </div>
  )
}

// ---------------------------------------------------------------- BP / BI
export function PaperDoc({ doc, settings, desk, embedded = false, copyLabel }: { doc: CashDocument; settings: Settings; desk?: CashDesk; embedded?: boolean; copyLabel?: string }) {
  const isBP = doc.type === 'BP'
  const tone = isBP ? 'text-emerald-900' : 'text-orange-950'
  const border = isBP ? 'border-emerald-800' : 'border-orange-800'
  const soft = isBP ? 'bg-emerald-50' : 'bg-orange-50'
  const title = isBP ? 'Blagajniški prejemek' : 'Blagajniški izdatek'
  const roles = isBP ? SIGNATURE_ROLES_BP : SIGNATURE_ROLES_BI
  const number = doc.officialNumber != null
    ? docNo(doc.type, doc.officialNumber, doc.seqYear, settings.numberFormat)
    : ''
  const words = doc.amountWordsOverride || znesekZBesedo(doc.amount)
  const sigFor = (role: string) => doc.signatures.find((s) => s.role === role) ?? null
  const rows = doc.rows.length > 0 ? doc.rows : [{ opis: doc.purpose, konto: '', znesek: doc.amount }]

  return (
    <div className={cx(embedded ? 'relative bg-white' : 'paper relative bg-white', tone)}>
      {copyLabel && <div className="mb-1 text-right text-[8px] font-semibold uppercase tracking-wide opacity-60">{copyLabel}</div>}
      {doc.status === 'STORNIRAN' && <Watermark text="STORNIRANO" color="text-red-600 border-red-600" />}
      {doc.status === 'ODPRT' && <Watermark text="OSNUTEK · BREZ URADNE ŠTEVILKE" color="text-slate-400 border-slate-400" />}

      {/* Glava */}
      <div className="flex justify-between gap-4">
        <div className="w-64">
          <div className="text-[8px]">izdajatelj</div>
          <div className={cx('border p-1.5 min-h-[52px]', border)}>
            <div className="text-[11px] font-semibold">{settings.company.name}</div>
            <div className="text-[9px]">{[settings.company.street, `${settings.company.postalCode} ${settings.company.city}`.trim()].filter(Boolean).join(', ')}</div>
            {desk && <div className="text-[9px] mt-1">Blagajna: {desk.name}</div>}
          </div>
        </div>
        <div className="flex-1">
          <div className={cx('text-right text-xl font-bold border-b-2 pb-1', border)}>{title}</div>
          <div className="flex justify-end gap-6 mt-1.5 items-end">
            <div className="flex items-end gap-1 w-40"><span className="text-[9px]">št.</span><span className="flex-1 border-b border-dotted border-current text-center font-mono text-[12px] font-semibold min-h-[16px]">{number}</span></div>
            <div className="flex items-end gap-1 w-40"><span className="text-[9px]">datum</span><span className="flex-1 border-b border-dotted border-current text-center font-mono text-[12px] min-h-[16px]">{fmtDate(doc.transactionDate)} {doc.transactionTime}</span></div>
          </div>
        </div>
      </div>

      {/* Vplačnik / Prejemnik */}
      <div className="mt-3">
        <Line label={isBP ? 'Vplačnik' : 'Prejemnik'} value={<span className="font-semibold">{doc.employeeName}</span>} />
      </div>

      {/* Znesek */}
      <div className="mt-2 flex items-end gap-2">
        <span className="text-[9px] leading-3">
          {isBP ? 'je vplačal' : 'je prejel'} <span className="font-bold underline">z gotovino</span> — znesek EUR
        </span>
        <span className="flex-1 border-b border-dotted border-current px-1 font-mono text-[13px] font-bold text-right min-h-[18px]">
          {doc.amount != null ? `= ${fmtNum(doc.amount)} =` : ''}
        </span>
      </div>
      <div className={cx('mt-1.5 border p-1 flex items-end gap-2', border, soft)}>
        <span className="text-[8px]">z besedami evrov</span>
        <span className="flex-1 font-mono text-[11px] px-1 min-h-[15px]">{words ? `= ${words} =` : ''}</span>
      </div>

      {/* Za + konto tabela */}
      <div className="mt-2 flex gap-3">
        <div className="flex-1">
          <div className="text-[9px]">za</div>
          <div className="space-y-2 mt-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border-b border-dotted border-current min-h-[16px] px-1 font-mono text-[10px]">
                {i === 0 ? doc.purpose : i === 1 && doc.notes ? `Opomba: ${doc.notes}` : ''}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-[9px]">priloge</span>
            <span className="flex-1 border-b border-dotted border-current min-h-[15px] px-1 font-mono text-[9px]">
              {doc.attachments.length > 0 ? `${doc.attachments.length}× (${doc.attachments.map((a) => a.name).join(', ')})` : ''}
            </span>
          </div>
        </div>
        <table className={cx('w-64 border-collapse text-[9px] self-start', tone)}>
          <thead>
            <tr>
              <th colSpan={2} className={cx('border text-center py-0.5 font-semibold', border, soft)}>{isBP ? 'v dobro' : 'v breme'}</th>
            </tr>
            <tr>
              <th className={cx('border w-24 py-0.5', border)}>konto</th>
              <th className={cx('border py-0.5', border)}>EUR</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map((i) => {
              const r = rows[i]
              return (
                <tr key={i}>
                  <td className={cx('border px-1 h-5 font-mono text-center', border)}>{r?.konto ?? ''}</td>
                  <td className={cx('border px-1 h-5 font-mono text-right', border)}>{r?.znesek != null ? fmtNum(r.znesek) : ''}</td>
                </tr>
              )
            })}
            <tr>
              <td className={cx('border px-1 py-0.5 text-right font-semibold', border, soft)}>skupaj</td>
              <td className={cx('border px-1 py-0.5 font-mono text-right font-bold', border, soft)}>{doc.amount != null ? fmtNum(doc.amount) : ''}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Podpisi */}
      <div className="mt-4 flex gap-2">
        {roles.map((r) => (
          <SigBox key={r} label={SIGNATURE_ROLE_LABELS[r]} sig={sigFor(r)} accent={r === 'PREJEL'} />
        ))}
      </div>

      {doc.status === 'STORNIRAN' && (
        <div className="mt-2 text-[9px] text-red-700">
          STORNIRANO {doc.cancelledAt ? fmtDateTime(doc.cancelledAt).split(' ')[0] : ''} — {doc.cancelReason}
        </div>
      )}
      <div className="mt-2 flex justify-between text-[7px] opacity-60">
        <span>{settings.company.name} — interna blagajniška dokumentacija</span>
        <span>Obr. {isBP ? 'BP' : 'BI'} · Blagajna Blu</span>
      </div>
    </div>
  )
}


function PaperDocPair({ doc, settings, desk }: { doc: CashDocument; settings: Settings; desk?: CashDesk }) {
  const personCopy = doc.type === 'BP' ? 'Izvod za vplačnika' : 'Izvod za prejemnika'
  return (
    <div className="paper relative bg-white">
      <PaperDoc doc={doc} settings={settings} desk={desk} embedded copyLabel="Izvod za blagajno" />
      <div className="my-3 border-t border-dashed border-slate-400 relative">
        <span className="absolute -top-2.5 left-2 bg-white px-1 text-[9px] text-slate-400">✂</span>
      </div>
      <PaperDoc doc={doc} settings={settings} desk={desk} embedded copyLabel={personCopy} />
    </div>
  )
}

// ---------------------------------------------------------------- Potrdilo o dejavnostih (AETR)
export function PaperPotrdilo({ p, settings }: { p: Potrdilo; settings: Settings }) {
  const c = settings.company
  const sigCompany = p.signatures.find((s) => s.role === 'PODJETJE')
  const sigDriver = p.signatures.find((s) => s.role === 'VOZNIK')
  const NumLine = ({ n, label, value }: { n: number; label: string; value?: React.ReactNode }) => (
    <div className="flex items-end gap-2 mt-2.5">
      <span className="shrink-0 text-[10px] font-semibold w-6 text-right">{n}.</span>
      <div className="flex-1">
        <div className="border-b border-dotted border-slate-700 min-h-[16px] px-1 text-[11px] font-mono">{value}</div>
        <div className="text-[8px] text-slate-600 italic">({label})</div>
      </div>
    </div>
  )
  return (
    <div className="paper paper-a4 relative bg-white text-slate-900">
      <div className="text-center">
        <div className="text-[15px] font-bold tracking-wide">POTRDILO O DEJAVNOSTIH<span className="align-super text-[9px]">(*)</span></div>
        <div className="text-[11px] font-semibold">(UREDBA (ES) št. 561/2006 ALI AETR<span className="align-super text-[8px]">(**)</span>)</div>
        <div className="text-[9px] italic mt-1.5 leading-4">
          Pred vožnjo izpolniti s tipkanjem v latinici in podpisati.<br />
          Hraniti skupaj z izvirnimi zapisi tahografa, kjer jih je treba hraniti.<br />
          <span className="font-semibold">Ponarejanje potrdila pomeni kršitev.</span>
        </div>
      </div>

      <div className="mt-3 border-t-2 border-slate-800 pt-1 text-[10px] font-bold uppercase">1. del — izpolni podjetje</div>
      <NumLine n={1} label="Naziv podjetja" value={c.name} />
      <NumLine n={2} label="Ulica in hišna številka, poštna številka, kraj, država" value={[c.street, `${c.postalCode} ${c.city}`.trim(), c.country].filter(Boolean).join(', ')} />
      <NumLine n={3} label="Telefonska številka (vključno z mednarodno klicno kodo)" value={c.phone} />
      <NumLine n={4} label="Številka telefaksa (vključno z mednarodno klicno kodo)" value={c.fax} />
      <NumLine n={5} label="Elektronski naslov" value={c.email} />
      <div className="mt-3 text-[10px] font-semibold">Podpisani:</div>
      <NumLine n={6} label="Priimek in ime" value={p.declarantName} />
      <NumLine n={7} label="Delovno mesto v podjetju" value={p.declarantPosition} />
      <div className="mt-3 text-[10px] font-semibold">izjavljam, da je voznik:</div>
      <NumLine n={8} label="Priimek in ime" value={p.employeeName} />
      <NumLine n={9} label="Datum rojstva (dan–mesec–leto)" value={fmtDate(p.employeeDateOfBirth)} />
      <NumLine n={10} label="Številka vozniškega dovoljenja ali osebne izkaznice ali potnega lista" value={p.employeeIdNumber} />
      <NumLine n={11} label="ki je začel delati v podjetju dne (dan–mesec–leto)" value={fmtDate(p.employeeEmploymentStart)} />
      <div className="mt-3 text-[10px] font-semibold">za obdobje:</div>
      <NumLine n={12} label="od (ura–dan–mesec–leto)" value={fmtDateTime(p.fromAt)} />
      <NumLine n={13} label="do (ura–dan–mesec–leto)" value={fmtDateTime(p.toAt)} />

      <div className="mt-3 space-y-1.5">
        {(Object.keys(ACTIVITY_LABELS) as Array<keyof typeof ACTIVITY_LABELS>).map((k) => (
          <div key={k} className="flex items-center gap-2 text-[10px]">
            <span className="shrink-0 w-6 text-right font-semibold">{ACTIVITY_FIELD_NO[k]}.</span>
            <span className={cx('inline-grid place-items-center w-4 h-4 border border-slate-700 text-[11px] font-bold', p.activityType === k && 'bg-slate-900 text-white')}>
              {p.activityType === k ? '×' : ''}
            </span>
            <span className={cx(p.activityType === k && 'font-semibold')}>{ACTIVITY_LABELS[k]}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4 text-[10px]">
        <Line label="Kraj" value={p.companyPlace} />
        <Line label="Datum" value={fmtDate(p.companyDate)} />
        <div>
          <div className="border-b border-dotted border-slate-700 h-10 flex items-end justify-center">{sigCompany?.dataUrl && <img src={sigCompany.dataUrl} className="max-h-9" alt="" />}</div>
          <div className="text-[8px] italic text-center">(Podpis)</div>
        </div>
      </div>

      <div className="mt-4 border-t border-slate-400 pt-2 text-[10px]">
        <span className="font-semibold">20.</span> Izjavljam kot voznik, da v zgoraj navedenem obdobju nisem vozil vozila, za katero se uporablja Uredba (ES) št. 561/2006 ali AETR.
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4 text-[10px]">
        <Line label="Kraj" value={p.driverPlace} />
        <Line label="Datum" value={fmtDate(p.driverDate)} />
        <div>
          <div className="border-b border-dotted border-slate-700 h-10 flex items-end justify-center">{sigDriver?.dataUrl && <img src={sigDriver.dataUrl} className="max-h-9" alt="" />}</div>
          <div className="text-[8px] italic text-center">(Podpis voznika)</div>
        </div>
      </div>

      <div className="mt-4 text-[7px] text-slate-500 leading-3">
        (*) Ta obrazec je na voljo v elektronski obliki za tiskanje na spletnem mestu podjetja. (**) Evropski sporazum o delu posadk vozil, ki opravljajo mednarodne cestne prevoze.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Blagajniška knjiga
export interface KnjigaRow {
  num: string
  date: string
  time: string
  opis: string
  emp: string
  bp: number | null
  bi: number | null
  saldo: number
  storno?: boolean
}
export interface KnjigaJob {
  deskName: string
  from: string
  to: string
  start: number
  end: number
  totBP: number
  totBI: number
  rows: KnjigaRow[]
}

export function PaperKnjiga({ k, settings }: { k: KnjigaJob; settings: Settings }) {
  return (
    <div className="paper paper-a4 relative bg-white text-slate-900">
      <div className="flex justify-between items-start">
        <div>
          <div className="text-[11px] font-semibold">{settings.company.name}</div>
          <div className="text-[9px] text-slate-600">{[settings.company.street, `${settings.company.postalCode} ${settings.company.city}`.trim()].filter(Boolean).join(', ')}</div>
        </div>
        <div className="text-right">
          <div className="text-[16px] font-bold tracking-wide">BLAGAJNIŠKA KNJIGA</div>
          <div className="text-[10px]">{k.deskName} · obdobje {fmtDate(k.from)} – {fmtDate(k.to)}</div>
        </div>
      </div>

      <table className="w-full border-collapse text-[9px] mt-3">
        <thead>
          <tr className="border-y-2 border-slate-800 text-left">
            <th className="py-1 pr-1 w-8">Zap.</th>
            <th className="py-1 pr-1 w-20">Datum</th>
            <th className="py-1 pr-1 w-20">Št. dok.</th>
            <th className="py-1 pr-1">Opis / namen</th>
            <th className="py-1 pr-1 w-28">Zaposleni</th>
            <th className="py-1 pl-1 w-20 text-right">Prejemek</th>
            <th className="py-1 pl-1 w-20 text-right">Izdatek</th>
            <th className="py-1 pl-1 w-20 text-right">Saldo</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          <tr className="border-b border-slate-300 bg-slate-50">
            <td className="py-0.5" />
            <td className="py-0.5">{fmtDate(k.from)}</td>
            <td className="py-0.5" />
            <td className="py-0.5 font-sans italic">Prenos / začetno stanje</td>
            <td />
            <td /><td />
            <td className="py-0.5 text-right font-bold">{fmtNum(k.start)}</td>
          </tr>
          {k.rows.map((r, i) => (
            <tr key={i} className={cx('border-b border-slate-200', r.storno && 'line-through text-slate-400')}>
              <td className="py-0.5">{i + 1}</td>
              <td className="py-0.5">{fmtDate(r.date)} {r.time}</td>
              <td className="py-0.5">{r.num}</td>
              <td className="py-0.5 font-sans">{r.opis}{r.storno ? ' (STORNO)' : ''}</td>
              <td className="py-0.5 font-sans">{r.emp}</td>
              <td className="py-0.5 text-right">{r.bp != null ? fmtNum(r.bp) : ''}</td>
              <td className="py-0.5 text-right">{r.bi != null ? fmtNum(r.bi) : ''}</td>
              <td className="py-0.5 text-right">{fmtNum(r.saldo)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-800 font-mono font-bold">
            <td colSpan={5} className="py-1 font-sans text-right pr-2">Skupaj promet obdobja</td>
            <td className="py-1 text-right">{fmtNum(k.totBP)}</td>
            <td className="py-1 text-right">{fmtNum(k.totBI)}</td>
            <td className="py-1 text-right" />
          </tr>
          <tr className="font-mono font-bold">
            <td colSpan={7} className="py-1 font-sans text-right pr-2">Stanje ob koncu obdobja</td>
            <td className="py-1 text-right border-t border-slate-400">{fmtNum(k.end)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-8 flex justify-between text-[9px]">
        <div>Datum izpisa: <span className="font-mono">{fmtDate(todayIso())}</span></div>
        <div className="w-48 text-center">
          <div className="border-b border-dotted border-slate-700 h-8" />
          <div className="italic mt-0.5">(Blagajnik)</div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Tiskalni sloj
export interface PrintJob {
  docs?: { doc: CashDocument; desk?: CashDesk }[]
  potrdila?: Potrdilo[]
  knjiga?: KnjigaJob
  title: string
}

export function PrintOverlay({ job, settings, onClose }: { job: PrintJob; settings: Settings; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-700/80 overflow-y-auto print:static print:bg-white print:overflow-visible">
      <div className="sticky top-0 z-10 bg-slate-900 text-white px-4 py-2.5 flex items-center justify-between gap-3 print:hidden">
        <div className="text-sm font-medium truncate">Tiskanje — {job.title}</div>
        <div className="flex gap-2 shrink-0">
          <Btn kind="primary" onClick={() => window.print()}>🖨️ Natisni</Btn>
          <Btn onClick={onClose}>Zapri</Btn>
        </div>
      </div>
      <div className="mx-auto max-w-4xl py-6 px-2 space-y-6 print:p-0 print:m-0 print:max-w-none print:space-y-0">
        <div className="text-center text-[11px] text-slate-300 print:hidden">
          Predogled tiskanja — obrazec je oblikovan po vzoru obstoječih papirnih obrazcev. Če se tiskalno okno ne odpre, uporabite nameščeno/izvoženo različico aplikacije.
        </div>
        {job.docs?.map(({ doc, desk }) => <PaperDocPair key={doc.id} doc={doc} settings={settings} desk={desk} />)}
        {job.potrdila?.map((p) => <PaperPotrdilo key={p.id} p={p} settings={settings} />)}
        {job.knjiga && <PaperKnjiga k={job.knjiga} settings={settings} />}
      </div>
    </div>
  )
}

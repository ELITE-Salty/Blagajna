import React, { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useApp } from '../state'
import type { CashDesk, CompanyInfo, Role } from '../types'
import { ROLE_LABELS } from '../types'
import { cx, fmtEur, parseAmount, uuid } from '../lib/util'
import { docDelta } from '../lib/balance'
import { Btn, Chip, ErrBox, Field, Modal, Warn, inputCls } from '../components/ui'
import { apiCreateUser, apiUpdateUser, apiUsers, type AppUser } from '../lib/api'
import { putDesk, updateDesk } from '../lib/persist'
import { descendantLocationIds } from '../lib/desks'

export function SettingsView() {
  const app = useApp()
  const { db, settings } = app
  const desks = useLiveQuery(() => db.desks.toArray(), []) ?? []
  const closesCount = useLiveQuery(() => db.closes.count(), []) ?? 0
  const allDocs = useLiveQuery(() => db.docs.toArray(), []) ?? []
  const balances = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of desks) m.set(d.id, d.openingBalance ?? 0)
    for (const doc of allDocs) m.set(doc.deskId, Math.round(((m.get(doc.deskId) ?? 0) + docDelta(doc)) * 100) / 100)
    for (const d of desks.filter((x) => x.isGroup)) {
      const total = descendantLocationIds(desks, d.id).reduce((sum, id) => sum + (m.get(id) ?? 0), 0)
      m.set(d.id, Math.round(total * 100) / 100)
    }
    return m
  }, [desks, allDocs])
  const [c, setC] = useState<CompanyInfo>({ ...settings.company })
  const [savedMsg, setSavedMsg] = useState('')

  async function saveCompany() {
    await app.saveSettings({ company: c })
    await app.audit('Sprememba nastavitev podjetja', 'Nastavitve', 'main', '')
    setSavedMsg('Shranjeno.')
    setTimeout(() => setSavedMsg(''), 2000)
  }

  const setc = (patch: Partial<CompanyInfo>) => setC((x) => ({ ...x, ...patch }))

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Podjetje */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Podjetje <span className="text-slate-400 font-normal text-sm">— izpolni glavo potrdila o dejavnostih in obrazcev</span></h2>
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          <Field label="Naziv podjetja"><input className={inputCls} value={c.name} onChange={(e) => setc({ name: e.target.value })} /></Field>
          <Field label="Ulica in hišna številka"><input className={inputCls} value={c.street} onChange={(e) => setc({ street: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Pošta"><input className={inputCls} value={c.postalCode} onChange={(e) => setc({ postalCode: e.target.value })} /></Field>
            <Field label="Kraj" className="col-span-2"><input className={inputCls} value={c.city} onChange={(e) => setc({ city: e.target.value })} /></Field>
          </div>
          <Field label="Država"><input className={inputCls} value={c.country} onChange={(e) => setc({ country: e.target.value })} /></Field>
          <Field label="Telefon (z mednarodno kodo)"><input className={inputCls} value={c.phone} onChange={(e) => setc({ phone: e.target.value })} placeholder="+386 …" /></Field>
          <Field label="Telefaks"><input className={inputCls} value={c.fax} onChange={(e) => setc({ fax: e.target.value })} /></Field>
          <Field label="E-pošta"><input className={inputCls} value={c.email} onChange={(e) => setc({ email: e.target.value })} /></Field>
          <Field label="Izjavitelj — priimek in ime"><input className={inputCls} value={c.declarantName} onChange={(e) => setc({ declarantName: e.target.value })} /></Field>
          <Field label="Izjavitelj — delovno mesto"><input className={inputCls} value={c.declarantPosition} onChange={(e) => setc({ declarantPosition: e.target.value })} /></Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn kind="primary" onClick={saveCompany}>Shrani podatke podjetja</Btn>
          {savedMsg && <span className="text-emerald-600 text-sm font-medium">{savedMsg}</span>}
        </div>
      </section>

      {/* Blagajne */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-800">Struktura blagajn</h2>
            <div className="text-[11px] text-slate-400 mt-0.5">Glavna/globalna blagajna je zbirnik; dokumenti in gotovina so na internih blagajnah pod njo.</div>
          </div>
          <div className="flex gap-2">
            <Btn onClick={async () => {
              const name = window.prompt('Ime glavne/globalne blagajne:', 'Glavna blagajna')
              if (!name?.trim()) return
              const d: CashDesk = { id: uuid(), name: name.trim(), code: '', description: '', active: true, openingBalance: 0, isGroup: true, parentId: null }
              await putDesk(db, d)
              await app.audit('Nova globalna blagajna', 'Blagajna', d.id, d.name)
            }}>+ Glavna / globalna</Btn>
            <Btn kind="primary" onClick={async () => {
              const name = window.prompt('Ime nove interne blagajne/lokacije:')
              if (!name?.trim()) return
              const groups = desks.filter((x) => x.isGroup && x.active)
              const d: CashDesk = { id: uuid(), name: name.trim(), code: '', description: '', active: true, openingBalance: 0, isGroup: false, parentId: groups[0]?.id ?? null }
              await putDesk(db, d)
              await app.audit('Nova lokacija blagajne', 'Blagajna', d.id, `${d.name}${groups[0] ? ` · ${groups[0].name}` : ''}`)
              if (!app.settings.activeDeskId) await app.saveSettings({ activeDeskId: d.id })
            }}>+ Interna blagajna</Btn>
          </div>
        </div>
        <div className="mt-3 space-y-3">
          {desks.filter((d) => d.isGroup).sort((a, b) => a.name.localeCompare(b.name)).map((g) => {
            const children = desks.filter((d) => !d.isGroup && d.parentId === g.id).sort((a, b) => a.name.localeCompare(b.name))
            return (
              <div key={g.id} className="rounded-lg border border-blu-200 bg-blu-50/40 p-2">
                <DeskRow d={g} desks={desks} current={balances.get(g.id) ?? 0} />
                <div className="ml-5 mt-2 border-l-2 border-blu-200 pl-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-blu-600">Interne blagajne pod {g.name}</div>
                  {children.map((d) => <DeskRow key={d.id} d={d} desks={desks} current={balances.get(d.id) ?? d.openingBalance ?? 0} />)}
                  {children.length === 0 && <div className="text-[12px] text-slate-400 py-1">Ni internih blagajn. Dodajte jo z gumbom »+ Interna blagajna« in izberite to glavno blagajno.</div>}
                </div>
              </div>
            )
          })}
          {desks.some((d) => !d.isGroup && !d.parentId) && (
            <div className="rounded-lg border border-slate-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Samostojne / še nepovezane blagajne</div>
              <div className="space-y-2">{desks.filter((d) => !d.isGroup && !d.parentId).sort((a, b) => a.name.localeCompare(b.name)).map((d) => <DeskRow key={d.id} d={d} desks={desks} current={balances.get(d.id) ?? d.openingBalance ?? 0} />)}</div>
            </div>
          )}
        </div>
        <div className="mt-2 text-[11px] text-slate-400">Primer: <b>Glavna blagajna (GB)</b> → <b>Pisarna</b> + <b>Direktor</b>. V zavihku Blagajna izberite GB za skupno stanje ali eno od podrejenih internih blagajn za njen lasten promet. Dokumenti se vedno knjižijo na konkretno interno blagajno.</div>
      </section>

      {/* Številčenje */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Številčenje</h2>
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          <Field label="Obseg zaporedij" hint={closesCount > 0 ? 'Zaklenjeno — obstajajo že zaključeni meseci, obsega ni več varno spreminjati.' : 'Določite pred prvim zaključkom meseca.'}>
            <select
              className={inputCls}
              value={settings.numberingScope}
              disabled={closesCount > 0}
              onChange={async (e) => { await app.saveSettings({ numberingScope: e.target.value as any }); await app.audit('Sprememba obsega številčenja', 'Nastavitve', 'main', e.target.value) }}
            >
              <option value="PER_DESK">Po blagajni (vsaka blagajna svoje zaporedje)</option>
              <option value="COMPANY">Skupno za celotno podjetje</option>
            </select>
          </Field>
          <Field label="Prikaz številke" hint="Motor številčenja ni odvisen od prikaza — spremembo lahko naredite kadarkoli.">
            <select
              className={inputCls}
              value={settings.numberFormat}
              onChange={async (e) => { await app.saveSettings({ numberFormat: e.target.value as any }); await app.audit('Sprememba formata številk', 'Nastavitve', 'main', e.target.value) }}
            >
              <option value="SLASH">BP 10/2026</option>
              <option value="DASH">BP-2026-0010</option>
            </select>
          </Field>
        </div>
        <div className="mt-3 text-[12px] text-slate-500">
          BP in BI imata ločeni zaporedji · zaporedja se ponastavijo vsako koledarsko leto · števec se začne pri 0, prvi dokument dobi številko 1 · številke se dodelijo šele ob akciji »Zaključi mesec«, kronološko po času transakcije.
        </div>
      </section>

      {/* Pravila */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Pravila</h2>
        <label className="flex items-start gap-2 mt-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={settings.financeCanClose}
            onChange={async (e) => { await app.saveSettings({ financeCanClose: e.target.checked }); await app.audit('Sprememba pravila', 'Nastavitve', 'main', `Finance lahko zaključi mesec: ${e.target.checked ? 'da' : 'ne'}`) }} />
          <span>Vloga <b>Finance</b> lahko izvede »Zaključi mesec« in vidi predogled številčenja</span>
        </label>
        <label className="flex items-start gap-2 mt-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={settings.requirePurpose}
            onChange={async (e) => { await app.saveSettings({ requirePurpose: e.target.checked }); await app.audit('Sprememba pravila', 'Nastavitve', 'main', `Namen (Za) obvezen: ${e.target.checked ? 'da' : 'ne'}`) }} />
          <span>Polje <b>Za (namen)</b> je obvezno za zaključek meseca</span>
        </label>
        <label className="flex items-start gap-2 mt-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={settings.autoSync !== false}
            onChange={async (e) => { await app.saveSettings({ autoSync: e.target.checked }); await app.audit('Sprememba pravila', 'Nastavitve', 'main', `Samodejna sinhronizacija: ${e.target.checked ? 'da' : 'ne'}`) }} />
          <span><b>Samodejna sinhronizacija</b> — zapisi se ob delujoči povezavi samodejno pošljejo na strežnik (priporočeno). Če je izklopljena, uporabite gumb »Sinhroniziraj«.</span>
        </label>
        <div className="mt-3">
          <Warn>Zaključen mesec se nikoli ne odpira ali preštevilči — kasnejši popravki potekajo izključno prek storna (potrjena poslovna odločitev). Podpisi niso pogoj za zaključek meseca.</Warn>
        </div>
      </section>

      {/* Uporabniki (strežniški način) */}
      {app.mode === 'server' && <UsersAdmin />}

      {/* Podatki */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Podatki</h2>
        {app.mode === 'demo' ? (
          <>
            <p className="text-sm text-slate-500 mt-1">DEMO način: podatki so shranjeni lokalno v brskalniku te naprave. V nameščeni različici jih hrani strežnik, naprave pa se samodejno sinhronizirajo.</p>
            <div className="mt-3">
              <Btn kind="danger" onClick={async () => {
                if (!window.confirm('Izbrišem VSE podatke in ponovno naložim predstavitvene? Tega ni mogoče razveljaviti.')) return
                await db.delete()
                window.location.reload()
              }}>Ponastavi na predstavitvene podatke</Btn>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500 mt-1">Strežniški način: podatki se hranijo na strežniku (SQLite baza v mapi data/). Varnostna kopija = kopija mape data/. Lokalna baza v brskalniku je predpomnilnik za delo brez povezave.</p>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- uporabniki
function UsersAdmin() {
  const app = useApp()
  const [users, setUsers] = useState<AppUser[]>([])
  const [err, setErr] = useState('')
  const [showNew, setShowNew] = useState(false)

  const load = () => apiUsers().then((r) => { setUsers(r.users); setErr('') }).catch((e) => setErr(String(e?.message ?? e)))
  useEffect(() => { void load() }, [])

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800">Uporabniki <span className="text-slate-400 font-normal text-sm">— prijava v aplikacijo</span></h2>
        <Btn kind="primary" onClick={() => setShowNew(true)}>+ Nov uporabnik</Btn>
      </div>
      {err && <div className="mt-2"><ErrBox>{err}</ErrBox></div>}
      <div className="mt-3 space-y-2">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-44 font-medium">{u.name}</span>
            <span className="w-56 text-slate-500">{u.email}</span>
            <select
              className={cx(inputCls, 'w-40')}
              value={u.role}
              disabled={u.id === app.user?.id}
              onChange={async (e) => { try { await apiUpdateUser(u.id, { role: e.target.value as Role }); await load() } catch (ex: any) { setErr(String(ex.message)) } }}
            >
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={u.active} disabled={u.id === app.user?.id}
                onChange={async (e) => { try { await apiUpdateUser(u.id, { active: e.target.checked }); await load() } catch (ex: any) { setErr(String(ex.message)) } }} />
              aktiven
            </label>
            <Btn kind="ghost" onClick={async () => {
              const p = window.prompt(`Novo geslo za ${u.name} (min. 8 znakov):`)
              if (!p) return
              try { await apiUpdateUser(u.id, { password: p }); alert('Geslo je spremenjeno.') } catch (ex: any) { setErr(String(ex.message)) }
            }}>Ponastavi geslo</Btn>
          </div>
        ))}
        {users.length === 0 && !err && <div className="text-sm text-slate-400">Nalagam …</div>}
      </div>
      {showNew && <NewUserModal onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); void load() }} />}
    </section>
  )
}

function NewUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'FINANCE' as Role, password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title="Nov uporabnik"
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Prekliči</Btn>
        <Btn kind="primary" disabled={busy || !f.name || !f.email || f.password.length < 8} onClick={async () => {
          setBusy(true)
          try { await apiCreateUser(f); onDone() } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
        }}>Ustvari</Btn>
      </>}
    >
      {err && <div className="mb-2"><ErrBox>{err}</ErrBox></div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ime in priimek"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="E-naslov"><input className={inputCls} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Vloga">
          <select className={inputCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </Field>
        <Field label="Geslo (min. 8 znakov)"><input className={inputCls} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
      <p className="text-[11px] text-slate-400 mt-3">Pravice: Finance vnaša dokumente; Računovodja tudi zaključuje mesece, stornira in ureja zaposlene; Admin upravlja blagajne, uporabnike in nastavitve.</p>
    </Modal>
  )
}

function DeskRow({ d, desks, current }: { d: CashDesk; desks: CashDesk[]; current: number }) {
  const app = useApp()
  const { db } = app
  const [name, setName] = useState(d.name)
  const [code, setCode] = useState(d.code)
  const [opening, setOpening] = useState(d.openingBalance != null ? String(d.openingBalance).replace('.', ',') : '0')
  useEffect(() => setName(d.name), [d.name])
  useEffect(() => setCode(d.code), [d.code])
  useEffect(() => setOpening(d.openingBalance != null ? String(d.openingBalance).replace('.', ',') : '0'), [d.openingBalance])

  async function syncIfNeeded() {
    if (app.mode === 'server') await app.syncNow()
  }

  async function saveName() {
    const value = name.trim()
    if (!value || value === d.name) { if (!value) setName(d.name); return }
    await updateDesk(db, d.id, { name: value })
    await app.audit('Sprememba blagajne', 'Blagajna', d.id, value)
    await syncIfNeeded()
  }

  async function saveCode() {
    if (code === d.code) return
    await updateDesk(db, d.id, { code })
    await app.audit('Sprememba oznake blagajne', 'Blagajna', d.id, code)
    await syncIfNeeded()
  }

  async function saveOpening() {
    const parsed = opening.trim() ? parseAmount(opening) : 0
    if (parsed == null) {
      setOpening(String(d.openingBalance ?? 0).replace('.', ','))
      return
    }
    const before = d.openingBalance ?? 0
    if (parsed === before) {
      setOpening(String(parsed).replace('.', ','))
      return
    }
    await updateDesk(db, d.id, { openingBalance: parsed })
    await app.audit('Sprememba začetnega stanja blagajne', 'Blagajna', d.id, `${fmtEur(before)} → ${fmtEur(parsed)}`)
    setOpening(String(parsed).replace('.', ','))
    await syncIfNeeded()
  }

  return (
    <div className={cx('flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5', d.isGroup && 'bg-blu-50 border border-blu-100')}>
      <input className={cx(inputCls, 'w-56', d.isGroup && 'font-semibold')} value={name} onChange={(e) => setName(e.target.value)}
        onBlur={() => void saveName()} />
      <input className={cx(inputCls, 'w-20 font-mono')} placeholder="oznaka" value={code} onChange={(e) => setCode(e.target.value)}
        onBlur={() => void saveCode()} />
      {d.isGroup ? (
        <><Chip tone="blue">GLOBALNA</Chip><Chip tone={current < 0 ? 'red' : 'blue'}>skupaj: {fmtEur(current)}</Chip></>
      ) : (
        <>
          <select className={cx(inputCls, 'w-44')} value={d.parentId ?? ''} onChange={async (e) => {
            await updateDesk(db, d.id, { parentId: e.target.value || null })
            await app.audit('Sprememba globalne blagajne lokacije', 'Blagajna', d.id, e.target.value || 'brez')
            await syncIfNeeded()
          }}>
            <option value="">— brez globalne —</option>
            {desks.filter((x) => x.isGroup && x.id !== d.id).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-slate-500">
            začetno stanje
            <input className={cx(inputCls, 'w-28 font-mono text-right')} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)}
              onBlur={() => void saveOpening()} />
          </label>
          <Chip tone={current < 0 ? 'red' : 'blue'}>trenutno: {fmtEur(current)}</Chip>
        </>
      )}
      {d.active ? <Chip tone="green">aktivna</Chip> : <Chip tone="slate">neaktivna</Chip>}
      <Btn onClick={async () => { await updateDesk(db, d.id, { active: !d.active }); await app.audit('Sprememba blagajne', 'Blagajna', d.id, d.active ? 'deaktivirana' : 'aktivirana'); await syncIfNeeded() }}>
        {d.active ? 'Deaktiviraj' : 'Aktiviraj'}
      </Btn>
    </div>
  )
}

import React, { useState } from 'react'
import { Btn, ErrBox, Field, inputCls } from '../components/ui'

export function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await onLogin(email.trim(), pass)
    } catch (ex: any) {
      setErr(String(ex?.message ?? ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 grid place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl p-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blu-800 text-white grid place-items-center font-extrabold text-lg">B</div>
          <div>
            <div className="font-bold text-slate-800 leading-5">Blagajna</div>
            <div className="text-[11px] text-slate-400 leading-4">Blu Logistics · prejemki · izdatki · dopust listi</div>
          </div>
        </div>
        {err && <div className="mt-4"><ErrBox>{err}</ErrBox></div>}
        <div className="mt-4 space-y-3">
          <Field label="E-naslov">
            <input className={inputCls} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ime@blu-logistics.si" autoFocus />
          </Field>
          <Field label="Geslo">
            <input className={inputCls} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" />
          </Field>
        </div>
        <div className="mt-5">
          <button type="submit" disabled={busy || !email || !pass} className="w-full rounded-md bg-blu-600 hover:bg-blu-700 text-white font-medium py-2 text-sm disabled:opacity-40 transition">
            {busy ? 'Prijavljam …' : 'Prijava'}
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-4">Dostop dodeli administrator v Nastavitvah → Uporabniki. Podatki se samodejno sinhronizirajo, delo brez povezave je podprto.</p>
      </form>
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { cx, fmtDate, fmtDateTime, parse24hTime, parseSlDate, parseSlDateTime } from '../lib/util'

export function Modal({
  title, onClose, children, wide, footer,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
  footer?: React.ReactNode
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-[2px] overflow-y-auto no-print" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('mx-auto my-6 bg-white rounded-xl shadow-2xl border border-slate-200', wide ? 'max-w-5xl' : 'max-w-2xl', 'w-[calc(100%-1.5rem)]')}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl z-10">
          <h2 className="font-semibold text-slate-800">{title}</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl leading-none px-1" onClick={onClose} title="Zapri">×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl flex flex-wrap gap-2 justify-end">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, children, hint, className }: { label: React.ReactNode; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blu-600/30 focus:border-blu-600 disabled:bg-slate-100 disabled:text-slate-500'

type LocalizedInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

function LocalizedInput({
  value, onValueChange, formatter, parser, placeholder, onBlur, onKeyDown, ...rest
}: LocalizedInputProps & {
  formatter: (value: string) => string
  parser: (value: string) => string | null
  placeholder: string
}) {
  const [draft, setDraft] = useState(() => formatter(value))

  useEffect(() => setDraft(formatter(value)), [value, formatter])

  const commit = () => {
    const parsed = parser(draft)
    if (parsed == null) {
      setDraft(formatter(value))
      return
    }
    setDraft(formatter(parsed))
    if (parsed !== value) onValueChange(parsed)
  }

  return (
    <input
      {...rest}
      type="text"
      lang="sl-SI"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => { commit(); onBlur?.(e) }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.key === 'Enter' && !e.defaultPrevented) e.currentTarget.blur()
      }}
      autoComplete="off"
      spellCheck={false}
    />
  )
}

const dateFormatter = (v: string) => (v ? fmtDate(v) : '')
const timeFormatter = (v: string) => v || ''
const dateTimeFormatter = (v: string) => (v ? fmtDateTime(v) : '')

/** Slovenski datum brez odvisnosti od brskalnikovega US/EU prikaza. */
export function SlDateInput(props: LocalizedInputProps) {
  return <LocalizedInput {...props} formatter={dateFormatter} parser={parseSlDate} placeholder="dd.mm.yyyy" inputMode="numeric" aria-label="Datum v obliki dd.mm.yyyy" />
}

/** 24-urni čas (HH:mm), brez AM/PM. */
export function SlTimeInput(props: LocalizedInputProps) {
  return <LocalizedInput {...props} formatter={timeFormatter} parser={parse24hTime} placeholder="HH:mm" inputMode="numeric" aria-label="Čas v 24-urni obliki HH:mm" />
}

/** Slovenski datum in 24-urni čas: dd.mm.yyyy HH:mm. */
export function SlDateTimeInput(props: LocalizedInputProps) {
  return <LocalizedInput {...props} formatter={dateTimeFormatter} parser={parseSlDateTime} placeholder="dd.mm.yyyy HH:mm" inputMode="numeric" aria-label="Datum in čas v obliki dd.mm.yyyy HH:mm" />
}

export function Btn({
  children, onClick, kind = 'default', disabled, title, type,
}: {
  children: React.ReactNode
  onClick?: () => void
  kind?: 'default' | 'primary' | 'danger' | 'ghost' | 'success'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed'
  const kinds = {
    default: 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50',
    primary: 'bg-blu-600 text-white hover:bg-blu-700 shadow-sm',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
    danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
    ghost: 'text-blu-600 hover:bg-blu-50',
  }
  return (
    <button type={type ?? 'button'} className={cx(base, kinds[kind])} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

export function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    blue: 'bg-blu-50 text-blu-700 border-blu-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
  }
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', tones[tone])}>{children}</span>
}

export function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 text-sm px-3 py-2 flex gap-2">
      <span aria-hidden>⚠️</span>
      <div>{children}</div>
    </div>
  )
}

export function ErrBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 text-red-800 text-sm px-3 py-2 flex gap-2">
      <span aria-hidden>⛔</span>
      <div>{children}</div>
    </div>
  )
}

// ---------- Podpisna ploščica ----------
export function SignaturePad({
  title, defaultName, onSave, onClose,
}: {
  title: string
  defaultName: string
  onSave: (name: string, dataUrl: string) => void
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [name, setName] = useState(defaultName)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.strokeStyle = '#1e3a5f'
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    let down = false
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
    }
    const onDown = (e: PointerEvent) => {
      down = true
      const p = pos(e)
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      c.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      if (!down) return
      const p = pos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      setDrawn(true)
      e.preventDefault()
    }
    const onUp = () => (down = false)
    c.addEventListener('pointerdown', onDown)
    c.addEventListener('pointermove', onMove)
    c.addEventListener('pointerup', onUp)
    c.addEventListener('pointerleave', onUp)
    return () => {
      c.removeEventListener('pointerdown', onDown)
      c.removeEventListener('pointermove', onMove)
      c.removeEventListener('pointerup', onUp)
      c.removeEventListener('pointerleave', onUp)
    }
  }, [])

  const clear = () => {
    const c = canvasRef.current!
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    setDrawn(false)
  }

  return (
    <Modal
      title={`Podpis — ${title}`}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={clear}>Počisti</Btn>
          <Btn kind="primary" disabled={!drawn || !name.trim()} onClick={() => onSave(name.trim(), canvasRef.current!.toDataURL('image/png'))}>
            Shrani podpis
          </Btn>
        </>
      }
    >
      <Field label="Ime in priimek podpisnika">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Janez Novak" />
      </Field>
      <div className="mt-3">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Narišite podpis (prst, pisalo ali miška)</span>
        <canvas ref={canvasRef} width={640} height={200} className="w-full border border-dashed border-slate-400 rounded-md touch-none bg-white cursor-crosshair" />
      </div>
      <p className="text-[11px] text-slate-400 mt-2">Podpis ni obvezen — dokument je mogoče natisniti in podpisati fizično.</p>
    </Modal>
  )
}

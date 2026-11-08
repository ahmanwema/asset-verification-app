import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import type { Condition, RoomStatus } from '../types'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">{children}</h2>
      {action}
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  full?: boolean
}

export function Button({ variant = 'primary', full, className = '', ...rest }: ButtonProps) {
  const base =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'secondary'
        ? 'btn-secondary'
        : variant === 'danger'
          ? 'btn-danger'
          : 'btn-ghost'
  return <button className={`${base} ${full ? 'w-full' : ''} ${className}`} {...rest} />
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  // The hint sits outside the <label> on purpose: nested, it becomes part of the
  // accessible name, so a screen reader would read the whole example sentence
  // back as the field's label.
  return (
    <div>
      <label className="block">
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-red-600">{error}</span>}
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input className={`field-input ${className}`} {...rest} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea className={`field-input ${className}`} rows={3} {...rest} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props
  return <select className={`field-input appearance-none bg-white pr-8 ${className}`} {...rest} />
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-semibold text-slate-700">{title}</p>
      {hint && <p className="max-w-xs text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  )
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'neutral' | 'brand' | 'warn' | 'danger'
}) {
  const tones = {
    neutral: 'text-slate-900',
    brand: 'text-brand-700',
    warn: 'text-amber-600',
    danger: 'text-red-600',
  }
  return (
    <div className="card px-3 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold tabular-nums leading-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

/**
 * Condition colours, shared by the chips, the charts and the room grid.
 *
 * These are the four reserved status steps (good / warning / serious / critical),
 * not series colours. Warning and serious sit below 3:1 on a white surface by
 * design, so every place that uses them also shows the condition name or count —
 * colour never carries the meaning on its own.
 */
export const CONDITION_STYLE: Record<Condition, { chip: string; color: string }> = {
  G: { chip: 'bg-emerald-50 text-emerald-900', color: '#0ca30c' },
  F: { chip: 'bg-amber-50 text-amber-900', color: '#fab219' },
  P: { chip: 'bg-orange-50 text-orange-900', color: '#ec835a' },
  U: { chip: 'bg-red-50 text-red-900', color: '#d03b3b' },
}

/** Room states: two status steps plus a neutral for "no data yet". */
export const ROOM_STATE_COLOR = {
  done: '#0ca30c',
  in_progress: '#fab219',
  not_started: '#cbd5e1',
} as const

/** Single-series magnitude bars use one hue, matching the app's brand. */
export const SERIES_COLOR = '#0f766e'

export const STATUS_STYLE: Record<RoomStatus, { chip: string; grid: string }> = {
  not_started: { chip: 'bg-slate-100 text-slate-600', grid: 'bg-white border-slate-300 text-slate-600' },
  in_progress: { chip: 'bg-amber-100 text-amber-800', grid: 'bg-amber-50 border-amber-400 text-amber-900' },
  done: { chip: 'bg-emerald-100 text-emerald-800', grid: 'bg-emerald-50 border-emerald-500 text-emerald-900' },
}

export function ProgressBar({ value, total, tone = 'brand' }: { value: number; total: number; tone?: 'brand' | 'amber' }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={`h-full rounded-full transition-all ${tone === 'brand' ? 'bg-brand-600' : 'bg-amber-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-xl border border-slate-300 bg-slate-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
            value === o.value ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-600'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-label="Close" />
      <div className="relative z-10 w-full max-w-lg rounded-t-2xl bg-white p-4 pb-[calc(1rem+var(--safe-bottom))] shadow-xl sm:rounded-2xl sm:pb-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-2xl leading-none text-slate-400 hover:bg-slate-100" aria-label="Close">
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4" role="status" aria-live="polite">
      <div className="rounded-full bg-slate-900/90 px-4 py-2 text-sm font-semibold text-white shadow-lg">{message}</div>
    </div>
  )
}

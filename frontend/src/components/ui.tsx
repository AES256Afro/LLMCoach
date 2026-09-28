import type { ReactNode } from 'react'
import type { JobStatus } from '../api'

export function Card({ title, actions, children, className = '' }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 text-sm font-medium">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

const STATUS_STYLE: Record<JobStatus, string> = {
  queued: 'bg-muted/15 text-muted',
  running: 'bg-accent/15 text-accent',
  done: 'bg-ok/15 text-ok',
  failed: 'bg-bad/15 text-bad',
  cancelled: 'bg-warn/15 text-warn',
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status}
    </span>
  )
}

export function Meter({ label, value, max = 100, unit = '%', detail }: {
  label: string
  value: number | null | undefined
  max?: number
  unit?: string
  detail?: string
}) {
  const pct = value == null ? 0 : Math.min(100, (value / max) * 100)
  const color = pct > 90 ? 'bg-bad' : pct > 70 ? 'bg-warn' : 'bg-accent'
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono">
          {value == null ? '—' : `${value.toFixed(unit === '%' ? 0 : 1)}${unit}`}
          {detail && <span className="text-muted"> {detail}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function Button({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}) {
  const styles = {
    primary: 'bg-accent text-bg hover:bg-accent/90',
    ghost: 'border border-line text-text hover:bg-panel-2',
    danger: 'border border-bad/40 text-bad hover:bg-bad/10',
  }[variant]
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${props.className ?? ''}`}
    >
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-muted">{children}</div>
}

/** Backend timestamps are UTC, but SQLite drops the tz suffix. */
export function parseUtc(iso: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z')
}

export function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return '—'
  const ms = (end ? parseUtc(end) : new Date()).getTime() - parseUtc(start).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function fmtTime(iso: string): string {
  return parseUtc(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

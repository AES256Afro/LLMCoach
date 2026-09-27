import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { JobEvent } from '../../api'
import { stripAnsi } from '../../components/ansi'

export function Tile({ title, fkey, right, style, className = '', bodyClass = '', children }: {
  title: ReactNode
  fkey?: string
  right?: ReactNode
  style?: CSSProperties
  className?: string
  bodyClass?: string
  children: ReactNode
}) {
  return (
    <section className={`mc-t ${className}`} style={style}>
      <div className="mc-th">{fkey && <b>{fkey}</b>}<span className="min-w-0 truncate">{title}</span>{right != null && <span className="mc-r">{right}</span>}</div>
      <div className={`mc-tb ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function Meter({ label, pct, value }: { label: string; pct: number | null; value: ReactNode }) {
  return (
    <>
      <span className="mc-am2">{label}</span>
      {pct == null ? <span className="mc-dim">not detected</span> : <div className="mc-meter" style={{ '--v': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties} />}
      <em className="not-italic text-right tabular-nums">{value}</em>
    </>
  )
}

/** "██████░░░░" as two spans, so the empty part can be drawn dim. */
export function Blocks({ value, width = 24 }: { value: number; width?: number }) {
  const n = Math.round(Math.max(0, Math.min(1, value)) * width)
  return (
    <span className="tracking-[-.5px]">
      <span className="mc-am">{'█'.repeat(n)}</span><span style={{ color: 'var(--mc-off)' }}>{'█'.repeat(width - n)}</span>
    </span>
  )
}

export interface Series {
  id: number
  label: string
  events: JobEvent[]
}

interface Pt { step: number; v: number }

function points(events: JobEvent[], key: 'loss' | 'eval_loss'): Pt[] {
  return events
    .filter((e) => e.type === 'metric' && typeof e[key] === 'number' && typeof e.step === 'number')
    .map((e) => ({ step: e.step as number, v: e[key] as number }))
}

/** Train loss (amber) and eval loss (green, dashed) for the main run, with earlier runs as faint lines. */
export function LossChart({ main, overlays = [], height = 250 }: { main: Series | null; overlays?: Series[]; height?: number }) {
  const W = 700, H = height, L = 42, R = 12, T = 12, B = 24
  const mainTrain = main ? points(main.events, 'loss') : []
  const mainEval = main ? points(main.events, 'eval_loss') : []
  const over = overlays.map((s) => ({ s, pts: points(s.events, 'loss') })).filter((o) => o.pts.length > 1)
  const all = [...mainTrain, ...mainEval, ...over.flatMap((o) => o.pts)]
  if (all.length < 2) {
    return <div className="grid h-full place-items-center mc-dim">{main ? 'waiting for the first loss…' : 'no training runs yet'}</div>
  }
  const maxStep = Math.max(...all.map((p) => p.step), 1)
  let lo = Math.min(...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v))
  if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5 }
  const pad = (hi - lo) * 0.08
  lo -= pad; hi += pad
  const x = (s: number) => L + ((W - L - R) * s) / maxStep
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo)
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')
  const ticks = [0, 0.5, 1].map((f) => lo + pad + (hi - lo - 2 * pad) * f)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" preserveAspectRatio="none" role="img" aria-label="Loss by training step">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--mc-off)" strokeWidth="1" />
          <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--mc-dim)">{t.toFixed(2)}</text>
        </g>
      ))}
      <text x={L} y={H - 6} fontSize="10" fill="var(--mc-dim)">0</text>
      <text x={W - R} y={H - 6} fontSize="10" fill="var(--mc-dim)" textAnchor="end">step {maxStep}</text>
      {over.map((o, i) => (
        <path key={o.s.id} d={path(o.pts)} fill="none" stroke="var(--mc-am2)" strokeWidth="1" opacity={0.45 - i * 0.08} vectorEffect="non-scaling-stroke" />
      ))}
      {mainTrain.length > 1 && <path d={`${path(mainTrain)}L${x(mainTrain[mainTrain.length - 1].step)} ${H - B}L${x(mainTrain[0].step)} ${H - B}Z`} fill="var(--mc-am)" opacity=".08" />}
      {mainTrain.length > 1 && <path d={path(mainTrain)} fill="none" stroke="var(--mc-am)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
      {mainEval.length > 0 && <path d={path(mainEval)} fill="none" stroke="var(--mc-grn)" strokeWidth="1.6" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
      {mainEval.map((p) => <circle key={p.step} cx={x(p.step)} cy={y(p.v)} r="3" fill="var(--mc-grn)" />)}
    </svg>
  )
}

const HIGHLIGHT = /(eval_loss|train_loss|saved|error|Traceback|failed|promoted)/i

/** The last lines of a log, kept scrolled to the end while following. */
export function LogTail({ lines, max = 400, empty = 'no output yet' }: { lines: string[]; max?: number; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = lines.slice(-max)
  const tail = shown[shown.length - 1]
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shown.length, tail])
  if (!shown.length) return <div className="mc-dim">{empty}</div>
  return (
    // A progress bar redraws itself with carriage returns; a terminal would show only the last state.
    <div ref={ref} className="mc-log h-full overflow-auto">{shown.map((l, i) => <div key={i} className={HIGHLIGHT.test(l) ? 'mc-am' : undefined}>{stripAnsi(l.split('\r').filter(Boolean).pop() ?? '') || ' '}</div>)}</div>
  )
}

export function gb(n: number | null | undefined, digits = 1) {
  return n == null ? '—' : `${n.toFixed(digits)}G`
}

export function mmss(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

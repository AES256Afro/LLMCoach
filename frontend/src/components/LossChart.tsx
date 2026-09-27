import { useMemo } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { JobEvent } from '../api'

interface Row {
  step: number
  loss?: number
  eval_loss?: number
  lr?: number
}

/** Merges metric events by step into chart rows. */
export function metricRows(events: JobEvent[]): Row[] {
  const byStep = new Map<number, Row>()
  for (const e of events) {
    if (e.type !== 'metric' || typeof e.step !== 'number') continue
    const row = byStep.get(e.step) ?? { step: e.step }
    for (const k of ['loss', 'eval_loss', 'lr'] as const) {
      if (typeof e[k] === 'number') row[k] = e[k] as number
    }
    byStep.set(e.step, row)
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step)
}

const axis = { stroke: '#8a93a6', fontSize: 11, tickLine: false }
const tooltip = {
  contentStyle: { background: '#12151c', border: '1px solid #252a36', borderRadius: 6, fontSize: 12 },
  labelFormatter: (s: unknown) => `step ${s}`,
}

export function LossChart({ events }: { events: JobEvent[] }) {
  const rows = useMemo(() => metricRows(events), [events])
  if (!rows.some((r) => r.loss != null)) return <div className="py-16 text-center text-sm text-muted">Waiting for first loss value…</div>
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="#252a36" strokeDasharray="3 3" />
        <XAxis dataKey="step" {...axis} />
        <YAxis {...axis} domain={['auto', 'auto']} />
        <Tooltip {...tooltip} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="loss" stroke="#7c9cff" dot={false} strokeWidth={2} isAnimationActive={false} />
        <Line type="monotone" dataKey="eval_loss" name="eval loss" stroke="#fbbf24" strokeWidth={2} connectNulls
              dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function LrChart({ events }: { events: JobEvent[] }) {
  const rows = useMemo(() => metricRows(events).filter((r) => r.lr != null), [events])
  if (!rows.length) return null
  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="#252a36" strokeDasharray="3 3" />
        <XAxis dataKey="step" {...axis} />
        <YAxis {...axis} tickFormatter={(v: number) => v.toExponential(0)} />
        <Tooltip {...tooltip} formatter={(v) => (v as number).toExponential(2)} />
        <Line type="monotone" dataKey="lr" name="learning rate" stroke="#4ade80" dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

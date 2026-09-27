import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, isFinal } from '../api'
import { useJobStream } from '../hooks/streams'
import { LogConsole } from '../components/LogConsole'
import { LossChart, LrChart, metricRows } from '../components/LossChart'
import { PageHeader } from '../components/Layout'
import { Button, Card, StatusBadge, fmtDuration, fmtTime, parseUtc } from '../components/ui'

export function JobDetail() {
  const id = Number(useParams().id)
  const { job, lines, events } = useJobStream(Number.isFinite(id) ? id : null)
  const [, tick] = useState(0)

  // Re-render every second so elapsed time/ETA stay current while running.
  useEffect(() => {
    if (!job || isFinal(job.status)) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [job])

  const progress = useMemo(() => [...events].reverse().find((e) => e.type === 'progress'), [events])
  const hasMetrics = useMemo(() => metricRows(events).length > 0, [events])
  const latest = useMemo(() => {
    const rows = metricRows(events)
    return {
      loss: [...rows].reverse().find((r) => r.loss != null)?.loss,
      evalLoss: [...rows].reverse().find((r) => r.eval_loss != null)?.eval_loss,
    }
  }, [events])

  if (!job) return <div className="text-sm text-muted">Loading job #{id}…</div>

  const pct = progress ? (Number(progress.current) / Number(progress.total)) * 100 : null
  let eta: string | null = null
  if (progress && job.started_at && job.status === 'running' && pct && pct > 0) {
    const elapsed = (Date.now() - parseUtc(job.started_at).getTime()) / 1000
    const remaining = Math.max(0, (elapsed * (100 - pct)) / pct)
    eta = remaining < 60 ? `${remaining.toFixed(0)}s` : `${Math.floor(remaining / 60)}m ${Math.round(remaining % 60)}s`
  }

  return (
    <>
      <PageHeader
        title={`Job #${job.id} · ${job.kind}`}
        subtitle={`Created ${fmtTime(job.created_at)}`}
        actions={
          <>
            <Link to="/jobs"><Button variant="ghost">All jobs</Button></Link>
            {!isFinal(job.status) && (
              <Button variant="danger" onClick={() => api.cancelJob(job.id)}>Cancel</Button>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Status"><StatusBadge status={job.status} /></Stat>
        <Stat label="Elapsed">{fmtDuration(job.started_at, job.finished_at)}</Stat>
        <Stat label="ETA">{eta ?? '—'}</Stat>
        <Stat label="Loss">{latest.loss?.toFixed(4) ?? '—'}</Stat>
        <Stat label="Eval loss">{latest.evalLoss?.toFixed(4) ?? '—'}</Stat>
      </div>

      {pct != null && (
        <div className="mb-6">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>{String(progress?.message || 'Progress')}</span>
            <span className="font-mono">{String(progress?.current)} / {String(progress?.total)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-line">
            <div className={`h-full transition-all ${job.status === 'failed' ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {job.error && (
        <Card title={<span className="text-bad">Error</span>} className="mb-6 border-bad/40">
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-xs text-bad">{job.error}</pre>
        </Card>
      )}

      {hasMetrics && (
        <div className="mb-6 grid gap-6 lg:grid-cols-3">
          <Card title="Loss" className="lg:col-span-2"><LossChart events={events} /></Card>
          <Card title="Learning rate"><LrChart events={events} /></Card>
        </div>
      )}

      <LogConsole lines={lines} title={`job-${job.id}`} height="h-[28rem]" live={!isFinal(job.status)} />

      <details className="mt-6 rounded-lg border border-line bg-panel p-4 text-sm">
        <summary className="cursor-pointer text-muted">Config</summary>
        <pre className="mt-3 font-mono text-xs">{JSON.stringify(job.config, null, 2)}</pre>
      </details>
    </>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm">{children}</div>
    </div>
  )
}

import { useEffect, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, isFinal } from '../api'
import { useJobStream } from '../hooks/streams'
import { stripAnsi } from './ansi'
import { Card } from './ui'

/** Compact live view of a job: progress bar, status and the last few log lines. */
export function JobProgress({ jobId, title, onFinished, onDismiss, className = 'mb-6' }: {
  jobId: number
  title: ReactNode
  onFinished?: () => void
  onDismiss?: () => void
  className?: string
}) {
  const { job, lines, events } = useJobStream(jobId)
  const progress = useMemo(() => [...events].reverse().find((e) => e.type === 'progress'), [events])
  const done = job != null && isFinal(job.status)

  useEffect(() => {
    if (done) onFinished?.()
  }, [done, onFinished])

  const pct = progress && Number(progress.total) > 0 ? (Number(progress.current) / Number(progress.total)) * 100 : 0
  return (
    <Card
      className={className}
      title={<span>{title} · <Link to={`/jobs/${jobId}`} className="font-mono text-accent hover:underline">job #{jobId}</Link></span>}
      actions={
        <>
          {job && !done && <button onClick={() => api.cancelJob(jobId)} className="text-xs text-bad/80 hover:text-bad">Cancel</button>}
          {done && onDismiss && <button onClick={onDismiss} className="text-xs text-muted hover:text-text">Dismiss</button>}
        </>
      }
    >
      <div className="mb-2 flex justify-between gap-3 text-xs text-muted">
        <span className="truncate">{String(progress?.message ?? (job?.status === 'queued' ? 'Waiting for the job queue…' : 'Starting…'))}</span>
        <span className="shrink-0">{job?.status}</span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={`h-full transition-all ${job?.status === 'failed' ? 'bg-bad' : job?.status === 'cancelled' ? 'bg-warn' : 'bg-accent'}`}
             style={{ width: `${done ? 100 : pct}%` }} />
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted">
        {lines.slice(-8).map(stripAnsi).join('\n')}
      </pre>
    </Card>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { LogConsole } from '../components/LogConsole'
import { PageHeader, useSystem } from '../components/Layout'
import { useJobStream } from '../hooks/streams'
import { usePolling } from '../hooks/usePolling'

const LEVELS = ['ALL', 'INFO', 'WARNING', 'ERROR'] as const

export function Logs() {
  const { logs } = useSystem()
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('ALL')
  const [jobId, setJobId] = useState<number | null>(null)
  const { data: jobs } = usePolling(() => api.jobs({ limit: 100 }), 5000)
  const jobStream = useJobStream(jobId)

  // Default to the most recent job.
  useEffect(() => {
    if (jobId == null && jobs?.length) setJobId(jobs[0].id)
  }, [jobs, jobId])

  const serverLines = useMemo(() => {
    const rank = { INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 } as Record<string, number>
    return logs
      .filter((l) => level === 'ALL' || (rank[l.level] ?? 0) >= rank[level])
      .map((l) => {
        const t = new Date(l.ts * 1000).toLocaleTimeString()
        const color = l.level === 'ERROR' ? '31' : l.level === 'WARNING' ? '33' : '90'
        return `\x1b[90m${t}\x1b[0m \x1b[${color}m${l.level.padEnd(7)}\x1b[0m \x1b[36m${l.logger}\x1b[0m ${l.message}`
      })
  }, [logs, level])

  return (
    <>
      <PageHeader title="Logs" subtitle="Recent server activity, and any job's full output" />
      <div className="space-y-6">
        <div>
          <div className="mb-2 flex gap-1">
            {LEVELS.map((l) => (
              <button key={l} onClick={() => setLevel(l)}
                className={`rounded px-2 py-1 text-xs ${level === l ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
                {l}
              </button>
            ))}
          </div>
          <LogConsole lines={serverLines} title="server" height="h-64" live />
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="text-muted">Job</span>
            <select
              value={jobId ?? ''}
              onChange={(e) => setJobId(Number(e.target.value))}
              className="rounded border border-line bg-panel px-2 py-1 text-sm outline-none"
            >
              {jobs?.map((j) => (
                <option key={j.id} value={j.id}>#{j.id} · {j.kind} · {j.status}</option>
              ))}
            </select>
          </div>
          <LogConsole lines={jobStream.lines} title={jobId ? `job-${jobId}` : 'job'} height="h-96"
                      live={jobStream.job?.status === 'running'} />
        </div>
      </div>
    </>
  )
}

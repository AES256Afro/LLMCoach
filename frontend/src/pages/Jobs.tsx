import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type JobStatus } from '../api'
import { JobTable } from '../components/JobTable'
import { PageHeader } from '../components/Layout'
import { Button, Card } from '../components/ui'
import { usePolling } from '../hooks/usePolling'

const FILTERS: (JobStatus | 'all')[] = ['all', 'running', 'queued', 'done', 'failed', 'cancelled']

export function Jobs() {
  const [filter, setFilter] = useState<JobStatus | 'all'>('all')
  const { data: jobs, error } = usePolling(
    () => api.jobs({ status: filter === 'all' ? undefined : filter, limit: 200 }),
    2000,
    [filter],
  )
  const navigate = useNavigate()

  const launch = async (kind: string, config: Record<string, unknown>) => {
    const job = await api.createJob(kind, config)
    navigate(`/jobs/${job.id}`)
  }

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Everything that runs on BigBox goes through one queue, one job at a time"
        actions={
          <>
            <Button variant="ghost" onClick={() => launch('smoke', { lora: true })}>Smoke test + LoRA</Button>
            <Button variant="ghost" onClick={() => launch('demo', { steps: 40, delay: 0.1, fail_at: 25 })}>Demo (fails)</Button>
            <Button onClick={() => launch('demo', { steps: 80, delay: 0.15 })}>Demo training</Button>
          </>
        }
      />
      <Card
        actions={
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs ${filter === f ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}
              >
                {f}
              </button>
            ))}
          </div>
        }
        title="All jobs"
      >
        {error && <div className="mb-3 text-sm text-bad">{error}</div>}
        <JobTable jobs={jobs ?? []} />
      </Card>
    </>
  )
}

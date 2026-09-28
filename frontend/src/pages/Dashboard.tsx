import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { JobTable } from '../components/JobTable'
import { ProjectBundle } from '../components/ProjectBundle'
import { PageHeader, useSystem } from '../components/Layout'
import { ProvidersPanel } from '../components/ProvidersPanel'
import { SystemPanel } from '../components/SystemPanel'
import { Button, Card } from '../components/ui'
import { usePolling } from '../hooks/usePolling'

export function Dashboard() {
  const { stats, history } = useSystem()
  const { data: jobs } = usePolling(() => api.jobs({ limit: 8 }), 3000)
  const navigate = useNavigate()

  const launch = async (kind: string, config: Record<string, unknown>) => {
    const job = await api.createJob(kind, config)
    navigate(`/jobs/${job.id}`)
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Hardware, running work, and recent runs"
        actions={
          <>
            <Button variant="ghost" onClick={() => launch('smoke', {})}>Run hardware check</Button>
            <Button onClick={() => launch('demo', { steps: 80, delay: 0.15 })}>Run demo training</Button>
          </>
        }
      />
      <div className="space-y-6">
        <SystemPanel stats={stats} history={history} />
        <ProvidersPanel />
        <Card title="Recent jobs">
          <JobTable jobs={jobs ?? []} />
        </Card>
        <ProjectBundle />
      </div>
    </>
  )
}

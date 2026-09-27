import { Link } from 'react-router-dom'
import { api, type ProviderStatus } from '../api'
import { usePolling } from '../hooks/usePolling'
import { Card } from './ui'

export function ReachBadge({ s }: { s: Pick<ProviderStatus, 'reachable' | 'version'> }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${s.reachable ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad'}`}>
      {s.reachable ? `connected${s.version ? ` · v${s.version}` : ''}` : 'unreachable'}
    </span>
  )
}

export function ModelChips({ s }: { s: ProviderStatus }) {
  if (!s.models.length) return <div className="text-sm text-muted">Connected, but no models loaded yet.</div>
  return (
    <div className="flex flex-wrap gap-2">
      {s.models.map((m) => (
        <span key={m.name} className="rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs">
          <span className="font-mono">{m.name}</span>
          <span className="ml-2 text-muted">
            {[m.embedding ? 'embeddings' : m.parameters, m.size_gb != null ? `${m.size_gb} GB` : null]
              .filter(Boolean).join(' · ')}
          </span>
        </span>
      ))}
    </div>
  )
}

export function Unreachable({ s }: { s: ProviderStatus }) {
  return (
    <div className="space-y-1 text-sm">
      <p>Can't reach <code className="font-mono text-xs">{s.provider.base_url}</code>.</p>
      {s.hint && <p className="text-muted">{s.hint}</p>}
      <p className="font-mono text-xs text-muted/70">{s.error}</p>
    </div>
  )
}

/** Dashboard summary of every enabled provider. */
export function ProvidersPanel() {
  const { data } = usePolling(api.providerStatus, 15000)
  return (
    <Card title="Model providers" actions={<Link to="/providers" className="text-xs text-accent hover:underline">Manage</Link>}>
      {!data ? (
        <div className="text-sm text-muted">Checking…</div>
      ) : (
        <div className="space-y-4">
          {data.map((s) => (
            <div key={s.provider.id}>
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-medium">{s.provider.name}</span>
                <span className="font-mono text-xs text-muted">{s.provider.slug}/</span>
                <span className="ml-auto"><ReachBadge s={s} /></span>
              </div>
              {s.reachable ? <ModelChips s={s} /> : <Unreachable s={s} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

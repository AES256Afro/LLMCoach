import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { useSystemStream } from '../hooks/streams'

type SystemStream = ReturnType<typeof useSystemStream>

const NAV: { to: string; label: string; icon: string; soon?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/jobs', label: 'Jobs', icon: '▶' },
  { to: '/knowledge', label: 'Knowledge Base', icon: '▤', soon: true },
  { to: '/datasets', label: 'Datasets', icon: '▦', soon: true },
  { to: '/train', label: 'Train', icon: '◭', soon: true },
  { to: '/playground', label: 'Playground', icon: '◌', soon: true },
  { to: '/compare', label: 'Compare', icon: '⇄', soon: true },
  { to: '/logs', label: 'Logs', icon: '≡' },
]

export function Layout() {
  const system = useSystemStream()
  const { stats, connected } = system
  const gpu = stats?.gpus[0]

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-5 py-4">
          <div className="text-lg font-semibold tracking-tight">LLMCoach</div>
          <div className="text-xs text-muted">RAG + fine-tuning workbench</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
                  isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text'
                }`
              }
            >
              <span className="w-4 text-center">{n.icon}</span>
              {n.label}
              {n.soon && <span className="ml-auto text-[10px] uppercase tracking-wide text-muted/60">soon</span>}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-bad'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
          {gpu ? (
            <div className="truncate" title={gpu.name}>
              GPU {gpu.util_pct?.toFixed(0) ?? '—'}% · {gpu.vram_used_gb?.toFixed(1) ?? '—'}/{gpu.vram_total_gb?.toFixed(0)} GB
            </div>
          ) : (
            stats && <div>CPU {stats.cpu_pct.toFixed(0)}% · no GPU</div>
          )}
          {stats?.running_job_id != null && (
            <NavLink to={`/jobs/${stats.running_job_id}`} className="block text-accent hover:underline">
              ▶ Job #{stats.running_job_id} running
            </NavLink>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-6">
          <Outlet context={system} />
        </div>
      </main>
    </div>
  )
}

export const useSystem = () => useOutletContext<SystemStream>()

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="ml-auto flex gap-2">{actions}</div>
    </div>
  )
}

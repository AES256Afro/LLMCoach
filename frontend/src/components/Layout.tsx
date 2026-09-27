import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom'
import { useSystemStream } from '../hooks/streams'
import { useAuth } from './AuthGate'
import { ProjectSwitcher } from './ProjectSwitcher'
import { StudioSwitcher } from '../studios/StudioSwitcher'

type SystemStream = ReturnType<typeof useSystemStream>

const NAV: { to: string; label: string; icon: string; soon?: boolean }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '◧' },
  { to: '/jobs', label: 'Jobs', icon: '▶' },
  { to: '/knowledge', label: 'Knowledge Base', icon: '▤' },
  { to: '/datasets', label: 'Datasets', icon: '▦' },
  { to: '/train', label: 'Train', icon: '◭' },
  { to: '/playground', label: 'Playground', icon: '◌' },
  { to: '/compare', label: 'Compare', icon: '⇄' },
  { to: '/providers', label: 'Providers', icon: '⌬' },
  { to: '/logs', label: 'Logs', icon: '≡' },
]

/** The Classic studio: every page and setting in one dashboard. */
export function Layout() {
  const system = useSystemStream()
  const { stats, connected } = system
  const gpu = stats?.gpus[0]
  const auth = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  // Close the mobile menu after navigating.
  useEffect(() => setMenuOpen(false), [location.pathname])

  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5 md:hidden">
        <button onClick={() => setMenuOpen(true)} aria-label="Open menu" className="text-lg text-muted">☰</button>
        <span className="font-semibold tracking-tight">LLMCoach</span>
        <span className={`ml-auto h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-bad'}`} />
      </header>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMenuOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel transition-transform md:static md:w-56 md:translate-x-0 ${
        menuOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <StudioSwitcher current="classic" className="px-3 py-3">
          <span className="flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-panel-2">
            <span className="min-w-0">
              <span className="block text-lg font-semibold tracking-tight">LLMCoach</span>
              <span className="block text-xs text-muted">Classic studio · switch ▾</span>
            </span>
          </span>
        </StudioSwitcher>
        <ProjectSwitcher />
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
          {auth?.state.user && (
            <button onClick={auth.signOut} className="block pt-1 hover:text-text">
              Sign out ({auth.state.user})
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-4 py-5 md:p-6">
          <Outlet context={system} />
        </div>
      </main>
    </div>
  )
}

export const useSystem = () => useOutletContext<SystemStream>()

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="ml-auto flex flex-wrap gap-2">{actions}</div>
    </div>
  )
}

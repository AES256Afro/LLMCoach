import '@fontsource-variable/jetbrains-mono'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type EvalRun, type FineTune, type Job, type ProviderStatus } from '../../api'
import { useProject } from '../../hooks/project'
import { usePolling } from '../../hooks/usePolling'
import { useSystemStream } from '../../hooks/streams'
import { StudioSwitcher } from '../StudioSwitcher'
import { rememberStudio } from '../registry'
import { gb } from './tiles'
import { AlertsView, ChatView, DataView, EvalView, KnowView, LogsView, ModelsView, TrainView, WallView, type Mission } from './views'

const VIEWS = [
  { id: 'chat', key: 'F1', label: 'CHAT' },
  { id: 'know', key: 'F2', label: 'KNOW' },
  { id: 'data', key: 'F3', label: 'DATA' },
  { id: 'train', key: 'F4', label: 'TRAIN' },
  { id: 'eval', key: 'F5', label: 'EVAL' },
  { id: 'logs', key: 'F6', label: 'LOGS' },
  { id: 'models', key: 'F7', label: 'MODELS' },
  { id: 'alerts', key: 'F8', label: 'ALERTS' },
  { id: 'wall', key: 'F9', label: 'WALL' },
] as const
type ViewId = (typeof VIEWS)[number]['id']

function stored(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === '1' } catch { return fallback }
}
function store(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* private window */ }
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t) }, [])
  const p = (n: number) => String(n).padStart(2, '0')
  return <span className="ml-auto mc-am tabular-nums">{now.getFullYear()}-{p(now.getMonth() + 1)}-{p(now.getDate())} {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>
}

export default function MissionStudio() {
  const { current: project, projects, select } = useProject()
  const navigate = useNavigate()
  const params = useParams()
  const view: ViewId = VIEWS.some((v) => v.id === params.view) ? (params.view as ViewId) : 'chat'
  const [lastView, setLastView] = useState<ViewId>('train')
  const [contrast, setContrastState] = useState(() => stored('llmcoach.mission.contrast', false))
  const [scanlines, setScanlinesState] = useState(() => stored('llmcoach.mission.scanlines', true))
  const setContrast = (v: boolean) => { setContrastState(v); store('llmcoach.mission.contrast', v) }
  const setScanlines = (v: boolean) => { setScanlinesState(v); store('llmcoach.mission.scanlines', v) }
  const { stats, logs: appLogs, connected } = useSystemStream()
  const pid = project?.id
  const { data: jobs } = usePolling<Job[]>(() => (pid ? api.jobs({ limit: 30, project_id: pid }) : Promise.resolve([])), 3000, [pid])
  const { data: providers } = usePolling<ProviderStatus[]>(api.providerStatus, 15000)
  const { data: finetunes } = usePolling<FineTune[]>(() => (pid ? api.finetunes(pid) : Promise.resolve([])), 8000, [pid])
  const { data: evals } = usePolling<EvalRun[]>(() => (pid ? api.evals(pid) : Promise.resolve([])), 8000, [pid])
  const wall = view === 'wall'

  useEffect(() => rememberStudio('mission'), [])
  useEffect(() => { if (!wall) setLastView(view) }, [view, wall])

  const go = (id: ViewId) => navigate(id === 'chat' ? '/console' : `/console/${id}`)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable
      const f = /^F([1-9])$/.exec(e.key)
      if (f) {
        e.preventDefault() // F5 would reload, F1 opens help
        go(VIEWS[Number(f[1]) - 1].id)
        return
      }
      if (e.key === 'Escape' && wall) { go(lastView); return }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      if (/^[1-9]$/.test(e.key)) go(VIEWS[Number(e.key) - 1].id)
      else if (e.key === 'w' || e.key === 'W') go(wall ? lastView : 'wall')
      else if (e.key === 'c' || e.key === 'C') setContrast(!contrast)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall, lastView, contrast])

  if (!project) return <div className="studio-mission grid h-full place-items-center">LOADING…</div>

  const m: Mission = {
    project, stats, appLogs, jobs: jobs ?? [], providers, finetunes: finetunes ?? [], evals: evals ?? [],
    wall, contrast, setContrast, scanlines, setScanlines,
  }
  const ollama = providers?.find((p) => p.provider.slug === 'ollama')
  const gpu = stats?.gpus[0]
  const nextProject = () => {
    if (projects.length < 2) return
    const i = projects.findIndex((p) => p.id === project.id)
    select(projects[(i + 1) % projects.length].id)
  }

  return (
    <div className={`studio-mission relative flex h-full flex-col ${contrast ? 'mc-contrast' : ''} ${wall ? 'mc-wall' : ''}`}>
      <header className="mc-hdr">
        <StudioSwitcher current="mission"><b className="cursor-pointer">LLMCOACH</b></StudioSwitcher>
        <button type="button" onClick={nextProject} className="uppercase hover:text-[var(--mc-hi)]" title={projects.length > 1 ? 'Next project' : undefined}>
          PROJECT: {project.name}{projects.length > 1 ? ' ▸' : ''}
        </button>
        <span className={ollama?.reachable ? 'mc-ok' : 'mc-bad'}>{ollama ? (ollama.reachable ? '● OLLAMA LINK' : '× OLLAMA DOWN') : '○ OLLAMA'}</span>
        <span className={connected ? '' : 'mc-bad'}>{connected ? '' : '× STREAM '}CPU {stats ? `${stats.cpu_pct.toFixed(0)}%` : '—'}</span>
        <span>RAM {stats ? `${stats.ram_used_gb.toFixed(1)}/${stats.ram_total_gb.toFixed(0)}G` : '—'}</span>
        <span>GPU {gpu ? `${gpu.util_pct?.toFixed(0) ?? '—'}% ${gb(gpu.vram_used_gb)}${gpu.temp_c != null ? ` ${gpu.temp_c.toFixed(0)}°C` : ''}${gpu.power_w != null ? ` ${gpu.power_w.toFixed(0)}W` : ''}` : '—'}</span>
        {wall && <span className="mc-am">WALL · READ ONLY · ESC</span>}
        <Clock />
      </header>

      {view === 'chat' && <ChatView m={m} />}
      {view === 'know' && <KnowView m={m} />}
      {view === 'data' && <DataView m={m} />}
      {view === 'train' && <TrainView m={m} />}
      {view === 'eval' && <EvalView m={m} />}
      {view === 'logs' && <LogsView m={m} />}
      {view === 'models' && <ModelsView m={m} />}
      {view === 'alerts' && <AlertsView m={m} />}
      {view === 'wall' && <WallView m={m} />}

      <nav className="mc-keys" aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" aria-current={view === v.id ? 'page' : undefined} onClick={() => go(v.id)}><b>{v.key}</b>{v.label}</button>
        ))}
      </nav>
      {scanlines && <div className="mc-scan" aria-hidden="true" />}
    </div>
  )
}

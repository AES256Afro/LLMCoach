import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './workbench.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronDown, ChevronRight, Cpu, FileText, FlaskConical, FolderInput, FolderTree, LayoutGrid, MessagesSquare, PanelBottom,
  Play, Plus, Search, Settings, Table2, TerminalSquare, Zap,
} from 'lucide-react'
import { api, uploadDocuments, type Conversation, type Job, type KBDocument, type PipelineGraph, type ProviderStatus } from '../../api'
import { useProject } from '../../hooks/project'
import { usePolling } from '../../hooks/usePolling'
import { useJobStream, useSystemStream } from '../../hooks/streams'
import { STUDIOS, rememberStudio } from '../registry'
import { StudioSwitcher } from '../StudioSwitcher'
import { ChatTab, DatasetTab, DocTab, EvalTab, FinetuneTab, JobTab, LogLines, NewFinetuneTab, WelcomeTab, type TabProps } from './tabs'

type Icon = typeof FileText
interface PaletteItem { id: string; group: string; label: string; hint?: string; icon: Icon; keys?: string; run: () => void }

const CLASSIC_PAGES: [string, string][] = [
  ['Dashboard', '/dashboard'], ['Jobs', '/jobs'], ['Knowledge Base', '/knowledge'], ['Inbox', '/inbox'], ['Learning loop', '/inbox?tab=loop'],
  ['API tokens', '/inbox?tab=tokens'], ['Datasets', '/datasets'], ['Train', '/train'], ['Playground', '/playground'], ['Compare', '/compare'],
  ['Providers', '/providers'], ['Logs', '/logs'],
]

function loadTabs(pid: number | undefined): { tabs: string[]; active: string } {
  try {
    const v = JSON.parse(localStorage.getItem(`llmcoach.workbench.${pid}`) ?? 'null')
    if (v && Array.isArray(v.tabs) && v.tabs.length) return v
  } catch { /* unavailable */ }
  return { tabs: ['welcome'], active: 'welcome' }
}

export default function WorkbenchStudio() {
  const { current: project, projects, select } = useProject()
  const pid = project?.id
  const navigate = useNavigate()
  const { data: g, reload } = usePolling<PipelineGraph | null>(() => (pid ? api.pipeline(pid) : Promise.resolve(null)), 5000, [pid])
  const { data: docs } = usePolling<KBDocument[]>(() => (pid ? api.documents(pid) : Promise.resolve([])), 10000, [pid])
  const { data: convs } = usePolling<Conversation[]>(() => (pid ? api.conversations(pid) : Promise.resolve([])), 8000, [pid])
  const { data: jobs } = usePolling<Job[]>(() => (pid ? api.jobs({ limit: 25, project_id: pid }) : Promise.resolve([])), 4000, [pid])
  const { data: providers } = usePolling<ProviderStatus[]>(api.providerStatus, 20000)
  const { stats, logs } = useSystemStream()
  const [{ tabs, active }, setTabState] = useState(() => loadTabs(pid))
  const narrow = () => window.matchMedia('(max-width: 899px)').matches
  // On a phone the explorer is an overlay: closed until asked for, and it gets out of the way after a pick.
  const [treeOpen, setTreeOpen] = useState(() => !narrow())
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<'logs' | 'jobs' | 'output'>('logs')
  const [outputJob, setOutputJob] = useState<number | null>(null)
  const [palette, setPalette] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => rememberStudio('workbench'), [])
  useEffect(() => {
    const state = loadTabs(pid)
    // ?open=finetune:3 opens that tab: links from elsewhere land on the object itself.
    const deep = new URLSearchParams(window.location.search).get('open')
    if (deep && /^(chat|doc|dataset|finetune|eval|job|new-finetune):[\w-]*$/.test(deep)) {
      state.tabs = state.tabs.includes(deep) ? state.tabs : [...state.tabs.filter((t) => t !== 'welcome'), deep]
      state.active = deep
    }
    setTabState(state)
  }, [pid])
  useEffect(() => {
    try { localStorage.setItem(`llmcoach.workbench.${pid}`, JSON.stringify({ tabs, active })) } catch { /* unavailable */ }
  }, [pid, tabs, active])
  useEffect(() => { if (!note) return; const t = window.setTimeout(() => setNote(null), 6000); return () => window.clearTimeout(t) }, [note])

  const open = useCallback((key: string) => {
    if (narrow()) setTreeOpen(false)
    setTabState((s) => ({ tabs: s.tabs.includes(key) ? s.tabs : [...s.tabs.filter((t) => t !== 'welcome'), key], active: key }))
  }, [])
  const close = useCallback((key: string) => setTabState((s) => {
    const i = s.tabs.indexOf(key)
    const rest = s.tabs.filter((t) => t !== key)
    const tabsLeft = rest.length ? rest : ['welcome']
    return { tabs: tabsLeft, active: s.active === key ? tabsLeft[Math.max(0, i - 1)] ?? tabsLeft[0] : s.active }
  }), [])
  const rename = useCallback((from: string, to: string) => setTabState((s) => ({
    tabs: [...new Set(s.tabs.map((t) => (t === from ? to : t)))], active: s.active === from ? to : s.active,
  })), [])
  const cycle = useCallback((d: number) => setTabState((s) => ({ ...s, active: s.tabs[(s.tabs.indexOf(s.active) + d + s.tabs.length) % s.tabs.length] })), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'p')) { e.preventDefault(); setPalette((p) => !p) }
      else if (e.ctrlKey && (k === '`' || e.code === 'Backquote')) { e.preventDefault(); setPanelOpen((p) => !p) }
      else if (e.ctrlKey && k === 'b') { e.preventDefault(); setTreeOpen((p) => !p) }
      else if (e.altKey && k === 'w') { e.preventDefault(); close(active) }
      else if (e.altKey && (e.key === '[' || e.key === ']')) { e.preventDefault(); cycle(e.key === ']' ? 1 : -1) }
      else if (e.key === 'Escape') setPalette(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, close, cycle])

  const say = useCallback((m: string) => { setNote(m); reload() }, [reload])
  const upload = async (files: File[]) => {
    if (!pid || !files.length) return
    try { const r = await uploadDocuments(pid, files, () => {}); say(`added ${r.documents.length} document(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`) } catch (e) { say(String(e)) }
  }

  const title = (key: string): [Icon, string] => {
    const [kind, arg] = key.split(':')
    const id = Number(arg)
    if (kind === 'chat') return [MessagesSquare, arg === 'new' ? 'new chat' : convs?.find((c) => c.id === id)?.title ?? `chat #${arg}`]
    if (kind === 'doc') return [FileText, docs?.find((d) => d.id === id)?.filename ?? `document #${arg}`]
    if (kind === 'dataset') return [Table2, g?.datasets.find((d) => d.id === id)?.name ?? `dataset #${arg}`]
    if (kind === 'finetune') return [Zap, g?.finetunes.find((f) => f.id === id)?.name ?? `fine-tune #${arg}`]
    if (kind === 'eval') return [FlaskConical, g?.evals.find((e) => e.id === id)?.name ?? `eval #${arg}`]
    if (kind === 'job') return [Play, `#${arg} ${jobs?.find((j) => j.id === id)?.kind ?? 'job'}`]
    if (kind === 'new-finetune') return [Plus, 'new fine-tune']
    return [LayoutGrid, 'welcome']
  }

  const items = useMemo<PaletteItem[]>(() => {
    if (!g) return []
    const out: PaletteItem[] = []
    const add = (it: Omit<PaletteItem, 'id'>) => out.push({ ...it, id: `${it.group}:${it.label}` })
    add({ group: 'Chat', label: 'New chat', icon: MessagesSquare, run: () => open('chat:new') })
    add({ group: 'Train', label: 'New fine-tune from a dataset…', icon: Zap, keys: 'settings as code', run: () => open('new-finetune:') })
    add({ group: 'Knowledge', label: 'Upload documents…', icon: FileText, run: () => fileInput.current?.click() })
    add({ group: 'Datasets', label: 'Generate Q&A from the knowledge base', icon: Table2, run: async () => {
      try { const ms = await api.models('chat'); const m = [...ms].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref; if (!m) return say('no chat model')
        const r = await api.generateDataset(g.project.id, { model: m, pairs_per_chunk: 3, max_chunks: 20, style: 'closed', val: 0.1, test: 0.1 }); say(`generating into ${r.dataset.name} (job #${r.job.id})`); open(`dataset:${r.dataset.id}`) } catch (e) { say(String(e)) } } })
    add({ group: 'Pipeline', label: 'Run pipeline: look at folders, index, learn, retrain if changed', icon: Play, run: async () => { try { const r = await api.runPipeline(g.project.id); say(r.waiting ? 'pipeline waiting for indexing and Q&A' : r.run?.reason ?? `loop run #${r.run?.id}`) } catch (e) { say(String(e)) } } })
    add({ group: 'Learning loop', label: 'Run now', icon: Play, run: async () => { try { const r = await api.runLoop(g.project.id); say(`loop run #${r.id}: ${r.reason ?? r.status}`) } catch (e) { say(String(e)) } } })
    add({ group: 'Inbox', label: 'Look at every watched folder now', icon: FolderInput, run: async () => { for (const s of g.sources) await api.scanSource(g.project.id, s.id).catch(() => {}); say(`looked at ${g.sources.length} folder(s)`) } })
    add({ group: 'Alerts', label: 'Send a test alert', icon: TerminalSquare, run: async () => { try { await api.testNotify(); say('test alert sent') } catch (e) { say(String(e)) } } })
    add({ group: 'View', label: 'Toggle bottom panel', icon: PanelBottom, keys: 'Ctrl `', run: () => setPanelOpen((p) => !p) })
    add({ group: 'View', label: 'Toggle explorer', icon: FolderTree, keys: 'Ctrl B', run: () => setTreeOpen((p) => !p) })
    for (const d of docs ?? []) add({ group: 'Document', label: d.filename, hint: `${d.chunk_count} chunks`, icon: FileText, run: () => open(`doc:${d.id}`) })
    for (const d of g.datasets) add({ group: 'Dataset', label: d.name, hint: `${d.rows} rows`, icon: Table2, run: () => open(`dataset:${d.id}`) })
    for (const f of g.finetunes) add({ group: 'Fine-tune', label: f.name, hint: f.status, icon: Zap, run: () => open(`finetune:${f.id}`) })
    for (const e of g.evals) add({ group: 'Evaluation', label: e.name, hint: e.status, icon: FlaskConical, run: () => open(`eval:${e.id}`) })
    for (const c of convs ?? []) add({ group: 'Chat', label: c.title, icon: MessagesSquare, run: () => open(`chat:${c.id}`) })
    for (const j of jobs ?? []) add({ group: 'Job', label: `#${j.id} ${j.kind}`, hint: j.status, icon: Play, run: () => open(`job:${j.id}`) })
    for (const s of STUDIOS.filter((x) => x.status === 'ready' && x.id !== 'workbench')) add({ group: 'Studio', label: `Switch to ${s.name}`, icon: LayoutGrid, run: () => { rememberStudio(s.id); navigate(s.path) } })
    for (const [label, path] of CLASSIC_PAGES) add({ group: 'Classic', label, icon: Settings, run: () => navigate(path) })
    return out
  }, [g, docs, convs, jobs, open, navigate, say])

  if (!project || !g) return <div className="studio-workbench grid h-full place-items-center wb-mono">loading workspace…</div>

  const ollama = providers?.find((p) => p.provider.slug === 'ollama')
  const gpu = stats?.gpus[0]
  const running = jobs?.find((j) => j.status === 'running')
  const tabProps: TabProps = { g, open, rename, setOutput: setOutputJob, say }
  const [, arg] = active.split(/:(.*)/)
  const kind = active.split(':')[0]
  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))
  const group = (k: string, label: string, children: ReactNode) => (
    <div className="wb-g">
      <button className="wb-gh" onClick={() => toggle(k)}>{collapsed[k] ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{label}</button>
      {!collapsed[k] && children}
    </div>
  )
  const row = (key: string, icon: ReactNode, label: string, n?: ReactNode, cls = '') => (
    <button key={key} className={`wb-r ${active === key ? 'sel' : ''}`} onClick={() => open(key)} title={label}>{icon}<span>{label}</span>{n != null && <span className={`n ${cls}`}>{n}</span>}</button>
  )
  const stClass = (s: string) => (['done', 'ready'].includes(s) ? 'okc' : ['failed', 'cancelled'].includes(s) ? 'badc' : 'runc')

  return (
    <div className="studio-workbench flex h-full flex-col">
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      <header className="wb-title">
        <StudioSwitcher current="workbench"><span className="brand">LLMCoach</span></StudioSwitcher>
        <button className="wb-cmd" onClick={() => setPalette(true)}><Search className="h-3.5 w-3.5" />Search chats, docs, runs or run a command<kbd>Ctrl K</kbd></button>
        <select className="wb-proj" value={project.id} onChange={(e) => select(Number(e.target.value))} aria-label="Project">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </header>
      <div className="wb-body">
        <nav className="wb-act" aria-label="Activity">
          <button aria-pressed={treeOpen} onClick={() => setTreeOpen((t) => !t)} title="Explorer (Ctrl B)"><FolderTree className="h-5 w-5" /></button>
          <button onClick={() => setPalette(true)} title="Go to anything (Ctrl K)"><Search className="h-5 w-5" /></button>
          <button onClick={() => open('new-finetune:')} title="New fine-tune"><Zap className="h-5 w-5" /></button>
          <button onClick={() => { const e = [...g.evals].reverse()[0]; if (e) open(`eval:${e.id}`) }} title="Latest evaluation"><FlaskConical className="h-5 w-5" /></button>
          <button aria-pressed={panelOpen} onClick={() => setPanelOpen((p) => !p)} title="Panel (Ctrl `)"><PanelBottom className="h-5 w-5" /></button>
          <button className="last" onClick={() => navigate('/providers')} title="Providers and settings (Classic)"><Settings className="h-5 w-5" /></button>
        </nav>
        {treeOpen && (
          <aside className="wb-tree open" aria-label="Explorer">
            <h6>explorer · {project.name}</h6>
            {group('kb', 'knowledge base', (docs ?? []).map((d) => row(`doc:${d.id}`, <FileText />, d.filename, d.status === 'ready' ? d.chunk_count : d.status, d.status === 'ready' ? '' : stClass(d.status))))}
            {g.sources.length > 0 && group('src', 'watched folders', g.sources.map((s) => (
              <button key={s.id} className="wb-r" onClick={() => navigate('/inbox')} title={s.path}><FolderInput /><span>{s.name}</span><span className="n">{s.counts.added ?? 0}</span></button>
            )))}
            {group('ds', 'datasets', g.datasets.map((d) => row(`dataset:${d.id}`, <Table2 />, d.name, d.splits ? `${d.splits.train}/${d.splits.val}/${d.splits.test}` : d.status)))}
            {group('ft', 'fine-tunes', <>
              {[...g.finetunes].reverse().map((f) => row(`finetune:${f.id}`, <Zap />, f.name, f.promoted_at ? '★' : f.status === 'ready' ? 'done' : f.status, f.promoted_at ? 'okc' : stClass(f.status)))}
              <button className="wb-r" onClick={() => open('new-finetune:')}><Plus /><span className="text-[var(--mu)]">New fine-tune</span></button>
            </>)}
            {group('ev', 'evaluations', [...g.evals].reverse().map((e) => row(`eval:${e.id}`, <FlaskConical />, e.name, `${e.variants?.length ?? 0} variants`)))}
            {group('chat', 'chats', <>
              {(convs ?? []).slice(0, 15).map((c) => row(`chat:${c.id}`, <MessagesSquare />, c.title))}
              <button className="wb-r" onClick={() => open('chat:new')}><Plus /><span className="text-[var(--mu)]">New chat</span></button>
            </>)}
            {group('jobs', 'jobs', (jobs ?? []).slice(0, 10).map((j) => row(`job:${j.id}`, <Play />, `#${j.id} ${j.kind}`, j.status, stClass(j.status))))}
            {providers?.map((p) => group(`m-${p.provider.id}`, `models · ${p.provider.name}`, p.models.map((m) => (
              <div key={m.name} className="wb-r cursor-default" title={m.name}><Cpu /><span>{m.name}</span><span className="n">{m.embedding ? 'embed' : m.parameters ?? ''}</span></div>
            ))))}
          </aside>
        )}
        <div className="wb-main">
          <div className="wb-tabs" role="tablist">
            {tabs.map((t) => {
              const [I, label] = title(t)
              return (
                <div key={t} role="tab" aria-selected={t === active} className={`wb-tab ${t === active ? 'on' : ''}`} onClick={() => setTabState((s) => ({ ...s, active: t }))}
                     onAuxClick={(e) => { if (e.button === 1) close(t) }}>
                  <I /><span>{label}</span>
                  <button className="x" aria-label={`Close ${label}`} onClick={(e) => { e.stopPropagation(); close(t) }}>✕</button>
                </div>
              )
            })}
          </div>
          <div className="flex min-h-0 flex-1 flex-col" key={active}>
            {kind === 'welcome' && <WelcomeTab />}
            {kind === 'chat' && <ChatTab {...tabProps} id={arg} />}
            {kind === 'doc' && <DocTab {...tabProps} id={Number(arg)} />}
            {kind === 'dataset' && <DatasetTab {...tabProps} id={Number(arg)} />}
            {kind === 'finetune' && <FinetuneTab {...tabProps} id={Number(arg)} />}
            {kind === 'eval' && <EvalTab {...tabProps} id={Number(arg)} />}
            {kind === 'job' && <JobTab {...tabProps} id={Number(arg)} />}
            {kind === 'new-finetune' && <NewFinetuneTab {...tabProps} arg={arg ?? ''} />}
          </div>
          {panelOpen && <BottomPanel tab={panelTab} setTab={setPanelTab} logs={logs} jobs={jobs ?? []} outputJob={outputJob ?? running?.id ?? null} openJob={(id) => open(`job:${id}`)} />}
        </div>
      </div>
      <footer className="wb-status">
        <span><span className="dot" style={{ background: ollama?.reachable ? 'var(--ok)' : 'var(--bad)' }} />Ollama</span>
        <span>CPU {stats ? `${stats.cpu_pct.toFixed(0)}%` : '—'}</span>
        <span>RAM {stats ? `${stats.ram_used_gb.toFixed(1)} / ${stats.ram_total_gb.toFixed(0)} GB` : '—'}</span>
        <span>{gpu ? `${gpu.name} ${gpu.util_pct?.toFixed(0) ?? '—'}%` : 'no GPU'}</span>
        {note && <span className="text-[#fff]">{note}</span>}
        <span className="r"><span>{running ? `job #${running.id} ${running.kind} running` : 'idle'}</span><span>Ctrl ` panel</span></span>
      </footer>
      {palette && <Palette items={items} onClose={() => setPalette(false)} />}
    </div>
  )
}

function BottomPanel({ tab, setTab, logs, jobs, outputJob, openJob }: {
  tab: 'logs' | 'jobs' | 'output'; setTab: (t: 'logs' | 'jobs' | 'output') => void
  logs: { ts: number; level: string; logger: string; message: string }[]; jobs: Job[]; outputJob: number | null; openJob: (id: number) => void
}) {
  const { lines } = useJobStream(tab === 'output' ? outputJob : null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const el = ref.current?.querySelector('.wb-lines'); if (el) el.scrollTop = el.scrollHeight }, [logs.length, lines.length, tab])
  return (
    <div className="wb-panel" ref={ref}>
      <div className="wb-ptabs" role="tablist">
        {(['logs', 'jobs', 'output'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'output' ? `OUTPUT${outputJob ? ` · JOB #${outputJob}` : ''}` : t.toUpperCase()}</button>)}
        <span className="r wb-mono">{tab === 'logs' ? 'server' : tab === 'output' ? '▾ follow' : ''}</span>
      </div>
      {tab === 'logs' && (
        <div className="wb-lines">
          {logs.slice(-300).map((l, i) => (
            <div key={i}><span className="t">{new Date(l.ts * 1000).toLocaleTimeString([], { hour12: false })}</span> <span className={l.level === 'ERROR' ? 'bad' : l.level === 'WARNING' ? 'am' : 'inf'}>{l.level.padEnd(7)}</span> {l.logger.split('.').pop()?.padEnd(8)} {l.message}</div>
          ))}
        </div>
      )}
      {tab === 'jobs' && (
        <div className="wb-lines">
          {jobs.map((j) => (
            <button key={j.id} onClick={() => openJob(j.id)} className="block w-full text-left hover:text-[var(--tx)]">
              <span className="t">#{String(j.id).padEnd(4)}</span> {j.kind.padEnd(9)} <span className={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'am'}>{j.status}</span>
            </button>
          ))}
        </div>
      )}
      {tab === 'output' && <LogLines lines={lines} empty={outputJob ? 'waiting for output' : 'open a fine-tune, evaluation or job to see its output here'} />}
    </div>
  )
}

function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const ql = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!ql) return items.filter((it) => !['Document', 'Job', 'Classic'].includes(it.group)).slice(0, 40)
    const words = ql.split(/\s+/)
    return items.filter((it) => { const hay = `${it.group} ${it.label} ${it.hint ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)) }).slice(0, 60)
  }, [items, ql])
  useEffect(() => setI(0), [ql])
  const run = (it: PaletteItem) => { onClose(); it.run() }
  const mark = (text: string) => {
    if (!ql) return text
    const w = ql.split(/\s+/)[0]
    const at = text.toLowerCase().indexOf(w)
    return at < 0 ? text : <>{text.slice(0, at)}<b>{text.slice(at, at + w.length)}</b>{text.slice(at + w.length)}</>
  }
  let lastGroup = ''
  return (
    <div className="wb-pal-back" onMouseDown={onClose}>
      <div className="wb-pal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Go to anything">
        <div className="in">
          <span className="wb-mono text-[var(--ac)]">›</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="type a name, or a command like train, chat, upload, studio"
                 onKeyDown={(e) => {
                   if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, matches.length - 1)) }
                   else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
                   else if (e.key === 'Enter' && matches[i]) { e.preventDefault(); run(matches[i]) }
                   else if (e.key === 'Escape') onClose()
                 }} />
        </div>
        <div className="list">
          {matches.map((it, k) => {
            const head = it.group !== lastGroup ? <div className="grp">{it.group}</div> : null
            lastGroup = it.group
            return (
              <div key={it.id}>
                {head}
                <button className={`it ${k === i ? 'on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => run(it)}>
                  <it.icon /><span>{mark(it.label)}{it.hint && <em> · {it.hint}</em>}</span>{it.keys && <kbd>{it.keys}</kbd>}
                </button>
              </div>
            )
          })}
          {!matches.length && <div className="grp">nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  )
}

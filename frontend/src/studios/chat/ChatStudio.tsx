import '@fontsource-variable/geist'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  BookOpen, Brain, Library, ListChecks, LogOut, Menu, MessagesSquare, PanelRight, Plus, Search, SlidersHorizontal, Trash2, X,
} from 'lucide-react'
import { api, ownModel, type AttachMode } from '../../api'
import { useAuth } from '../../components/AuthGate'
import { ProjectSwitcher } from '../../components/ProjectSwitcher'
import { useProject } from '../../hooks/project'
import { StudioSwitcher } from '../StudioSwitcher'
import { rememberStudio } from '../registry'
import { runCommand, type CommandContext } from './commands'
import { Composer, type Staged } from './Composer'
import { ContextRail } from './ContextRail'
import { Thread, type SelectedSource } from './Thread'
import { useChatSession } from './useChatSession'

export default function ChatStudio() {
  const { current: project } = useProject()
  const auth = useAuth()
  const navigate = useNavigate()
  const session = useChatSession(project)
  const { active, settings, setSettings } = session
  const [historyOpen, setHistoryOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(() => window.matchMedia('(min-width: 1280px)').matches)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [staged, setStaged] = useState<Staged>({ files: [], mode: 'remember' })
  const [selected, setSelected] = useState<SelectedSource | null>(null)
  const [kbChunks, setKbChunks] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [focusKey, setFocusKey] = useState(0)
  const [filter, setFilter] = useState('')
  const dragDepth = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const pickMode = useRef<'remember' | 'learn'>('remember')
  const pid = project?.id

  useEffect(() => rememberStudio('chat'), [])
  useEffect(() => {
    const model = new URLSearchParams(window.location.search).get('model')
    if (model) setSettings((s) => ({ ...s, model }))
  }, [setSettings])

  // ---- URL <-> conversation ------------------------------------------------------------------
  const params = useParams()
  const paramId = params.conversationId ? Number(params.conversationId) : null
  const synced = useRef<number | null>(null)
  useEffect(() => {
    if (paramId === synced.current) return
    synced.current = paramId
    if (paramId == null) { if (active) session.newChat() } else if (paramId !== active?.id) session.open(paramId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId])
  useEffect(() => {
    const id = active?.id ?? null
    if (id === synced.current) return
    synced.current = id
    navigate(id == null ? '/chat' : `/chat/${id}`, { replace: id != null && paramId == null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])
  useEffect(() => setSelected(null), [active?.id])

  // ---- knowledge size (for the chip and the empty state) ---------------------------------------
  useEffect(() => {
    if (pid == null) return
    let alive = true
    const load = () => api.knowledge(pid).then((k) => alive && setKbChunks(k.chunks)).catch(() => {})
    load()
    const t = window.setInterval(load, 8000)
    return () => { alive = false; window.clearInterval(t) }
  }, [pid, refreshKey])

  // Same rule as the server's default_chat_model: the smallest chat model, which is the
  // sensible pick on a CPU-only box.
  const [fallbackModel, setFallbackModel] = useState<string | null>(null)
  useEffect(() => {
    api.models('chat').then((ms) => {
      const sorted = [...ms].sort((a, b) => Number(ownModel(a.ref)) - Number(ownModel(b.ref)) || (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))
      setFallbackModel(sorted[0]?.ref ?? null)
    }).catch(() => {})
  }, [])
  const effectiveModel = settings.model ?? active?.model ?? project?.settings.chat_model ?? fallbackModel
  const chatModel = useCallback(async () => effectiveModel, [effectiveModel])

  const pickFiles = useCallback((mode: 'remember' | 'learn') => {
    pickMode.current = mode
    picker.current?.click()
  }, [])

  const onCommand = useCallback((name: string, args = '') => {
    if (!project) return
    const ctx: CommandContext = { project, session, chatModel, kbChunks, pickFiles, goClassic: () => { rememberStudio('classic'); navigate('/') } }
    runCommand(ctx, name, args).finally(() => setRefreshKey((k) => k + 1))
  }, [project, session, chatModel, kbChunks, pickFiles, navigate])

  const attach = useCallback((files: File[], mode: AttachMode, question = '') => {
    session.attach(files, mode, question).finally(() => setRefreshKey((k) => k + 1))
  }, [session])

  // ---- drag and drop anywhere --------------------------------------------------------------------
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragging(false)
  }
  const dropTo = (mode: AttachMode | 'stage') => (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    if (mode === 'stage') {
      setStaged((s) => ({ ...s, files: [...s.files, ...files] }))
      setFocusKey((k) => k + 1)
    } else {
      attach(files, mode)
    }
  }

  // "/" from anywhere that isn't a text field moves focus to the composer; the keystroke then
  // lands there and opens the command menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) {
        document.getElementById('chat-composer')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const lastQuestion = useMemo(() => {
    const users = (active?.messages ?? []).filter((m) => m.role === 'user')
    return session.pending?.question ?? users[users.length - 1]?.content ?? ''
  }, [active?.messages, session.pending?.question])

  const conversations = session.conversations.filter((c) => !filter || c.title.toLowerCase().includes(filter.toLowerCase()))

  if (!project || pid == null) {
    return <div className="studio-chat grid h-full place-items-center text-sm text-muted">Loading…</div>
  }

  const railButton = (label: string, icon: React.ReactNode, onClick: () => void, on = false) => (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={on}
            className={`grid h-9 w-9 place-items-center rounded-[10px] ${on ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2 hover:text-text'}`}>
      {icon}
    </button>
  )

  const history = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-line px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search chats" aria-label="Search chats"
                 className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
        </div>
        <button type="button" onClick={() => setHistoryOpen(false)} className="text-muted hover:text-text md:hidden" aria-label="Close"><X className="h-5 w-5" /></button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {conversations.map((c) => (
          <div key={c.id} className={`group flex items-center rounded-xl ${active?.id === c.id ? 'bg-panel-2' : 'hover:bg-panel-2/60'}`}>
            <button type="button" onClick={() => { session.open(c.id); if (window.innerWidth < 768) setHistoryOpen(false) }}
                    className="min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px]">{c.title}</button>
            <button type="button" onClick={() => session.remove(c.id)} aria-label={`Delete ${c.title}`}
                    className="px-2 text-muted opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        {!conversations.length && <p className="px-3 py-2 text-xs text-muted">{filter ? 'No matches.' : 'No conversations yet.'}</p>}
      </div>
    </div>
  )

  return (
    <div className="studio-chat relative flex h-full overflow-hidden" onDragEnter={onDragEnter} onDragLeave={onDragLeave}
         onDragOver={(e) => hasFiles(e) && e.preventDefault()} onDrop={dropTo('stage')}>
      <input ref={picker} type="file" multiple className="hidden" accept=".pdf,.md,.markdown,.txt,.text,.rst,.csv,.json,.html,.htm,.docx"
             onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) attach(f, pickMode.current) }} />

      {/* nav rail */}
      <nav className="hidden w-14 shrink-0 flex-col items-center gap-1.5 border-r border-line py-3.5 md:flex" aria-label="Chat studio">
        <StudioSwitcher current="chat" className="mb-2" context={{ conversation: active?.id }}>
          <span className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-accent text-[13px] font-bold text-bg">LC</span>
        </StudioSwitcher>
        {railButton('New chat', <Plus className="h-[18px] w-[18px]" />, () => { session.newChat(); setFocusKey((k) => k + 1) })}
        {railButton('Chats', <MessagesSquare className="h-[18px] w-[18px]" />, () => setHistoryOpen((o) => !o), historyOpen)}
        {railButton('Add files', <Library className="h-[18px] w-[18px]" />, () => pickFiles('remember'))}
        {railButton('Settings', <SlidersHorizontal className="h-[18px] w-[18px]" />, () => setSettingsOpen((o) => !o), settingsOpen)}
        <div className="mt-auto">
          {auth?.state.user && railButton(`Sign out ${auth.state.user}`, <LogOut className="h-[18px] w-[18px]" />, auth.signOut)}
        </div>
      </nav>

      {/* history (desktop panel) */}
      {historyOpen && <aside className="hidden w-64 shrink-0 border-r border-line bg-panel md:block">{history}</aside>}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2 px-3 md:px-5">
          <button type="button" onClick={() => setHistoryOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-muted md:hidden" aria-label="Chats"><Menu className="h-5 w-5" /></button>
          <StudioSwitcher current="chat" className="md:hidden" context={{ conversation: active?.id }}>
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-[12px] font-bold text-bg">LC</span>
          </StudioSwitcher>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
            <span className="hidden truncate sm:inline">{project.name}</span>
            <span className="hidden sm:inline">/</span>
            <b className="truncate font-medium text-text">{active?.title ?? 'New chat'}</b>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => setSettingsOpen((o) => !o)} className="grid h-9 w-9 place-items-center rounded-lg text-muted md:hidden" aria-label="Settings"><SlidersHorizontal className="h-[18px] w-[18px]" /></button>
            <button type="button" onClick={() => setRailOpen((o) => !o)} aria-pressed={railOpen}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] ${railOpen ? 'border-[#4a463f] text-text' : 'border-line text-muted hover:text-text'}`}>
              <PanelRight className="h-3.5 w-3.5" />Context
            </button>
          </div>
        </header>

        {settingsOpen && (
          <div className="mx-3 mb-2 grid gap-4 rounded-2xl border border-line bg-card p-4 text-[13px] md:mx-5 md:grid-cols-[1fr_15rem]">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted">How the assistant should behave (system prompt)</span>
              <textarea value={settings.system} rows={3} id="chat-system"
                        onChange={(e) => setSettings((s) => ({ ...s, system: e.target.value }))}
                        placeholder="You are a helpful, accurate assistant. Answer concisely."
                        className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-[#4a463f]" />
            </label>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 flex justify-between text-xs text-muted"><span>Creativity (temperature)</span><span className="tabular-nums">{settings.temperature.toFixed(1)}</span></span>
                <input type="range" id="chat-temperature" min={0} max={2} step={0.1} value={settings.temperature}
                       onChange={(e) => setSettings((s) => ({ ...s, temperature: Number(e.target.value) }))} className="w-full accent-[var(--color-accent)]" />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" id="chat-think" checked={settings.think} onChange={(e) => setSettings((s) => ({ ...s, think: e.target.checked }))} className="accent-[var(--color-accent)]" />
                Let reasoning models think first
              </label>
              <div className="-mx-3"><ProjectSwitcher /></div>
            </div>
          </div>
        )}

        <Thread session={session} kbChunks={kbChunks} projectName={project.name}
                onSelect={(s) => { setSelected(s); setRailOpen(true) }}
                onCommand={onCommand} onAsk={(q) => session.send(q)} onPick={pickFiles} />

        <Composer streaming={session.streaming} busy={!!session.busy} model={effectiveModel} useRag={settings.useRag} kbChunks={kbChunks}
                  staged={staged} onStage={setStaged} focusKey={focusKey}
                  onModel={(ref) => setSettings((s) => ({ ...s, model: ref }))}
                  onToggleRag={() => setSettings((s) => ({ ...s, useRag: !s.useRag }))}
                  onSend={(t) => session.send(t)} onAttach={attach} onCommand={onCommand} onStop={session.stop} />
      </main>

      {/* context rail: a column on wide screens, a sheet on small ones */}
      {railOpen && (
        <>
          <aside className="hidden w-[300px] shrink-0 border-l border-line bg-panel xl:block">
            <ContextRail pid={pid} selected={selected} question={lastQuestion} onPick={() => pickFiles('remember')} onCommand={onCommand} refreshKey={refreshKey} />
          </aside>
          <div className="fixed inset-0 z-40 bg-panel xl:hidden">
            <ContextRail pid={pid} selected={selected} question={lastQuestion} onPick={() => pickFiles('remember')} onCommand={onCommand}
                         refreshKey={refreshKey} onClose={() => setRailOpen(false)} />
          </div>
        </>
      )}

      {/* history drawer on phones */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="w-[82%] max-w-xs bg-panel shadow-2xl">
            <div className="flex gap-2 px-3 pt-3">
              <button type="button" onClick={() => { session.newChat(); setHistoryOpen(false) }} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent py-2 text-[13px] font-medium text-bg"><Plus className="h-4 w-4" />New chat</button>
            </div>
            {history}
          </div>
          <button type="button" className="flex-1 bg-black/50" aria-label="Close" onClick={() => setHistoryOpen(false)} />
        </div>
      )}

      {/* drop overlay: drop onto what should happen */}
      {dragging && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-[#1a1917]/85 p-6 backdrop-blur-sm" onDrop={dropTo('stage')}>
          <div className="w-full max-w-2xl space-y-4 text-center">
            <p className="text-sm text-muted">Drop onto what {project.name} should do with it</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div onDragOver={(e) => e.preventDefault()} onDrop={dropTo('remember')}
                   className="rounded-3xl border-2 border-dashed border-accent/60 bg-accent-dim/60 px-6 py-10 transition hover:bg-accent-dim">
                <BookOpen className="mx-auto mb-3 h-8 w-8 text-accent" />
                <b className="block text-lg font-semibold">Remember</b>
                <span className="text-sm text-muted">Add to the knowledge base. Answers can cite it in about a minute.</span>
              </div>
              <div onDragOver={(e) => e.preventDefault()} onDrop={dropTo('learn')}
                   className="rounded-3xl border-2 border-dashed border-warm/60 bg-warm/10 px-6 py-10 transition hover:bg-warm/20">
                <Brain className="mx-auto mb-3 h-8 w-8 text-warm" />
                <b className="block text-lg font-semibold">Learn from it</b>
                <span className="text-sm text-muted">Also write practice Q&amp;A, ready to fine-tune a model with /train.</span>
              </div>
              <div onDragOver={(e) => e.preventDefault()} onDrop={dropTo('review')}
                   className="rounded-3xl border-2 border-dashed border-line bg-panel-2/60 px-6 py-10 transition hover:bg-panel-2">
                <ListChecks className="mx-auto mb-3 h-8 w-8 text-text" />
                <b className="block text-lg font-semibold">Review first</b>
                <span className="text-sm text-muted">Write practice Q&amp;A for you to look over; only what you keep is learned.</span>
              </div>
            </div>
            <p className="text-xs text-muted">Drop anywhere else to attach it to your next message.</p>
          </div>
        </div>
      )}
    </div>
  )
}

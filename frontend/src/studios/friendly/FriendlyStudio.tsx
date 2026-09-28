import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/plus-jakarta-sans'
import './friendly.css'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BookOpen, Check, ChevronRight, Database, FlaskConical, FolderInput, Loader2, Moon, Send, Sparkles, Table2, Zap } from 'lucide-react'
import { api, uploadDocuments, type EvalRun, type JobEvent, type KBDocument, type ModelRef, type PipelineGraph, type SearchHit, type Source } from '../../api'
import { metricRows } from '../../components/LossChart'
import { useProject } from '../../hooks/project'
import { usePolling } from '../../hooks/usePolling'
import { useJobStream } from '../../hooks/streams'
import { StudioSwitcher } from '../StudioSwitcher'
import { rememberStudio } from '../registry'
import { startingConversation, useChatSession } from '../chat/useChatSession'
import { findings, type Scored } from '../findings'
import { latestResult, nextSteps, type NextStep, type Target } from '../recommend'

type Page = 'home' | 'chat' | 'knowledge' | 'train' | 'results'
const PAGES: { id: Page; label: string; icon: typeof BookOpen }[] = [
  { id: 'home', label: 'Home', icon: Sparkles }, { id: 'chat', label: 'Chat', icon: BookOpen },
  { id: 'knowledge', label: 'Knowledge', icon: Database }, { id: 'train', label: 'Train', icon: Zap }, { id: 'results', label: 'Results', icon: FlaskConical },
]
const TARGET: Record<Target, string> = {
  knowledge: '/friendly/knowledge', practice: '/friendly/train', train: '/friendly/train', results: '/friendly/results',
  inbox: '/inbox', loop: '/inbox?tab=loop',
}
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
const shortModel = (ref: string | null | undefined) => (ref ?? '').split('/').slice(1).join('/').split(':')[0] || ref || 'the model'
const smallest = (ms: ModelRef[]) => [...ms].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref ?? ''

function Logo() {
  return <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true"><rect width="30" height="30" rx="10" fill="#1f2346" /><circle cx="11" cy="13" r="3" fill="#ffbf2e" /><circle cx="19" cy="13" r="3" fill="#1fb58f" /><path d="M9 20c3.5 3 8.5 3 12 0" stroke="#ff6a3d" strokeWidth="2.4" fill="none" strokeLinecap="round" /></svg>
}
function Bot() {
  return <svg className="fr-bot" viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="12" fill="#ffbf2e" /><circle cx="13" cy="16" r="2.6" fill="#1f2346" /><circle cx="23" cy="16" r="2.6" fill="#1f2346" /><path d="M12 23c3.4 2.6 8.6 2.6 12 0" stroke="#1f2346" strokeWidth="2.2" fill="none" strokeLinecap="round" /></svg>
}
function Deco() {
  return <svg className="deco" viewBox="0 0 170 130" aria-hidden="true"><circle cx="40" cy="30" r="34" fill="#ff6a3d" opacity=".9" /><circle cx="110" cy="92" r="28" fill="#1fb58f" opacity=".9" /><rect x="92" y="10" width="40" height="40" rx="12" fill="#ffbf2e" transform="rotate(18 112 30)" /></svg>
}

const FILE_TONE: Record<string, string> = { pdf: 't-pri', md: 't-sky', markdown: 't-sky', txt: 't-sun', docx: 't-mint', html: 't-sun', csv: 't-mint', json: 't-sun' }
function FileBadge({ name }: { name: string }) {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return <i className={`fr-badge-file ${FILE_TONE[ext] ?? 't-sky'}`}>{ext.slice(0, 4)}</i>
}

/** A result in words people use: "hermes3 + documents", "Your trained version". */
function friendlyName(v: Scored, all: Scored[]): string {
  const trained = all.filter((x) => x.kind === 'ft' || x.kind === 'ft-kb').length
  if (v.kind === 'ft') return trained > 1 ? `Trained version #${v.ref}` : 'Your trained version'
  if (v.kind === 'ft-kb') return 'Trained version + documents'
  const model = shortModel(v.label.replace(/ \+ knowledge base$/, ''))
  return v.kind === 'kb' ? `${model} + documents` : `${model} alone`
}

/** The headline with its number picked out, as in "made answers <em>34% more accurate</em>". */
function Headline({ text }: { text: string }) {
  const m = /^(.*?)(\d+% more accurate)(.*)$/.exec(text)
  return <h2 className="fr-disp">{m ? <>{m[1]}<em>{m[2]}</em>{m[3]}</> : text}</h2>
}

export default function FriendlyStudio() {
  const { current: project, projects, select } = useProject()
  const params = useParams()
  const page: Page = (PAGES.some((p) => p.id === params.page) ? params.page : 'home') as Page
  const pid = project?.id
  const { data: g, reload } = usePolling<PipelineGraph | null>(() => (pid ? api.pipeline(pid) : Promise.resolve(null)), 5000, [pid])
  const { data: held } = usePolling(() => (pid ? api.reviewQueue(pid) : Promise.resolve([])), 15000, [pid])
  useEffect(() => rememberStudio('friendly'), [])

  if (!project || !g) return <div className="studio-friendly grid h-full place-items-center fr-disp text-xl font-bold">Getting things ready…</div>
  const initials = project.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="studio-friendly h-full overflow-y-auto">
      <nav className="fr-nav" aria-label="Friendly studio">
        <Link to="/friendly" className="fr-logo"><Logo />LLMCoach</Link>
        <div className="fr-links">
          {PAGES.map((p) => (
            <Link key={p.id} to={p.id === 'home' ? '/friendly' : `/friendly/${p.id}`} aria-current={page === p.id ? 'page' : undefined}>
              <p.icon className="h-3.5 w-3.5" />{p.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="fr-proj"><i>{initials}</i>
            {projects.length > 1
              ? <select aria-label="Project" value={project.id} onChange={(e) => select(Number(e.target.value))}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              : project.name}
          </span>
          <StudioSwitcher current="friendly" align="right"><span className="fr-av" title="Switch studio">✦</span></StudioSwitcher>
        </div>
      </nav>
      {page === 'home' && <Home g={g} held={held?.length ?? 0} />}
      {page === 'chat' && <Chat g={g} changed={reload} />}
      {page === 'knowledge' && <Knowledge g={g} changed={reload} />}
      {page === 'train' && <Train g={g} changed={reload} />}
      {page === 'results' && <Results g={g} changed={reload} held={held?.length ?? 0} />}
    </div>
  )
}

// ---- home -----------------------------------------------------------------------------------------------

function Steps({ steps }: { steps: NextStep[] }) {
  const icon: Record<Target, ReactNode> = {
    knowledge: <Database className="h-4 w-4" />, practice: <Table2 className="h-4 w-4" />, train: <Zap className="h-4 w-4" />,
    results: <FlaskConical className="h-4 w-4" />, inbox: <FolderInput className="h-4 w-4" />, loop: <Moon className="h-4 w-4" />,
  }
  if (!steps.length) return <p className="fr-sub">Nothing needs doing. Your bot is in good shape.</p>
  return (
    <>
      {steps.map((s) => (
        <Link key={s.id} to={TARGET[s.target]} className="fr-step">
          <i className={`t-${s.tone}`}>{icon[s.target]}</i>
          <div><b>{s.title}</b><small>{s.detail}</small></div>
          <ChevronRight className="go h-4 w-4" />
        </Link>
      ))}
    </>
  )
}

function Home({ g, held }: { g: PipelineGraph; held: number }) {
  const result = latestResult(g)
  const f = result ? findings(result) : null
  const questions = g.datasets.reduce((n, d) => n + d.rows, 0)
  const trained = g.finetunes.filter((x) => x.status === 'ready')
  const current = trained.find((x) => x.promoted_at)
  const steps = nextSteps(g, held)
  const stat = (to: string, tone: string, icon: ReactNode, big: ReactNode, label: string) => (
    <Link to={to} className="fr-card fr-stat"><span className={`ic ${tone}`}>{icon}</span><b>{big}</b><span>{label}</span></Link>
  )
  return (
    <div className="fr-page">
      <div className="fr-card fr-hero">
        <Deco />
        <div>
          <h2 className="fr-disp">{g.documents.count ? `Your bot knows ${g.documents.count} document${g.documents.count === 1 ? '' : 's'}.` : "Let's build your bot."}</h2>
          <p>{f ? `Latest test: ${f.headline}` : g.documents.count ? 'Ask it anything about them, or teach it to answer your way.' : 'Start by adding the documents it should know about.'}</p>
        </div>
        <Link to={g.documents.count ? '/friendly/chat' : '/friendly/knowledge'} className="fr-btn white">{g.documents.count ? 'Ask your bot' : 'Add documents'}</Link>
      </div>
      <div className="fr-grid four">
        {stat('/friendly/knowledge', 't-sky', <Database className="h-5 w-5" />, g.knowledge.chunks, `searchable pieces from ${g.documents.count} documents`)}
        {stat('/friendly/train', 't-sun', <Table2 className="h-5 w-5" />, questions, 'practice questions')}
        {stat('/friendly/train', 't-pri', <Zap className="h-5 w-5" />, trained.length, current ? 'trained versions, one in use' : 'trained versions')}
        {stat('/friendly/results', 't-mint', <FlaskConical className="h-5 w-5" />, f ? `${Math.round((f.ranked[0]?.score.f1 ?? 0) * 100)}%` : '—', f ? 'accuracy of the best version' : 'not tested yet')}
      </div>
      <div className="fr-grid two">
        <div className="fr-card p-5">
          <h3 className="fr-h">What to try next</h3>
          <div className="mt-2"><Steps steps={steps} /></div>
        </div>
        <div className="fr-card fr-tip">
          <h4 className="fr-h text-[17px]">How it works</h4>
          <p>Your bot answers from your documents and shows where each answer came from. Practice questions teach it your style, and a test on questions it has never seen shows whether that helped.</p>
        </div>
      </div>
      <div className="fr-grid three">
        {[
          { to: '/friendly/knowledge', tone: 't-sky', icon: <BookOpen className="h-5 w-5" />, title: 'Answer from my documents', steps: ['Add your documents', 'Ask in the chat', 'Check the sources it shows'] },
          { to: '/friendly/train', tone: 't-pri', icon: <Zap className="h-5 w-5" />, title: 'Teach it my style', steps: ['Write practice questions', 'Teach your bot', 'Test it on new questions'] },
          { to: '/inbox', tone: 't-mint', icon: <Moon className="h-5 w-5" />, title: 'Keep it learning', steps: ['Pick a folder to watch', 'Drop files in it any time', 'It retrains overnight'] },
        ].map((r) => (
          <Link key={r.title} to={r.to} className="fr-card fr-recipe">
            <span className={`grid h-10 w-10 place-items-center rounded-xl ${r.tone}`}>{r.icon}</span>
            <h4 className="fr-h text-[17px]">{r.title}</h4>
            <ol>{r.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </Link>
        ))}
      </div>
    </div>
  )
}

// ---- chat -----------------------------------------------------------------------------------------------

const matchWord = (score: number) => (score >= 0.75 ? 'strong match' : score >= 0.55 ? 'good match' : 'loose match')

function Answer({ content, sources, tps, live }: { content: string; sources: SearchHit[] | null; tps?: number | null; live?: boolean }) {
  const n = sources?.length ?? 0
  const parts = content.split(/(\[\d{1,2}\])/g)
  return (
    <div className="fr-a">
      <Bot />
      <div className="min-w-0">
        <div className="fr-bub">
          {parts.map((p, i) => {
            const m = /^\[(\d{1,2})\]$/.exec(p)
            return m && Number(m[1]) <= n ? <span key={i} className="c">{m[1]}</span> : <span key={i}>{p}</span>
          })}
          {live && !content && <Loader2 className="inline h-4 w-4 animate-spin text-[var(--mu)]" />}
        </div>
        {n > 0 && (
          <div className="fr-srcs">
            {sources!.slice(0, 3).map((s, i) => (
              <div key={s.id} className={`fr-src ${i === 0 ? 'on' : ''}`} title={s.text.slice(0, 300)}>
                <FileBadge name={s.filename} />
                <div className="min-w-0"><b>{s.filename}</b><small>{s.page != null ? `Page ${s.page}` : `Part ${s.chunk_index + 1}`} · {matchWord(s.score)}</small></div>
              </div>
            ))}
          </div>
        )}
        {!live && (
          <div className="fr-stats">
            {tps != null && <span className={tps >= 8 ? 'fast' : ''}>● {tps >= 8 ? 'Fast' : 'Steady'} · {tps} words/s</span>}
            <span>{n ? 'Answered from your documents' : 'Answered without your documents'}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function KnowsCard({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const { data: docs } = usePolling<KBDocument[]>(() => api.documents(g.project.id), 10000, [g.project.id])
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const upload = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    try { await uploadDocuments(g.project.id, files, () => {}) } catch { /* shown on the Knowledge page */ }
    setBusy(false)
    changed()
  }
  return (
    <div className="fr-card relative overflow-hidden p-5">
      <svg className="absolute -right-5 -top-5 h-[110px] w-[110px]" viewBox="0 0 110 110" aria-hidden="true"><circle cx="70" cy="40" r="40" fill="#e8f1ff" /><circle cx="38" cy="70" r="16" fill="#ffe7dd" /><rect x="62" y="52" width="26" height="26" rx="8" fill="#e3f7f1" transform="rotate(14 75 65)" /></svg>
      <h4 className="fr-h relative text-[17px]">Your bot knows</h4>
      <p className="fr-sub relative">{g.documents.count} documents, split into {g.knowledge.chunks} searchable pieces.</p>
      {docs?.slice(0, 5).map((d) => (
        <div key={d.id} className="fr-doc">
          <FileBadge name={d.filename} />
          <div className="min-w-0"><b>{d.filename}</b><small>{d.status === 'ready' ? `${d.chunk_count} pieces` : d.status === 'failed' ? "couldn't be read" : 'reading…'}</small></div>
          {d.status === 'ready' && <Check className="ok h-4 w-4" />}
        </div>
      ))}
      <button className="fr-drop mt-4" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Adding…' : '+ Add documents'}</button>
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    </div>
  )
}

function Chat({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const { current } = useProject()
  const session = useChatSession(current)
  const { active, pending, streaming, settings, setSettings } = session
  const [text, setText] = useState('')
  const [models, setModels] = useState<ModelRef[]>([])
  const [opened, setOpened] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { api.models('chat').then(setModels).catch(() => {}) }, [])
  useEffect(() => { const m = new URLSearchParams(window.location.search).get('model'); if (m) setSettings((s) => ({ ...s, model: m })) }, [setSettings])
  useEffect(() => { if (!opened && !active && session.conversations.length) { setOpened(true); session.open(startingConversation(session.conversations)!) } }, [opened, active, session])
  const msgs = (active?.messages ?? []).filter((m) => m.role !== 'event')
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length, pending?.answer])
  const model = settings.model ?? active?.model ?? smallest(models)
  const info = models.find((m) => m.ref === model)
  const send = (e: FormEvent) => { e.preventDefault(); if (text.trim() && !streaming) { session.send(text.trim()); setText('') } }
  const nextModel = () => { if (models.length) { const i = models.findIndex((m) => m.ref === model); setSettings((s) => ({ ...s, model: models[(i + 1) % models.length].ref })) } }
  return (
    <div className="fr-page">
      <div className="fr-grid two">
        <div className="fr-card fr-chat">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="fr-h text-xl">Ask your bot</h3>
            <button className="fr-model" onClick={nextModel} title="Try another model"><Sparkles className="h-3.5 w-3.5" />{shortModel(model)}{info?.parameters ? ` · ${info.parameters}` : ''}</button>
            <button className="text-xs font-semibold text-[var(--mu)] hover:text-[var(--ink)]" onClick={() => { session.newChat(); setOpened(true) }}>New chat</button>
          </div>
          <div className="fr-msgs">
            {!msgs.length && !pending && (
              <div className="grid flex-1 place-items-center text-center">
                <div><Bot /><p className="fr-sub mt-3">Ask anything about your documents. Numbered bubbles show where each answer came from.</p></div>
              </div>
            )}
            {msgs.map((m) => (m.role === 'user'
              ? <div key={m.id} className="fr-u">{m.content}</div>
              : <Answer key={m.id} content={m.content} sources={m.sources} tps={m.stats?.tokens_per_sec} />))}
            {pending && <><div className="fr-u">{pending.question}</div><Answer content={pending.answer} sources={pending.sources} live={streaming} /></>}
            <div ref={end} />
          </div>
          <form onSubmit={send} className="fr-comp">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything about your documents…" aria-label="Question" disabled={streaming} />
            <button type="button" className={`fr-tog ${settings.useRag ? 'on' : ''}`} onClick={() => setSettings((s) => ({ ...s, useRag: !s.useRag }))} aria-pressed={settings.useRag}><i />Use my documents</button>
            <button type="submit" className="fr-send" aria-label="Send" disabled={!text.trim() || streaming}><Send className="h-4 w-4" /></button>
          </form>
        </div>
        <div className="flex flex-col gap-4">
          <KnowsCard g={g} changed={changed} />
          <div className="fr-card fr-tip"><h4 className="fr-h text-[17px]">Tip</h4><p>Hover a source card to see the exact passage your bot used. If it's wrong, fix the document and add it again.</p></div>
        </div>
      </div>
    </div>
  )
}

// ---- knowledge ------------------------------------------------------------------------------------------

function Knowledge({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const { data: docs, reload } = usePolling<KBDocument[]>(() => api.documents(pid), 5000, [pid])
  const [said, setSaid] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const upload = async (files: File[]) => {
    if (!files.length) return
    setProgress(0)
    try {
      const r = await uploadDocuments(pid, files, setProgress)
      setSaid(`Added ${r.documents.length}. ${r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.map((s) => `${s.filename} (${s.reason})`).join(', ')}.` : 'Your bot can use them in about a minute.'}`)
    } catch (e) { setSaid(errText(e)) }
    setProgress(null)
    reload()
    changed()
  }
  return (
    <div className="fr-page">
      <div className="fr-card fr-hero">
        <Deco />
        <div><h2 className="fr-disp">Your bot knows {g.documents.count} document{g.documents.count === 1 ? '' : 's'}.</h2>
          <p>Each is split into pieces your bot can search and quote. {g.knowledge.chunks} pieces so far.</p></div>
      </div>
      <div className="fr-grid two">
        <div className="fr-card p-5">
          <button className="fr-drop big" onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); upload(Array.from(e.dataTransfer.files)) }}>
            {progress != null ? `Adding… ${Math.round(progress * 100)}%` : '+ Drop documents here, or click to choose'}
          </button>
          <input ref={input} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
          {said && <p className="fr-say mt-3">{said}</p>}
          <div className="mt-2">
            {docs?.map((d) => (
              <div key={d.id} className="fr-doc">
                <FileBadge name={d.filename} />
                <div className="min-w-0"><b>{d.filename}</b><small>{d.status === 'ready' ? `${d.chunk_count} pieces` : d.status === 'failed' ? "couldn't be read: it may be a scan without text" : 'reading…'}</small></div>
                {d.status === 'ready' ? <Check className="ok h-4 w-4" /> : d.status !== 'failed' && <Loader2 className="ml-auto h-4 w-4 animate-spin text-[var(--mu)]" />}
              </div>
            ))}
          </div>
        </div>
        <Folders sources={g.sources} />
      </div>
    </div>
  )
}

function Folders({ sources }: { sources: Source[] }) {
  return (
    <div className="fr-card fr-tip !bg-[var(--mint-l)]">
      <h4 className="fr-h text-[17px]">Watched folders</h4>
      {sources.length ? (
        <>
          {sources.map((s) => <p key={s.id} className="!text-[#0d5f4b]"><b>{s.name}</b> · {s.counts.added ?? 0} added{s.counts.quarantined ? ` · ${s.counts.quarantined} waiting for your OK` : ''}</p>)}
          <Link to="/inbox" className="fr-btn mint mt-3">Manage folders</Link>
        </>
      ) : (
        <>
          <p className="!text-[#0d5f4b]">Pick a folder, or a shared folder on your network, and anything copied into it is added by itself.</p>
          <Link to="/inbox" className="fr-btn mint mt-3">Watch a folder</Link>
        </>
      )}
    </div>
  )
}

// ---- train ----------------------------------------------------------------------------------------------

function LearnChart({ events, height = 120 }: { events: JobEvent[]; height?: number }) {
  const rows = useMemo(() => metricRows(events), [events])
  const train = rows.filter((r) => r.loss != null), test = rows.filter((r) => r.eval_loss != null)
  if (train.length < 2) return <p className="fr-sub">The chart appears after the first few rounds.</p>
  const W = 520, H = height, L = 8
  const all = [...train.map((r) => r.loss!), ...test.map((r) => r.eval_loss!)]
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1
  const maxStep = Math.max(...rows.map((r) => r.step), 1)
  const x = (s: number) => L + ((W - 2 * L) * s) / maxStep
  const y = (v: number) => 8 + ((H - 16) * (hi - v)) / span
  const path = (pts: [number, number][]) => pts.map(([s, v], i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="Mistakes going down as it practises">
      <path d={path(train.map((r) => [r.step, r.loss!]))} fill="none" stroke="var(--pri)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {test.length > 0 && <path d={path(test.map((r) => [r.step, r.eval_loss!]))} fill="none" stroke="var(--mint)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 7" />}
      {test.map((r) => <circle key={r.step} cx={x(r.step)} cy={y(r.eval_loss!)} r="4.5" fill="var(--mint)" />)}
    </svg>
  )
}

function Train({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const questions = g.datasets.reduce((n, d) => n + d.rows, 0)
  const trainable = [...g.datasets].filter((d) => (d.splits?.train ?? 0) > 0).sort((a, b) => b.rows - a.rows)
  const writing = g.active_jobs.find((j) => j.kind === 'generate')
  const training = g.active_jobs.find((j) => j.kind === 'train')
  const versions = g.finetunes.filter((f) => f.status === 'ready')
  const last = [...g.finetunes].reverse().find((f) => f.job_id)
  const { events, job } = useJobStream(training?.id ?? last?.job_id ?? null)
  const prog = [...events].reverse().find((e) => e.type === 'progress')
  const pct = prog ? Number(prog.current) / Math.max(1, Number(prog.total)) : 0

  const write = async () => {
    setBusy(true)
    try {
      const model = smallest(await api.models('chat'))
      const r = await api.generateDataset(pid, { model, pairs_per_chunk: 3, max_chunks: 20, style: 'closed', val: 0.1, test: 0.1 })
      setSaid(`Writing about 60 questions into “${r.dataset.name}”. This page updates as they arrive.`)
      changed()
    } catch (e) { setSaid(errText(e)) }
    setBusy(false)
  }
  const exporting = new Set(g.active_jobs.filter((j) => j.kind === 'export').map((j) => Number(j.config.finetune_id)))
  const useInChat = async (id: number) => {
    try { await api.exportFinetune(pid, id); setSaid('Getting this version ready to chat with. It takes a minute or two.'); changed() } catch (e) { setSaid(errText(e)) }
  }
  const teach = async () => {
    if (!trainable.length) return
    setBusy(true)
    try {
      const opts = await api.trainingOptions()
      await api.createFinetune(pid, { base_model: opts.recommended_base_model, dataset_id: trainable[0].id, preset: 'quick', method: 'lora', backend: 'auto', overrides: {} })
      setSaid('Your bot has started practising. You can leave this page; it carries on.')
      changed()
    } catch (e) { setSaid(errText(e)) }
    setBusy(false)
  }
  return (
    <div className="fr-page">
      <div className="fr-card fr-hero">
        <Deco />
        <div><h2 className="fr-disp">Teach your bot to answer your way.</h2>
          <p>It practises on questions written from your documents, then keeps some aside to check itself.</p></div>
      </div>
      <div className="fr-grid three">
        <div className="fr-card p-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl t-sun"><Table2 className="h-5 w-5" /></span>
          <h4 className="fr-h mt-3 text-[17px]">1 · Practice questions</h4>
          <p className="fr-sub">You have <b className="text-[var(--ink)]">{questions}</b>. Around 100 or more works best.</p>
          <button className="fr-btn pri mt-4" onClick={write} disabled={busy || !!writing || !g.knowledge.chunks}>
            {writing ? <><Loader2 className="h-4 w-4 animate-spin" />Writing…</> : 'Write more from my documents'}
          </button>
        </div>
        <div className="fr-card p-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl t-pri"><Zap className="h-5 w-5" /></span>
          <h4 className="fr-h mt-3 text-[17px]">2 · Teach your bot</h4>
          <p className="fr-sub">{training ? `Practising… ${Math.round(pct * 100)}%` : trainable.length ? `Uses “${trainable[0].name}”. A few minutes on this computer.` : 'Needs practice questions first.'}</p>
          {training ? <div className="fr-bar mt-4"><i style={{ width: `${Math.max(3, pct * 100)}%` }} /></div>
            : <button className="fr-btn pri mt-4" onClick={teach} disabled={busy || !trainable.length}>Start teaching</button>}
        </div>
        <div className="fr-card p-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl t-mint"><FlaskConical className="h-5 w-5" /></span>
          <h4 className="fr-h mt-3 text-[17px]">3 · Check it helped</h4>
          <p className="fr-sub">A test on questions it has never seen, compared with the plain model.</p>
          <Link to="/friendly/results" className="fr-btn mint mt-4">See results</Link>
        </div>
      </div>
      {said && <p className="fr-say">{said}</p>}
      <div className="fr-grid two">
        <div className="fr-card p-5">
          <h3 className="fr-h">How your bot is learning <span className="ml-1 text-xs font-semibold text-[var(--mu)]">fewer mistakes is better · <span className="text-[var(--pri)]">practice</span> · <span className="text-[var(--mint)]">check</span></span></h3>
          <LearnChart events={events} />
          {job && <p className="fr-sub mt-1">{job.status === 'running' ? 'Still practising.' : job.status === 'done' ? 'Finished.' : `Stopped (${job.status}).`}</p>}
        </div>
        <div className="fr-card p-5">
          <h3 className="fr-h">Trained versions</h3>
          {!versions.length && <p className="fr-sub mt-2">None yet.</p>}
          {versions.slice().reverse().slice(0, 6).map((v, i) => (
            <div key={v.id} className="fr-doc">
              <i className={`fr-badge-file ${v.promoted_at ? 't-mint' : 't-sky'}`}>v{versions.length - i}</i>
              <div className="min-w-0"><b>Version {versions.length - i}</b><small>{v.promoted_at ? 'in use · ' : ''}{v.finished_at ? new Date(v.finished_at + (v.finished_at.endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</small></div>
              {v.ollama_model
                ? <a className="fr-btn soft ml-auto !px-3 !py-1.5 text-xs" href={`/friendly/chat?model=${encodeURIComponent(v.ollama_model)}`}>Chat with it</a>
                : <button className="fr-btn soft ml-auto !px-3 !py-1.5 text-xs" disabled={exporting.has(v.id)} onClick={() => useInChat(v.id)}>{exporting.has(v.id) ? 'Getting ready…' : 'Use in chat'}</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---- results --------------------------------------------------------------------------------------------

function Ring({ value, max, color, label }: { value: number; max: number; color: string; label: ReactNode }) {
  const c = 2 * Math.PI * 34
  return (
    <div className="fr-ring">
      <svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" stroke="#eef1f6" strokeWidth="9" />
        <circle cx="42" cy="42" r="34" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(Math.max(0, Math.min(1, value / max)) * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 42 42)" /></svg>
      <div>{label}</div>
    </div>
  )
}

function Results({ g, changed, held }: { g: PipelineGraph; changed: () => void; held: number }) {
  const pid = g.project.id
  const base = latestResult(g)
  const { data: run } = usePolling<EvalRun | null>(() => (base ? api.evalRun(pid, base.id) : Promise.resolve(null)), 15000, [pid, base?.id])
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const r = run ?? base
  const dsName = g.datasets.find((d) => d.id === r?.dataset_id)?.name
  const f = r ? findings(r, dsName) : null
  const testing = g.active_jobs.find((j) => j.kind === 'evaluate')
  const testable = g.datasets.filter((d) => (d.splits?.test ?? 0) > 0)
  const ft = f?.ranked.find((v) => v.kind === 'ft' || v.kind === 'ft-kb')
  const ftRow = g.finetunes.find((x) => String(x.id) === ft?.ref)
  const { events } = useJobStream(ftRow?.job_id ?? null)

  const test = async () => {
    setBusy(true)
    try {
      if (r?.variants?.length && r.dataset_id) {
        await api.createEval(pid, { dataset_id: r.dataset_id, max_examples: 20, variants: r.variants.map(({ kind, ref, rag }) => ({ kind, ref, rag })), ...(r.judge_model ? { judge_model: r.judge_model } : {}) })
      } else {
        const model = smallest(await api.models('chat'))
        const newest = [...g.finetunes].reverse().find((x) => x.status === 'ready')
        await api.createEval(pid, { dataset_id: testable[0].id, max_examples: 20, variants: [
          { kind: 'model', ref: model, rag: false }, ...(g.knowledge.chunks ? [{ kind: 'model' as const, ref: model, rag: true }] : []),
          ...(newest ? [{ kind: 'finetune' as const, ref: String(newest.id), rag: false }] : []),
        ] })
      }
      setSaid('Testing now. This page shows the answer when it finishes.')
      changed()
    } catch (e) { setSaid(errText(e)) }
    setBusy(false)
  }
  const fastest = f ? Math.min(...f.ranked.map((v) => v.score.latency_ms || 1)) : 1
  // Only crown a winner that is actually ahead; a tie gets no "Best" badge.
  const leads = !!f && f.ranked.length > 1 && f.ranked[0].score.f1 - f.ranked[1].score.f1 >= 0.02
  const colors = ['#1fb58f', '#3d86ff', '#ff6a3d', '#ffbf2e']

  return (
    <div className="fr-page">
      <div className="fr-card fr-hero">
        <Deco />
        <div>
          {f ? <Headline text={f.headline} /> : <h2 className="fr-disp">Let's see how well your bot does.</h2>}
          <p>{f ? `We tested ${f.ranked.length} version${f.ranked.length === 1 ? '' : 's'} of your bot on ${f.questions} question${f.questions === 1 ? '' : 's'} it had never seen.${r?.judge_model ? ` ${shortModel(r.judge_model)} graded each answer.` : ''}` : testable.length ? 'Your bot answers questions it has never seen, with and without your documents.' : 'It needs practice questions first, on the Train page.'}</p>
        </div>
        <button className="fr-btn white" onClick={test} disabled={busy || !!testing || (!r && !testable.length)}>{testing ? <><Loader2 className="h-4 w-4 animate-spin" />Testing…</> : r ? 'Run again' : 'Test my bot'}</button>
      </div>
      {said && <p className="fr-say">{said}</p>}
      {f && (
        <div className="fr-grid three">
          {f.ranked.map((v, i) => (
            <div key={v.label} className={`fr-card fr-vc ${i === 0 && leads ? 'best' : ''}`}>
              {i === 0 && leads && <span className="fr-badge">Best</span>}
              <h5>{friendlyName(v, f.ranked)}</h5><div className="sub">{v.label}</div>
              <div className="row">
                {v.score.judge != null
                  ? <Ring value={v.score.judge} max={5} color={colors[i % 4]} label={<span><b>{v.score.judge.toFixed(1)}</b><small>of 5</small></span>} />
                  : <Ring value={v.score.f1} max={1} color={colors[i % 4]} label={<span><b>{Math.round(v.score.f1 * 100)}%</b><small>accurate</small></span>} />}
                <div className="fr-m">
                  <div><span>Accuracy<b>{Math.round(v.score.f1 * 100)}%</b></span><div className="fr-track"><i style={{ width: `${v.score.f1 * 100}%`, background: colors[i % 4] }} /></div></div>
                  <div><span>Speed<b>{(v.score.latency_ms / 1000).toFixed(1)} s</b></span><div className="fr-track"><i style={{ width: `${(fastest / Math.max(1, v.score.latency_ms)) * 100}%`, background: 'var(--sky)' }} /></div></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="fr-grid two">
        {ftRow ? (
          <div className="fr-card p-5">
            <h3 className="fr-h">How your trained version learned <span className="ml-1 text-xs font-semibold text-[var(--mu)]">fewer mistakes is better · <span className="text-[var(--pri)]">practice</span> · <span className="text-[var(--mint)]">check</span></span></h3>
            <LearnChart events={events} />
          </div>
        ) : (
          <div className="fr-card fr-tip"><h4 className="fr-h text-[17px]">Reading the results</h4><p>Accuracy is how closely each answer matches the right one. Speed is how long an answer took. The best version gets the green outline.</p></div>
        )}
        <div className="fr-card p-5">
          <h3 className="fr-h">What to try next</h3>
          <div className="mt-2"><Steps steps={nextSteps(g, held).filter((s) => s.target !== 'results' || !f)} /></div>
        </div>
      </div>
    </div>
  )
}

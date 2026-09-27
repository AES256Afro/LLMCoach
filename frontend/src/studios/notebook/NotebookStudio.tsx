import '@fontsource-variable/newsreader'
import '@fontsource-variable/newsreader/wght-italic.css'
import '@fontsource-variable/public-sans'
import './notebook.css'
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'
import { api, type ChatMessage, type ModelRef, type PipelineGraph, type SearchHit } from '../../api'
import { useProject } from '../../hooks/project'
import { usePolling } from '../../hooks/usePolling'
import { StudioSwitcher } from '../StudioSwitcher'
import { rememberStudio } from '../registry'
import { useChatSession } from '../chat/useChatSession'
import { DatasetStep, DocumentsStep, EvaluateStep, ReportView, TrainStep } from './steps'

const STEPS = [
  { id: 'documents', label: 'Documents' },
  { id: 'dataset', label: 'Dataset' },
  { id: 'train', label: 'Train' },
  { id: 'evaluate', label: 'Evaluate' },
] as const

export type StepId = (typeof STEPS)[number]['id']

export default function NotebookStudio() {
  const { current: project, projects, select } = useProject()
  const params = useParams()
  const pid = project?.id
  const { data: g, reload } = usePolling<PipelineGraph | null>(() => (pid ? api.pipeline(pid) : Promise.resolve(null)), 5000, [pid])
  useEffect(() => rememberStudio('notebook'), [])

  if (!project || !g) return <div className="studio-notebook grid h-full place-items-center nb-serif text-lg">Opening the notebook…</div>

  const view = params.evalId ? 'report' : (params.step as StepId | undefined) ?? 'ask'
  const done: Record<StepId, boolean> = {
    documents: g.documents.count > 0,
    dataset: g.datasets.some((d) => d.rows > 0),
    train: g.finetunes.some((f) => f.status === 'ready'),
    evaluate: g.evals.some((e) => e.status === 'done'),
  }
  const count: Partial<Record<StepId, number>> = {
    documents: g.documents.count, dataset: g.datasets.reduce((n, d) => n + d.rows, 0) || undefined,
  }
  const current = view === 'report' ? 'evaluate' : view

  return (
    <div className="studio-notebook flex h-full flex-col">
      <header className="nb-top nb-noprint">
        <div className="nb-brand">
          <StudioSwitcher current="notebook"><span className="cursor-pointer">LLMCoach</span></StudioSwitcher>
          {projects.length > 1 ? (
            <select aria-label="Project" value={project.id} onChange={(e) => select(Number(e.target.value))}
                    className="cursor-pointer bg-transparent font-sans text-xs font-medium text-[var(--mu)] outline-none">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <small>{project.name}</small>}
        </div>
        <ol className="nb-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={current === s.id ? 'cur' : done[s.id] ? 'done' : ''}>
              <Link to={`/notebook/${s.id}`} aria-current={current === s.id ? 'step' : undefined}>
                <i>{i + 1}</i>{s.label}{count[s.id] ? <small>{count[s.id]}</small> : null}
              </Link>
            </li>
          ))}
        </ol>
        <Link to="/notebook" className={`nb-pill ${view === 'ask' ? 'on' : ''}`}><MessageCircle className="h-3.5 w-3.5" />Ask your bot</Link>
      </header>
      {view === 'ask' && <AskView g={g} />}
      {view === 'documents' && <DocumentsStep g={g} changed={reload} />}
      {view === 'dataset' && <DatasetStep g={g} changed={reload} />}
      {view === 'train' && <TrainStep g={g} changed={reload} />}
      {view === 'evaluate' && <EvaluateStep g={g} changed={reload} />}
      {view === 'report' && <ReportView g={g} evalId={Number(params.evalId)} />}
    </div>
  )
}

// ---- ask --------------------------------------------------------------------------------------------

const STOP = new Set('that this with from have were their there which what when where your about into they them then than will would could should also been being these those does each other more most some such only very just over under while'.split(' '))

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))
}

/** The passage with the words the answer took from it marked. */
function Quote({ text, answer }: { text: string; answer: string }) {
  const keep = words(answer)
  const clipped = text.replace(/\s+/g, ' ').trim().slice(0, 320) + (text.length > 320 ? '…' : '')
  return (
    <q>“{clipped.split(/(\s+)/).map((w, i) => (keep.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')) ? <mark key={i}>{w}</mark> : <Fragment key={i}>{w}</Fragment>))}”</q>
  )
}

/** Prose with each cited sentence highlighted and its [n] set as a superscript. */
function Prose({ text, sources }: { text: string; sources: number }) {
  const paragraphs = text.split(/\n{2,}/)
  return (
    <>
      {paragraphs.map((p, pi) => (
        <p key={pi}>
          {p.split(/(?<=[.!?])\s+/).map((sentence, si) => {
            const cites = [...sentence.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= sources)
            const clean = sentence.replace(/\s*\[(\d{1,2})\]/g, '').replace(/\*\*/g, '')
            const body: ReactNode = cites.length ? <mark>{clean}</mark> : clean
            return <Fragment key={si}>{si ? ' ' : ''}{body}{cites.map((n, k) => <sup key={k}>{n}</sup>)}</Fragment>
          })}
        </p>
      ))}
    </>
  )
}

function Turn({ q, a, faded }: { q: string; a: ChatMessage | null; faded?: boolean }) {
  if (faded) {
    return (
      <div className="nb-prev">
        <h3>{q}</h3>
        {a && <p className="line-clamp-3">{a.content.replace(/\s*\[\d{1,2}\]/g, '')}</p>}
      </div>
    )
  }
  return null
}

function AskView({ g }: { g: PipelineGraph }) {
  const { current } = useProject()
  const session = useChatSession(current)
  const { active, pending, streaming, settings, setSettings } = session
  const [text, setText] = useState('')
  const [models, setModels] = useState<ModelRef[]>([])
  const [opened, setOpened] = useState(false)
  const navigate = useNavigate()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { api.models('chat').then(setModels).catch(() => {}) }, [])
  useEffect(() => {
    if (!opened && !active && session.conversations.length) { setOpened(true); session.open(session.conversations[0].id) }
  }, [opened, active, session])

  // Pair the conversation into question/answer turns; events stay out of the prose.
  const turns = useMemo(() => {
    const out: { q: string; a: ChatMessage | null }[] = []
    for (const m of active?.messages ?? []) {
      if (m.role === 'user') out.push({ q: m.content, a: null })
      else if (m.role === 'assistant' && out.length) out[out.length - 1].a = m
    }
    return out
  }, [active?.messages])
  const last = pending ? null : turns[turns.length - 1]
  const earlier = pending ? turns : turns.slice(0, -1)
  const question = pending?.question ?? last?.q
  const answer = pending ? { content: pending.answer, sources: pending.sources, model: pending.model, stats: null } : last?.a
  const hits: SearchHit[] = answer?.sources ?? []
  const model = settings.model ?? active?.model ?? [...models].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref ?? null
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must return a cleanup or nothing.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [turns.length, pending?.answer])

  const ask = (e?: FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t || streaming) return
    session.send(t)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }
  const nextModel = () => {
    if (!models.length) return
    const i = models.findIndex((m) => m.ref === model)
    setSettings((s) => ({ ...s, model: models[(i + 1) % models.length].ref }))
  }
  const s = answer && 'stats' in answer ? answer.stats : null

  return (
    <div className="nb-body">
      <nav className="nb-side nb-noprint" aria-label="Conversations">
        <h6>Conversations</h6>
        <button className="new" onClick={() => { session.newChat(); setOpened(true) }}>+ New question</button>
        {session.conversations.slice(0, 12).map((c) => (
          <button key={c.id} className={active?.id === c.id ? 'on' : ''} onClick={() => session.open(c.id)}>{c.title}</button>
        ))}
        <h6 className="mt-[18px]">Elsewhere</h6>
        <button onClick={() => navigate('/providers')}>Models &amp; providers</button>
        <button onClick={() => navigate('/jobs')}>Jobs and logs</button>
        <button onClick={() => navigate('/inbox')}>Inbox and learning loop</button>
      </nav>

      <main className="nb-main">
        {earlier.slice(-2).map((t, i) => <Turn key={i} q={t.q} a={t.a} faded />)}
        {question ? (
          <>
            <div className="nb-eye">{answer?.model?.split('/').slice(1).join('/') ?? model?.split('/').slice(1).join('/')}{streaming ? ' · writing' : ''}</div>
            <h2 className="nb-q">{question}</h2>
            <div className="nb-a">{answer?.content ? <Prose text={answer.content} sources={hits.length} /> : <p className="text-[var(--mu)]">…</p>}</div>
            {!streaming && answer && (
              <div className="nb-meta">
                {hits.length > 0 && <span>Grounded in <b>{hits.length} passage{hits.length === 1 ? '' : 's'}</b></span>}
                {s?.tokens_per_sec != null && <span>{s.tokens_per_sec} tokens/s</span>}
                {s?.first_token_ms != null && <span>first word in {(s.first_token_ms / 1000).toFixed(1)} s</span>}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="nb-eye">{g.knowledge.chunks} passages from {g.documents.count} documents</div>
            <h2 className="nb-q">Ask anything about your documents. The sources will appear in the margin.</h2>
          </>
        )}
        <div ref={endRef} />
        <form onSubmit={ask} className="nb-comp nb-noprint">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Question"
                    placeholder={question ? 'Ask a follow-up…' : 'What would you like to know?'} disabled={streaming} />
          <div className="row">
            <span>Answer with <button type="button" className="nb-dash" onClick={nextModel} title="Next model">{model?.split('/').slice(1).join('/') ?? 'default'} ▸</button></span>
            <button type="button" className="flex items-center" onClick={() => setSettings((x) => ({ ...x, useRag: !x.useRag }))} aria-pressed={settings.useRag}>
              <span className={`nb-sw ${settings.useRag ? 'on' : ''}`} />Use my knowledge base ({g.knowledge.chunks} passages)
            </button>
            {streaming
              ? <button type="button" className="nb-pill ml-auto" onClick={session.stop}>Stop</button>
              : <button type="submit" className="nb-pill green ml-auto" disabled={!text.trim()}>Ask</button>}
          </div>
        </form>
      </main>

      <aside className="nb-margin" aria-label="Sources">
        {hits.map((h, i) => (
          <div key={h.id} className="nb-note">
            <span className="n">{i + 1}</span><b>{h.filename}</b>, {h.page != null ? `page ${h.page}` : `passage ${h.chunk_index + 1}`}
            <Quote text={h.text} answer={answer?.content ?? ''} />
            <small>match<span className="nb-sim"><i style={{ width: `${Math.max(0, Math.min(1, h.score)) * 100}%` }} /></span>{h.score.toFixed(2)}</small>
          </div>
        ))}
        {!hits.length && question && !streaming && (
          <div className="nb-note"><b>No sources.</b> {settings.useRag ? 'Nothing in your documents matched this question.' : 'The knowledge base is switched off for this chat.'}</div>
        )}
      </aside>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, ChevronRight, FolderInput, Loader2, Play, X } from 'lucide-react'
import { api, isFinal, type Dataset, type Job, type KBDocument, type Source } from '../../api'
import { nextSteps, type NextStep, type Tone } from '../recommend'
import type { SelectedSource } from './Thread'

const KIND_LABEL: Record<string, string> = { ingest: 'Index files', generate: 'Write Q&A', train: 'Fine-tune', evaluate: 'Compare', export: 'Export to Ollama', smoke: 'Hardware check', demo: 'Demo' }
const TONE_DOT: Record<Tone, string> = { sun: 'bg-warm', mint: 'bg-ok', sky: 'bg-accent', pri: 'bg-accent' }

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center justify-between text-[11.5px] font-medium text-muted">{title}{action}</h2>
      {children}
    </section>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3)
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i} className="rounded-[3px] bg-accent-dim px-0.5 text-text">{p}</mark> : p))}</>
}

export function ContextRail({ pid, selected, question, onPick, onCommand, onClose, refreshKey }: {
  pid: number
  selected: SelectedSource | null
  question: string
  onPick: () => void
  onCommand: (name: string, args?: string) => void
  onClose?: () => void
  refreshKey: number
}) {
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [held, setHeld] = useState(0)
  const [steps, setSteps] = useState<NextStep[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const load = async () => {
      try {
        const [d, j, ds, src, review, graph] = await Promise.all([
          api.documents(pid), api.jobs({ limit: 6, project_id: pid }), api.datasets(pid),
          api.sources(pid).catch(() => []), api.reviewQueue(pid).catch(() => []), api.pipeline(pid).catch(() => null),
        ])
        if (!alive) return
        setDocs(d)
        setJobs(j)
        setDataset(ds.find((x) => x.source === 'chat') ?? null)
        setSources(src)
        setHeld(review.length)
        // Files held for review already have their own notice under Inbox.
        setSteps(graph ? nextSteps(graph, review.length).filter((x) => x.id !== 'review') : [])
        const moving = j.some((x) => !isFinal(x.status)) || d.some((x) => x.status === 'pending' || x.status === 'ingesting')
        timer = window.setTimeout(load, moving ? 2500 : 10000)
      } catch {
        if (alive) timer = window.setTimeout(load, 10000)
      }
    }
    load()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [pid, refreshKey])

  const s = selected?.stats
  // Each step's area, as this studio does it: most are a slash command away.
  const go = (step: NextStep) => {
    if (step.id === 'held') navigate('/knowledge') // decided on the Knowledge page
    else if (step.target === 'knowledge') onPick()
    else if (step.target === 'practice') onCommand('learn', 'all')
    else if (step.target === 'train') onCommand('train')
    else if (step.target === 'results') onCommand('compare')
    else navigate(step.target === 'loop' ? '/inbox?tab=loop' : '/inbox')
  }
  const total = dataset?.splits ? dataset.splits.train + dataset.splits.val + dataset.splits.test : 0

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      {onClose && (
        <button type="button" onClick={onClose} className="-mb-2 self-end text-muted hover:text-text" aria-label="Close context"><X className="h-5 w-5" /></button>
      )}

      {selected && (
        <Section title={`Source ${selected.index + 1} · ${selected.hit.filename}`} action={<span className="tabular-nums">{selected.hit.score.toFixed(2)}</span>}>
          <div className="rounded-xl bg-card p-3 text-[12.5px] leading-relaxed text-[#cdc7bc]">
            <Highlight text={selected.hit.text} query={question} />
            <small className="mt-2 block text-[11px] text-muted">
              passage {selected.hit.chunk_index + 1}{selected.hit.page != null ? ` · page ${selected.hit.page}` : ''}
              {s?.retrieval_ms != null ? ` · retrieved in ${s.retrieval_ms} ms` : ''}
              {selected.hit.source_url && (
                <a href={selected.hit.source_url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-accent hover:underline"
                   title={selected.hit.source_url}>Open the page ↗</a>
              )}
            </small>
          </div>
        </Section>
      )}

      {selected && s && (
        <Section title="This reply">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
            {selected.model && <><dt className="text-muted">Model</dt><dd className="truncate text-right">{selected.model.split('/').slice(1).join('/')}</dd></>}
            {s.completion_tokens != null && <><dt className="text-muted">Tokens</dt><dd className="text-right">{s.completion_tokens}</dd></>}
            {s.tokens_per_sec != null && <><dt className="text-muted">Speed</dt><dd className="text-right">{s.tokens_per_sec} tok/s</dd></>}
            {s.first_token_ms != null && <><dt className="text-muted">First token</dt><dd className="text-right">{(s.first_token_ms / 1000).toFixed(1)} s</dd></>}
            {s.total_ms != null && <><dt className="text-muted">Total</dt><dd className="text-right">{(s.total_ms / 1000).toFixed(1)} s</dd></>}
          </dl>
        </Section>
      )}

      {steps.length > 0 && (
        <Section title="Next">
          <ul className="space-y-1">
            {steps.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => go(x)}
                        className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
                  <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[x.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px]">{x.title}</span>
                    <span className="block text-[11px] leading-snug text-muted">{x.detail}</span>
                  </span>
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted opacity-0 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Knowledge" action={<button type="button" onClick={onPick} className="text-accent hover:underline">Add</button>}>
        {docs.length === 0 && <p className="text-xs text-muted">Nothing yet. Drop files into the chat.</p>}
        <ul className="space-y-0.5">
          {docs.slice(0, 10).map((d) => (
            <li key={d.id} className="flex items-center gap-2.5 py-1 text-[12.5px]">
              <span className="grid h-7 w-6 shrink-0 place-items-center rounded-[5px] bg-panel-2 text-[8.5px] font-semibold uppercase text-muted">
                {d.filename.split('.').pop()?.slice(0, 4)}
              </span>
              <span className="min-w-0 flex-1 truncate">{d.filename}</span>
              <span className="shrink-0 text-[11px] text-muted">
                {d.status === 'ready' ? `${d.chunk_count} chunks` : d.status === 'failed' ? <span className="text-bad">failed</span> : <Loader2 className="h-3 w-3 animate-spin" />}
              </span>
            </li>
          ))}
        </ul>
        {docs.length > 10 && <Link to="/knowledge" className="block text-xs text-muted hover:text-text">+{docs.length - 10} more in Classic</Link>}
      </Section>

      <Section title="Inbox" action={<Link to="/inbox" className="hover:text-text">{sources.length ? 'Open' : 'Set up'}</Link>}>
        {sources.length === 0 ? (
          <p className="text-xs text-muted">Watch a folder, or a share on the network, and files copied into it join the knowledge base on their own.</p>
        ) : (
          <ul className="space-y-1">
            {sources.map((x) => (
              <li key={x.id} className="flex items-center gap-2 text-[12.5px]">
                <FolderInput className={`h-3.5 w-3.5 shrink-0 ${x.enabled && !x.last_error ? 'text-accent' : 'text-muted'}`} />
                <span className="min-w-0 flex-1 truncate">{x.name}</span>
                <span className="shrink-0 text-[11px] text-muted">{x.counts.added ?? 0} added{x.mode === 'learn' ? ' · learns' : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {held > 0 && (
          <Link to="/inbox" className="flex items-center gap-2 rounded-lg bg-warm/10 px-2.5 py-1.5 text-xs text-warm hover:bg-warm/15">
            <AlertTriangle className="h-3.5 w-3.5" />{held} file{held > 1 ? 's' : ''} held for review
          </Link>
        )}
      </Section>

      <Section title="Learned in chat" action={dataset && total > 0 ? <button type="button" onClick={() => onCommand('train')} className="inline-flex items-center gap-1 text-accent hover:underline"><Play className="h-3 w-3" />Train</button> : undefined}>
        {!dataset || !total ? (
          <p className="text-xs text-muted">Drop files onto <b className="text-warm">Learn</b> and the chat writes practice questions here for fine-tuning.</p>
        ) : (
          <>
            <div className="text-[12.5px]">{dataset.row_count} examples{dataset.status === 'generating' ? ' · adding more…' : ''}</div>
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              <i className="block bg-accent" style={{ flex: dataset.splits!.train }} />
              <i className="block bg-warm" style={{ flex: dataset.splits!.val || 0.0001 }} />
              <i className="block bg-muted" style={{ flex: dataset.splits!.test || 0.0001 }} />
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-y-0.5 text-xs tabular-nums">
              <dt className="text-muted">Train</dt><dd className="text-right">{dataset.splits!.train}</dd>
              <dt className="text-muted">Validation</dt><dd className="text-right">{dataset.splits!.val}</dd>
              <dt className="text-muted">Test</dt><dd className="text-right">{dataset.splits!.test}</dd>
            </dl>
          </>
        )}
      </Section>

      <Section title="Jobs" action={<Link to="/jobs" className="hover:text-text">All</Link>}>
        {jobs.length === 0 && <p className="text-xs text-muted">No jobs yet.</p>}
        <ul>
          {jobs.map((j) => (
            <li key={j.id}>
              <Link to={`/jobs/${j.id}`} className="flex items-center gap-2.5 border-t border-line py-2 text-[12.5px] first:border-t-0 hover:text-accent">
                <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ${j.status === 'done' ? 'bg-accent-dim text-accent' : j.status === 'failed' ? 'bg-bad/15 text-bad' : 'bg-panel-2 text-warm'}`}>
                  {j.status === 'done' ? <Check className="h-3 w-3" /> : j.status === 'failed' ? <X className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{KIND_LABEL[j.kind] ?? j.kind}</span>
                <span className="text-[11px] text-muted">#{j.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

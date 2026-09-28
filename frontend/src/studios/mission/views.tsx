import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  api, type ChatMessage, type Dataset, type EvalRun, type FineTune, type Job, type JobEvent, type KBDocument,
  type LoopState, type ModelRef, type NotifyConfig, type Project, type ProviderStatus, type SearchHit, type Source,
  type SystemStats,
} from '../../api'
import type { AppLog } from '../../api'
import { parseUtc } from '../../components/ui'
import { usePolling } from '../../hooks/usePolling'
import { useJobStream, type StatsSample } from '../../hooks/streams'
import { startingConversation, useChatSession } from '../chat/useChatSession'
import { nextSteps, type Target } from '../recommend'
import { Blocks, LogTail, LossChart, Meter, Tile, Trend, gb, mmss, type Series } from './tiles'

export interface Mission {
  project: Project
  stats: SystemStats | null
  history: StatsSample[]
  appLogs: AppLog[]
  jobs: Job[]
  providers: ProviderStatus[] | null
  finetunes: FineTune[]
  evals: EvalRun[]
  wall: boolean
  contrast: boolean
  setContrast: (v: boolean) => void
  scanlines: boolean
  setScanlines: (v: boolean) => void
}

const grid = (columns: string, rows: string) => ({ gridTemplateColumns: columns, gridTemplateRows: rows })
const KIND: Record<string, string> = { ingest: 'INDEX', generate: 'QA-GEN', train: 'TRAIN', evaluate: 'EVAL', export: 'EXPORT', smoke: 'SMOKE', demo: 'DEMO' }
const STATUS: Record<string, [string, string]> = {
  done: ['OK', 'mc-ok'], failed: ['FAIL', 'mc-bad'], cancelled: ['STOP', 'mc-dim'], running: ['RUN', 'mc-am'], queued: ['WAIT', 'mc-dim'],
}

function jobSummary(j: Job): string {
  const c = j.config as Record<string, unknown>
  if (j.kind === 'train') return `${String(c.base_model ?? '').split('/').pop()} · ${String(c.method ?? 'lora').toUpperCase()} · ${c.total_steps ?? '?'} steps`
  if (j.kind === 'ingest') return `${(c.doc_ids as unknown[] | undefined)?.length ?? 0} docs`
  if (j.kind === 'generate') return `${String(c.model ?? '')} · ${c.max_chunks ?? '?'} passages`
  if (j.kind === 'evaluate') return `eval #${c.eval_id ?? '?'} · ${c.max_examples ?? '?'} questions`
  if (j.kind === 'export') return `${String(c.name ?? '')} · ${String(c.quantize ?? 'f16')}`
  return ''
}

function elapsed(j: Job | null | undefined): number {
  if (!j?.started_at) return 0
  return ((j.finished_at ? parseUtc(j.finished_at) : new Date()).getTime() - parseUtc(j.started_at).getTime()) / 1000
}

function lastProgress(events: JobEvent[]) {
  const p = [...events].reverse().find((e) => e.type === 'progress')
  return p ? { current: Number(p.current), total: Number(p.total), message: String(p.message ?? '') } : null
}

// ---- shared tiles ---------------------------------------------------------------------------------

export function SystemTile({ m, style }: { m: Mission; style?: React.CSSProperties }) {
  const s = m.stats
  const gpu = s?.gpus[0]
  return (
    <Tile title="System" right="2s" style={style}>
      <div className="grid grid-cols-[48px_1fr_64px] items-center gap-x-2 gap-y-1.5 text-[11.5px]">
        <Meter label="CPU" pct={s?.cpu_pct ?? null} value={s ? `${s.cpu_pct.toFixed(0)}%` : '—'} />
        <Meter label="RAM" pct={s ? (s.ram_used_gb / s.ram_total_gb) * 100 : null} value={gb(s?.ram_used_gb)} />
        <Meter label="GPU" pct={gpu?.util_pct ?? null} value={gpu?.util_pct != null ? `${gpu.util_pct.toFixed(0)}%` : '—'} />
        {gpu && <Meter label="VRAM" pct={gpu.vram_total_gb ? ((gpu.vram_used_gb ?? 0) / gpu.vram_total_gb) * 100 : null} value={gb(gpu.vram_used_gb)} />}
      </div>
      {m.history.length > 1 && (
        <div className="mt-2.5">
          <Trend series={[
            { label: 'CPU', values: m.history.map((h) => h.cpu), color: 'var(--mc-am)' },
            { label: 'RAM', values: m.history.map((h) => h.ram), color: 'var(--mc-dim)' },
            ...(gpu ? [{ label: 'VRAM', values: m.history.map((h) => h.vram), color: 'var(--mc-grn)' }] : []),
          ]} />
        </div>
      )}
      {gpu && (
        <div className="mt-2 flex gap-4 text-[11px] mc-am2">
          <span>{gpu.name}</span>
          {gpu.temp_c != null && <span className={gpu.temp_c >= 80 ? 'mc-bad' : ''}>{gpu.temp_c.toFixed(0)}°C</span>}
          {gpu.power_w != null && <span>{gpu.power_w.toFixed(0)} W</span>}
        </div>
      )}
    </Tile>
  )
}

export function QueueTile({ m, style, onPick, selected }: { m: Mission; style?: React.CSSProperties; onPick?: (id: number) => void; selected?: number | null }) {
  const running = m.jobs.filter((j) => j.status === 'running').length
  const waiting = m.jobs.filter((j) => j.status === 'queued').length
  return (
    <Tile title="Queue" right={`${running} running · ${waiting} waiting`} style={style}>
      {m.jobs.length === 0 ? <div className="mc-dim">no jobs yet</div> : (
        <div className="mc-list grid-cols-[auto_auto_1fr_auto]">
          {m.jobs.slice(0, 12).map((j) => {
            const [word, cls] = STATUS[j.status] ?? [j.status, '']
            return (
              <div key={j.id} className={`contents ${onPick ? 'mc-row' : ''} ${selected === j.id ? 'mc-sel' : ''}`} onClick={() => onPick?.(j.id)}>
                <span className="mc-dim">#{j.id}</span><span>{KIND[j.kind] ?? j.kind.toUpperCase()}</span>
                <span className="mc-dim">{jobSummary(j)}</span><span className={cls}>{word}</span>
              </div>
            )
          })}
        </div>
      )}
    </Tile>
  )
}

function Scoreboard({ run, style, fkey }: { run: EvalRun | undefined; style?: React.CSSProperties; fkey?: string }) {
  const rows = run?.summary ? Object.entries(run.summary).sort((a, b) => (b[1].f1 ?? 0) - (a[1].f1 ?? 0)) : []
  return (
    <Tile title="Scoreboard" fkey={fkey} right={run ? `EVAL #${run.id}` : undefined} style={style}>
      {!rows.length ? <div className="mc-dim">{run ? `evaluation ${run.status}…` : 'no evaluations yet'}</div> : (
        <div className="space-y-2 text-[11.5px] leading-snug">
          {rows.map(([label, v]) => (
            <div key={label}>
              <div className="truncate uppercase">{label}</div>
              <div className="flex items-center gap-2"><Blocks value={v.f1 ?? 0} width={18} /><span className="tabular-nums">{(v.f1 ?? 0).toFixed(3).replace(/^0/, '')}</span></div>
              {v.judge != null && <div className="mc-am2">JUDGE {v.judge.toFixed(1)}</div>}
            </div>
          ))}
        </div>
      )}
    </Tile>
  )
}

// ---- F1 chat ----------------------------------------------------------------------------------------

function withCites(text: string, n: number): ReactNode[] {
  return text.split(/(\[\d{1,2}\])/g).map((part, i) => {
    const hit = /^\[(\d{1,2})\]$/.exec(part)
    return hit && Number(hit[1]) <= n ? <span key={i} className="mc-cite">{hit[1]}</span> : <Fragment key={i}>{part}</Fragment>
  })
}

function Sources({ hits }: { hits: SearchHit[] }) {
  return (
    <>
      {hits.slice(0, 4).map((h, i) => {
        const name = `${h.filename}${h.page != null ? ` p${h.page}` : `#${h.chunk_index + 1}`}`
        return <div key={h.id} className="mc-am2 truncate">  [{i + 1}] {name} {'.'.repeat(Math.max(3, 30 - name.length))} sim {h.score.toFixed(2)}</div>
      })}
    </>
  )
}

function Turn({ m }: { m: ChatMessage }) {
  if (m.role === 'user') return <div className="whitespace-pre-wrap"><span className="mc-am">&gt;</span> {m.content}</div>
  if (m.role === 'event') return <div className="mc-dim">  · {m.content}</div>
  const s = m.stats
  return (
    <div>
      {m.sources && <div className="mc-dim">  · retrieve → {m.sources.length} hits{s?.retrieval_ms != null ? ` · ${s.retrieval_ms} ms` : ''}</div>}
      {s?.first_token_ms != null && <div className="mc-dim">  · stream {m.model?.split('/').slice(1).join('/')} · first token {(s.first_token_ms / 1000).toFixed(1)} s</div>}
      <div className="mt-1 whitespace-pre-wrap text-[13.5px] mc-hi">{withCites(m.content, m.sources?.length ?? 0)}</div>
      {m.error && m.error !== 'stopped' && <div className="mc-bad">  ! {m.error}</div>}
      {m.sources && m.sources.length > 0 && <div className="mt-1"><Sources hits={m.sources} /></div>}
      {s && <div className="mc-dim">  {s.completion_tokens ?? '?'} tok{s.tokens_per_sec != null ? ` · ${s.tokens_per_sec} tok/s` : ''}{s.total_ms != null ? ` · ${(s.total_ms / 1000).toFixed(1)} s total` : ''}</div>}
    </div>
  )
}

function ChatTile({ m, style }: { m: Mission; style?: React.CSSProperties }) {
  const session = useChatSession(m.project)
  const { active, pending, streaming, settings, setSettings } = session
  const [text, setText] = useState('')
  const [models, setModels] = useState<ModelRef[]>([])
  const [opened, setOpened] = useState(false)
  useEffect(() => { api.models('chat').then(setModels).catch(() => {}) }, [])
  useEffect(() => {
    if (!opened && !active && session.conversations.length) {
      setOpened(true)
      session.open(startingConversation(session.conversations)!)
    }
  }, [opened, active, session])
  const model = settings.model ?? active?.model ?? [...models].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref ?? null
  const cycleModel = () => {
    if (!models.length) return
    const i = models.findIndex((x) => x.ref === model)
    setSettings((s) => ({ ...s, model: models[(i + 1) % models.length].ref }))
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || streaming) return
    setText('')
    if (t === '/new') return session.newChat()
    if (t === '/kb') return setSettings((s) => ({ ...s, useRag: !s.useRag }))
    session.send(t)
  }
  const messages = active?.messages ?? []
  const endRef = useScrollEnd([messages.length, pending?.answer])

  return (
    <Tile title={`chat · ${active ? `conversation ${active.id}` : 'new'}`} fkey="F1" style={style} bodyClass="!p-0 flex flex-col"
          right={<>MODEL {model?.split('/').slice(1).join('/') ?? '—'} · KB <span className={settings.useRag ? 'mc-ok' : 'mc-dim'}>{settings.useRag ? 'ON' : 'OFF'}</span></>}>
      <div className="flex-1 space-y-3 overflow-auto px-2.5 py-2 text-[12.5px] leading-[1.7]">
        {!messages.length && !pending && <div className="mc-dim">  ask anything. /new starts a new chat, /kb turns the knowledge base {settings.useRag ? 'off' : 'on'}.</div>}
        {messages.map((msg) => <Turn key={msg.id} m={msg} />)}
        {pending && (
          <>
            <div className="whitespace-pre-wrap"><span className="mc-am">&gt;</span> {pending.question}</div>
            {pending.sources && <div className="mc-dim">  · retrieve → {pending.sources.length} hits</div>}
            <div className="whitespace-pre-wrap text-[13.5px] mc-hi">{withCites(pending.answer, pending.sources?.length ?? 0)}{streaming && <span className="mc-cur ml-0.5" />}</div>
            {pending.error && pending.error !== 'stopped' && <div className="mc-bad">  ! {pending.error}</div>}
          </>
        )}
        <div ref={endRef} />
      </div>
      {!m.wall && (
        <form onSubmit={submit} className="flex items-center gap-2 border-t px-2.5 py-1.5" style={{ borderColor: 'var(--mc-ln)' }}>
          <span className="mc-am">&gt;</span>
          <input className="mc-input !border-0" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message"
                 placeholder={streaming ? 'answering…' : 'type a question'} disabled={streaming} />
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2.5 border-t px-2.5 py-1 text-[11.5px] mc-am2" style={{ borderColor: 'var(--mc-ln)' }}>
        <span>MODEL</span><button type="button" className="mc-tag" onClick={cycleModel} title="Next model">{model?.split('/').slice(1).join('/') ?? '—'} ▸</button>
        <span>KB</span><button type="button" className={`mc-tag ${settings.useRag ? 'on' : ''}`} onClick={() => setSettings((s) => ({ ...s, useRag: !s.useRag }))}>{settings.useRag ? 'ON' : 'OFF'}</button>
        <span>TEMP</span><span className="mc-am">{settings.temperature.toFixed(1)}</span>
        {streaming && <button type="button" className="mc-btn ml-auto" onClick={session.stop}>stop</button>}
      </div>
    </Tile>
  )
}

function useScrollEnd(deps: unknown[]) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { el?.scrollIntoView({ block: 'end' }) }, [el, ...deps])
  return setEl
}

function ModelsTile({ m, style }: { m: Mission; style?: React.CSSProperties }) {
  const ollama = m.providers?.find((p) => p.provider.slug === 'ollama')
  return (
    <Tile title="Models" right={ollama ? (ollama.reachable ? 'OLLAMA' : 'OLLAMA DOWN') : ''} style={style}>
      <div className="mc-list grid-cols-[auto_1fr_auto]">
        {ollama?.models.map((x) => (
          <Fragment key={x.name}><span className={x.embedding ? 'mc-dim' : 'mc-ok'}>{x.embedding ? '○' : '●'}</span><span>{x.name}</span><span className="mc-dim">{x.size_gb != null ? gb(x.size_gb) : ''}</span></Fragment>
        ))}
        {m.finetunes.filter((f) => f.status === 'ready').slice(0, 4).map((f) => (
          <Fragment key={f.id}><span className={f.promoted_at ? 'mc-am' : 'mc-dim'}>{f.promoted_at ? '★' : '○'}</span><span>{f.name}</span><span className="mc-dim">lora</span></Fragment>
        ))}
      </div>
    </Tile>
  )
}

function LastRunTile({ m, style }: { m: Mission; style?: React.CSSProperties }) {
  const job = m.jobs.find((j) => j.kind === 'train')
  const { events } = useJobStream(job?.id ?? null)
  const ft = m.finetunes.find((f) => f.job_id === job?.id)
  const losses = events.filter((e) => e.type === 'metric' && typeof e.loss === 'number')
  const evals = events.filter((e) => e.type === 'metric' && typeof e.eval_loss === 'number')
  const last = losses[losses.length - 1]?.loss as number | undefined
  const lastEval = evals[evals.length - 1]?.eval_loss as number | undefined
  return (
    <Tile title={`last run${ft ? ` · ${ft.name}` : ''}`} fkey="F4" style={style}
          right={job ? `${(STATUS[job.status]?.[0] ?? job.status).replace('OK', 'DONE')} ${mmss(elapsed(job))}` : undefined}>
      {!job ? <div className="mc-dim">no training runs yet. /train in the Chat studio, or the Train page.</div> : (
        <div className="grid h-full grid-cols-[auto_1fr] items-center gap-4">
          <div>
            <div className="mc-lbl">train loss</div><div className="mc-big">{last?.toFixed(2) ?? '—'}</div>
            <div className="mc-lbl mt-1.5">eval <span className="mc-ok">{lastEval?.toFixed(2) ?? '—'}</span></div>
          </div>
          <div className="h-full min-h-16"><LossChart main={{ id: job.id, label: '', events }} height={90} /></div>
        </div>
      )}
    </Tile>
  )
}

// Where each suggested step is done in this studio.
const NEXT_VIEW: Record<Target, [string, string]> = {
  knowledge: ['know', 'F2'], inbox: ['know', 'F2'], practice: ['data', 'F3'], loop: ['data', 'F3'], train: ['train', 'F4'], results: ['eval', 'F5'],
}

function NextTile({ m, style }: { m: Mission; style?: React.CSSProperties }) {
  const pid = m.project.id
  const navigate = useNavigate()
  const { data: graph } = usePolling(() => api.pipeline(pid), 15000, [pid])
  const { data: held } = usePolling(() => api.reviewQueue(pid).catch(() => []), 15000, [pid])
  const steps = graph ? nextSteps(graph, held?.length ?? 0) : []
  return (
    <Tile title="Next" right={graph ? (steps.length ? `${steps.length} TO DO` : 'ALL CLEAR') : undefined} style={style}>
      {graph && !steps.length && <div className="mc-dim">nothing waiting on you.</div>}
      <div className="mc-list grid-cols-[auto_1fr_auto]">
        {steps.map((x) => {
          const [view, key] = NEXT_VIEW[x.target]
          return (
            <Fragment key={x.id}>
              <span className={x.tone === 'pri' ? 'mc-am' : 'mc-dim'}>›</span>
              <button type="button" className="text-left hover:underline" title={x.detail} onClick={() => navigate(`/console/${view}`)}>{x.title}</button>
              <span className="mc-dim">{key}</span>
            </Fragment>
          )
        })}
      </div>
    </Tile>
  )
}

export function ChatView({ m }: { m: Mission }) {
  return (
    <div className="mc-grid" style={grid('1.7fr 1fr 1fr', 'auto auto 1fr 1fr')}>
      <ChatTile m={m} style={{ gridRow: 'span 4' }} />
      <SystemTile m={m} />
      <ModelsTile m={m} style={{ gridRow: 'span 2' }} />
      <NextTile m={m} />
      <LastRunTile m={m} style={{ gridColumn: 'span 2' }} />
      <QueueTile m={m} style={{ gridColumn: 'span 2' }} />
    </div>
  )
}

// ---- F2 knowledge -------------------------------------------------------------------------------------

export function KnowView({ m }: { m: Mission }) {
  const pid = m.project.id
  const { data: docs } = usePolling<KBDocument[]>(() => api.documents(pid), 5000, [pid])
  const { data: sources } = usePolling<Source[]>(() => api.sources(pid), 5000, [pid])
  const { data: held } = usePolling(() => api.reviewQueue(pid), 10000, [pid])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [took, setTook] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const search = async (e: FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setErr(null)
    try {
      const r = await api.search(pid, q.trim(), 6)
      setHits(r.results)
      setTook(`${r.mode.toUpperCase()} · ${r.total_ms} MS`)
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)) }
  }
  const chunks = docs?.reduce((a, d) => a + d.chunk_count, 0) ?? 0
  return (
    <div className="mc-grid" style={grid('1.3fr 1fr', '1.2fr 1fr')}>
      <Tile title="Documents" fkey="F2" right={`${docs?.length ?? 0} docs · ${chunks} chunks`} style={{ gridRow: 'span 2' }}>
        <div className="mc-list grid-cols-[auto_1fr_auto_auto]">
          {docs?.map((d) => (
            <Fragment key={d.id}>
              <span className={d.status === 'ready' ? 'mc-ok' : d.status === 'failed' ? 'mc-bad' : 'mc-am'}>{d.status === 'ready' ? '●' : d.status === 'failed' ? '×' : '◌'}</span>
              <span title={d.error ?? undefined}>{d.filename}</span>
              <span className="mc-dim">{d.status === 'ready' ? `${d.chunk_count} ch` : d.status}</span>
              <span className="mc-dim">{(d.size_bytes / 1024).toFixed(0)}K</span>
            </Fragment>
          ))}
        </div>
        {docs?.length === 0 && <div className="mc-dim">empty. drop files into the chat, or watch a folder (F3 has the loop).</div>}
      </Tile>
      <Tile title="Search" right={took}>
        {!m.wall && (
          <form onSubmit={search} className="mb-2 flex items-center gap-2"><span className="mc-am">?</span>
            <input className="mc-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search the knowledge base" aria-label="Search" />
          </form>
        )}
        {err && <div className="mc-bad">{err}</div>}
        <div className="space-y-1.5 text-[11.5px]">
          {hits?.map((h) => (
            <div key={h.id}><span className="mc-am">{h.score.toFixed(2)}</span> <span className="mc-am2">{h.filename}#{h.chunk_index + 1}</span>
              <div className="mc-dim line-clamp-2">{h.text.replace(/\s+/g, ' ')}</div></div>
          ))}
          {hits?.length === 0 && <div className="mc-dim">no matches</div>}
        </div>
      </Tile>
      <Tile title="Inbox" right={held?.length ? <span className="mc-bad">{held.length} HELD</span> : 'WATCHING'}>
        {!sources?.length ? <div className="mc-dim">no watched folders. set one up on the Classic Inbox page.</div> : (
          <div className="mc-list grid-cols-[auto_1fr_auto]">
            {sources.map((s) => (
              <Fragment key={s.id}>
                <span className={!s.enabled ? 'mc-dim' : s.last_error ? 'mc-bad' : 'mc-ok'}>{s.enabled ? '●' : '○'}</span>
                <span>{s.name} <span className="mc-dim">{s.kind === 'bucket' ? `s3://${s.bucket}/${s.prefix ?? ''}` : s.kind === 'web' ? s.path : s.folder}{s.mode === 'learn' ? ' · LEARN' : ''}</span></span>
                <span className="mc-dim">{s.counts.added ?? 0} in{s.counts.quarantined ? ` · ${s.counts.quarantined} held` : ''}</span>
              </Fragment>
            ))}
          </div>
        )}
        {held?.slice(0, 4).map((f) => <div key={f.id} className="mc-bad mt-1 truncate">! {f.relpath}: {f.findings?.map((x) => x.label).join(', ')}</div>)}
      </Tile>
    </div>
  )
}

// ---- F3 data ---------------------------------------------------------------------------------------------

function splitBar(d: Dataset) {
  const s = d.splits
  if (!s) return null
  const total = s.train + s.val + s.test || 1
  const w = 20
  const tr = Math.round((s.train / total) * w), va = Math.round((s.val / total) * w)
  return <span className="tracking-[-.5px]"><span className="mc-am">{'█'.repeat(tr)}</span><span className="mc-ok">{'█'.repeat(va)}</span><span className="mc-am2">{'█'.repeat(Math.max(0, w - tr - va))}</span></span>
}

export function DataView({ m }: { m: Mission }) {
  const pid = m.project.id
  const { data: datasets } = usePolling<Dataset[]>(() => api.datasets(pid), 5000, [pid])
  const { data: loop } = usePolling<LoopState>(() => api.loop(pid), 10000, [pid])
  const [pick, setPick] = useState<number | null>(null)
  const selected = datasets?.find((d) => d.id === pick) ?? datasets?.[0]
  const { data: rows } = usePolling(() => (selected ? api.datasetRows(pid, selected.id, { limit: 8 }) : Promise.resolve(null)), 15000, [pid, selected?.id])
  const next = loop?.loop.enabled && loop.loop.next_run_at ? parseUtc(loop.loop.next_run_at) : null
  return (
    <div className="mc-grid" style={grid('1fr 1.3fr', '1.2fr 1fr')}>
      <Tile title="Datasets" fkey="F3" right={`${datasets?.length ?? 0}`} style={{ gridRow: 'span 2' }}>
        <div className="mc-list grid-cols-[1fr_auto_auto]">
          {datasets?.map((d) => (
            <div key={d.id} className={`contents mc-row ${selected?.id === d.id ? 'mc-sel' : ''}`} onClick={() => setPick(d.id)}>
              <span>{d.name}{d.status !== 'ready' && <span className="mc-am"> · {d.status}</span>}</span>
              <span>{splitBar(d)}</span>
              <span className="mc-dim tabular-nums">{d.row_count}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[11px] mc-dim"><span className="mc-am">█</span> train <span className="mc-ok">█</span> val <span className="mc-am2">█</span> test</div>
      </Tile>
      <Tile title={`rows · ${selected?.name ?? '—'}`} right={rows ? `${rows.total} total` : undefined}>
        <div className="space-y-2.5 text-[11.5px]">
          {rows?.rows.map((r, i) => {
            const q = r.messages.find((x) => x.role === 'user')?.content ?? ''
            const a = r.messages.find((x) => x.role === 'assistant')?.content ?? ''
            return <div key={i}><div><span className="mc-am">Q</span> {q}</div><div className="mc-am2"><span className="mc-ok">A</span> {a}</div></div>
          })}
          {!rows?.rows.length && <div className="mc-dim">no rows</div>}
        </div>
      </Tile>
      <Tile title="Learning loop" right={loop?.loop.enabled ? <span className="mc-ok">ON</span> : 'OFF'}>
        {loop && (
          <div className="space-y-1.5 text-[11.5px]">
            <div><span className="mc-am2">NEXT </span>{next ? next.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
              <span className="mc-am2"> · LEARNS </span>{loop.dataset?.name ?? '—'}</div>
            {loop.runs.slice(0, 5).map((r) => (
              <div key={r.id} className="truncate"><span className={r.status === 'promoted' ? 'mc-ok' : r.status === 'failed' ? 'mc-bad' : 'mc-am2'}>{r.status.toUpperCase().padEnd(9)}</span>
                <span className="mc-dim">#{r.id} </span>{r.candidate_f1 != null ? `F1 ${r.candidate_f1.toFixed(2)}${r.baseline_f1 != null ? ` vs ${r.baseline_f1.toFixed(2)}` : ''}` : (r.reason ?? '')}</div>
            ))}
            {!loop.runs.length && <div className="mc-dim">no runs yet</div>}
          </div>
        )}
      </Tile>
    </div>
  )
}

// ---- F4 train ---------------------------------------------------------------------------------------------

function useOverlays(jobs: Job[], skip: number | null, n = 3): Series[] {
  const done = useMemo(() => jobs.filter((j) => j.kind === 'train' && j.status === 'done' && j.id !== skip).slice(0, n), [jobs, skip, n])
  const [cache, setCache] = useState<Record<number, JobEvent[]>>({})
  useEffect(() => {
    for (const j of done) {
      if (cache[j.id]) continue
      api.jobMetrics(j.id).then((ev) => setCache((c) => ({ ...c, [j.id]: ev }))).catch(() => {})
    }
  }, [done, cache])
  return done.filter((j) => cache[j.id]).map((j) => ({ id: j.id, label: `#${j.id}`, events: cache[j.id] }))
}

export function TrainView({ m, follow = false }: { m: Mission; follow?: boolean }) {
  const trains = m.jobs.filter((j) => j.kind === 'train')
  const [pick, setPick] = useState<number | null>(null)
  const auto = trains.find((j) => j.status === 'running') ?? trains[0]
  const job = (follow ? auto : trains.find((j) => j.id === pick) ?? auto) ?? null
  const { lines, events } = useJobStream(job?.id ?? null)
  const [overlay, setOverlay] = useState(true)
  const overlays = useOverlays(m.jobs, job?.id ?? null)
  const ft = m.finetunes.find((f) => f.job_id === job?.id)
  const losses = events.filter((e) => e.type === 'metric' && typeof e.loss === 'number')
  const evals = events.filter((e) => e.type === 'metric' && typeof e.eval_loss === 'number')
  const first = losses[0]?.loss as number | undefined, last = losses[losses.length - 1]?.loss as number | undefined
  const firstEval = evals[0], lastEval = evals[evals.length - 1]
  const prog = lastProgress(events)
  const cfg = (job?.config ?? {}) as Record<string, unknown>
  const perStep = /([\d.]+)s\/step/.exec(prog?.message ?? '')?.[1]
  const idx = trains.findIndex((j) => j.id === job?.id)
  const step = (d: number) => { const t = trains[idx + d]; if (t) setPick(t.id) }
  const latestEval = m.evals.find((e) => e.status === 'done' && e.summary)
  const readout = (label: string, big: ReactNode, sub: ReactNode, color?: string) => (
    <Tile title={label}><div className="mc-big" style={color ? { color } : undefined}>{big}</div><div className="mc-lbl mt-1.5">{sub}</div></Tile>
  )

  return (
    <div className="mc-grid" style={grid('repeat(4, 1fr)', 'auto 1fr minmax(120px, 30%)')}>
      {readout('train loss', last?.toFixed(2) ?? '—', first != null && last != null ? `${last <= first ? '▼' : '▲'} ${Math.abs(first - last).toFixed(2)} from step ${losses[0].step}` : 'waiting')}
      {readout('eval loss', (lastEval?.eval_loss as number | undefined)?.toFixed(2) ?? '—',
        firstEval && lastEval && firstEval !== lastEval ? `▼ ${((firstEval.eval_loss as number) - (lastEval.eval_loss as number)).toFixed(2)} from step ${firstEval.step}` : evals.length ? `at step ${lastEval.step}` : 'no eval yet', 'var(--mc-grn)')}
      {readout('steps', <>{prog?.current ?? 0}<span className="text-[18px] mc-dim">/{String(prog?.total ?? cfg.total_steps ?? '?')}</span></>,
        `${cfg.epochs ?? '?'} epoch${cfg.epochs === 1 ? '' : 's'}${cfg.train_examples ? ` · ${cfg.train_examples} examples` : ''}`)}
      {readout('runtime', mmss(elapsed(job)), `${String(cfg.device ?? 'cpu').toUpperCase()}${perStep ? ` · ${perStep} s/step` : ''}`)}
      <Tile title={job ? `train #${job.id}${ft ? ` · ${ft.name}` : ''}` : 'train'} fkey="F4" style={{ gridColumn: 'span 3' }} bodyClass="!p-2"
            right={<>
              {!follow && trains.length > 1 && <><button type="button" className="mc-tag" onClick={() => step(1)} disabled={idx >= trains.length - 1}>‹</button> <button type="button" className="mc-tag" onClick={() => step(-1)} disabled={idx <= 0}>›</button> </>}
              <span className="mc-am">━ TRAIN</span> <span className="mc-ok">╍ EVAL</span>{' '}
              {!follow && <button type="button" className={`mc-tag ${overlay ? 'on' : ''}`} onClick={() => setOverlay((o) => !o)} title="Show earlier runs">+{overlays.length} RUNS</button>}
            </>}>
        <LossChart main={job ? { id: job.id, label: '', events } : null} overlays={overlay || follow ? overlays : []} />
      </Tile>
      <Scoreboard run={latestEval} fkey="F5" />
      <Tile title={job ? `log tail · job #${job.id}` : 'log tail'} fkey="F6" right={job?.status === 'running' ? <span className="mc-ok">FOLLOW ●</span> : (job?.status ?? '').toUpperCase()} style={{ gridColumn: 'span 4' }}>
        <LogTail lines={lines} max={200} />
      </Tile>
    </div>
  )
}

// ---- F5 eval -------------------------------------------------------------------------------------------------

export function EvalView({ m }: { m: Mission }) {
  const pid = m.project.id
  const [pick, setPick] = useState<number | null>(null)
  const run = m.evals.find((e) => e.id === pick) ?? m.evals.find((e) => e.summary) ?? m.evals[0]
  const { data: detail } = usePolling(() => (run ? api.evalRun(pid, run.id) : Promise.resolve(null)), 15000, [pid, run?.id, run?.status])
  const rows = run?.summary ? Object.entries(run.summary).sort((a, b) => (b[1].f1 ?? 0) - (a[1].f1 ?? 0)) : []
  return (
    <div className="mc-grid" style={grid('1fr 1.6fr', 'auto 1fr')}>
      <Tile title={run ? `scoreboard · ${run.name}` : 'scoreboard'} fkey="F5" right={run ? `${run.examples} questions · ${run.split}` : undefined} style={{ gridColumn: 'span 2' }}>
        {!rows.length ? <div className="mc-dim">{run ? `evaluation ${run.status}` : 'no evaluations yet. /compare in the Chat studio.'}</div> : (
          <div className="mc-list grid-cols-[minmax(0,1.4fr)_auto_auto_auto_auto] gap-x-4 text-[12px]">
            <span className="mc-lbl">variant</span><span className="mc-lbl">f1</span><span className="mc-lbl" /><span className="mc-lbl">rouge-l</span><span className="mc-lbl">judge</span>
            {rows.map(([label, v], i) => (
              <Fragment key={label}>
                <span className={i === 0 ? 'mc-am' : ''}>{label.toUpperCase()}</span>
                <Blocks value={v.f1 ?? 0} width={28} />
                <span className="tabular-nums">{(v.f1 ?? 0).toFixed(3)}</span>
                <span className="tabular-nums mc-am2">{(v.rouge_l ?? 0).toFixed(3)}</span>
                <span className="tabular-nums mc-am2">{v.judge != null ? v.judge.toFixed(1) : '—'}</span>
              </Fragment>
            ))}
          </div>
        )}
      </Tile>
      <Tile title="Evaluations" right={`${m.evals.length}`}>
        <div className="mc-list grid-cols-[auto_1fr_auto]">
          {m.evals.map((e) => (
            <div key={e.id} className={`contents mc-row ${run?.id === e.id ? 'mc-sel' : ''}`} onClick={() => setPick(e.id)}>
              <span className="mc-dim">#{e.id}</span><span>{e.name}</span><span className={e.status === 'done' ? 'mc-ok' : e.status === 'failed' ? 'mc-bad' : 'mc-am'}>{e.status.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </Tile>
      <Tile title="Answers" right={detail?.results ? `${detail.results.length} shown` : undefined}>
        <div className="space-y-3 text-[11.5px]">
          {detail?.results?.slice(0, 6).map((r) => (
            <div key={r.index}>
              <div><span className="mc-am">Q</span> {r.question}</div>
              <div className="mc-ok"><span className="mc-dim">REF</span> {r.reference}</div>
              {Object.entries(r.outputs).map(([label, o]) => (
                <div key={label} className="mc-am2 line-clamp-2"><span className="mc-dim">{label.slice(0, 18).toUpperCase()} {o.f1.toFixed(2)}</span> {o.answer}</div>
              ))}
            </div>
          ))}
        </div>
      </Tile>
    </div>
  )
}

// ---- F6 logs -----------------------------------------------------------------------------------------------------

export function LogsView({ m }: { m: Mission }) {
  const [pick, setPick] = useState<number | null>(null)
  const auto = m.jobs.find((j) => j.status === 'running') ?? m.jobs[0]
  const job = m.jobs.find((j) => j.id === pick) ?? auto
  const { lines } = useJobStream(job?.id ?? null)
  const server = m.appLogs.slice(-150).map((l) => `${new Date(l.ts * 1000).toLocaleTimeString([], { hour12: false })}  ${l.level.padEnd(7)} ${l.message}`)
  return (
    <div className="mc-grid" style={grid('minmax(260px, 1fr) 3fr', '2fr 1fr')}>
      <QueueTile m={m} style={{ gridRow: 'span 2' }} onPick={setPick} selected={job?.id ?? null} />
      <Tile title={job ? `job #${job.id} · ${KIND[job.kind] ?? job.kind}` : 'job log'} fkey="F6" right={job?.status === 'running' ? <span className="mc-ok">FOLLOW ●</span> : job?.status?.toUpperCase()}>
        <LogTail lines={lines} max={1000} />
      </Tile>
      <Tile title="Server log"><LogTail lines={server} max={150} empty="quiet" /></Tile>
    </div>
  )
}

// ---- F7 models -----------------------------------------------------------------------------------------------------

export function ModelsView({ m }: { m: Mission }) {
  return (
    <div className="mc-grid" style={grid('1fr 1.2fr 1fr', '1fr')}>
      <Tile title="Served models" fkey="F7">
        {m.providers?.map((p) => (
          <div key={p.provider.id} className="mb-3">
            <div className="mc-am2">{p.provider.name.toUpperCase()} <span className={p.reachable ? 'mc-ok' : 'mc-bad'}>{p.reachable ? '● LINK' : '× DOWN'}</span></div>
            <div className="mc-list mt-1 grid-cols-[1fr_auto_auto]">
              {p.models.map((x) => (
                <Fragment key={x.name}><span>{x.name}</span><span className="mc-dim">{x.parameters ?? (x.embedding ? 'embed' : '')}</span><span className="mc-dim">{x.size_gb != null ? gb(x.size_gb) : ''}</span></Fragment>
              ))}
            </div>
            {!p.reachable && p.error && <div className="mc-bad mt-1 text-[11px]">{p.error}</div>}
          </div>
        ))}
      </Tile>
      <Tile title="Adapters" right="★ CURRENT">
        <div className="mc-list grid-cols-[auto_1fr_auto_auto]">
          {m.finetunes.map((f) => (
            <Fragment key={f.id}>
              <span className={f.promoted_at ? 'mc-am' : 'mc-dim'}>{f.promoted_at ? '★' : '·'}</span>
              <span>{f.name}</span>
              <span className={f.status === 'ready' ? 'mc-ok' : f.status === 'failed' ? 'mc-bad' : 'mc-am'}>{f.status.toUpperCase()}</span>
              <span className="mc-dim tabular-nums">{f.metrics?.train_loss != null ? f.metrics.train_loss.toFixed(3) : ''}</span>
            </Fragment>
          ))}
        </div>
        {!m.finetunes.length && <div className="mc-dim">no fine-tunes yet</div>}
      </Tile>
      <SystemTile m={m} />
    </div>
  )
}

// ---- F8 alerts and display ----------------------------------------------------------------------------------------

export function AlertsView({ m }: { m: Mission }) {
  const [cfg, setCfg] = useState<NotifyConfig | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    api.notify().then((c) => { setCfg(c); setUrl(c.url); setEvents(c.events) }).catch((e) => setNote(String(e)))
  }, [])
  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    setNote(null)
    try {
      const c = await api.saveNotify({ url, events, ...(token ? { token } : {}) })
      setCfg(c)
      setToken('')
      setNote('saved')
      return true
    } catch (x) { setNote(x instanceof Error ? x.message.replace(/^\d+: /, '') : String(x)); return false }
  }
  const test = async () => {
    if (!(await save())) return
    try { await api.testNotify(); setNote('sent. check your phone.') } catch (x) { setNote(x instanceof Error ? x.message.replace(/^\d+: /, '') : String(x)) }
  }
  const flip = (k: string) => setEvents((ev) => (ev.includes(k) ? ev.filter((x) => x !== k) : [...ev, k]))
  return (
    <div className="mc-grid" style={grid('1.3fr 1fr', '1fr')}>
      <Tile title="Alerts · ntfy" fkey="F8" right={cfg?.url ? <span className="mc-ok">ON</span> : 'OFF'}>
        <form onSubmit={save} className="max-w-xl space-y-3 text-[12px]">
          <label className="block"><span className="mc-lbl">topic url</span>
            <input className="mc-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ntfy.sh/pick-a-hard-to-guess-topic" /></label>
          <label className="block"><span className="mc-lbl">access token (optional)</span>
            <input className="mc-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg?.token_set ? '•••••••• set. type to replace' : 'for a protected topic'} autoComplete="off" /></label>
          <div>
            <div className="mc-lbl mb-1">buzz me when</div>
            {cfg && Object.entries(cfg.available).map(([k, label]) => (
              <button key={k} type="button" onClick={() => flip(k)} className="block text-left hover:text-[var(--mc-hi)]">
                <span className="mc-am">[{events.includes(k) ? 'x' : ' '}]</span> {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2"><button type="submit" className="mc-btn">save</button><button type="button" className="mc-btn" onClick={test} disabled={!url}>send test</button></div>
          {note && <div className={note === 'saved' || note.startsWith('sent') ? 'mc-ok' : 'mc-bad'}>{note}</div>}
        </form>
      </Tile>
      <Tile title="Display">
        <div className="space-y-3 text-[12px]">
          <button type="button" className="block text-left" onClick={() => m.setContrast(!m.contrast)}><span className="mc-am">[{m.contrast ? 'x' : ' '}]</span> readable contrast <span className="mc-dim">(C)</span></button>
          <button type="button" className="block text-left" onClick={() => m.setScanlines(!m.scanlines)}><span className="mc-am">[{m.scanlines ? 'x' : ' '}]</span> scanlines</button>
          <div className="mc-dim leading-relaxed">
            F9 (or W) turns this screen into a read-only wall display that follows the running job. ESC comes back.
            Number keys 1–9 work too, for keyboards without function keys.
          </div>
          <div className="mc-dim leading-relaxed">
            ntfy: install the app on your phone and subscribe to the same topic. ntfy.sh is free; anyone who knows the topic
            name can read it, so pick a long one, or run your own ntfy server and use a token.
          </div>
        </div>
      </Tile>
    </div>
  )
}

// ---- F9 wall --------------------------------------------------------------------------------------------------------

export function WallView({ m }: { m: Mission }) {
  return <TrainView m={m} follow />
}

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Send, X } from 'lucide-react'
import { api, defaultModel, uploadDocuments, type KBDocument, type PipelineGraph, type SearchHit, type SourceMode } from '../../api'
import { metricRows } from '../../components/LossChart'
import { stripAnsi } from '../../components/ansi'
import { fmtTime } from '../../components/ui'
import { useJobStream } from '../../hooks/streams'
import { useProject } from '../../hooks/project'
import { startingConversation, useChatSession } from '../chat/useChatSession'
import { COLOR, type CardData } from './graph'
import { ICON } from './NodeCard'

type Say = (msg: string) => void
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))

function Kpis({ items }: { items: [string, ReactNode][] }) {
  return <div className="cv-kpis">{items.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
}

function Params({ items }: { items: [string, ReactNode][] }) {
  return <div className="cv-params">{items.map(([k, v]) => <FragmentRow key={k} k={k} v={v} />)}</div>
}
function FragmentRow({ k, v }: { k: string; v: ReactNode }) {
  return <><span>{k}</span><b className="text-right font-semibold">{v}</b></>
}

/** Train loss (magenta) and eval loss (teal) on the light canvas. */
function MiniLoss({ events }: { events: Parameters<typeof metricRows>[0] }) {
  const rows = useMemo(() => metricRows(events), [events])
  const train = rows.filter((r) => r.loss != null), ev = rows.filter((r) => r.eval_loss != null)
  if (train.length < 2) return <div className="rounded-lg bg-[var(--soft)] py-8 text-center text-xs text-[var(--mu)]">The loss chart appears after the first steps.</div>
  const W = 356, H = 150, L = 30, B = 18
  const all = [...train.map((r) => r.loss!), ...ev.map((r) => r.eval_loss!)]
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1
  const maxStep = Math.max(...rows.map((r) => r.step), 1)
  const x = (s: number) => L + ((W - L - 6) * s) / maxStep
  const y = (v: number) => 6 + ((H - B - 12) * (hi - v)) / span
  const path = (pts: [number, number][]) => pts.map(([s, v], i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Loss by step">
      {[hi, (hi + lo) / 2, lo].map((t) => (
        <g key={t}><line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#eceef2" /><text x={L - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill="#8a92a2">{t.toFixed(2)}</text></g>
      ))}
      <text x={W - 6} y={H - 4} fontSize="9" textAnchor="end" fill="#8a92a2">step {maxStep}</text>
      <path d={path(train.map((r) => [r.step, r.loss!]))} fill="none" stroke="var(--c-ft)" strokeWidth="2" />
      {ev.length > 0 && <path d={path(ev.map((r) => [r.step, r.eval_loss!]))} fill="none" stroke="var(--c-kb)" strokeWidth="2" strokeDasharray="5 4" />}
      {ev.map((r) => <circle key={r.step} cx={x(r.step)} cy={y(r.eval_loss!)} r="3" fill="var(--c-kb)" />)}
    </svg>
  )
}

export function JobLog({ jobId }: { jobId: number | null | undefined }) {
  const { lines, job } = useJobStream(jobId ?? null)
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [lines.length])
  if (!jobId) return <p className="text-xs text-[var(--mu)]">No job yet.</p>
  return (
    <>
      <div className="text-xs text-[var(--mu)]">Job #{jobId} · {job?.status ?? '…'}</div>
      <pre ref={ref} className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-[#0f172a] p-3 font-mono text-[11px] leading-relaxed text-[#cbd5e1]">
        {lines.slice(-300).map((l) => stripAnsi(l.split('\r').filter(Boolean).pop() ?? '')).join('\n') || 'No output yet.'}
      </pre>
    </>
  )
}

// ---- panels -----------------------------------------------------------------------------------------

function SourcePanel({ g, id, pid, say, changed }: { g: PipelineGraph; id: number; pid: number; say: Say; changed: () => void }) {
  const s = g.sources.find((x) => x.id === id)
  const [busy, setBusy] = useState(false)
  if (!s) return null
  const look = async () => {
    setBusy(true)
    try {
      const r = await api.scanSource(pid, s.id)
      const parts = Object.entries(r.processed ?? {}).map(([k, n]) => `${n} ${k}`)
      say(parts.length ? `${s.name}: ${parts.join(', ')}` : `${s.name}: nothing new`)
    } catch (e) { say(errText(e)) }
    setBusy(false)
    changed()
  }
  return (
    <>
      <Kpis items={[['Added', s.counts.added ?? 0], ['Held', s.counts.quarantined ?? 0], ['Waiting', s.counts.waiting ?? 0]]} />
      <Params items={[[s.kind === 'bucket' ? 'Bucket' : s.kind === 'web' ? 'Pages' : 'Folder', <code key="p" className="break-all text-[11.5px]">{s.path}</code>], ['New files', s.mode === 'learn' ? 'Index, then write Q&A' : 'Index'],
        ['Checks', { all: 'Secrets and personal data', secrets: 'Secrets only', off: 'None' }[s.scan]], ['Last look', s.last_scan_at ? fmtTime(s.last_scan_at) : 'not yet']]} />
      {s.last_error && <p className="text-xs text-[var(--bad)]">{s.last_error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="cv-btn pri" disabled={busy} onClick={look}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Look now</button>
        <Link className="cv-btn" to="/inbox">Review and settings</Link>
      </div>
    </>
  )
}

function AddSourcePanel({ pid, say, changed }: { pid: number; say: Say; changed: () => void }) {
  const [folder, setFolder] = useState('')
  const [mode, setMode] = useState<SourceMode>('remember')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const s = await api.createSource(pid, { folder, mode, scan: 'all' })
      say(`Watching ${s.path}`)
      changed()
    } catch (x) { say(errText(x)) }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[13px] text-[var(--mu)]">Files copied into this folder, or onto a network share pointed at it, join the knowledge base by themselves after a check for secrets and personal data.</p>
      <label className="block text-xs font-semibold text-[var(--mu)]">Folder inside the inbox<input className="cv-input mt-1" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="contracts" required /></label>
      <label className="block text-xs font-semibold text-[var(--mu)]">New files
        <select className="cv-input mt-1" value={mode} onChange={(e) => setMode(e.target.value as SourceMode)}>
          <option value="remember">Add to the knowledge base</option><option value="learn">Add, and write practice Q&A</option>
        </select>
      </label>
      <button className="cv-btn pri" type="submit">Start watching</button>
    </form>
  )
}

function DocsPanel({ pid, say, changed }: { pid: number; say: Say; changed: () => void }) {
  const [docs, setDocs] = useState<KBDocument[] | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const load = () => api.documents(pid).then(setDocs).catch(() => {})
  useEffect(() => { load() }, [pid]) // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (files: File[]) => {
    if (!files.length) return
    setProgress(0)
    try {
      const r = await uploadDocuments(pid, files, setProgress)
      say(`Added ${r.documents.length - r.held.length} file${r.documents.length - r.held.length === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}${r.held.length ? `, held back ${r.held.length} that may be private (decide on the Knowledge page)` : ''}`)
    } catch (e) { say(errText(e)) }
    setProgress(null)
    load()
    changed()
  }
  return (
    <>
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(Array.from(e.dataTransfer.files)) }}
           className="rounded-lg border border-dashed border-[#aab2c0] px-3 py-4 text-center text-xs text-[var(--mu)]">
        {progress != null ? `Uploading… ${Math.round(progress * 100)}%` : <>Drop files here or <button className="font-bold text-[var(--sel)]" onClick={() => input.current?.click()}>choose</button></>}
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      </div>
      <ul className="divide-y divide-[var(--ln)] text-[12.5px]">
        {docs?.slice(0, 25).map((d) => (
          <li key={d.id} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate">{d.filename}</span>
            <span className={`shrink-0 text-[11px] ${d.status === 'failed' ? 'text-[var(--bad)]' : 'text-[var(--mu)]'}`}>{d.status === 'ready' ? `${d.chunk_count} chunks` : d.status}</span>
          </li>
        ))}
      </ul>
      <Link className="text-xs font-bold text-[var(--sel)]" to="/knowledge">All documents in Classic</Link>
    </>
  )
}

function KbPanel({ g, pid }: { g: PipelineGraph; pid: number }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const search = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    try { setHits((await api.search(pid, q, 5)).results) } catch (x) { setErr(errText(x)) }
  }
  return (
    <>
      <Kpis items={[['Chunks', g.knowledge.chunks], ['Documents', g.documents.count], ['From folders', g.documents.from_sources]]} />
      <Params items={[['Embeddings', g.knowledge.embed_model]]} />
      <form onSubmit={search} className="flex gap-2"><input className="cv-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Test a search" /><button className="cv-btn" type="submit">Search</button></form>
      {err && <p className="text-xs text-[var(--bad)]">{err}</p>}
      {hits?.map((h) => (
        <div key={h.id} className="rounded-lg border border-[var(--ln)] p-2.5 text-[12px]">
          <div className="mb-1 flex justify-between font-semibold"><span className="truncate">{h.filename}</span><span className="text-[var(--mu)]">{h.score.toFixed(2)}</span></div>
          <div className="line-clamp-3 text-[var(--mu)]">{h.text}</div>
        </div>
      ))}
    </>
  )
}

function ChatPanel() {
  const { current } = useProject()
  const session = useChatSession(current)
  const [text, setText] = useState('')
  const [opened, setOpened] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!opened && !session.active && session.conversations.length) { setOpened(true); session.open(startingConversation(session.conversations)!) }
  }, [opened, session])
  const msgs = (session.active?.messages ?? []).filter((m) => m.role !== 'event').slice(-8)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length, session.pending?.answer])
  const send = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { session.send(text.trim()); setText('') } }
  const Bubble = ({ role, content, sources }: { role: string; content: string; sources?: SearchHit[] | null }) => role === 'user'
    ? <div className="ml-auto max-w-[85%] rounded-[14px_14px_4px_14px] bg-[#eef2ff] px-3 py-2 font-semibold text-[#1e2a5a]">{content}</div>
    : (
      <div className="text-[13.5px] leading-relaxed">
        <div className="whitespace-pre-wrap">{content}</div>
        {!!sources?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sources.slice(0, 3).map((s, i) => (
              <span key={s.id} className="flex items-center gap-1.5 rounded-lg border border-[var(--ln)] px-2 py-0.5 text-[11.5px] font-semibold">
                <i className="grid h-4 w-4 place-items-center rounded bg-[var(--c-doc)] text-[9.5px] not-italic text-white">{i + 1}</i>{s.filename}<em className="font-medium not-italic text-[var(--mu)]">{s.score.toFixed(2)}</em>
              </span>
            ))}
          </div>
        )}
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex-1 space-y-3.5 overflow-y-auto">
        {!msgs.length && !session.pending && <p className="text-xs text-[var(--mu)]">Ask about your documents. Answers cite the passages they come from.</p>}
        {msgs.map((m) => <Bubble key={m.id} role={m.role} content={m.content} sources={m.sources} />)}
        {session.pending && <><Bubble role="user" content={session.pending.question} /><Bubble role="assistant" content={session.pending.answer || '…'} sources={session.pending.sources} /></>}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex items-center gap-2 rounded-xl border border-[var(--ln)] px-3 py-2">
        <input className="min-w-0 flex-1 bg-transparent outline-none" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your documents…" disabled={session.streaming} />
        <button type="submit" aria-label="Send" className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ink)] text-white disabled:opacity-40" disabled={session.streaming || !text.trim()}><Send className="h-3.5 w-3.5" /></button>
      </form>
    </div>
  )
}

async function defaultChatModel(g: PipelineGraph): Promise<string | null> {
  if (g.chat.model) return g.chat.model
  const models = await api.models('chat').catch(() => [])
  return defaultModel(models)
}

function DatasetPanel({ g, id, pid, say, changed }: { g: PipelineGraph; id: number; pid: number; say: Say; changed: () => void }) {
  const d = g.datasets.find((x) => x.id === id)
  const [rows, setRows] = useState<{ q: string; a: string }[]>([])
  useEffect(() => {
    api.datasetRows(pid, id, { limit: 5 }).then((r) => setRows(r.rows.map((x) => ({
      q: x.messages.find((m) => m.role === 'user')?.content ?? '', a: x.messages.find((m) => m.role === 'assistant')?.content ?? '',
    })))).catch(() => {})
  }, [pid, id, d?.rows])
  if (!d) return null
  const train = async () => {
    try {
      const opts = await api.trainingOptions()
      const r = await api.createFinetune(pid, { base_model: opts.recommended_base_model, dataset_id: d.id, preset: 'quick', method: 'lora', backend: 'auto', overrides: {} })
      say(`Training ${r.finetune?.name ?? ''} (job #${r.job?.id})`)
      changed()
    } catch (e) { say(errText(e)) }
  }
  const compare = async () => {
    try {
      const model = await defaultChatModel(g)
      if (!model) return say('No chat model is available. Pull one in Ollama first.')
      const r = await api.createEval(pid, { dataset_id: d.id, max_examples: 20, variants: [
        { kind: 'model', ref: model, rag: false }, ...(g.knowledge.chunks ? [{ kind: 'model' as const, ref: model, rag: true }] : []),
      ] })
      say(`Comparing on “${d.name}” (job #${r.job.id})`)
      changed()
    } catch (e) { say(errText(e)) }
  }
  return (
    <>
      <Kpis items={[['Examples', d.rows], ['Train', d.splits?.train ?? '—'], ['Test', d.splits?.test ?? '—']]} />
      <div className="space-y-2.5 text-[12.5px]">
        {rows.map((r, i) => <div key={i} className="rounded-lg bg-[var(--soft)] p-2.5"><div className="font-semibold">{r.q}</div><div className="mt-1 text-[var(--mu)]">{r.a}</div></div>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="cv-btn pri" onClick={train} disabled={!d.splits?.train}>Fine-tune on it</button>
        <button className="cv-btn" onClick={compare} disabled={!d.splits?.test}>Compare models on it</button>
      </div>
    </>
  )
}

function FinetunePanel({ g, id, pid, say, changed }: { g: PipelineGraph; id: number; pid: number; say: Say; changed: () => void }) {
  const ft = g.finetunes.find((x) => x.id === id)
  const [tab, setTab] = useState<'overview' | 'logs'>('overview')
  const { events } = useJobStream(ft?.job_id ?? null)
  if (!ft) return null
  const m = ft.metrics
  const cfg = (ft.config ?? {}) as Record<string, unknown>
  const rows = metricRows(events)
  const lastEval = [...rows].reverse().find((r) => r.eval_loss != null)?.eval_loss ?? m?.eval_loss
  const evaluate = async () => {
    if (ft.dataset_id == null) return
    try {
      const model = await defaultChatModel(g)
      const variants = [{ kind: 'finetune' as const, ref: String(ft.id), rag: false }, ...(model ? [{ kind: 'model' as const, ref: model, rag: g.knowledge.chunks > 0 }] : [])]
      const r = await api.createEval(pid, { dataset_id: ft.dataset_id, max_examples: 20, variants })
      say(`Evaluating ${ft.name} (job #${r.job.id})`)
      changed()
    } catch (e) { say(errText(e)) }
  }
  const rerun = async () => {
    if (ft.dataset_id == null) return
    try {
      const r = await api.createFinetune(pid, { base_model: ft.base_model, dataset_id: ft.dataset_id, preset: String(cfg.preset ?? 'quick'), method: ft.method, backend: 'auto', overrides: {} })
      say(`Re-running as job #${r.job?.id}`)
      changed()
    } catch (e) { say(errText(e)) }
  }
  const promote = async () => {
    try { await (ft.promoted_at ? api.demote(pid, ft.id) : api.promote(pid, ft.id)); changed() } catch (e) { say(errText(e)) }
  }
  const exporting = g.active_jobs.some((j) => j.kind === 'export' && Number(j.config.finetune_id) === ft.id)
  const sendToOllama = async () => {
    try { const r = await api.exportFinetune(pid, ft.id); say(`Building ${r.model} in Ollama (job #${r.job.id}). A minute or two.`); changed() } catch (e) { say(errText(e)) }
  }
  return (
    <>
      <div className="cv-tabs -mx-[18px] -mt-[14px]" role="tablist">
        {(['overview', 'logs'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'overview' ? 'Overview' : 'Logs'}</button>)}
      </div>
      {tab === 'logs' ? <JobLog jobId={ft.job_id} /> : (
        <>
          <Kpis items={[['Train loss', m?.train_loss?.toFixed(2) ?? '—'], ['Eval loss', lastEval != null ? lastEval.toFixed(2) : '—'], ['Steps', m?.steps ?? rows[rows.length - 1]?.step ?? '—']]} />
          <div className="flex gap-3.5 text-[11.5px] font-semibold text-[var(--mu)]">
            <span className="flex items-center gap-1.5"><i className="inline-block h-[3px] w-3 rounded bg-[var(--c-ft)]" />Train</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-[3px] w-3 rounded bg-[var(--c-kb)]" />Eval</span>
          </div>
          <MiniLoss events={events} />
          <Params items={[['Base model', ft.base_model], ['Method', ft.method.toUpperCase()],
            ['LoRA r / alpha', cfg.lora_r ? `${cfg.lora_r} / ${cfg.lora_alpha}` : '—'], ['Learning rate', String(cfg.learning_rate ?? '—')],
            ['Epochs', String(cfg.epochs ?? '—')], ['Device', String(cfg.device ?? '—')]]} />
        </>
      )}
      <div className="cv-acts -mx-[18px] -mb-[14px] mt-auto">
        <button className="cv-btn pri" onClick={evaluate} disabled={ft.status !== 'ready' || ft.dataset_id == null}>Send to Evaluate</button>
        <button className="cv-btn" onClick={promote} disabled={ft.status !== 'ready'}>{ft.promoted_at ? 'Unset current' : 'Make current'}</button>
        <button className="cv-btn" onClick={rerun} disabled={ft.dataset_id == null || ft.status === 'training' || ft.status === 'queued'}>Re-run</button>
        {ft.ollama_model
          ? <a className="cv-btn" href={`/chat?model=${encodeURIComponent(ft.ollama_model)}`}>Chat with it</a>
          : <button className="cv-btn" onClick={sendToOllama} disabled={ft.status !== 'ready' || exporting}>{exporting ? 'Sending to Ollama…' : 'Send to Ollama'}</button>}
      </div>
    </>
  )
}

function EvalPanel({ g, id }: { g: PipelineGraph; id: number }) {
  const e = g.evals.find((x) => x.id === id)
  if (!e) return null
  const rows = Object.entries(e.summary ?? {}).sort((a, b) => (b[1].f1 ?? 0) - (a[1].f1 ?? 0))
  return (
    <>
      {!rows.length && <p className="text-xs text-[var(--mu)]">Evaluation {e.status}…</p>}
      <div className="space-y-3">
        {rows.map(([label, v], i) => (
          <div key={label}>
            <div className="flex justify-between text-[12.5px] font-semibold"><span className="truncate">{label}</span><span className="tabular-nums">{(v.f1 ?? 0).toFixed(3)}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--soft)]"><div className="h-full rounded-full" style={{ width: `${(v.f1 ?? 0) * 100}%`, background: i === 0 ? 'var(--c-ev)' : '#a5b4fc' }} /></div>
            <div className="mt-0.5 text-[11px] text-[var(--mu)]">ROUGE-L {(v.rouge_l ?? 0).toFixed(3)}{v.judge != null ? ` · judge ${v.judge.toFixed(1)}/5` : ''}</div>
          </div>
        ))}
      </div>
      <Link className="text-xs font-bold text-[var(--sel)]" to="/compare">Answers side by side in Classic</Link>
    </>
  )
}

function LoopPanel({ g, pid, say, changed }: { g: PipelineGraph; pid: number; say: Say; changed: () => void }) {
  const l = g.loop
  const run = async () => { try { const r = await api.runLoop(pid); say(`Run #${r.id}: ${r.reason ?? r.status}`); changed() } catch (e) { say(errText(e)) } }
  const toggle = async () => { try { await api.updateLoop(pid, { enabled: !l.enabled }); changed() } catch (e) { say(errText(e)) } }
  return (
    <>
      <p className="text-[13px] text-[var(--mu)]">Trains a new adapter on the learned dataset, scores it against the current one on the same test questions, and promotes it only if it does better.</p>
      <Params items={[['Schedule', l.enabled ? `Nightly, next ${l.next_run_at ? fmtTime(l.next_run_at) : '—'}` : 'Off'], ['Promote if F1 gains more than', l.margin.toFixed(2)], ['Preset', l.preset]]} />
      <ul className="divide-y divide-[var(--ln)] text-[12.5px]">
        {l.runs.map((r) => <li key={r.id} className="py-2"><b className="capitalize">{r.status}</b> <span className="text-[var(--mu)]">· #{r.id} · {fmtTime(r.started_at)}</span><div className="text-[var(--mu)]">{r.reason ?? '…'}</div></li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="cv-btn pri" onClick={run}>Run now</button>
        <button className="cv-btn" onClick={toggle}>{l.enabled ? 'Turn off nightly' : 'Turn on nightly'}</button>
        <Link className="cv-btn" to="/inbox?tab=loop">Settings</Link>
      </div>
    </>
  )
}

// ---- drawer -------------------------------------------------------------------------------------------

export function Drawer({ g, node, pid, onClose, say, changed }: {
  g: PipelineGraph; node: CardData; pid: number; onClose: () => void; say: Say; changed: () => void
}) {
  const Icon = ICON[node.kind]
  const sub: Record<string, string> = {
    source: 'Watched folder', 'add-source': 'New watched folder', docs: 'Everything the knowledge base is built from',
    kb: 'Passages, embeddings and search', chat: 'Chat with your documents', dataset: 'Training examples', finetune: 'LoRA adapter',
    eval: 'Scores on held-out questions', loop: 'Nightly retrain with a promotion gate',
  }
  const ref = node.ref ?? 0
  return (
    <aside className="cv-drawer" aria-label={node.title}>
      <div className="cv-dh">
        <div className="flex items-center gap-2.5">
          <span className="cv-ic" style={{ background: COLOR[node.kind] }}><Icon className="h-3.5 w-3.5" /></span>
          <b className="min-w-0 flex-1 truncate text-base font-extrabold tracking-tight">{node.title}</b>
          <button onClick={onClose} aria-label="Close" className="text-[var(--mu)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="ml-[34px] mt-0.5 text-xs text-[var(--mu)]">{sub[node.kind]}</div>
      </div>
      <div className="cv-body">
        {node.kind === 'source' && <SourcePanel g={g} id={ref} pid={pid} say={say} changed={changed} />}
        {node.kind === 'add-source' && <AddSourcePanel pid={pid} say={say} changed={changed} />}
        {node.kind === 'docs' && <DocsPanel pid={pid} say={say} changed={changed} />}
        {node.kind === 'kb' && <KbPanel g={g} pid={pid} />}
        {node.kind === 'chat' && <ChatPanel />}
        {node.kind === 'dataset' && <DatasetPanel g={g} id={ref} pid={pid} say={say} changed={changed} />}
        {node.kind === 'finetune' && <FinetunePanel g={g} id={ref} pid={pid} say={say} changed={changed} />}
        {node.kind === 'eval' && <EvalPanel g={g} id={ref} />}
        {node.kind === 'loop' && <LoopPanel g={g} pid={pid} say={say} changed={changed} />}
      </div>
    </aside>
  )
}

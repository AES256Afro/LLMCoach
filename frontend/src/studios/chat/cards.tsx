import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, BarChart3, BookOpen, Brain, Check, FileText, Info, Loader2, Play, Terminal, X,
} from 'lucide-react'
import { api, isFinal, type ChatCardData, type Dataset, type DatasetRow, type EvalRun, type FineTune, type HeldFile, type JobStatus } from '../../api'
import { stripAnsi } from '../../components/ansi'
import { HeldFiles } from '../../components/HeldFiles'
import { useProject } from '../../hooks/project'
import type { LocalCard } from './useChatSession'
import { useJobLive } from './useJobLive'

type OnCommand = (name: string, args?: string) => void

function Shell({ icon, title, right, children }: { icon: ReactNode; title: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rise rounded-2xl border border-line bg-card px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-dim text-accent">{icon}</span>
        <div className="min-w-0 flex-1 text-[13.5px] font-medium">{title}</div>
        {right}
      </div>
      {children && <div className="mt-3 space-y-3 pl-[38px]">{children}</div>}
    </div>
  )
}

function StatusChip({ status }: { status: JobStatus | undefined }) {
  if (!status) return <Loader2 className="h-4 w-4 animate-spin text-muted" />
  const map: Record<JobStatus, [string, string]> = {
    queued: ['waiting', 'text-muted'], running: ['running', 'text-warm'], done: ['done', 'text-accent'],
    failed: ['failed', 'text-bad'], cancelled: ['cancelled', 'text-muted'],
  }
  const [label, cls] = map[status]
  return (
    <span className={`flex items-center gap-1.5 text-xs ${cls}`}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status === 'done' && <Check className="h-3.5 w-3.5" />}
      {label}
    </span>
  )
}

function Bar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'warm' | 'bad' }) {
  const bg = tone === 'warm' ? 'bg-warm' : tone === 'bad' ? 'bg-bad' : 'bg-accent'
  return (
    <div className="h-1 overflow-hidden rounded-full bg-panel-2">
      <div className={`h-full rounded-full transition-all duration-500 ${bg}`} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  )
}

function Action({ children, onClick, to }: { children: ReactNode; onClick?: () => void; to?: string }) {
  const cls = 'inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-text hover:border-accent hover:text-accent'
  return to ? <Link to={to} className={cls}>{children}</Link> : <button type="button" onClick={onClick} className={cls}>{children}</button>
}

function fmtBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}

// ---- files dropped into the chat ------------------------------------------------------------

interface LearnInfo { dataset_id: number; dataset_name: string; job_id: number; model: string; review?: boolean }

export function AttachCard({ data, onCommand, onAsk }: { data: ChatCardData; onCommand: OnCommand; onAsk: (q: string) => void }) {
  const docs = (data.documents as { id: number; filename: string; size_bytes: number }[]) ?? []
  const skipped = (data.skipped as { filename: string; reason: string }[]) ?? []
  const held = (data.held as HeldFile[] | undefined) ?? []
  const pid = useProject().current?.id
  const learn = data.learn as LearnInfo | null
  const ingest = useJobLive(data.ingest_job_id as number | null, true)
  const status = ingest.job?.status
  const p = ingest.progress
  const title = docs.length
    ? <>Added {docs.length === 1 ? docs[0].filename : `${docs.length} files`} to the knowledge base</>
    : learn ? <>Learning from files already in the knowledge base</>
    : held.length ? <>Held back {held.length === 1 ? held[0].filename : `${held.length} files`}</> : <>Nothing new was added</>

  return (
    <Shell icon={<BookOpen className="h-4 w-4" />} title={title} right={docs.length ? <StatusChip status={status} /> : undefined}>
      {docs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {docs.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1 text-xs">
              <FileText className="h-3.5 w-3.5 text-muted" />{d.filename}<span className="text-muted">{fmtBytes(d.size_bytes)}</span>
            </span>
          ))}
        </div>
      )}
      {docs.length > 0 && status && !isFinal(status) && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted">{p?.message || (status === 'queued' ? 'Waiting for the job queue…' : 'Reading…')}</div>
          <Bar value={p && p.total ? (p.current + 0.3) / p.total : 0.05} />
        </div>
      )}
      {status === 'done' && docs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Ready. Answers can cite {docs.length === 1 ? 'it' : 'them'} now.</span>
          <Action onClick={() => onAsk(docs.length === 1 ? `Summarize ${docs[0].filename}.` : 'Summarize what the new files cover.')}>Summarize</Action>
        </div>
      )}
      {status === 'failed' && <div className="text-xs text-bad">Indexing failed. <Link className="underline" to={`/jobs/${data.ingest_job_id}`}>See why</Link></div>}
      {skipped.length > 0 && (
        <div className="space-y-0.5 text-xs text-muted">
          {skipped.map((s) => <div key={s.filename}>Skipped {s.filename}: {s.reason}</div>)}
        </div>
      )}
      {held.length > 0 && pid != null && <HeldFiles pid={pid} held={held} />}
      {learn && <LearnBlock learn={learn} onCommand={onCommand} />}
    </Shell>
  )
}

export function LearnCard({ data, onCommand }: { data: ChatCardData; onCommand: OnCommand }) {
  const learn = data.learn as LearnInfo
  return (
    <Shell icon={<Brain className="h-4 w-4" />} title={<>Learning from the knowledge base into “{learn.dataset_name}”</>}>
      <LearnBlock learn={learn} onCommand={onCommand} />
    </Shell>
  )
}

function LearnBlock({ learn, onCommand }: { learn: LearnInfo; onCommand: OnCommand }) {
  const live = useJobLive(learn.job_id, true)
  const status = live.job?.status
  const [dataset, setDataset] = useState<Dataset | null>(null)
  const pairs = [...live.events].reverse().find((e) => e.type === 'metric' && typeof e.pairs === 'number')?.pairs as number | undefined

  useEffect(() => {
    if (status && isFinal(status) && live.job) api.dataset(live.job.project_id!, learn.dataset_id).then(setDataset).catch(() => {})
  }, [status, live.job, learn.dataset_id])

  return (
    <div className="space-y-1.5 rounded-xl border border-line/70 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <Brain className="h-3.5 w-3.5 text-warm" />
        <span className="flex-1">Writing practice Q&amp;A{learn.review ? ' for you to review' : ''} with <code className="text-[11px] text-muted">{learn.model}</code></span>
        <StatusChip status={status} />
      </div>
      {status && !isFinal(status) && (
        <>
          <div className="text-xs text-muted">{status === 'queued' ? 'Starts after indexing finishes…' : live.progress?.message || 'Reading passages…'}</div>
          <Bar tone="warm" value={live.progress && live.progress.total ? (live.progress.current + 0.3) / live.progress.total : 0.04} />
        </>
      )}
      {status === 'done' && learn.review && live.job?.project_id != null && (
        <ReviewBlock pid={live.job.project_id} datasetId={learn.dataset_id} onCommand={onCommand} />
      )}
      {status === 'done' && !learn.review && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>
            {pairs != null ? `${pairs} new pairs. ` : ''}“{learn.dataset_name}” now has <b className="text-text">{dataset?.row_count ?? '…'}</b> examples
            {dataset?.splits ? ` (${dataset.splits.train} train · ${dataset.splits.val} val · ${dataset.splits.test} test)` : ''}.
          </span>
          <Action onClick={() => onCommand('train')}><Play className="h-3 w-3" />Train on it</Action>
        </div>
      )}
      {status === 'failed' && <div className="text-xs text-bad">Learning failed. <Link className="underline" to={`/jobs/${learn.job_id}`}>See why</Link></div>}
    </div>
  )
}

/** Practice Q&A from a "Learn, after I check" drop: untick the wrong ones, keep the rest. */
function ReviewBlock({ pid, datasetId, onCommand }: { pid: number; datasetId: number; onCommand: OnCommand }) {
  const [rows, setRows] = useState<DatasetRow[] | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [off, setOff] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Once accepted or discarded the review dataset is gone, so a 404 means it was already decided.
    api.datasetRows(pid, datasetId, { limit: 200 }).then((r) => setRows(r.rows)).catch(() => setDone('Reviewed.'))
  }, [pid, datasetId])

  const text = (r: DatasetRow, role: 'user' | 'assistant') => r.messages.find((m) => m.role === role)?.content ?? ''
  const toggle = (i: number) => setOff((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  const decide = async (indexes: number[]) => {
    setBusy(true)
    try {
      const r = await api.acceptReview(pid, datasetId, indexes)
      setDone(r.accepted ? `Kept ${r.accepted} in “${r.dataset?.name}”${r.discarded ? `, left out ${r.discarded}` : ''}.` : 'Left them all out.')
    } catch (e) {
      setDone(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
    }
    setBusy(false)
  }

  if (done) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{done}</span>
        {done.startsWith('Kept') && <Action onClick={() => onCommand('train')}><Play className="h-3 w-3" />Train on it</Action>}
      </div>
    )
  }
  if (!rows) return <Loader2 className="h-4 w-4 animate-spin text-muted" />
  const keep = rows.filter((r) => !off.has(r.index)).map((r) => r.index)
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted">{rows.length} pairs. Untick any that are wrong; the rest join “Learned in chat”.</div>
      <ul className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
        {rows.map((r) => (
          <li key={r.index}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-panel-2">
              <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={!off.has(r.index)} onChange={() => toggle(r.index)} />
              <span className={off.has(r.index) ? 'opacity-45' : ''}>
                <span className="block font-medium text-text">{text(r, 'user')}</span>
                <span className="block text-muted">{text(r, 'assistant')}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {keep.length > 0 && !busy && <Action onClick={() => decide(keep)}><Check className="h-3 w-3" />Keep {keep.length}</Action>}
        {!busy && <Action onClick={() => decide([])}><X className="h-3 w-3" />Leave all out</Action>}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
      </div>
    </div>
  )
}

// ---- training ---------------------------------------------------------------------------------

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 180, h = 40, pad = 3
  const lo = Math.min(...values), hi = Math.max(...values)
  const x = (i: number) => pad + ((w - 2 * pad) * i) / (values.length - 1)
  const y = (v: number) => pad + (h - 2 * pad) * (hi === lo ? 0.5 : (hi - v) / (hi - lo))
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-44" role="img" aria-label="Training loss">
      <path d={`${d}L${x(values.length - 1)} ${h}L${x(0)} ${h}Z`} fill="var(--color-accent)" opacity=".14" />
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.6" fill="var(--color-accent)" />
    </svg>
  )
}

export function TrainCard({ data, onCommand }: { data: ChatCardData; onCommand: OnCommand }) {
  const live = useJobLive(data.job_id as number, true)
  const status = live.job?.status
  const [ft, setFt] = useState<FineTune | null>(null)
  const losses = useMemo(() => live.events.filter((e) => e.type === 'metric' && typeof e.loss === 'number').map((e) => e.loss as number), [live.events])
  const lastEval = [...live.events].reverse().find((e) => typeof e.eval_loss === 'number')?.eval_loss as number | undefined

  useEffect(() => {
    if (status && isFinal(status) && live.job?.project_id) api.finetune(live.job.project_id, data.finetune_id as number).then(setFt).catch(() => {})
  }, [status, live.job, data.finetune_id])

  const p = live.progress
  return (
    <Shell icon={<Play className="h-4 w-4" />}
           title={<>Fine-tuning <b className="font-semibold">{String(data.base_model).split('/').pop()}</b> on “{String(data.dataset_name)}”</>}
           right={<StatusChip status={status} />}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Spark values={losses} />
        <div className="space-y-0.5 text-xs text-muted">
          {losses.length > 0 && <div>loss <b className="font-mono text-text">{losses[losses.length - 1].toFixed(3)}</b>{lastEval != null && <> · eval <b className="font-mono text-warm">{lastEval.toFixed(3)}</b></>}</div>}
          <div>{String(data.device).toUpperCase()} · {data.backend === 'unsloth' ? 'Unsloth' : 'TRL + PEFT'} · {String(data.total_steps)} steps</div>
        </div>
      </div>
      {status && !isFinal(status) && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted">{status === 'queued' ? 'Waiting for the job queue…' : p?.message || 'Loading the base model (the first time downloads it)…'}</div>
          <Bar tone="warm" value={p && p.total ? p.current / p.total : 0.03} />
        </div>
      )}
      {status === 'done' && ft?.metrics && (
        <div className="text-xs text-muted">
          Done in {Math.round(ft.metrics.seconds / 60) || '<1'} min · train loss <b className="text-text">{ft.metrics.train_loss.toFixed(3)}</b>
          {ft.metrics.eval_loss != null && <> · eval loss <b className="text-text">{ft.metrics.eval_loss.toFixed(3)}</b></>}.
        </div>
      )}
      {status === 'failed' && <div className="text-xs text-bad">{live.job?.error?.split('\n').filter(Boolean).pop() ?? 'Training failed.'}</div>}
      <div className="flex flex-wrap gap-2">
        {status === 'done' && <Action onClick={() => onCommand('compare')}><BarChart3 className="h-3 w-3" />Compare it</Action>}
        {status && !isFinal(status) && <Action onClick={() => api.cancelJob(data.job_id as number)}><X className="h-3 w-3" />Cancel</Action>}
        <Action to={`/jobs/${data.job_id}`}>Charts &amp; logs</Action>
      </div>
    </Shell>
  )
}

// ---- evaluation --------------------------------------------------------------------------------

function verdict(run: EvalRun): string | null {
  const s = run.summary
  if (!s) return null
  const variants = run.variants
  const base = variants.find((v) => v.kind === 'model' && !v.rag)
  const kb = variants.find((v) => v.kind === 'model' && v.rag)
  const ft = variants.find((v) => v.kind === 'finetune')
  const best = [...variants].sort((a, b) => (s[b.label]?.f1 ?? 0) - (s[a.label]?.f1 ?? 0))[0]
  const parts: string[] = []
  if (base && kb && s[base.label] && s[kb.label]) {
    const a = s[base.label].f1, b = s[kb.label].f1
    parts.push(b > a ? `Your documents lifted F1 from ${a.toFixed(3)} to ${b.toFixed(3)}.` : `Your documents didn't help here (F1 ${a.toFixed(3)} → ${b.toFixed(3)}).`)
  }
  if (ft && s[ft.label] && base && s[base.label]) {
    const f = s[ft.label], b = s[base.label]
    parts.push(f.f1 >= b.f1 ? `The fine-tune scores ${f.f1.toFixed(3)}, at or above the base model.` : `The fine-tune scores ${f.f1.toFixed(3)}, below the base model; more examples usually help.`)
  }
  if (!parts.length && best) parts.push(`Best: ${best.label} (F1 ${s[best.label]?.f1.toFixed(3)}).`)
  if (run.examples && run.examples < 10) parts.push(`Only ${run.examples} test questions, so treat small gaps with care.`)
  return parts.join(' ')
}

export function EvalCard({ data }: { data: ChatCardData }) {
  const live = useJobLive(data.job_id as number, true)
  const status = live.job?.status
  const [run, setRun] = useState<EvalRun | null>(null)

  useEffect(() => {
    if (status && isFinal(status) && live.job?.project_id) api.evalRun(live.job.project_id, data.eval_id as number).then(setRun).catch(() => {})
  }, [status, live.job, data.eval_id])

  const rows = run?.summary ? run.variants.map((v) => ({ label: v.label, s: run.summary![v.label] })).filter((r) => r.s) : []
  const top = Math.max(0.01, ...rows.map((r) => r.s.f1))
  return (
    <Shell icon={<BarChart3 className="h-4 w-4" />} title={<>Comparing on “{String(data.dataset_name)}”</>} right={<StatusChip status={status} />}>
      {status && !isFinal(status) && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted">{live.progress?.message || (status === 'queued' ? 'Waiting for the job queue…' : 'Starting…')}</div>
          <Bar tone="warm" value={live.progress && live.progress.total ? live.progress.current / live.progress.total : 0.03} />
        </div>
      )}
      {rows.length > 0 && (
        <table className="w-full text-[12.5px] tabular-nums">
          <thead className="text-left text-[11px] text-muted"><tr><th className="pb-1 font-normal">Version</th><th className="pb-1 font-normal">F1</th><th className="pb-1 text-right font-normal">Latency</th></tr></thead>
          <tbody>
            {rows.map(({ label, s }) => {
              const best = s.f1 === top
              return (
                <tr key={label} className="border-t border-line/70">
                  <td className={`py-1.5 pr-3 ${best ? 'text-accent' : ''}`}>{label}</td>
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span className={`block h-1.5 rounded-full ${best ? 'bg-accent' : 'bg-muted'}`} style={{ width: `${Math.max(4, (s.f1 / top) * 110)}px` }} />
                      {s.f1.toFixed(3)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-muted">{(s.latency_ms / 1000).toFixed(1)}s</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {run && <p className="text-[13.5px] leading-relaxed">{verdict(run)}</p>}
      {status === 'failed' && <div className="text-xs text-bad">{live.job?.error?.split('\n').filter(Boolean).pop() ?? 'Comparison failed.'}</div>}
      <div className="flex gap-2"><Action to="/compare">Full results in Classic</Action></div>
    </Shell>
  )
}

// ---- logs and local cards ----------------------------------------------------------------------

export function LogsCard({ data }: { data: ChatCardData }) {
  const [lines, setLines] = useState<string[] | null>(null)
  useEffect(() => {
    api.jobLog(data.job_id as number).then((t) => setLines(stripAnsi(t).split('\n').filter((l) => l.trim()).slice(-40))).catch(() => setLines([]))
  }, [data.job_id])
  return (
    <Shell icon={<Terminal className="h-4 w-4" />} title={<>Output of job #{String(data.job_id)}</>}
           right={<Link to={`/jobs/${data.job_id}`} className="text-xs text-muted hover:text-text">Open</Link>}>
      <pre className="max-h-64 overflow-auto rounded-lg bg-[#141311] p-3 font-mono text-[11.5px] leading-5 text-muted">
        {lines == null ? 'Loading…' : lines.length ? lines.join('\n') : 'No output.'}
      </pre>
    </Shell>
  )
}

export function LocalCardView({ card, onDismiss }: { card: LocalCard; onDismiss: () => void }) {
  const icon = card.kind === 'error' ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />
  return (
    <div className={`rise flex gap-2.5 rounded-2xl border px-4 py-3 ${card.kind === 'error' ? 'border-bad/40 bg-bad/10' : 'border-line bg-card'}`}>
      <span className={`mt-0.5 ${card.kind === 'error' ? 'text-bad' : 'text-accent'}`}>{icon}</span>
      <div className="prose-chat min-w-0 flex-1 text-[13.5px]" style={{ fontSize: 13.5 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.text}</ReactMarkdown>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="self-start text-muted hover:text-text"><X className="h-4 w-4" /></button>
    </div>
  )
}

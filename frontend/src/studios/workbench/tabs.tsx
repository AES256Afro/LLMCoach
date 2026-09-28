import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api, type Chunk, type EvalRun, type JobEvent, type ModelRef, type PipelineGraph, type SearchHit, type Split, type TrainPlan } from '../../api'
import { metricRows } from '../../components/LossChart'
import { stripAnsi } from '../../components/ansi'
import { fmtTime } from '../../components/ui'
import { usePolling } from '../../hooks/usePolling'
import { useJobStream } from '../../hooks/streams'
import { useChatSession } from '../chat/useChatSession'
import { useProject } from '../../hooks/project'

export interface TabProps {
  g: PipelineGraph
  open: (key: string) => void
  rename: (from: string, to: string) => void
  setOutput: (jobId: number | null) => void
  say: (msg: string) => void
}

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
const short = (ref?: string | null) => (ref ?? '').split('/').slice(1).join('/') || ref || '—'

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="wb-tb">{children}</div>
}

export function DarkLoss({ events, height = 220 }: { events: JobEvent[]; height?: number }) {
  const rows = useMemo(() => metricRows(events), [events])
  const train = rows.filter((r) => r.loss != null), ev = rows.filter((r) => r.eval_loss != null)
  if (train.length < 2) return <div className="wb-empty" style={{ height }}>no loss values yet</div>
  const W = 560, H = height, L = 36, B = 18
  const all = [...train.map((r) => r.loss!), ...ev.map((r) => r.eval_loss!)]
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1
  const maxStep = Math.max(...rows.map((r) => r.step), 1)
  const x = (s: number) => L + ((W - L - 8) * s) / maxStep
  const y = (v: number) => 8 + ((H - B - 16) * (hi - v)) / span
  const path = (pts: [number, number][]) => pts.map(([s, v], i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Loss by step">
      {[hi, (hi + lo) / 2, lo].map((t) => <g key={t}><line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#262a31" /><text x={L - 6} y={y(t) + 3} fontSize="10" textAnchor="end" fill="#6b727d" fontFamily="IBM Plex Mono">{t.toFixed(2)}</text></g>)}
      <text x={W - 8} y={H - 4} fontSize="10" textAnchor="end" fill="#6b727d" fontFamily="IBM Plex Mono">step {maxStep}</text>
      <path d={path(train.map((r) => [r.step, r.loss!]))} fill="none" stroke="var(--ac)" strokeWidth="1.8" />
      {ev.length > 0 && <path d={path(ev.map((r) => [r.step, r.eval_loss!]))} fill="none" stroke="var(--am)" strokeWidth="1.6" strokeDasharray="5 4" />}
      {ev.map((r) => <circle key={r.step} cx={x(r.step)} cy={y(r.eval_loss!)} r="3" fill="var(--am)" />)}
    </svg>
  )
}

export function LogLines({ lines, empty = 'no output' }: { lines: string[]; empty?: string }) {
  if (!lines.length) return <div className="wb-lines">{empty}</div>
  return (
    <div className="wb-lines">
      {lines.slice(-600).map((l, i) => {
        const text = stripAnsi(l.split('\r').filter(Boolean).pop() ?? '')
        const cls = /error|Traceback|failed/i.test(text) ? 'bad' : /eval_loss|promoted|saved|done|ready/i.test(text) ? 'ok' : /^\[?\w+\]/.test(text) ? 'inf' : undefined
        return <div key={i} className={cls}>{text || ' '}</div>
      })}
    </div>
  )
}

// ---- chat ------------------------------------------------------------------------------------------------

export function ChatTab({ id, rename, g }: TabProps & { id: string }) {
  const { current } = useProject()
  const session = useChatSession(current)
  const { active, pending, streaming, settings, setSettings } = session
  const [text, setText] = useState('')
  const [models, setModels] = useState<ModelRef[]>([])
  const [pick, setPick] = useState<{ msg: number | 'pending'; n: number } | null>(null)
  useEffect(() => { api.models('chat').then(setModels).catch(() => {}) }, [])
  useEffect(() => { if (id !== 'new') session.open(Number(id)) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (id === 'new' && active) rename('chat:new', `chat:${active.id}`) }, [id, active, rename])
  const model = settings.model ?? active?.model ?? [...models].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref ?? ''
  const msgs = (active?.messages ?? []).filter((m) => m.role !== 'event')
  const lastAnswer = [...msgs].reverse().find((m) => m.role === 'assistant')
  const shown = pick?.msg === 'pending' ? pending?.sources : pick ? msgs.find((m) => m.id === pick.msg)?.sources : pending?.sources ?? lastAnswer?.sources
  const hit: SearchHit | undefined = shown?.[pick?.n ?? 0]
  const send = (e: FormEvent) => { e.preventDefault(); if (text.trim() && !streaming) { session.send(text.trim()); setText(''); setPick(null) } }
  const cites = (content: string, sources: SearchHit[] | null, msg: number | 'pending') => content.split(/(\[\d{1,2}\])/g).map((p, i) => {
    const m = /^\[(\d{1,2})\]$/.exec(p)
    return m && sources && Number(m[1]) <= sources.length
      ? <button key={i} className="wb-cite" onClick={() => setPick({ msg, n: Number(m[1]) - 1 })}>{p}</button>
      : <Fragment key={i}>{p}</Fragment>
  })
  return (
    <>
      <Toolbar>
        <select className="wb-sel" value={model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} aria-label="Model">
          {models.map((m) => <option key={m.ref} value={m.ref}>{short(m.ref)}</option>)}
        </select>
        <button className={`wb-chk ${settings.useRag ? 'on' : ''}`} onClick={() => setSettings((s) => ({ ...s, useRag: !s.useRag }))} aria-pressed={settings.useRag}>
          <i>{settings.useRag ? '✓' : ''}</i>Knowledge base · {g.knowledge.chunks} chunks
        </button>
        <label className="wb-sel flex items-center gap-1.5">temp<input type="number" step={0.1} min={0} max={2} value={settings.temperature} onChange={(e) => setSettings((s) => ({ ...s, temperature: Number(e.target.value) }))} className="w-12 bg-transparent outline-none" /></label>
        <button className={`wb-chk ${settings.think ? 'on' : ''}`} onClick={() => setSettings((s) => ({ ...s, think: !s.think }))}><i>{settings.think ? '✓' : ''}</i>think</button>
        <span className="ml-auto wb-mono text-[11px] text-[var(--mu)]">{active ? `conversation #${active.id}` : 'new conversation'}</span>
      </Toolbar>
      <div className="wb-split">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="wb-pane space-y-3.5 px-5 py-3.5">
            {!msgs.length && !pending && <div className="wb-empty h-40">Ask about your documents. [n] opens the passage in the inspector.</div>}
            {msgs.map((m, i) => {
              const dim = i < msgs.length - 2 && !pending
              return m.role === 'user'
                ? <div key={m.id} className={`wb-m ${dim ? 'dim' : ''}`}><div className="wb-who">you</div><div className="wb-ans">{m.content}</div></div>
                : (
                  <div key={m.id} className={`wb-m ${dim ? 'dim' : ''}`}>
                    <div className="wb-who ac">{short(m.model)}</div>
                    <div>
                      {m.stats?.retrieval_ms != null && <div className="mb-1 text-[11.5px] text-[var(--mu)]">▸ retrieved {m.sources?.length ?? 0} passages in {m.stats.retrieval_ms} ms</div>}
                      <div className="wb-ans">{cites(m.content, m.sources, m.id)}</div>
                      {!!m.sources?.length && (
                        <div className="wb-chips">{m.sources.slice(0, 5).map((s, k) => <button key={s.id} className={pick?.msg === m.id && pick.n === k ? 'on' : ''} onClick={() => setPick({ msg: m.id, n: k })}>[{k + 1}] {s.filename} {s.page != null ? `p.${s.page}` : `#${s.chunk_index + 1}`}</button>)}</div>
                      )}
                      {m.stats && <div className="wb-meta">{m.stats.tokens_per_sec ?? '?'} tok/s · {m.stats.completion_tokens ?? '?'} tokens · first token {((m.stats.first_token_ms ?? 0) / 1000).toFixed(1)}s · total {((m.stats.total_ms ?? 0) / 1000).toFixed(1)}s</div>}
                      {m.error && m.error !== 'stopped' && <div className="wb-meta text-[var(--bad)]">error: {m.error}</div>}
                    </div>
                  </div>
                )
            })}
            {pending && (
              <>
                <div className="wb-m"><div className="wb-who">you</div><div className="wb-ans">{pending.question}</div></div>
                <div className="wb-m"><div className="wb-who ac">{short(pending.model ?? model)}</div><div className="wb-ans">{cites(pending.answer || '…', pending.sources, 'pending')}</div></div>
              </>
            )}
          </div>
          <form onSubmit={send} className="wb-comp">
            <span className="pr">›</span>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask a follow-up" aria-label="Message" disabled={streaming} />
            {streaming ? <button type="button" className="wb-btn" onClick={session.stop}>stop</button> : <kbd>Enter</kbd>}
          </form>
        </div>
        <aside className="wb-insp">
          {hit ? (
            <div className="wb-sec">
              <h6><span>source [{(pick?.n ?? 0) + 1}]</span><span>{hit.score.toFixed(2)}</span></h6>
              <div className="wb-mono flex justify-between text-[11.5px]"><span>{hit.filename} › {hit.page != null ? `p.${hit.page}` : `chunk ${hit.chunk_index + 1}`}</span></div>
              <div className="wb-bar"><i style={{ width: `${Math.max(0, Math.min(1, hit.score)) * 100}%` }} /></div>
              <p className="wb-ex">{hit.text}</p>
            </div>
          ) : <div className="wb-sec text-[var(--mu)]">No source selected.</div>}
          <div className="wb-sec">
            <h6><span>run</span></h6>
            <div className="wb-kv"><span>model</span><b>{short(model)}</b><span>embed</span><b>{short(g.knowledge.embed_model)}</b><span>knowledge</span><b>{settings.useRag ? 'on' : 'off'}</b><span>temperature</span><b>{settings.temperature}</b></div>
          </div>
        </aside>
      </div>
    </>
  )
}

// ---- document --------------------------------------------------------------------------------------------

export function DocTab({ g, id }: TabProps & { id: number }) {
  const pid = g.project.id
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState('')
  const load = (offset: number) => api.chunks(pid, id, offset, 100).then((r) => { setChunks((c) => (offset ? [...c, ...r.chunks] : r.chunks)); setTotal(r.total) }).catch(() => {})
  useEffect(() => { load(0) }, [pid, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = filter ? chunks.filter((c) => c.text.toLowerCase().includes(filter.toLowerCase())) : chunks
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">knowledge ›</span><b className="font-semibold">document #{id}</b>
        <span className="wb-pill">{total} chunks</span>
        <input className="wb-sel ml-auto w-56" placeholder="filter loaded chunks" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </Toolbar>
      <div className="wb-pane">
        <table className="wb-table">
          <thead><tr><th className="w-16">#</th><th className="w-16">page</th><th>text</th></tr></thead>
          <tbody>
            {shown.map((c) => <tr key={c.id}><td className="wb-mono text-[var(--mu)]">{c.chunk_index + 1}</td><td className="wb-mono text-[var(--mu)]">{c.page ?? '—'}</td><td className="whitespace-pre-wrap leading-relaxed">{c.text}</td></tr>)}
          </tbody>
        </table>
        {chunks.length < total && <div className="p-3"><button className="wb-btn" onClick={() => load(chunks.length)}>load 100 more ({total - chunks.length} left)</button></div>}
      </div>
    </>
  )
}

// ---- dataset ---------------------------------------------------------------------------------------------

export function DatasetTab({ g, id, open }: TabProps & { id: number }) {
  const pid = g.project.id
  const d = g.datasets.find((x) => x.id === id)
  const [split, setSplit] = useState<Split | ''>('')
  const [q, setQ] = useState('')
  const { data } = usePolling(() => api.datasetRows(pid, id, { split: split || undefined, q: q || undefined, limit: 200 }), 15000, [pid, id, split, q])
  if (!d) return <div className="wb-empty">dataset #{id} is gone</div>
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">datasets ›</span><b className="font-semibold">{d.name}</b>
        <span className={`wb-pill ${d.status === 'ready' ? 'ok' : d.status === 'failed' ? 'bad' : 'run'}`}>{d.status} · {d.rows} rows</span>
        {d.splits && <span className="wb-pill">{d.splits.train}/{d.splits.val}/{d.splits.test}</span>}
        <select className="wb-sel" value={split} onChange={(e) => setSplit(e.target.value as Split | '')}><option value="">all splits</option><option value="train">train</option><option value="val">val</option><option value="test">test</option></select>
        <input className="wb-sel w-48" placeholder="search rows" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ml-auto flex gap-1.5"><button className="wb-btn pri" onClick={() => open(`new-finetune:${d.id}`)} disabled={!d.splits?.train}>train on it</button></span>
      </Toolbar>
      <div className="wb-pane">
        <table className="wb-table">
          <thead><tr><th className="w-14">split</th><th>question</th><th>answer</th></tr></thead>
          <tbody>
            {data?.rows.map((r, i) => (
              <tr key={i}>
                <td className="wb-mono text-[var(--mu)]">{r.split}</td>
                <td>{r.messages.find((m) => m.role === 'user')?.content}</td>
                <td className="text-[#aab0b9]">{r.messages.find((m) => m.role === 'assistant')?.content}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <div className="wb-mono p-3 text-[11px] text-[var(--mu)]">{data.rows.length} of {data.total} shown</div>}
      </div>
    </>
  )
}

// ---- fine-tune: run settings as code, with a diff against another run ------------------------------------

function flatten(obj: Record<string, unknown> | null | undefined, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`))
    else out[`${prefix}${k}`] = JSON.stringify(v)
  }
  return out
}

export function FinetuneTab({ g, id, open, setOutput, say }: TabProps & { id: number }) {
  const pid = g.project.id
  const ft = g.finetunes.find((x) => x.id === id)
  const [against, setAgainst] = useState<number | ''>('')
  const { events } = useJobStream(ft?.job_id ?? null)
  useEffect(() => { setOutput(ft?.job_id ?? null) }, [ft?.job_id, setOutput])
  if (!ft) return <div className="wb-empty">fine-tune #{id} is gone</div>
  const mine = flatten({ base_model: ft.base_model, dataset_id: ft.dataset_id, method: ft.method, ...(ft.config ?? {}) })
  const other = against ? g.finetunes.find((x) => x.id === against) : null
  const theirs = other ? flatten({ base_model: other.base_model, dataset_id: other.dataset_id, method: other.method, ...(other.config ?? {}) }) : null
  const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs ?? {})])].sort()
  const rows = metricRows(events)
  const m = ft.metrics
  const evaluate = async () => {
    if (ft.dataset_id == null) return
    try {
      const chat = (g.chat.model ?? [...(await api.models('chat'))].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref) || null
      const variants = [{ kind: 'finetune' as const, ref: String(ft.id), rag: false }, ...(chat ? [{ kind: 'model' as const, ref: chat, rag: g.knowledge.chunks > 0 }] : [])]
      const r = await api.createEval(pid, { dataset_id: ft.dataset_id, max_examples: 20, variants })
      say(`evaluation #${r.eval.id} queued (job #${r.job.id})`)
      open(`eval:${r.eval.id}`)
    } catch (e) { say(errText(e)) }
  }
  const promote = async () => { try { await (ft.promoted_at ? api.demote(pid, ft.id) : api.promote(pid, ft.id)); say(ft.promoted_at ? 'unset as current' : 'now the current adapter') } catch (e) { say(errText(e)) } }
  const exporting = g.active_jobs.some((j) => j.kind === 'export' && Number(j.config.finetune_id) === ft.id)
  const sendToOllama = async () => { try { const r = await api.exportFinetune(pid, ft.id); say(`exporting to ${r.model} (job #${r.job.id})`); open(`job:${r.job.id}`) } catch (e) { say(errText(e)) } }
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">fine-tunes ›</span><b className="font-semibold">{ft.name}</b>
        <span className={`wb-pill ${ft.status === 'ready' ? 'ok' : ft.status === 'failed' ? 'bad' : 'run'}`}>{ft.status}{ft.promoted_at ? ' · current' : ''}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button className="wb-btn" onClick={evaluate} disabled={ft.status !== 'ready'}>evaluate</button>
          <button className="wb-btn" onClick={promote} disabled={ft.status !== 'ready'}>{ft.promoted_at ? 'unset current' : 'make current'}</button>
          <button className="wb-btn" onClick={sendToOllama} disabled={ft.status !== 'ready' || exporting}>{exporting ? 'exporting…' : ft.ollama_model ? 're-export to ollama' : 'send to ollama'}</button>
          {ft.ollama_model && <a className="wb-btn" href={`/chat?model=${encodeURIComponent(ft.ollama_model)}`}>chat with it</a>}
          <button className="wb-btn pri" onClick={() => open(`new-finetune:from-${ft.id}`)}>re-run with new settings</button>
        </span>
      </Toolbar>
      <div className="wb-split">
        <div className="wb-cfg w-[380px] flex-none overflow-y-auto border-r border-[var(--ln)] py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-4 text-[10.5px] tracking-[.09em] text-[var(--mu)]">
            <span className="whitespace-nowrap">RUN CONFIG · read-only</span>
            <select className="wb-sel ml-auto max-w-[190px]" value={against} onChange={(e) => setAgainst(e.target.value ? Number(e.target.value) : '')} aria-label="Compare with">
              <option value="">diff with…</option>
              {g.finetunes.filter((x) => x.id !== ft.id).map((x) => <option key={x.id} value={x.id}>#{x.id} {x.name.slice(0, 28)}</option>)}
            </select>
          </div>
          {keys.map((k) => {
            const a = mine[k], b = theirs?.[k]
            const changed = theirs != null && a !== b
            return (
              <div key={k} className={`wb-row2 ${changed ? 'chg' : ''}`}>
                <span>{k}</span>
                <span>{changed && b !== undefined && <del>{b}</del>}{a !== undefined ? (/^"/.test(a) ? <em>{a.replace(/^"|"$/g, '')}</em> : <span className="s">{a}</span>) : <span className="text-[var(--mu)]">—</span>}</span>
              </div>
            )
          })}
          {theirs && <div className="mt-2 px-4 text-[11px] text-[var(--mu)]">highlighted: differs from #{against} (struck through)</div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          <div className="flex items-center gap-3 text-[12px]"><b>Loss</b><span className="text-[var(--ac)]">━ train</span><span className="text-[var(--am)]">╍ eval</span><span className="wb-mono ml-auto text-[var(--mu)]">step {rows[rows.length - 1]?.step ?? 0}</span></div>
          <DarkLoss events={events} />
          <div className="wb-metrics">
            <div><span>TRAIN LOSS</span><b>{m?.train_loss?.toFixed(2) ?? '—'}</b></div>
            <div><span>EVAL LOSS</span><b className="text-[var(--am)]">{m?.eval_loss?.toFixed(2) ?? '—'}</b></div>
            <div><span>STEPS</span><b>{m?.steps ?? '—'}</b></div>
            <div><span>RUNTIME</span><b>{m?.seconds != null ? `${Math.floor(m.seconds / 60)}m ${Math.round(m.seconds % 60)}s` : '—'}</b></div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---- new fine-tune as code ----------------------------------------------------------------------------------

export function NewFinetuneTab({ g, arg, open, rename, say }: TabProps & { arg: string }) {
  const pid = g.project.id
  const [text, setText] = useState('')
  const [plan, setPlan] = useState<TrainPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.trainingOptions().then((o) => {
      const from = arg.startsWith('from-') ? g.finetunes.find((f) => f.id === Number(arg.slice(5))) : null
      const ds = from?.dataset_id ?? (Number(arg) || g.datasets.find((d) => (d.splits?.train ?? 0) > 0)?.id || null)
      const cfg = (from?.config ?? {}) as Record<string, unknown>
      const overrides = from ? Object.fromEntries(['epochs', 'learning_rate', 'lora_r', 'lora_alpha', 'lora_dropout', 'max_seq_len'].filter((k) => cfg[k] != null).map((k) => [k, cfg[k]])) : {}
      setText(JSON.stringify({ name: from ? `${from.name} (re-run)` : undefined, base_model: from?.base_model ?? o.recommended_base_model, dataset_id: ds, preset: String(cfg.preset ?? 'quick'), method: from?.method ?? 'lora', backend: 'auto', overrides }, null, 2))
    }).catch((e) => setError(errText(e)))
  }, [arg]) // eslint-disable-line react-hooks/exhaustive-deps
  const parse = () => { try { setError(null); return JSON.parse(text) } catch (e) { setError(`not valid JSON: ${errText(e)}`); return null } }
  const dry = async () => {
    const body = parse()
    if (!body) return
    try { setPlan((await api.createFinetune(pid, { ...body, dry_run: true })).plan) } catch (e) { setError(errText(e)); setPlan(null) }
  }
  const start = async () => {
    const body = parse()
    if (!body) return
    try {
      const r = await api.createFinetune(pid, body)
      say(`training ${r.finetune?.name} (job #${r.job?.id})`)
      if (r.finetune) { rename(`new-finetune:${arg}`, `finetune:${r.finetune.id}`); open(`finetune:${r.finetune.id}`) }
    } catch (e) { setError(errText(e)) }
  }
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">fine-tunes ›</span><b className="font-semibold">new run</b>
        <span className="ml-auto flex gap-1.5"><button className="wb-btn" onClick={dry}>dry run</button><button className="wb-btn pri" onClick={start}>start</button></span>
      </Toolbar>
      <div className="wb-split">
        <div className="wb-pane p-4">
          <div className="mb-2 text-[11.5px] text-[var(--mu)]">run settings as code. <code>overrides</code> takes epochs, learning_rate, lora_r, lora_alpha, lora_dropout, max_seq_len; presets: {Object.keys({ quick: 1, balanced: 1, thorough: 1 }).join(', ')}</div>
          <textarea className="wb-code" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Run settings" />
          {error && <div className="wb-mono mt-2 text-[12px] text-[var(--bad)]">{error}</div>}
        </div>
        <aside className="wb-insp">
          <div className="wb-sec">
            <h6><span>plan</span><span>{plan ? 'dry run' : ''}</span></h6>
            {plan ? <div className="wb-kv">{Object.entries(plan).filter(([, v]) => typeof v !== 'object').map(([k, v]) => <Fragment key={k}><span>{k}</span><b>{String(v)}</b></Fragment>)}</div>
              : <div className="text-[var(--mu)]">"dry run" checks the settings against this machine and shows the plan, memory and steps, without starting.</div>}
          </div>
        </aside>
      </div>
    </>
  )
}

// ---- evaluation --------------------------------------------------------------------------------------------

export function EvalTab({ g, id, setOutput }: TabProps & { id: number }) {
  const pid = g.project.id
  const { data: run } = usePolling<EvalRun>(() => api.evalRun(pid, id), 6000, [pid, id])
  useEffect(() => { setOutput(run?.job_id ?? null) }, [run?.job_id, setOutput])
  if (!run) return <div className="wb-empty">loading evaluation #{id}…</div>
  const rows = Object.entries(run.summary ?? {}).sort((a, b) => (b[1].f1 ?? 0) - (a[1].f1 ?? 0))
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">evaluations ›</span><b className="font-semibold">{run.name}</b>
        <span className={`wb-pill ${run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : 'run'}`}>{run.status}</span>
        <span className="wb-pill">{run.split} · {run.examples} questions</span>
        {run.judge_model && <span className="wb-pill">judge {short(run.judge_model)}</span>}
      </Toolbar>
      <div className="wb-pane">
        <table className="wb-table">
          <thead><tr><th>variant</th><th>f1</th><th>em</th><th>rouge-l</th><th>judge</th><th>latency</th><th>errors</th></tr></thead>
          <tbody>
            {rows.map(([label, v], i) => (
              <tr key={label}>
                <td className={i === 0 ? 'text-[var(--ac)]' : ''}>{label}</td>
                <td className="wb-mono">{v.f1.toFixed(3)}</td><td className="wb-mono">{v.exact_match.toFixed(3)}</td><td className="wb-mono">{v.rouge_l.toFixed(3)}</td>
                <td className="wb-mono text-[var(--am)]">{v.judge != null ? v.judge.toFixed(1) : '—'}</td><td className="wb-mono">{(v.latency_ms / 1000).toFixed(1)}s</td><td className="wb-mono">{v.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="wb-table mt-4">
          <thead><tr><th className="w-8">#</th><th>question · reference</th>{rows.map(([label]) => <th key={label}>{label.slice(0, 26)}</th>)}</tr></thead>
          <tbody>
            {run.results?.map((r) => (
              <tr key={r.index}>
                <td className="wb-mono text-[var(--mu)]">{r.index + 1}</td>
                <td><div>{r.question}</div><div className="mt-1 text-[#8e959f]">{r.reference}</div></td>
                {rows.map(([label]) => { const o = r.outputs[label]; return <td key={label} className="text-[#aab0b9]">{o ? <><span className="wb-mono text-[10.5px] text-[var(--ac)]">f1 {o.f1.toFixed(2)}</span><div>{o.error ?? o.answer}</div></> : '—'}</td> })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ---- job -----------------------------------------------------------------------------------------------------

export function JobTab({ id, setOutput }: TabProps & { id: number }) {
  const { job, lines } = useJobStream(id)
  useEffect(() => { setOutput(null) }, [setOutput])
  return (
    <>
      <Toolbar>
        <span className="wb-mono text-[var(--mu)]">jobs ›</span><b className="font-semibold">#{id} {job?.kind}</b>
        <span className={`wb-pill ${job?.status === 'done' ? 'ok' : job?.status === 'failed' ? 'bad' : 'run'}`}>{job?.status ?? '…'}</span>
        {job?.created_at && <span className="wb-pill">{fmtTime(job.created_at)}</span>}
        {job && ['queued', 'running'].includes(job.status) && <button className="wb-btn ml-auto" onClick={() => api.cancelJob(id)}>cancel</button>}
      </Toolbar>
      <div className="wb-split">
        <div className="wb-pane flex flex-col"><LogLines lines={lines} empty="waiting for output" /></div>
        <aside className="wb-insp">
          <div className="wb-sec"><h6><span>config</span></h6>
            <div className="wb-kv">{Object.entries(flatten(job?.config ?? {})).map(([k, v]) => <Fragment key={k}><span>{k}</span><b>{v}</b></Fragment>)}</div>
          </div>
          {job?.error && <div className="wb-sec"><h6><span>error</span></h6><pre className="wb-mono whitespace-pre-wrap text-[11px] text-[var(--bad)]">{job.error}</pre></div>}
        </aside>
      </div>
    </>
  )
}

export function WelcomeTab() {
  const keys: [string, string][] = [['Ctrl K', 'go to anything: chats, documents, runs, commands'], ['Ctrl `', 'show or hide the bottom panel'], ['Ctrl B', 'show or hide the explorer'], ['Alt W', 'close the tab'], ['Alt [ / ]', 'previous and next tab']]
  return (
    <div className="wb-empty">
      <div>
        <div className="mb-4 text-[15px] text-[var(--tx)]">Open something from the explorer, or press <kbd>Ctrl K</kbd>.</div>
        <div className="wb-kv mx-auto w-fit text-left">{keys.map(([k, v]) => <Fragment key={k}><span><kbd>{k}</kbd></span><b className="text-[var(--mu)]">{v}</b></Fragment>)}</div>
      </div>
    </div>
  )
}

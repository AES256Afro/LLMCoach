import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, uploadDocuments, type EvalRun, type JobEvent, type KBDocument, type ModelRef, type PipelineGraph, type TrainingOptions } from '../../api'
import { metricRows } from '../../components/LossChart'
import { fmtTime } from '../../components/ui'
import { usePolling } from '../../hooks/usePolling'
import { findings, KIND_WORDS, reportMarkdown } from '../findings'

const err = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
const smallest = (ms: ModelRef[]) => [...ms].sort((a, b) => (a.size_gb ?? 1e9) - (b.size_gb ?? 1e9))[0]?.ref ?? ''

function Page({ eye, title, lede, children, margin }: { eye: string; title: ReactNode; lede?: ReactNode; children: ReactNode; margin: ReactNode }) {
  return (
    <div className="nb-body report">
      <main className="nb-main">
        <div className="nb-eye">{eye}</div>
        <h1 className="nb-h1">{title}</h1>
        {lede && <p className="nb-lede">{lede}</p>}
        {children}
      </main>
      <aside className="nb-margin">{margin}</aside>
    </div>
  )
}

function Note({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="nb-note">{title && <b>{title} </b>}{children}</div>
}

function Said({ text }: { text: string | null }) {
  return text ? <p className="mt-3 text-[13px] text-[var(--ac)]" role="status">{text}</p> : null
}

/** A small loss figure in the notebook's ink: train in green, eval in rust. */
function LossFigure({ events, caption }: { events: JobEvent[]; caption?: string }) {
  const rows = useMemo(() => metricRows(events), [events])
  const train = rows.filter((r) => r.loss != null), ev = rows.filter((r) => r.eval_loss != null)
  if (train.length < 2) return null
  const W = 250, H = 130, L = 26
  const all = [...train.map((r) => r.loss!), ...ev.map((r) => r.eval_loss!)]
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1
  const maxStep = Math.max(...rows.map((r) => r.step), 1)
  const x = (s: number) => L + ((W - L - 4) * s) / maxStep
  const y = (v: number) => 6 + ((H - 24) * (hi - v)) / span
  const path = (pts: [number, number][]) => pts.map(([s, v], i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  const end = train[train.length - 1].loss!, endEval = ev[ev.length - 1]?.eval_loss
  return (
    <figure className="nb-fig">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Training loss">
        {[hi, lo].map((t) => <g key={t}><line x1={L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#e6e6e1" /><text x={L - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill="#8a8f9b">{t.toFixed(1)}</text></g>)}
        <path d={path(train.map((r) => [r.step, r.loss!]))} fill="none" stroke="var(--ac)" strokeWidth="1.8" />
        {ev.length > 0 && <path d={path(ev.map((r) => [r.step, r.eval_loss!]))} fill="none" stroke="var(--warm)" strokeWidth="1.6" strokeDasharray="4 3" />}
      </svg>
      <figcaption>{caption ?? 'Fine-tune loss.'} Train ends at {end.toFixed(2)}{endEval != null ? `, eval at ${endEval.toFixed(2)}` : ''}.</figcaption>
    </figure>
  )
}

// ---- 1 documents ------------------------------------------------------------------------------------

export function DocumentsStep({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const { data: docs, reload } = usePolling<KBDocument[]>(() => api.documents(pid), 5000, [pid])
  const [said, setSaid] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const addPage = async (e: FormEvent) => {
    e.preventDefault()
    setFetching(true)
    try {
      const r = await api.addUrl(pid, url.trim())
      const d = r.documents[0]
      setSaid(r.held.length ? `Held back ${r.held[0].filename}: it looks private. Index or remove it on the Knowledge page.`
        : d ? `Added “${d.filename}” from ${url.trim()}. It's being read now.` : r.skipped.length ? `Skipped: ${r.skipped[0].reason}.` : 'Nothing new.')
      setUrl('')
    } catch (err) { setSaid(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err)) }
    setFetching(false)
    reload()
    changed()
  }
  const upload = async (files: File[]) => {
    if (!files.length) return
    setProgress(0)
    try {
      const r = await uploadDocuments(pid, files, setProgress)
      const n = r.documents.length - r.held.length
      setSaid(`Added ${n} document${n === 1 ? '' : 's'}${r.skipped.length ? `; ${r.skipped.length} skipped (${r.skipped.map((s) => s.reason).join(', ')})` : ''}. They're being read now.`
        + (r.held.length ? ` Held back ${r.held.map((h) => h.filename).join(', ')}: ${r.held.length === 1 ? 'it looks' : 'they look'} private. Index or remove ${r.held.length === 1 ? 'it' : 'them'} on the Knowledge page.` : ''))
    } catch (e) { setSaid(err(e)) }
    setProgress(null)
    reload()
    changed()
  }
  const n = g.documents.count
  return (
    <Page eye="Step 1 of 4 · Documents"
          title={n ? `${n} document${n === 1 ? '' : 's'}, ${g.knowledge.chunks} passages to draw on.` : 'Start with the documents your bot should know.'}
          lede="PDFs, Markdown, Word files, web pages and plain text. Each is split into passages the bot can find and quote."
          margin={<>
            <Note title="Other ways in.">A watched folder in the <Link className="nb-link" to="/inbox">Inbox</Link> picks up anything copied into it, after a check for secrets and personal data.</Note>
            <Note title="Next:"><Link className="nb-link" to="/notebook/dataset">turn them into practice questions →</Link></Note>
          </>}>
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(Array.from(e.dataTransfer.files)) }}
           className="nb-noprint mt-6 rounded border border-dashed border-[#bfc2ba] px-4 py-6 text-center text-[13px] text-[var(--mu)]">
        {progress != null ? `Uploading… ${Math.round(progress * 100)}%` : <>Drop documents here, or <button className="nb-link" onClick={() => input.current?.click()}>choose files</button></>}
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        <form className="mt-3 flex gap-2" onSubmit={addPage}>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="or a web page: https://…"
                 className="min-w-0 flex-1 rounded border border-[#d5d7cf] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--acc,#1e5a4b)]" />
          <button className="nb-link text-[13px] disabled:opacity-40" disabled={!url.trim() || fetching}>{fetching ? 'reading…' : 'add page'}</button>
        </form>
      </div>
      <Said text={said} />
      <ul className="mt-4">
        {docs?.map((d) => (
          <li key={d.id} className="nb-example flex flex-wrap items-baseline gap-x-3">
            <span className="nb-serif text-[17px]">{d.filename}</span>
            <span className="text-xs text-[var(--mu)]">
              {d.status === 'ready' ? `${d.chunk_count} passages` : d.status === 'failed' ? <span className="text-[var(--warm)]">couldn't be read: {d.error}</span> : `${d.status}…`}
              {' · '}{(d.size_bytes / 1024).toFixed(0)} KB
            </span>
          </li>
        ))}
      </ul>
    </Page>
  )
}

// ---- 2 dataset ------------------------------------------------------------------------------------------

export function DatasetStep({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const [pick, setPick] = useState<number | null>(null)
  const d = g.datasets.find((x) => x.id === pick) ?? g.datasets.find((x) => x.rows > 0) ?? g.datasets[0]
  const { data: rows } = usePolling(() => (d ? api.datasetRows(pid, d.id, { limit: 4 }) : Promise.resolve(null)), 15000, [pid, d?.id, d?.rows])
  const [models, setModels] = useState<ModelRef[]>([])
  const [model, setModel] = useState('')
  const [pairs, setPairs] = useState(3)
  const [chunks, setChunks] = useState(20)
  const [said, setSaid] = useState<string | null>(null)
  useEffect(() => { api.models('chat').then((ms) => { setModels(ms); setModel((m) => m || smallest(ms)) }).catch(() => {}) }, [])
  const total = g.datasets.reduce((n, x) => n + x.rows, 0)
  const write = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const r = await api.generateDataset(pid, { model, pairs_per_chunk: pairs, max_chunks: chunks, style: 'closed', val: 0.1, test: 0.1 })
      setSaid(`Writing about ${pairs * chunks} questions into “${r.dataset.name}”. It takes a while on a CPU; the step fills in as it goes.`)
      changed()
    } catch (x) { setSaid(err(x)) }
  }
  return (
    <Page eye="Step 2 of 4 · Dataset"
          title={total ? `${total} practice questions across ${g.datasets.length} dataset${g.datasets.length === 1 ? '' : 's'}.` : 'Write practice questions from your documents.'}
          lede="A chat model reads passages and writes questions with their answers. A tenth are set aside as test questions, so the evaluation asks things training never saw."
          margin={<>
            {d?.splits && <Note title={`“${d.name}”:`}>{d.splits.train} to train on, {d.splits.val} to check training with, {d.splits.test} held back for the test.</Note>}
            <Note title="Next:"><Link className="nb-link" to="/notebook/train">teach a model with them →</Link></Note>
          </>}>
      <div className="mt-6 flex flex-wrap gap-2 nb-noprint">
        {g.datasets.map((x) => (
          <button key={x.id} onClick={() => setPick(x.id)} className={`nb-pill ${d?.id === x.id ? 'on' : ''}`}>{x.name} · {x.rows}</button>
        ))}
      </div>
      {rows?.rows.map((r, i) => (
        <div key={i} className="nb-example">
          <p className="nb-q !my-0 !text-[19px]">{r.messages.find((m) => m.role === 'user')?.content}</p>
          <p className="nb-serif mt-1.5 text-[16px] leading-relaxed text-[#3a4150]">{r.messages.find((m) => m.role === 'assistant')?.content}</p>
        </div>
      ))}
      <form onSubmit={write} className="nb-noprint mt-8 border-t-2 border-[var(--ink)] pt-4">
        <h2 className="nb-h2 !mt-0">Write more</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-xs text-[var(--mu)]">Model<select className="nb-input" value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}</select></label>
          <label className="text-xs text-[var(--mu)]">Questions per passage<input className="nb-input" type="number" min={1} max={10} value={pairs} onChange={(e) => setPairs(Number(e.target.value))} /></label>
          <label className="text-xs text-[var(--mu)]">Passages to read<input className="nb-input" type="number" min={1} max={500} value={chunks} onChange={(e) => setChunks(Number(e.target.value))} /></label>
        </div>
        <button className="nb-pill green mt-4" type="submit" disabled={!model || !g.knowledge.chunks}>Write practice questions</button>
        <Said text={said} />
      </form>
    </Page>
  )
}

// ---- 3 train ---------------------------------------------------------------------------------------------

export function TrainStep({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const [opts, setOpts] = useState<TrainingOptions | null>(null)
  const trainable = g.datasets.filter((d) => (d.splits?.train ?? 0) > 0)
  const [ds, setDs] = useState<number | null>(null)
  const [base, setBase] = useState('')
  const [preset, setPreset] = useState('quick')
  const [said, setSaid] = useState<string | null>(null)
  const [events, setEvents] = useState<JobEvent[]>([])
  useEffect(() => { api.trainingOptions().then((o) => { setOpts(o); setBase((b) => b || o.recommended_base_model) }).catch(() => {}) }, [])
  const ready = g.finetunes.filter((f) => f.status === 'ready')
  const latest = [...g.finetunes].reverse().find((f) => f.job_id)
  useEffect(() => { if (latest?.job_id) api.jobMetrics(latest.job_id).then(setEvents).catch(() => {}) }, [latest?.job_id, latest?.status])
  const current = g.finetunes.find((f) => f.promoted_at)
  const start = async (e: FormEvent) => {
    e.preventDefault()
    const dataset = ds ?? trainable[0]?.id
    if (!dataset) return
    try {
      const r = await api.createFinetune(pid, { base_model: base, dataset_id: dataset, preset, method: 'lora', backend: 'auto', overrides: {} })
      setSaid(`Training ${r.finetune?.name}. About ${r.plan.total_steps} steps${r.plan.device ? ` on ${r.plan.device.toUpperCase()}` : ''}.`)
      changed()
    } catch (x) { setSaid(err(x)) }
  }
  return (
    <Page eye="Step 3 of 4 · Train"
          title={ready.length ? `${ready.length} adapter${ready.length === 1 ? '' : 's'} trained${current ? `; “${current.name}” is the current one` : ''}.` : 'Teach a small model your task.'}
          lede="Fine-tuning adds a small set of weights (a LoRA adapter) on top of a base model, trained on your practice questions. It teaches manner and format; the knowledge base supplies facts."
          margin={<>
            {latest && <LossFigure events={events} caption={`Fig. 1. ${latest.name}.`} />}
            <Note title="Small is fine.">On a CPU, a 0.5B model trains in minutes. With the RTX 4080 in, 4B models become practical.</Note>
            <Note title="Next:"><Link className="nb-link" to="/notebook/evaluate">find out whether it helped →</Link></Note>
          </>}>
      <ul className="mt-6">
        {[...g.finetunes].reverse().map((f) => (
          <li key={f.id} className="nb-example">
            <div className="nb-serif text-[18px]">{f.name}{f.promoted_at && <span className="nb-hl ml-2 font-sans text-[11px] font-semibold uppercase tracking-wide">current</span>}</div>
            <div className="text-xs text-[var(--mu)]">{f.base_model} · {f.status}{f.metrics?.train_loss != null ? ` · final loss ${f.metrics.train_loss.toFixed(2)}` : ''}{f.finished_at ? ` · ${fmtTime(f.finished_at)}` : ''}</div>
          </li>
        ))}
      </ul>
      <form onSubmit={start} className="nb-noprint mt-8 border-t-2 border-[var(--ink)] pt-4">
        <h2 className="nb-h2 !mt-0">Train another</h2>
        {!trainable.length ? <p className="text-[13px] text-[var(--mu)]">Make a dataset first, in step 2.</p> : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-xs text-[var(--mu)]">Practice questions<select className="nb-input" value={ds ?? trainable[0].id} onChange={(e) => setDs(Number(e.target.value))}>{trainable.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.splits?.train} train</option>)}</select></label>
              <label className="text-xs text-[var(--mu)]">Base model<select className="nb-input" value={base} onChange={(e) => setBase(e.target.value)}>
                {opts?.base_models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.id === opts.recommended_base_model ? ' (recommended)' : ''}</option>)}
              </select></label>
              <label className="text-xs text-[var(--mu)]">How long<select className="nb-input" value={preset} onChange={(e) => setPreset(e.target.value)}>{opts && Object.entries(opts.presets).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select></label>
            </div>
            <button className="nb-pill green mt-4" type="submit" disabled={!base}>Start training</button>
          </>
        )}
        <Said text={said} />
      </form>
    </Page>
  )
}

// ---- 4 evaluate -------------------------------------------------------------------------------------------

export function EvaluateStep({ g, changed }: { g: PipelineGraph; changed: () => void }) {
  const pid = g.project.id
  const testable = g.datasets.filter((d) => (d.splits?.test ?? 0) > 0)
  const ready = g.finetunes.filter((f) => f.status === 'ready').reverse().slice(0, 4)
  const [ds, setDs] = useState<number | null>(null)
  const [models, setModels] = useState<ModelRef[]>([])
  const [model, setModel] = useState('')
  const [judge, setJudge] = useState('')
  const [plain, setPlain] = useState(true)
  const [withKb, setWithKb] = useState(g.knowledge.chunks > 0)
  const [fts, setFts] = useState<number[]>(() => ready.slice(0, 1).map((f) => f.id))
  const [said, setSaid] = useState<string | null>(null)
  useEffect(() => { api.models('chat').then((ms) => { setModels(ms); setModel((m) => m || smallest(ms)) }).catch(() => {}) }, [])
  const done = [...g.evals].reverse().filter((e) => e.status === 'done' && e.summary)
  const latest = done[0]
  const dsName = (id: number | null) => g.datasets.find((d) => d.id === id)?.name
  const run = async (e: FormEvent) => {
    e.preventDefault()
    const dataset = ds ?? testable[0]?.id
    const variants = [
      ...(plain ? [{ kind: 'model' as const, ref: model, rag: false }] : []),
      ...(withKb ? [{ kind: 'model' as const, ref: model, rag: true }] : []),
      ...fts.map((id) => ({ kind: 'finetune' as const, ref: String(id), rag: false })),
    ]
    if (!dataset || !variants.length) return
    try {
      const r = await api.createEval(pid, { dataset_id: dataset, variants, max_examples: 20, ...(judge ? { judge_model: judge } : {}) })
      setSaid(`Evaluation #${r.eval.id} is running. Its report will appear above when it's done.`)
      changed()
    } catch (x) { setSaid(err(x)) }
  }
  return (
    <Page eye="Step 4 of 4 · Evaluate"
          title={latest ? findings({ ...latest, results: [] } as unknown as EvalRun, dsName(latest.dataset_id)).headline : 'Find out whether it worked.'}
          lede={latest ? <>From evaluation #{latest.id}. <Link className="nb-link" to={`/notebook/report/${latest.id}`}>Read the report →</Link></>
            : 'Each version answers the same held-out test questions, and the scores say which helped: your documents, your fine-tune, both, or neither.'}
          margin={<>
            <Note title="Reading the scores.">F1 is word overlap with the reference answer, from 0 to 1. The judge score is a second model's opinion, from 1 to 5.</Note>
            <Note title="Fair tests.">Test questions are never trained on, so a fine-tune can't simply remember them.</Note>
          </>}>
      <ul className="mt-6">
        {done.map((e) => {
          const f = findings({ ...e, results: [] } as unknown as EvalRun, dsName(e.dataset_id))
          return (
            <li key={e.id} className="nb-example">
              <Link to={`/notebook/report/${e.id}`} className="nb-serif text-[19px] text-[var(--ink)] hover:underline">{f.headline}</Link>
              <div className="text-xs text-[var(--mu)]">#{e.id} · {e.name} · {f.questions} questions</div>
            </li>
          )
        })}
      </ul>
      <form onSubmit={run} className="nb-noprint mt-8 border-t-2 border-[var(--ink)] pt-4">
        <h2 className="nb-h2 !mt-0">Run an evaluation</h2>
        {!testable.length ? <p className="text-[13px] text-[var(--mu)]">It needs a dataset with test questions: about ten practice questions or more, from step 2.</p> : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-xs text-[var(--mu)]">Test questions from<select className="nb-input" value={ds ?? testable[0].id} onChange={(e) => setDs(Number(e.target.value))}>{testable.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.splits?.test} test</option>)}</select></label>
              <label className="text-xs text-[var(--mu)]">Chat model<select className="nb-input" value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}</select></label>
              <label className="text-xs text-[var(--mu)]">Judge (optional, slower)<select className="nb-input" value={judge} onChange={(e) => setJudge(e.target.value)}><option value="">No judge</option>{models.map((m) => <option key={m.ref} value={m.ref}>{m.name}</option>)}</select></label>
            </div>
            <fieldset className="mt-4 space-y-1.5 text-[13px]">
              <legend className="mb-1 text-xs text-[var(--mu)]">Compare</legend>
              <label className="flex items-center gap-2"><input type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} /> the model on its own</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={withKb} disabled={!g.knowledge.chunks} onChange={(e) => setWithKb(e.target.checked)} /> the model with your documents</label>
              {ready.map((f) => (
                <label key={f.id} className="flex items-center gap-2"><input type="checkbox" checked={fts.includes(f.id)} onChange={(e) => setFts((xs) => (e.target.checked ? [...xs, f.id] : xs.filter((x) => x !== f.id)))} /> {f.name}</label>
              ))}
            </fieldset>
            <button className="nb-pill green mt-4" type="submit" disabled={!model}>Evaluate</button>
          </>
        )}
        <Said text={said} />
      </form>
    </Page>
  )
}

// ---- the report --------------------------------------------------------------------------------------------

export function ReportView({ g, evalId }: { g: PipelineGraph; evalId: number }) {
  const pid = g.project.id
  const { data: run } = usePolling<EvalRun>(() => api.evalRun(pid, evalId), 8000, [pid, evalId])
  const [events, setEvents] = useState<JobEvent[]>([])
  const [said, setSaid] = useState<string | null>(null)
  const dsName = g.datasets.find((d) => d.id === run?.dataset_id)?.name ?? null
  const f = useMemo(() => (run ? findings(run, dsName) : null), [run, dsName])
  const ftVariant = f?.ranked.find((v) => v.kind === 'ft' || v.kind === 'ft-kb')
  const ft = g.finetunes.find((x) => String(x.id) === ftVariant?.ref)
  useEffect(() => { if (ft?.job_id) api.jobMetrics(ft.job_id).then(setEvents).catch(() => {}) }, [ft?.job_id])
  if (!run || !f) return <div className="nb-body report"><p className="nb-serif text-lg">Loading the report…</p></div>

  const md = () => reportMarkdown(run, f, dsName)
  const copy = async () => { try { await navigator.clipboard.writeText(md()); setSaid('Copied as Markdown.') } catch { setSaid('Your browser refused the clipboard; use Download instead.') } }
  const download = () => {
    const url = URL.createObjectURL(new Blob([md()], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `llmcoach-evaluation-${run.id}.md`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const top = Math.max(...f.ranked.map((v) => v.score.f1), 0.001)
  return (
    <Page eye={`Step 4 of 4 · Evaluate · run #${run.id}`} title={run.status === 'done' ? f.headline : `Evaluation ${run.status}…`} lede={f.lede}
          margin={<>
            <Note title="Reading the scores.">Token F1 is word overlap with the reference answer, from 0 to 1. The judge score is a second model's opinion, from 1 to 5.</Note>
            {f.notes.map((n) => <Note key={n}>{n}{f.small && n.startsWith('Before') && dsName ? <> <Link className="nb-link" to="/notebook/dataset">Add examples to “{dsName}” →</Link></> : null}</Note>)}
            {ft && <LossFigure events={events} caption={`Fig. 1. ${ft.name}.`} />}
          </>}>
      <div className="nb-noprint mt-4 flex flex-wrap gap-2">
        <button className="nb-pill" onClick={copy}>Copy as Markdown</button>
        <button className="nb-pill" onClick={download}>Download .md</button>
        <button className="nb-pill" onClick={() => window.print()}>Print</button>
      </div>
      <Said text={said} />
      <div className="nb-tbl-wrap">
        <table className="nb-tbl">
          <thead><tr><th>Version</th><th className="w-[210px]">Token F1</th><th>Judge</th><th className="text-right">Latency</th></tr></thead>
          <tbody>
            {f.ranked.map((v, i) => (
              <tr key={v.label} className={i === 0 && f.ranked.length > 1 ? 'best' : ''}>
                <td className="v"><b>{v.label}</b><small>{KIND_WORDS[v.kind]}</small></td>
                <td><div className={`nb-f1 ${i ? 'lo' : ''}`}><span style={{ width: `${Math.max(2, (v.score.f1 / top) * 140)}px` }} />{v.score.f1.toFixed(3)}</div></td>
                <td>{v.score.judge != null
                  ? <div className="nb-dots" title={`${v.score.judge.toFixed(1)} of 5`}>{[1, 2, 3, 4, 5].map((k) => <i key={k} className={k <= Math.round(v.score.judge!) ? 'f' : ''} />)}</div>
                  : <span className="text-[var(--mu)]">—</span>}</td>
                <td className="text-right">{(v.score.latency_ms / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!run.results?.length && (
        <>
          <h2 className="nb-h2">What they said</h2>
          {run.results.slice(0, 3).map((r) => (
            <div key={r.index} className="nb-example">
              <p className="nb-q !my-0 !text-[19px]">{r.question}</p>
              <p className="mt-1 text-[12.5px] text-[var(--mu)]"><b className="font-semibold text-[var(--ink)]">Reference.</b> {r.reference}</p>
              {f.ranked.map((v) => {
                const o = r.outputs[v.label]
                return o ? (
                  <p key={v.label} className="nb-serif mt-2 text-[15.5px] leading-relaxed">
                    <span className="font-sans text-[11px] font-semibold uppercase tracking-wide text-[var(--mu)]">{v.label} · F1 {o.f1.toFixed(2)}</span><br />{o.error ? <i>{o.error}</i> : o.answer}
                  </p>
                ) : null
              })}
            </div>
          ))}
        </>
      )}
    </Page>
  )
}

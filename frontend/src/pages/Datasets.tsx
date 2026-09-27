import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import {
  api, uploadDataset,
  type Dataset, type DatasetRow, type GenerateRequest, type Split,
} from '../api'
import { JobProgress } from '../components/JobProgress'
import { PageHeader } from '../components/Layout'
import { ModelSelect } from '../components/ModelSelect'
import { Button, Card, Empty, fmtTime } from '../components/ui'
import { useProject } from '../hooks/project'

const SPLIT_COLOR: Record<Split, string> = { train: 'bg-accent', val: 'bg-warn', test: 'bg-ok' }

export function Datasets() {
  const { current: project } = useProject()
  const pid = project?.id
  const [list, setList] = useState<Dataset[]>([])
  const [open, setOpen] = useState<Dataset | null>(null)
  const [genJob, setGenJob] = useState<number | null>(null)
  const [kbChunks, setKbChunks] = useState(0)
  const [mode, setMode] = useState<'import' | 'generate'>('generate')

  const reload = useCallback(async () => {
    if (pid == null) return
    const l = await api.datasets(pid)
    setList(l)
    setOpen((o) => (o ? l.find((d) => d.id === o.id) ?? null : null))
  }, [pid])

  useEffect(() => {
    setOpen(null)
    setGenJob(null)
    reload().catch(() => {})
    if (pid != null) api.knowledge(pid).then((k) => setKbChunks(k.chunks)).catch(() => {})
  }, [pid, reload])

  useEffect(() => {
    if (!list.some((d) => d.status === 'generating')) return
    const t = window.setInterval(() => reload().catch(() => {}), 3000)
    return () => window.clearInterval(t)
  }, [list, reload])

  if (!project) return <div className="text-sm text-muted">Loading project…</div>

  return (
    <>
      <PageHeader title="Datasets" subtitle={`Training examples in chat format · ${project.name}`} />

      <Card
        className="mb-6"
        title={
          <div className="flex gap-1">
            {(['generate', 'import'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                      className={`rounded px-2.5 py-1 text-sm ${mode === m ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
                {m === 'generate' ? 'Generate from knowledge base' : 'Import a file'}
              </button>
            ))}
          </div>
        }
      >
        {mode === 'generate'
          ? <GenerateForm pid={project.id} kbChunks={kbChunks} onStarted={(jobId) => { setGenJob(jobId); reload() }} />
          : <ImportForm pid={project.id} onImported={(d) => { reload(); setOpen(d) }} />}
      </Card>

      {genJob != null && (
        <JobProgress jobId={genJob} title="Generating" onFinished={reload} onDismiss={() => setGenJob(null)} />
      )}

      <Card title="Datasets" className="mb-6">
        {!list.length ? <Empty>No datasets yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-normal">Name</th>
                  <th className="pb-2 font-normal">Source</th>
                  <th className="pb-2 text-right font-normal">Examples</th>
                  <th className="pb-2 font-normal">Split</th>
                  <th className="pb-2 text-right font-normal">Avg tokens</th>
                  <th className="pb-2 font-normal">Created</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} className={`border-t border-line ${open?.id === d.id ? 'bg-accent/5' : 'hover:bg-panel-2'}`}>
                    <td className="py-2">
                      <button onClick={() => setOpen(open?.id === d.id ? null : d)} disabled={d.status !== 'ready'}
                              className="text-left hover:text-accent disabled:hover:text-text">{d.name}</button>
                      {d.status === 'generating' && <span className="ml-2 text-xs text-accent">generating…</span>}
                      {d.error && <div className="text-xs text-warn">{d.error}</div>}
                    </td>
                    <td className="py-2 text-muted">{d.source}</td>
                    <td className="py-2 text-right font-mono">{d.row_count.toLocaleString()}</td>
                    <td className="py-2"><SplitBar splits={d.splits} /></td>
                    <td className="py-2 text-right font-mono text-muted">{d.stats?.tokens_mean ?? '—'}</td>
                    <td className="py-2 text-muted">{fmtTime(d.created_at)}</td>
                    <td className="whitespace-nowrap py-2 text-right text-xs">
                      {d.status === 'ready' && (
                        <a href={`/api/projects/${project.id}/datasets/${d.id}/download`} className="mr-3 text-muted hover:text-text">Download</a>
                      )}
                      <button disabled={d.status === 'generating'} className="text-bad/80 hover:text-bad disabled:opacity-30"
                              onClick={async () => {
                                if (!confirm(`Delete dataset "${d.name}"?`)) return
                                await api.deleteDataset(project.id, d.id)
                                if (open?.id === d.id) setOpen(null)
                                reload()
                              }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <DatasetView pid={project.id} dataset={open} onChanged={reload} onClose={() => setOpen(null)} />}
    </>
  )
}

function SplitBar({ splits }: { splits: Dataset['splits'] }) {
  if (!splits) return <span className="text-muted">—</span>
  const total = splits.train + splits.val + splits.test || 1
  return (
    <div className="flex items-center gap-2" title={`train ${splits.train} · val ${splits.val} · test ${splits.test}`}>
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-line">
        {(['train', 'val', 'test'] as const).map((k) => (
          <div key={k} className={SPLIT_COLOR[k]} style={{ width: `${(splits[k] / total) * 100}%` }} />
        ))}
      </div>
      <span className="font-mono text-[11px] text-muted">{splits.train}/{splits.val}/{splits.test}</span>
    </div>
  )
}

function GenerateForm({ pid, kbChunks, onStarted }: { pid: number; kbChunks: number; onStarted: (jobId: number) => void }) {
  const [form, setForm] = useState<GenerateRequest>({
    model: '', pairs_per_chunk: 3, max_chunks: 20, style: 'closed', system_prompt: '', val: 0.1, test: 0.1,
  })
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof GenerateRequest>(k: K, v: GenerateRequest[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const r = await api.generateDataset(pid, { ...form, name: name || undefined, system_prompt: form.system_prompt || undefined })
      onStarted(r.job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
  }

  if (!kbChunks) {
    return <p className="text-sm text-muted">Add documents to the Knowledge Base first. Generation writes question-and-answer pairs from its passages.</p>
  }
  const passages = Math.min(form.max_chunks, kbChunks)
  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      <p className="text-muted">
        A chat model reads passages from your knowledge base and writes question-and-answer pairs about each one.
        Nobody has to write examples by hand. Review them below before training.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Model that writes the pairs">
          <ModelSelect capability="chat" value={form.model || null} onChange={(v) => set('model', v ?? '')} className="w-full" />
        </Field>
        <Field label="Dataset name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Generated from knowledge base" className={input} />
        </Field>
        <Field label={`Passages to use (the knowledge base has ${kbChunks})`}>
          <input type="number" min={1} max={2000} value={form.max_chunks} onChange={(e) => set('max_chunks', Number(e.target.value))} className={input} />
        </Field>
        <Field label="Pairs per passage">
          <input type="number" min={1} max={10} value={form.pairs_per_chunk} onChange={(e) => set('pairs_per_chunk', Number(e.target.value))} className={input} />
        </Field>
        <Field label="Example style">
          <select value={form.style} onChange={(e) => set('style', e.target.value as 'closed' | 'grounded')} className={input}>
            <option value="closed">Question → answer (teaches the model to answer directly)</option>
            <option value="grounded">Passage + question → answer (teaches it to use retrieved context)</option>
          </select>
        </Field>
        <Field label="System prompt on every example (optional)">
          <input value={form.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} placeholder="You are the support assistant for…" className={input} />
        </Field>
      </div>
      <p className="text-xs text-muted">
        About {passages * form.pairs_per_chunk} examples. On a CPU, expect roughly 20–60 seconds per passage with an 8B model
        (~{Math.max(1, Math.round((passages * 40) / 60))} min).
      </p>
      {error && <div className="text-bad">{error}</div>}
      <Button type="submit" disabled={!form.model}>Generate dataset</Button>
    </form>
  )
}

function ImportForm({ pid, onImported }: { pid: number; onImported: (d: Dataset) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [val, setVal] = useState(0.1)
  const [test, setTest] = useState(0.1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok?: string; error?: string; lines?: { line: number; error: string }[] } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setResult(null)
    try {
      const r = await uploadDataset(pid, file, name, val, test)
      setResult({ ok: `Imported ${r.dataset.row_count} examples${r.error_count ? `, skipped ${r.error_count} invalid row(s)` : ''}.`, lines: r.errors })
      onImported(r.dataset)
      setFile(null)
      setName('')
    } catch (err) {
      const e2 = err as Error & { lines?: { line: number; error: string }[] }
      setResult({ error: e2.message, lines: e2.lines })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      <p className="text-muted">
        JSONL, JSON or CSV. Accepted shapes: chat <code className="font-mono text-xs">{'{"messages": [...]}'}</code>, Alpaca
        (<code className="font-mono text-xs">instruction / input / output</code>), <code className="font-mono text-xs">prompt / completion</code>,
        or <code className="font-mono text-xs">question / answer</code>. Invalid rows are skipped and listed.
      </p>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="File">
          <button type="button" onClick={() => input.current?.click()} className={`${inputCls} truncate text-left`}>
            {file ? file.name : 'Choose file…'}
          </button>
          <input ref={input} type="file" accept=".jsonl,.json,.csv,.ndjson" className="hidden"
                 onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
        </Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={file?.name ?? ''} className={inputCls} /></Field>
        <Field label="Validation share"><input type="number" step={0.05} min={0} max={0.5} value={val} onChange={(e) => setVal(Number(e.target.value))} className={inputCls} /></Field>
        <Field label="Test share"><input type="number" step={0.05} min={0} max={0.5} value={test} onChange={(e) => setTest(Number(e.target.value))} className={inputCls} /></Field>
      </div>
      <Button type="submit" disabled={!file || busy}>{busy ? 'Importing…' : 'Import'}</Button>
      {result?.ok && <div className="text-ok">{result.ok}</div>}
      {result?.error && <div className="text-bad">{result.error}</div>}
      {result?.lines && result.lines.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded border border-line bg-bg/50 p-2 font-mono text-xs">
          {result.lines.map((l) => <div key={l.line}><span className="text-muted">line {l.line}:</span> <span className="text-warn">{l.error}</span></div>)}
        </div>
      )}
    </form>
  )
}

function DatasetView({ pid, dataset, onChanged, onClose }: { pid: number; dataset: Dataset; onChanged: () => void; onClose: () => void }) {
  const [split, setSplit] = useState<Split | ''>('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<DatasetRow[]>([])
  const [total, setTotal] = useState(0)
  const [val, setVal] = useState(dataset.splits ? +(dataset.splits.val / Math.max(1, dataset.row_count)).toFixed(2) : 0.1)
  const [test, setTest] = useState(dataset.splits ? +(dataset.splits.test / Math.max(1, dataset.row_count)).toFixed(2) : 0.1)

  const load = useCallback(async (offset: number) => {
    const r = await api.datasetRows(pid, dataset.id, { split: split || undefined, q: q || undefined, offset, limit: 25 })
    setRows((prev) => (offset === 0 ? r.rows : [...prev, ...r.rows]))
    setTotal(r.total)
  }, [pid, dataset.id, split, q])

  useEffect(() => {
    const t = window.setTimeout(() => load(0).catch(() => {}), 200)
    return () => window.clearTimeout(t)
  }, [load])

  const st = dataset.stats
  return (
    <Card title={dataset.name} className="mb-6" actions={<button onClick={onClose} className="text-xs text-muted hover:text-text">Close</button>}>
      {st && (
        <div className="mb-5 grid gap-4 md:grid-cols-[1fr_16rem]">
          <div>
            <div className="mb-1 text-xs text-muted">Examples by length (approx. tokens)</div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={st.length_histogram.map((b) => ({ ...b, label: `${b.from}+` }))}>
                <XAxis dataKey="label" stroke="#8a93a6" fontSize={11} tickLine={false} />
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252a36', fontSize: 12 }} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="count" fill="#7c9cff" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Examples" value={dataset.row_count.toLocaleString()} />
            <Stat label="Total tokens" value={st.tokens_total.toLocaleString()} />
            <Stat label="Mean / p95" value={`${st.tokens_mean} / ${st.tokens_p95}`} />
            <Stat label="Answer mean" value={String(st.answer_tokens_mean)} />
            <Stat label="Multi-turn" value={String(st.multi_turn)} />
            <Stat label="With system" value={String(st.with_system)} />
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div className="flex gap-1">
          {(['', 'train', 'val', 'test'] as const).map((s) => (
            <button key={s} onClick={() => setSplit(s)}
                    className={`rounded px-2 py-1 text-xs ${split === s ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
              {s || 'all'}{s && dataset.splits ? ` (${dataset.splits[s]})` : ''}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search examples…" className={`${inputCls} w-56`} />
        <div className="ml-auto flex items-end gap-2">
          <Field label="Val"><input type="number" step={0.05} min={0} max={0.5} value={val} onChange={(e) => setVal(Number(e.target.value))} className={`${inputCls} w-20`} /></Field>
          <Field label="Test"><input type="number" step={0.05} min={0} max={0.5} value={test} onChange={(e) => setTest(Number(e.target.value))} className={`${inputCls} w-20`} /></Field>
          <Button variant="ghost" onClick={async () => { await api.resplit(pid, dataset.id, val, test); onChanged(); load(0) }}>Re-split</Button>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.index} className="rounded-md border border-line p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
              <span className="font-mono">#{r.index + 1}</span>
              <span className={`rounded px-1.5 py-0.5 text-bg ${SPLIT_COLOR[r.split]}`}>{r.split}</span>
              {typeof r.meta?.source === 'string' && <span className="truncate">from {r.meta.source}</span>}
            </div>
            <div className="space-y-1.5">
              {r.messages.map((m, i) => (
                <div key={i} className="grid grid-cols-[4.5rem_1fr] gap-2 text-sm">
                  <span className={`text-xs ${m.role === 'assistant' ? 'text-ok' : m.role === 'system' ? 'text-warn' : 'text-accent'}`}>{m.role}</span>
                  <span className="line-clamp-6 whitespace-pre-wrap">{m.content}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!rows.length && <Empty>No matching examples.</Empty>}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-muted">
        <span>Showing {rows.length} of {total}</span>
        {rows.length < total && <Button variant="ghost" onClick={() => load(rows.length)}>Load more</Button>}
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line px-2 py-1.5">
      <div className="text-muted">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  )
}

const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent'
const input = inputCls

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  )
}

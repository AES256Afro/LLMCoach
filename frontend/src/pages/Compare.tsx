import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type Dataset, type EvalRun, type EvalVariant, type FineTune } from '../api'
import { JobProgress } from '../components/JobProgress'
import { PageHeader } from '../components/Layout'
import { ModelSelect } from '../components/ModelSelect'
import { Button, Card, Empty, fmtTime } from '../components/ui'
import { useProject } from '../hooks/project'

const COLORS = ['#7c9cff', '#fbbf24', '#4ade80', '#f472b6', '#22d3ee', '#c084fc']
type Draft = Omit<EvalVariant, 'label'>

export function Compare() {
  const { current: project } = useProject()
  const pid = project?.id
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [open, setOpen] = useState<EvalRun | null>(null)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [finetunes, setFinetunes] = useState<FineTune[]>([])
  const [jobId, setJobId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    if (pid == null) return
    const [r, d, f] = await Promise.all([api.evals(pid), api.datasets(pid), api.finetunes(pid)])
    setRuns(r)
    setDatasets(d.filter((x) => x.status === 'ready'))
    setFinetunes(f.filter((x) => x.status === 'ready'))
  }, [pid])

  useEffect(() => {
    setOpen(null)
    setJobId(null)
    reload().catch(() => {})
  }, [reload])

  const openRun = useCallback(async (id: number) => {
    if (pid != null) setOpen(await api.evalRun(pid, id))
  }, [pid])

  if (!project) return <div className="text-sm text-muted">Loading project…</div>

  return (
    <>
      <PageHeader title="Compare" subtitle={`Score models, fine-tunes and RAG side by side on held-out questions · ${project.name}`} />
      {datasets.length === 0
        ? <Card className="mb-6"><p className="text-sm text-muted">Evaluations need a dataset with a test split. Create one on the Datasets page.</p></Card>
        : <NewEval pid={project.id} datasets={datasets} finetunes={finetunes}
                   onStarted={(evalId, job) => { setJobId(job); reload(); openRun(evalId) }} />}

      {jobId != null && (
        <JobProgress jobId={jobId} title="Evaluating" onDismiss={() => setJobId(null)}
                     onFinished={() => { reload(); if (open) openRun(open.id) }} />
      )}

      <Card title="Evaluations" className="mb-6">
        {!runs.length ? <Empty>No evaluations yet.</Empty> : (
          <div className="space-y-1">
            {runs.map((r) => {
              const best = r.summary ? Object.entries(r.summary).sort((a, b) => b[1].f1 - a[1].f1)[0] : null
              return (
                <div key={r.id} className={`flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-sm ${open?.id === r.id ? 'bg-accent/10' : 'hover:bg-panel-2'}`}>
                  <button onClick={() => openRun(r.id)} className="font-medium hover:text-accent">{r.name}</button>
                  <span className={`text-xs ${r.status === 'done' ? 'text-ok' : r.status === 'failed' ? 'text-bad' : 'text-muted'}`}>{r.status}</span>
                  <span className="text-xs text-muted">{r.variants.length} variants · {r.examples || '?'} questions</span>
                  {best && <span className="text-xs text-muted">best F1: <b className="text-text">{best[0]}</b> ({best[1].f1.toFixed(3)})</span>}
                  <span className="ml-auto text-xs text-muted">{fmtTime(r.created_at)}</span>
                  <button disabled={r.status === 'queued' || r.status === 'running'} className="text-xs text-bad/80 hover:text-bad disabled:opacity-30"
                          onClick={async () => {
                            if (!confirm(`Delete "${r.name}"?`)) return
                            await api.deleteEval(project.id, r.id)
                            if (open?.id === r.id) setOpen(null)
                            reload()
                          }}>Delete</button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {open && <Results run={open} onRefresh={() => openRun(open.id)} />}
    </>
  )
}

function NewEval({ pid, datasets, finetunes, onStarted }: {
  pid: number; datasets: Dataset[]; finetunes: FineTune[]; onStarted: (evalId: number, jobId: number) => void
}) {
  const withTest = datasets.filter((d) => (d.splits?.test ?? 0) + (d.splits?.val ?? 0) > 0)
  const [datasetId, setDatasetId] = useState<number | null>(withTest[0]?.id ?? null)
  const [variants, setVariants] = useState<Draft[]>([{ kind: 'model', ref: '', rag: false }, { kind: 'model', ref: '', rag: true }])
  const [judge, setJudge] = useState<string | null>(null)
  const [maxExamples, setMaxExamples] = useState(20)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const update = (i: number, patch: Partial<Draft>) => setVariants((v) => v.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const ds = datasets.find((d) => d.id === datasetId)
  const questions = Math.min(maxExamples, (ds?.splits?.test || ds?.splits?.val) ?? 0)

  const start = async () => {
    if (datasetId == null) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.createEval(pid, { dataset_id: datasetId, variants, judge_model: judge ?? undefined, max_examples: maxExamples })
      onStarted(r.eval.id, r.job.id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!withTest.length) {
    return <Card className="mb-6"><p className="text-sm text-muted">None of the datasets has a test or validation split. Re-split one on the Datasets page.</p></Card>
  }
  return (
    <Card title="New evaluation" className="mb-6">
      <div className="space-y-4 text-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Questions from">
            <select value={datasetId ?? ''} onChange={(e) => setDatasetId(Number(e.target.value))} className={inputCls}>
              {withTest.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.splits?.test || d.splits?.val} test</option>)}
            </select>
          </Field>
          <Field label="Max questions">
            <input type="number" min={1} max={1000} value={maxExamples} onChange={(e) => setMaxExamples(Number(e.target.value))} className={inputCls} />
          </Field>
          <Field label="Judge model (optional, scores 1-5)">
            <ModelSelect capability="chat" value={judge} onChange={setJudge} allowDefault="No judge" className="w-full" />
          </Field>
        </div>

        <div>
          <div className="mb-2 text-xs text-muted">Variants to compare</div>
          <div className="space-y-2">
            {variants.map((v, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                <select value={v.kind} onChange={(e) => update(i, { kind: e.target.value as Draft['kind'], ref: '' })} className={`${inputCls} w-32`}>
                  <option value="model">Model</option>
                  <option value="finetune" disabled={!finetunes.length}>Fine-tune</option>
                </select>
                {v.kind === 'model'
                  ? <ModelSelect capability="chat" value={v.ref || null} onChange={(r) => update(i, { ref: r ?? '' })} allowDefault="Choose a model…" className="min-w-[14rem] flex-1" />
                  : (
                    <select value={v.ref} onChange={(e) => update(i, { ref: e.target.value })} className={`${inputCls} min-w-[14rem] flex-1`}>
                      <option value="">Choose a fine-tune…</option>
                      {finetunes.map((f) => <option key={f.id} value={String(f.id)}>{f.name}</option>)}
                    </select>
                  )}
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={v.rag} onChange={(e) => update(i, { rag: e.target.checked })} className="accent-[var(--color-accent)]" />
                  + knowledge base
                </label>
                <button onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))} disabled={variants.length <= 1}
                        className="px-1 text-muted hover:text-bad disabled:opacity-30" title="Remove">×</button>
              </div>
            ))}
          </div>
          {variants.length < 6 && (
            <button onClick={() => setVariants((v) => [...v, { kind: 'model', ref: '', rag: false }])} className="mt-2 text-xs text-accent">+ Add variant</button>
          )}
        </div>

        <p className="text-xs text-muted">
          {questions} questions × {variants.length} variants = {questions * variants.length} answers{judge ? ', each graded by the judge' : ''}.
          Fine-tunes run inside the job with transformers, which is slow on a CPU for anything above ~0.5B.
        </p>
        {error && <div className="text-bad">{error}</div>}
        <Button disabled={busy || datasetId == null || variants.some((v) => !v.ref)} onClick={start}>{busy ? 'Starting…' : 'Run evaluation'}</Button>
      </div>
    </Card>
  )
}

function Results({ run, onRefresh }: { run: EvalRun; onRefresh: () => void }) {
  const [sortBy, setSortBy] = useState<string>('')
  const labels = run.variants.map((v) => v.label)
  const summary = run.summary ?? {}

  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'queued') return
    const t = window.setInterval(onRefresh, 4000)
    return () => window.clearInterval(t)
  }, [run.status, onRefresh])

  const best = (k: 'f1' | 'rouge_l' | 'exact_match' | 'judge') =>
    Math.max(...labels.map((l) => summary[l]?.[k] ?? -1))
  const chart = [
    { metric: 'F1', ...Object.fromEntries(labels.map((l) => [l, summary[l]?.f1 ?? 0])) },
    { metric: 'ROUGE-L', ...Object.fromEntries(labels.map((l) => [l, summary[l]?.rouge_l ?? 0])) },
    { metric: 'Exact match', ...Object.fromEntries(labels.map((l) => [l, summary[l]?.exact_match ?? 0])) },
    ...(run.judge_model ? [{ metric: 'Judge (÷5)', ...Object.fromEntries(labels.map((l) => [l, (summary[l]?.judge ?? 0) / 5])) }] : []),
  ]

  const rows = useMemo(() => {
    const r = [...(run.results ?? [])]
    if (sortBy) r.sort((a, b) => (a.outputs[sortBy]?.f1 ?? 1) - (b.outputs[sortBy]?.f1 ?? 1))
    return r
  }, [run.results, sortBy])

  return (
    <Card title={`${run.name} · ${run.split} split`} className="mb-6"
          actions={<span className="text-xs text-muted">{run.status}{run.judge_model ? ` · judge ${run.judge_model}` : ''}</span>}>
      {run.error && <div className="mb-4 text-sm text-bad">{run.error}</div>}
      {Object.keys(summary).length > 0 && (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-normal">Variant</th>
                  <th className="pb-2 text-right font-normal">F1</th>
                  <th className="pb-2 text-right font-normal">ROUGE-L</th>
                  <th className="pb-2 text-right font-normal">Exact</th>
                  {run.judge_model && <th className="pb-2 text-right font-normal">Judge</th>}
                  <th className="pb-2 text-right font-normal">Latency</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((l, i) => {
                  const s = summary[l]
                  if (!s) return null
                  const cell = (k: 'f1' | 'rouge_l' | 'exact_match' | 'judge', digits = 3) => (
                    <td className={`py-1.5 text-right font-mono ${s[k] != null && s[k] === best(k) && labels.length > 1 ? 'font-bold text-ok' : ''}`}>
                      {s[k] == null ? '—' : s[k]!.toFixed(digits)}
                    </td>
                  )
                  return (
                    <tr key={l} className="border-t border-line">
                      <td className="py-1.5">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                        {l}{s.errors ? <span className="ml-2 text-xs text-bad">{s.errors} errors</span> : null}
                      </td>
                      {cell('f1')}{cell('rouge_l')}{cell('exact_match', 2)}{run.judge_model && cell('judge', 2)}
                      <td className="py-1.5 text-right font-mono text-muted">{(s.latency_ms / 1000).toFixed(1)}s</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ left: -20, right: 8 }}>
              <CartesianGrid stroke="#252a36" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="metric" stroke="#8a93a6" fontSize={11} tickLine={false} />
              <YAxis domain={[0, 1]} stroke="#8a93a6" fontSize={11} tickLine={false} />
              <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252a36', fontSize: 12 }} cursor={{ fill: '#ffffff08' }}
                       formatter={(v) => (v as number).toFixed(3)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {labels.map((l, i) => <Bar key={l} dataKey={l} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-3 flex items-center gap-2 text-xs text-muted">
            <span>Sort questions:</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="rounded border border-line bg-bg px-2 py-1">
              <option value="">In order</option>
              {labels.map((l) => <option key={l} value={l}>Worst first for {l}</option>)}
            </select>
          </div>
          <div className="space-y-4">
            {rows.map((r) => (
              <div key={r.index} className="rounded-md border border-line p-3">
                <div className="mb-1 text-sm font-medium">Q{r.index + 1}. {r.question}</div>
                <div className="mb-3 rounded bg-ok/5 px-2 py-1.5 text-xs"><span className="text-ok">Reference:</span> {r.reference}</div>
                <div className="grid gap-3 md:grid-cols-2">
                  {labels.map((l, i) => {
                    const o = r.outputs[l]
                    if (!o) return null
                    return (
                      <div key={l} className="rounded border border-line/70 p-2 text-sm">
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                          <span className="h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="truncate">{l}</span>
                          <span className="ml-auto font-mono">F1 {o.f1.toFixed(2)} · R-L {o.rouge_l.toFixed(2)}{o.judge != null ? ` · judge ${o.judge}/5` : ''}</span>
                        </div>
                        {o.error ? <div className="text-xs text-bad">{o.error}</div>
                          : <div className="whitespace-pre-wrap"><Overlap text={o.answer} reference={r.reference} /></div>}
                        {o.judge_reason && <div className="mt-1 text-[11px] italic text-muted">{o.judge_reason}</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {!rows.length && run.status !== 'failed' && <Empty>Results appear here as the evaluation runs.</Empty>}
    </Card>
  )
}

/** Highlights words that also appear in the reference answer. */
function Overlap({ text, reference }: { text: string; reference: string }) {
  const ref = useMemo(() => new Set(reference.toLowerCase().match(/[a-z0-9]+/g) ?? []), [reference])
  return (
    <>
      {text.split(/(\s+)/).map((w, i) => {
        const key = w.toLowerCase().replace(/[^a-z0-9]/g, '')
        return key.length > 2 && ref.has(key) ? <span key={i} className="rounded bg-ok/15">{w}</span> : <span key={i}>{w}</span>
      })}
    </>
  )
}

const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  )
}

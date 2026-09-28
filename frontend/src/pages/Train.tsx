import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Dataset, type FineTune, type FineTuneRequest, type TrainingOptions, type TrainPlan } from '../api'
import { JobProgress } from '../components/JobProgress'
import { PageHeader } from '../components/Layout'
import { Button, Card, Empty, fmtTime } from '../components/ui'
import { useProject } from '../hooks/project'

const FT_STYLE: Record<FineTune['status'], string> = {
  queued: 'bg-muted/15 text-muted',
  training: 'bg-accent/15 text-accent',
  ready: 'bg-ok/15 text-ok',
  failed: 'bg-bad/15 text-bad',
  cancelled: 'bg-warn/15 text-warn',
}

type Overrides = { epochs?: number; learning_rate?: number; lora_r?: number; lora_alpha?: number; max_seq_len?: number; max_steps?: number }

export function Train() {
  const { current: project } = useProject()
  const pid = project?.id
  const [opts, setOpts] = useState<TrainingOptions | null>(null)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [finetunes, setFinetunes] = useState<FineTune[]>([])
  const [jobId, setJobId] = useState<number | null>(null)
  const [jobTitle, setJobTitle] = useState('Training')
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (pid == null) return
    const [d, f] = await Promise.all([api.datasets(pid), api.finetunes(pid)])
    setDatasets(d.filter((x) => x.status === 'ready'))
    setFinetunes(f)
  }, [pid])

  useEffect(() => {
    api.trainingOptions().then(setOpts).catch(() => {})
  }, [])
  useEffect(() => {
    setJobId(null)
    reload().catch(() => {})
  }, [reload])
  useEffect(() => {
    if (!finetunes.some((f) => f.status === 'queued' || f.status === 'training')) return
    const t = window.setInterval(() => reload().catch(() => {}), 3000)
    return () => window.clearInterval(t)
  }, [finetunes, reload])

  if (!project || !opts) return <div className="text-sm text-muted">Loading…</div>
  const hw = opts.hardware

  const sendToOllama = async (f: FineTune) => {
    setError('')
    try {
      const r = await api.exportFinetune(project.id, f.id)
      setJobTitle(`Export to Ollama · ${r.model.replace(/^[^/]+\//, '')}`)
      setJobId(r.job.id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
    }
  }

  return (
    <>
      <PageHeader title="Train" subtitle={`LoRA fine-tuning on your datasets · ${project.name}`} />

      <div className={`mb-6 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border px-4 py-3 text-sm ${
        hw.backend === 'cuda' ? 'border-ok/30 bg-ok/5' : 'border-warn/30 bg-warn/5'}`}>
        <span className="font-medium">{hw.backend === 'cuda' ? `GPU: ${hw.gpu} · ${hw.vram_gb} GB` : 'CPU only'}</span>
        <span className="text-muted">{hw.ram_gb} GB RAM · {hw.cpu_threads} threads</span>
        <span className="text-muted">Trainer: {hw.recommended_backend === 'unsloth' ? 'Unsloth' : 'TRL + PEFT'}</span>
        {hw.backend !== 'cuda' && (
          <span className="text-warn">
            Without a GPU, only models under {opts.cpu_max_params_b}B can train, and slowly. It's still useful for trying the pipeline end to end.
          </span>
        )}
      </div>

      {datasets.length === 0 ? (
        <Card className="mb-6">
          <p className="text-sm text-muted">You need a dataset first. <Link to="/datasets" className="text-accent hover:underline">Import or generate one</Link>.</p>
        </Card>
      ) : (
        <NewFineTune pid={project.id} opts={opts} datasets={datasets} onStarted={(j) => { setJobTitle('Training'); setJobId(j); reload() }} />
      )}

      {jobId != null && <JobProgress key={jobId} jobId={jobId} title={jobTitle} onFinished={reload} onDismiss={() => setJobId(null)} />}
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}

      <Card title="Fine-tunes">
        {!finetunes.length ? <Empty>No fine-tunes yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-normal">Name</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 text-right font-normal">Train loss</th>
                  <th className="pb-2 text-right font-normal">Eval loss</th>
                  <th className="pb-2 text-right font-normal">Steps</th>
                  <th className="pb-2 font-normal">Trainer</th>
                  <th className="pb-2 font-normal">Created</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {finetunes.map((f) => (
                  <tr key={f.id} className="border-t border-line hover:bg-panel-2">
                    <td className="py-2">
                      <div>{f.name}</div>
                      <div className="font-mono text-[11px] text-muted">{f.base_model} · {f.method.toUpperCase()}</div>
                      {f.ollama_model && <div className="font-mono text-[11px] text-ok" title="Exported: chat with it like any Ollama model">{f.ollama_model}</div>}
                      {f.error && <div className="line-clamp-2 text-xs text-bad">{f.error}</div>}
                    </td>
                    <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${FT_STYLE[f.status]}`}>{f.status}</span></td>
                    <td className="py-2 text-right font-mono">{f.metrics?.train_loss?.toFixed(4) ?? '—'}</td>
                    <td className="py-2 text-right font-mono">{f.metrics?.eval_loss?.toFixed(4) ?? '—'}</td>
                    <td className="py-2 text-right font-mono text-muted">{f.metrics?.steps ?? f.config?.total_steps ?? '—'}</td>
                    <td className="py-2 text-muted">{f.backend === 'unsloth' ? 'Unsloth' : 'TRL'}</td>
                    <td className="whitespace-nowrap py-2 text-muted">{fmtTime(f.created_at)}</td>
                    <td className="whitespace-nowrap py-2 text-right text-xs">
                      {f.job_id && <Link to={`/jobs/${f.job_id}`} className="mr-3 text-accent hover:underline">Charts & logs</Link>}
                      {f.status === 'ready' && (f.ollama_model
                        ? <Link to={`/chat?model=${encodeURIComponent(f.ollama_model)}`} className="mr-3 text-accent hover:underline">Chat with it</Link>
                        : <button className="mr-3 text-accent hover:underline" title="Merge the adapter into its base model and add it to Ollama"
                                  onClick={() => sendToOllama(f)}>Export to Ollama</button>)}
                      <button disabled={f.status === 'queued' || f.status === 'training'} className="text-bad/80 hover:text-bad disabled:opacity-30"
                              onClick={async () => {
                                if (!confirm(`Delete "${f.name}" and its adapter?`)) return
                                await api.deleteFinetune(project.id, f.id)
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
    </>
  )
}

function NewFineTune({ pid, opts, datasets, onStarted }: {
  pid: number; opts: TrainingOptions; datasets: Dataset[]; onStarted: (jobId: number) => void
}) {
  const cpu = opts.hardware.backend !== 'cuda'
  const firstFit = opts.base_models.find((m) => !cpu || m.params_b <= opts.cpu_max_params_b)?.id ?? ''
  const [baseModel, setBaseModel] = useState(cpu ? 'Qwen/Qwen2.5-0.5B-Instruct' : firstFit)
  const [custom, setCustom] = useState('')
  const [datasetId, setDatasetId] = useState(datasets[0].id)
  const [preset, setPreset] = useState('quick')
  const [method, setMethod] = useState<'lora' | 'qlora'>('lora')
  const [backend, setBackend] = useState<'auto' | 'hf' | 'unsloth'>('auto')
  const [overrides, setOverrides] = useState<Overrides>({})
  const [name, setName] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [plan, setPlan] = useState<TrainPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const model = baseModel === '__custom' ? custom.trim() : baseModel
  const body: FineTuneRequest = { name: name || undefined, base_model: model, dataset_id: datasetId, preset, method, backend, overrides }

  // Live plan preview: steps, memory vs. budget, and any reason it can't run.
  useEffect(() => {
    if (!model) return
    const t = window.setTimeout(async () => {
      try {
        const r = await api.createFinetune(pid, { ...body, dry_run: true })
        setPlan(r.plan)
        setPlanError(null)
      } catch (e) {
        setPlan(null)
        setPlanError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
      }
    }, 300)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, model, datasetId, preset, method, backend, JSON.stringify(overrides)])

  const start = async () => {
    setBusy(true)
    try {
      const r = await api.createFinetune(pid, body)
      if (r.job) onStarted(r.job.id)
    } catch (e) {
      setPlanError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  const setO = (k: keyof Overrides, v: string) => setOverrides((o) => ({ ...o, [k]: v === '' ? undefined : Number(v) }))
  const p = opts.presets[preset]
  const selected = opts.base_models.find((m) => m.id === baseModel)

  return (
    <Card title="New fine-tune" className="mb-6">
      <div className="grid gap-4 text-sm lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Base model (Hugging Face)">
            <select value={baseModel} onChange={(e) => setBaseModel(e.target.value)} className={inputCls}>
              {opts.base_models.map((m) => {
                const tooBig = cpu && m.params_b > opts.cpu_max_params_b
                return (
                  <option key={m.id} value={m.id} disabled={tooBig}>
                    {m.id} · {m.params_b}B · {m.license}{m.gated ? ' · gated' : ''}{tooBig ? ' (needs a GPU)' : ''}
                  </option>
                )
              })}
              <option value="__custom">Other Hugging Face model…</option>
            </select>
          </Field>
          {baseModel === '__custom' && (
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="organization/model-name" className={`${inputCls} font-mono`} />
          )}
          {selected && <p className="text-xs text-muted">{selected.note}{selected.gated && !opts.hf_token_set ? ' Set LLMCOACH_HF_TOKEN first.' : ''}</p>}
          <Field label="Dataset">
            <select value={datasetId} onChange={(e) => setDatasetId(Number(e.target.value))} className={inputCls}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{d.name} · {d.splits?.train ?? d.row_count} train / {d.splits?.val ?? 0} val</option>
              ))}
            </select>
          </Field>
          <Field label="Name (optional)">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={model ? `${model.split('/').pop()} on …` : ''} className={inputCls} />
          </Field>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(opts.presets).map(([k, v]) => (
              <button key={k} type="button" onClick={() => setPreset(k)}
                      className={`rounded-md border px-3 py-2 text-left ${preset === k ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-2'}`}>
                <div className="font-medium">{v.label}</div>
                <div className="text-[11px] text-muted">{v.epochs} epoch{v.epochs > 1 ? 's' : ''} · r={v.lora_r}</div>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{p.note}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Method">
              <select value={method} onChange={(e) => setMethod(e.target.value as 'lora' | 'qlora')} className={inputCls}>
                <option value="lora">LoRA (16-bit base)</option>
                <option value="qlora" disabled={cpu}>QLoRA (4-bit base, GPU){cpu ? ' (needs a GPU)' : ''}</option>
              </select>
            </Field>
            <Field label="Trainer">
              <select value={backend} onChange={(e) => setBackend(e.target.value as 'auto' | 'hf' | 'unsloth')} className={inputCls}>
                <option value="auto">Auto ({opts.hardware.recommended_backend === 'unsloth' ? 'Unsloth' : 'TRL + PEFT'})</option>
                <option value="hf">TRL + PEFT</option>
                <option value="unsloth" disabled={!opts.hardware.unsloth_installed || cpu}>Unsloth (NVIDIA)</option>
              </select>
            </Field>
          </div>
          <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-accent">
            {showAdvanced ? 'Hide' : 'Show'} advanced settings
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-3 gap-2">
              <Num label="Epochs" ph={p.epochs} v={overrides.epochs} on={(v) => setO('epochs', v)} step={0.5} />
              <Num label="Learning rate" ph={p.learning_rate} v={overrides.learning_rate} on={(v) => setO('learning_rate', v)} step={0.00001} />
              <Num label="Max steps" ph="all" v={overrides.max_steps} on={(v) => setO('max_steps', v)} />
              <Num label="LoRA r" ph={p.lora_r} v={overrides.lora_r} on={(v) => setO('lora_r', v)} />
              <Num label="LoRA alpha" ph={p.lora_alpha} v={overrides.lora_alpha} on={(v) => setO('lora_alpha', v)} />
              <Num label="Max tokens" ph={p.max_seq_len} v={overrides.max_seq_len} on={(v) => setO('max_seq_len', v)} step={128} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-line pt-4 text-sm">
        {plan && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            <span><b className="text-text">{plan.total_steps}</b> steps</span>
            <span>batch {plan.micro_batch}×{plan.grad_accum}</span>
            <span>max {plan.max_seq_len} tokens</span>
            <span>{plan.backend === 'unsloth' ? 'Unsloth' : 'TRL + PEFT'} on {plan.device.toUpperCase()}</span>
            {plan.memory.gb != null && (
              <span className={plan.memory.fits ? 'text-ok' : 'text-bad'}>
                ~{plan.memory.gb} GB {plan.memory.where}{plan.memory.budget_gb ? ` of ${plan.memory.budget_gb} GB` : ''}
              </span>
            )}
          </div>
        )}
        {planError && <span className="text-bad">{planError}</span>}
        <Button className="ml-auto" disabled={!plan || busy} onClick={start}>{busy ? 'Starting…' : 'Start training'}</Button>
      </div>
    </Card>
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

function Num({ label, ph, v, on, step = 1 }: { label: string; ph: number | string; v?: number; on: (v: string) => void; step?: number }) {
  return (
    <Field label={label}>
      <input type="number" step={step} value={v ?? ''} placeholder={String(ph)} onChange={(e) => on(e.target.value)} className={`${inputCls} font-mono`} />
    </Field>
  )
}

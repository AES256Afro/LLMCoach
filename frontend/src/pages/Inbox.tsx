import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  api, uploadToSource, type ApiToken, type Dataset, type FileStatus, type LoopRunStatus, type Source,
  type SourceFile, type SourceMode, type SourceScan, type TrainingOptions,
} from '../api'
import { PageHeader } from '../components/Layout'
import { Button, Card, Empty, fmtTime } from '../components/ui'
import { useProject } from '../hooks/project'
import { usePolling } from '../hooks/usePolling'

const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted/80">{hint}</span>}
    </label>
  )
}

const MODE_LABEL: Record<SourceMode, string> = { remember: 'Remember: add to the knowledge base', learn: 'Learn: also write practice Q&A' }
const SCAN_LABEL: Record<SourceScan, string> = {
  all: 'Hold files with secrets or personal data',
  secrets: 'Hold files with secrets only',
  off: "Don't check files",
}
const STATUS_STYLE: Record<FileStatus, string> = {
  waiting: 'bg-muted/15 text-muted',
  added: 'bg-ok/15 text-ok',
  duplicate: 'bg-muted/15 text-muted',
  skipped: 'bg-muted/15 text-muted',
  quarantined: 'bg-warn/15 text-warn',
  rejected: 'bg-muted/15 text-muted',
  failed: 'bg-bad/15 text-bad',
  gone: 'bg-muted/15 text-muted',
  forgotten: 'bg-muted/15 text-muted',
}
const STATUS_WORD: Record<FileStatus, string> = {
  waiting: 'waiting', added: 'added', duplicate: 'already known', skipped: 'skipped',
  quarantined: 'held for review', rejected: 'kept out', failed: 'failed',
  gone: 'deleted, still known', forgotten: 'deleted and forgotten',
}

function FileBadge({ status }: { status: FileStatus }) {
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{STATUS_WORD[status]}</span>
}

type Tab = 'folders' | 'loop' | 'tokens'

export function Inbox() {
  const { current } = useProject()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'folders'
  if (!current) return null
  const tabs: [Tab, string][] = [['folders', 'Folders'], ['loop', 'Learning loop'], ['tokens', 'API tokens']]
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Folders LLMCoach watches. Files copied into them join the knowledge base without anyone opening the app, and the learning loop retrains overnight."
      />
      <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setParams(id === 'folders' ? {} : { tab: id })}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'folders' && <Folders pid={current.id} />}
      {tab === 'loop' && <Loop pid={current.id} />}
      {tab === 'tokens' && <Tokens pid={current.id} />}
    </>
  )
}

// ---- folders ------------------------------------------------------------------------------------

function Folders({ pid }: { pid: number }) {
  const { data: sources, reload } = usePolling(() => api.sources(pid), 5000, [pid])
  const { data: review, reload: reloadReview } = usePolling(() => api.reviewQueue(pid), 5000, [pid])
  const [info, setInfo] = useState<{ root: string; supported: string[] } | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => { api.inbox().then(setInfo).catch(() => {}) }, [])
  const refresh = () => { reload(); reloadReview() }

  return (
    <div className="space-y-4">
      {!!review?.length && <ReviewQueue pid={pid} files={review} onChange={refresh} />}
      {sources?.map((s) => <SourceCard key={s.id} pid={pid} source={s} onChange={refresh} />)}
      {adding || sources?.length === 0 ? (
        <AddSource pid={pid} root={info?.root} onDone={() => { setAdding(false); refresh() }} onCancel={sources?.length ? () => setAdding(false) : undefined} />
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)}>Watch another folder or bucket</Button>
      )}
      {info && (
        <p className="text-xs text-muted">
          The inbox is <code className="font-mono">{info.root}</code>. On BigBox, BoxPilot can share that folder over SMB so other
          computers can drop files straight into it. Supported: {info.supported.join(' ')}.
        </p>
      )}
    </div>
  )
}

function ReviewQueue({ pid, files, onChange }: { pid: number; files: SourceFile[]; onChange: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (id: number, fn: typeof api.approveFile | typeof api.rejectFile) => {
    setBusy(id)
    setError(null)
    try { await fn(pid, id) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(null)
    onChange()
  }
  return (
    <Card title={<span className="text-warn">Held for review · {files.length}</span>}>
      <p className="mb-3 text-xs text-muted">
        These files look like they contain secrets or personal data. Anything in the knowledge base can be quoted in answers and
        copied into training data, so they wait here. Values are shown masked.
      </p>
      {error && <p className="mb-2 text-xs text-bad">{error}</p>}
      <ul className="divide-y divide-line">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-start gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm">{f.relpath}</div>
              <div className="text-xs text-muted">{f.source_name} · found {fmtTime(f.processed_at ?? f.first_seen_at)}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {f.findings?.map((x) => (
                  <span key={x.kind} className={`rounded px-1.5 py-0.5 text-xs ${x.category === 'secret' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}>
                    {x.label}{x.count > 1 ? ` ×${x.count}` : ''} <span className="font-mono opacity-80">{x.sample}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busy === f.id} onClick={() => act(f.id, api.rejectFile)}>Keep out</Button>
              <Button variant="danger" disabled={busy === f.id} onClick={() => act(f.id, api.approveFile)}>Add anyway</Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function SourceCard({ pid, source: s, onChange }: { pid: number; source: Source; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [scanning, setScanning] = useState(false)
  const update = (patch: Parameters<typeof api.updateSource>[2]) => api.updateSource(pid, s.id, patch).then(onChange)
  const summarize = (r: Awaited<ReturnType<typeof api.scanSource>>) => {
    if (r.error) return r.error
    const parts = Object.entries(r.processed ?? {}).map(([k, n]) => `${n} ${STATUS_WORD[k as FileStatus]}`)
    if (r.written?.length) parts.unshift(`copied ${r.written.length} into the folder`)
    if (r.waiting) parts.push(`${r.waiting} still settling`)
    return parts.length ? parts.join(', ') : 'Nothing new.'
  }
  const scan = async () => {
    setScanning(true)
    try { setNote(summarize(await api.scanSource(pid, s.id))) } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
    setScanning(false)
    onChange()
  }
  const drop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    setNote(`Copying ${files.length} file${files.length > 1 ? 's' : ''}…`)
    try { setNote(summarize(await uploadToSource(pid, s.id, files))) } catch (err) { setNote(err instanceof Error ? err.message : String(err)) }
    onChange()
  }
  const total = Object.values(s.counts).reduce((a, b) => a + (b ?? 0), 0)
  const where = s.kind === 'bucket' ? 'bucket' : 'folder'

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${!s.enabled ? 'bg-muted' : s.last_error ? 'bg-bad' : 'bg-ok'}`} />
          {s.name}
          <span className="truncate font-mono text-xs font-normal text-muted">{s.path}</span>
        </span>
      }
      actions={
        <>
          <Button variant="ghost" disabled={scanning || !s.enabled} onClick={scan}>{scanning ? 'Looking…' : 'Look now'}</Button>
          <Button variant="ghost" onClick={() => update({ enabled: !s.enabled })}>{s.enabled ? 'Pause' : 'Resume'}</Button>
          <Button variant="danger" onClick={() => confirm(`Stop watching ${s.name}? Its ${s.kind === 'bucket' ? 'objects' : 'files'} and the documents already added stay.`) && api.deleteSource(pid, s.id).then(onChange)}>
            Stop watching
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What to do with new files">
          <select className={inputCls} value={s.mode} onChange={(e) => update({ mode: e.target.value as SourceMode })}>
            {(Object.keys(MODE_LABEL) as SourceMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Before adding">
          <select className={inputCls} value={s.scan} onChange={(e) => update({ scan: e.target.value as SourceScan })}>
            {(Object.keys(SCAN_LABEL) as SourceScan[]).map((m) => <option key={m} value={m}>{SCAN_LABEL[m]}</option>)}
          </select>
        </Field>
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={s.mirror_deletes}
               onChange={(e) => update({ mirror_deletes: e.target.checked })} />
        <span>
          Forget files deleted from this {where}
          <span className="block text-[11px] text-muted">
            {s.mirror_deletes
              ? `A file gone for a minute takes its document out of the knowledge base. Nothing is removed while the whole ${where} looks empty${s.kind === 'bucket' ? '' : ', as an unplugged share would'}.`
              : `Off: documents stay after their file is deleted, so the ${where} can be cleared once files are in.`}
          </span>
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        {(Object.keys(STATUS_WORD) as FileStatus[]).filter((k) => s.counts[k]).map((k) => (
          <span key={k} className={`rounded-full px-2 py-0.5 ${STATUS_STYLE[k]}`}>{s.counts[k]} {STATUS_WORD[k]}</span>
        ))}
        <span className="ml-auto text-muted">
          {!s.enabled ? 'Paused' : s.last_scan_at ? `Looked ${fmtTime(s.last_scan_at)} · every ${s.poll_seconds}s` : 'Not looked at yet'}
        </span>
      </div>
      {s.last_error && <p className="mt-2 text-xs text-bad">{s.last_error}</p>}

      {s.kind === 'bucket' ? (
        <>
          {note && <p className="mt-3 text-xs">{note}</p>}
          <BucketKeys pid={pid} source={s} onChange={onChange} />
        </>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={`mt-3 rounded-md border border-dashed px-3 py-3 text-center text-xs transition ${dragging ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted'}`}
        >
          Drop files here to put them in this folder{note ? <span className="mt-1 block text-text">{note}</span> : null}
        </div>
      )}

      {total > 0 && (
        <button className="mt-3 text-xs text-accent hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide files' : `Show files (${total})`}
        </button>
      )}
      {open && <Ledger pid={pid} sourceId={s.id} />}
    </Card>
  )
}

function BucketKeys({ pid, source: s, onChange }: { pid: number; source: Source; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [accessKey, setAccessKey] = useState(s.access_key ?? '')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.updateSource(pid, s.id, { access_key: accessKey, ...(secret ? { secret_key: secret } : {}) })
      setSecret('')
      setOpen(false)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
  }
  if (!open) {
    return (
      <p className="mt-3 text-xs text-muted">
        Reads with key <code className="font-mono">{s.access_key}</code> · region {s.region ?? 'us-east-1'} ·{' '}
        <button className="text-accent hover:underline" onClick={() => setOpen(true)}>Change key</button>
      </p>
    )
  }
  return (
    <form onSubmit={save} className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Access key"><input className={inputCls} value={accessKey} onChange={(e) => setAccessKey(e.target.value)} required /></Field>
      <Field label="Secret key" hint="Leave empty to keep the current one.">
        <input className={inputCls} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      {error && <p className="text-xs text-bad sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit">Check and save</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  )
}

function Ledger({ pid, sourceId }: { pid: number; sourceId: number }) {
  const [filter, setFilter] = useState<FileStatus | ''>('')
  const { data } = usePolling(() => api.sourceFiles(pid, sourceId, filter || undefined), 5000, [pid, sourceId, filter])
  return (
    <div className="mt-2">
      <select className={`${inputCls} mb-2 max-w-52`} value={filter} onChange={(e) => setFilter(e.target.value as FileStatus | '')}>
        <option value="">Every file</option>
        {(Object.keys(STATUS_WORD) as FileStatus[]).map((k) => <option key={k} value={k}>{STATUS_WORD[k]}</option>)}
      </select>
      <div className="max-h-80 overflow-auto rounded border border-line">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-panel text-muted">
            <tr><th className="px-2 py-1.5 font-normal">File</th><th className="px-2 py-1.5 font-normal">Status</th><th className="px-2 py-1.5 font-normal">When</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.files.map((f) => (
              <tr key={f.id}>
                <td className="px-2 py-1.5">
                  <span className="font-mono">{f.relpath}</span>
                  {f.error && <span className="block text-muted">{f.error}</span>}
                  {f.missing_at && <span className="block text-warn">Not in the folder since {fmtTime(f.missing_at)}; its document goes if it stays away.</span>}
                </td>
                <td className="px-2 py-1.5"><FileBadge status={f.status} /></td>
                <td className="whitespace-nowrap px-2 py-1.5 text-muted">{fmtTime(f.processed_at ?? f.first_seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.files.length === 0 && <Empty>No files{filter ? ` ${STATUS_WORD[filter]}` : ''}.</Empty>}
      </div>
    </div>
  )
}

function AddSource({ pid, root, onDone, onCancel }: { pid: number; root?: string; onDone: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<'folder' | 'bucket'>('folder')
  const [folder, setFolder] = useState('')
  const [bucket, setBucket] = useState({ endpoint: '', bucket: '', prefix: '', region: '', access_key: '', secret_key: '' })
  const setB = (k: keyof typeof bucket) => (e: React.ChangeEvent<HTMLInputElement>) => setBucket((b) => ({ ...b, [k]: e.target.value }))
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<SourceMode>('remember')
  const [scan, setScan] = useState<SourceScan>('all')
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.createSource(pid, kind === 'folder'
        ? { folder, name: name || undefined, mode, scan }
        : { kind, ...bucket, name: name || undefined, mode, scan, poll_seconds: 120 })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
    setBusy(false)
  }
  return (
    <Card title={kind === 'folder' ? 'Watch a folder' : 'Watch a bucket'}>
      <div role="radiogroup" className="mb-4 flex gap-1 text-sm">
        {([['folder', 'A folder or network share'], ['bucket', 'An S3 or MinIO bucket']] as const).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  className={`rounded-md border px-3 py-1.5 ${kind === k ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {kind === 'folder' ? (
          <Field label="Folder inside the inbox" hint={root ? `Created under ${root} if it doesn't exist. Subfolders are included.` : undefined}>
            <input className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="contracts" required />
          </Field>
        ) : (
          <>
            <Field label="Endpoint" hint="The S3 API address. BoxPilot's MinIO listens on port 9000.">
              <input className={inputCls} value={bucket.endpoint} onChange={setB('endpoint')} placeholder="http://host.docker.internal:9000" required />
            </Field>
            <Field label="Bucket">
              <input className={inputCls} value={bucket.bucket} onChange={setB('bucket')} placeholder="team-docs" required />
            </Field>
            <Field label="Prefix (optional)" hint="Only objects under it are read, e.g. notes/. Empty reads the whole bucket.">
              <input className={inputCls} value={bucket.prefix} onChange={setB('prefix')} placeholder="notes/" />
            </Field>
            <Field label="Region (optional)" hint="MinIO doesn't care; AWS needs the bucket's region.">
              <input className={inputCls} value={bucket.region} onChange={setB('region')} placeholder="us-east-1" />
            </Field>
            <Field label="Access key" hint="A read-only key is enough. LLMCoach never writes to the bucket.">
              <input className={inputCls} value={bucket.access_key} onChange={setB('access_key')} autoComplete="off" required />
            </Field>
            <Field label="Secret key" hint="Stored in LLMCoach's database and never shown again.">
              <input className={inputCls} type="password" autoComplete="new-password" value={bucket.secret_key} onChange={setB('secret_key')} required />
            </Field>
          </>
        )}
        <Field label="Name (optional)">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'folder' ? 'Contracts' : 'Team docs'} />
        </Field>
        <Field label="What to do with new files">
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as SourceMode)}>
            {(Object.keys(MODE_LABEL) as SourceMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Before adding">
          <select className={inputCls} value={scan} onChange={(e) => setScan(e.target.value as SourceScan)}>
            {(Object.keys(SCAN_LABEL) as SourceScan[]).map((m) => <option key={m} value={m}>{SCAN_LABEL[m]}</option>)}
          </select>
        </Field>
        {error && <p className="text-xs text-bad sm:col-span-2">{error}</p>}
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Start watching'}</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  )
}

// ---- learning loop ---------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

function utcToLocal(hour: number, minute: number): string {
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localToUtc(hhmm: string): { hour_utc: number; minute: number } {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return { hour_utc: d.getUTCHours(), minute: d.getUTCMinutes() }
}

const RUN_STYLE: Record<LoopRunStatus, string> = {
  training: 'bg-accent/15 text-accent', evaluating: 'bg-accent/15 text-accent', promoted: 'bg-ok/15 text-ok',
  kept: 'bg-muted/15 text-muted', skipped: 'bg-muted/15 text-muted', failed: 'bg-bad/15 text-bad',
}

function Loop({ pid }: { pid: number }) {
  const { data: state, reload } = usePolling(() => api.loop(pid), 5000, [pid])
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [opts, setOpts] = useState<TrainingOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.datasets(pid).then(setDatasets).catch(() => {})
    api.trainingOptions().then(setOpts).catch(() => {})
  }, [pid])
  if (!state) return null
  const { loop } = state

  const save = async (patch: Parameters<typeof api.updateLoop>[1]) => {
    setError(null)
    try { await api.updateLoop(pid, patch) } catch (e) { setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e)) }
    reload()
  }
  const runNow = async () => {
    setError(null)
    try { await api.runLoop(pid) } catch (e) { setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e)) }
    reload()
  }
  const active = state.runs.some((r) => r.status === 'training' || r.status === 'evaluating')
  const splits = state.dataset?.splits

  return (
    <div className="space-y-4">
      <Card
        title="Nightly retrain"
        actions={
          <>
            <Button variant="ghost" disabled={active} onClick={runNow}>{active ? 'Running…' : 'Run now'}</Button>
            <Button variant={loop.enabled ? 'ghost' : 'primary'} onClick={() => save({ enabled: !loop.enabled })}>
              {loop.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted">
          Each night, LLMCoach trains a new adapter on {state.dataset ? <b className="text-text">“{state.dataset.name}”</b> : 'the learned dataset'},
          scores it and the current one on the same test questions, and promotes the new one only if it scores better.
          {state.dataset && splits && <> It has {state.dataset.rows} examples ({splits.train} train · {splits.val} val · {splits.test} test).</>}
          {!state.dataset && <> Nothing has been learned yet: set a watched folder to <em>Learn</em>, or drop files onto Learn in the Chat studio.</>}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Time (your local time)" hint={loop.enabled && loop.next_run_at ? `Next run ${fmtTime(loop.next_run_at)}` : undefined}>
            <input type="time" className={inputCls} value={utcToLocal(loop.hour_utc, loop.minute)} onChange={(e) => e.target.value && save(localToUtc(e.target.value))} />
          </Field>
          <Field label="Learn from">
            <select className={inputCls} value={loop.dataset_id ?? 0} onChange={(e) => save({ dataset_id: Number(e.target.value) })}>
              <option value={0}>Automatic (inbox, then chat)</option>
              {datasets.filter((d) => d.status === 'ready').map((d) => <option key={d.id} value={d.id}>{d.name} · {d.row_count} examples</option>)}
            </select>
          </Field>
          <Field label="Base model" hint={`Blank uses ${state.recommended_base_model}, the best fit for this hardware.`}>
            <input className={inputCls} defaultValue={loop.base_model ?? ''} placeholder={state.recommended_base_model}
                   onBlur={(e) => e.target.value !== (loop.base_model ?? '') && save({ base_model: e.target.value })} />
          </Field>
          <Field label="Training preset">
            <select className={inputCls} value={loop.preset} onChange={(e) => save({ preset: e.target.value })}>
              {opts && Object.entries(opts.presets).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Skip nights with fewer new examples than">
            <input type="number" min={0} className={inputCls} defaultValue={loop.min_new_rows}
                   onBlur={(e) => Number(e.target.value) !== loop.min_new_rows && save({ min_new_rows: Number(e.target.value) })} />
          </Field>
          <Field label="Promote only if F1 improves by more than" hint="0 promotes any improvement.">
            <input type="number" min={0} max={1} step={0.01} className={inputCls} defaultValue={loop.margin}
                   onBlur={(e) => Number(e.target.value) !== loop.margin && save({ margin: Number(e.target.value) })} />
          </Field>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={loop.export_on_promote}
                 onChange={(e) => save({ export_on_promote: e.target.checked })} />
          <span>
            Keep a chat model up to date with the promoted adapter
            <span className="block text-[11px] text-muted">
              After each promotion, <code className="font-mono">{state.current_model}</code> is rebuilt in Ollama from it (a minute
              or two on a CPU). Chats set to that model always get the best version so far.
            </span>
          </span>
        </label>
        {error && <p className="mt-3 text-xs text-bad">{error}</p>}
      </Card>

      <Card title="Runs">
        {state.runs.length === 0 ? <Empty>No runs yet.</Empty> : (
          <ul className="divide-y divide-line">
            {state.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-2.5 text-sm">
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STYLE[r.status]}`}>{r.status}</span>
                <div className="min-w-0 flex-1">
                  <div>{r.reason ?? (r.status === 'training' ? `Training ${r.finetune_name ?? ''}…` : 'Scoring the new adapter against the current one…')}</div>
                  <div className="text-xs text-muted">
                    #{r.id} · {r.trigger === 'manual' ? 'run by hand' : 'scheduled'} · {fmtTime(r.started_at)}
                    {r.eval_id && <> · <Link className="text-accent hover:underline" to="/compare">evaluation</Link></>}
                  </div>
                </div>
                {r.candidate_f1 != null && (
                  <span className="font-mono text-xs text-muted">F1 {r.candidate_f1.toFixed(2)}{r.baseline_f1 != null ? ` vs ${r.baseline_f1.toFixed(2)}` : ''}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Adapters">
        {state.registry.length === 0 ? <Empty>No fine-tunes yet.</Empty> : (
          <ul className="divide-y divide-line">
            {state.registry.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{f.name}</span>
                    {f.promoted_at && <span className="rounded bg-ok/15 px-1.5 text-[10px] uppercase text-ok">current</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {f.base_model} · {f.status}{f.train_loss != null ? ` · loss ${f.train_loss.toFixed(3)}` : ''} · {fmtTime(f.created_at)}
                  </div>
                </div>
                {f.status === 'ready' && (f.promoted_at
                  ? <Button variant="ghost" onClick={() => api.demote(pid, f.id).then(reload)}>Unset</Button>
                  : <Button variant="ghost" onClick={() => api.promote(pid, f.id).then(reload)}>Make current</Button>)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ---- API tokens ------------------------------------------------------------------------------------

function Tokens({ pid }: { pid: number }) {
  const { data: tokens, reload } = usePolling(api.tokens, 15000)
  const { data: sources } = usePolling(() => api.sources(pid), 30000, [pid])
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ApiToken['scope']>('inbox')
  const [made, setMade] = useState<ApiToken | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      setMade(await api.createToken(name, scope))
      setName('')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
  }
  const src = sources?.[0]
  const example = made?.token && src
    ? `curl -H "Authorization: Bearer ${made.token}" -F "files=@report.pdf" ${location.origin}/api/projects/${pid}/sources/${src.id}/upload`
    : null
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* refused */ }
  }

  return (
    <div className="space-y-4">
      <Card title="New token">
        <p className="mb-3 text-sm text-muted">
          For scripts and other machines. An <b className="text-text">inbox</b> token can only list a project's folders and upload into
          one, as if the file had been copied there, so it's safe to leave on a scanner or a laptop.
        </p>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1"><Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Office scanner" required /></Field></div>
          <Field label="Allowed to">
            <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value as ApiToken['scope'])}>
              <option value="inbox">Upload into the inbox</option>
              <option value="full">Use the whole API</option>
            </select>
          </Field>
          <Button type="submit">Create token</Button>
        </form>
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}
        {made?.token && (
          <div className="mt-4 space-y-2 rounded-md border border-accent/40 bg-accent/10 p-3 text-sm">
            <div>Copy it now. It won't be shown again.</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 font-mono text-xs">{made.token}</code>
              <Button variant="ghost" onClick={() => copy(made.token!)}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            {example ? (
              <div className="text-xs text-muted">Send a file to “{src!.name}”:<code className="mt-1 block break-all rounded bg-bg px-2 py-1 font-mono">{example}</code></div>
            ) : (
              <div className="text-xs text-muted">Watch a folder first to get an upload address.</div>
            )}
          </div>
        )}
      </Card>
      <Card title="Tokens">
        {!tokens?.length ? <Empty>No tokens.</Empty> : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div>{t.name} <span className="font-mono text-xs text-muted">{t.prefix}…</span></div>
                  <div className="text-xs text-muted">
                    {t.scope === 'inbox' ? 'Upload into the inbox' : 'Whole API'} · made {fmtTime(t.created_at)} · {t.last_used_at ? `last used ${fmtTime(t.last_used_at)}` : 'never used'}
                  </div>
                </div>
                <Button variant="danger" onClick={() => confirm(`Revoke ${t.name}? Anything using it stops working.`) && api.revokeToken(t.id).then(reload)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import {
  api, uploadDocuments,
  type Chunk, type DocStatus, type KBDocument, type KnowledgeStats, type SearchHit, type UploadResult,
} from '../api'
import { HeldFiles } from '../components/HeldFiles'
import { JobProgress } from '../components/JobProgress'
import { PageHeader } from '../components/Layout'
import { ModelSelect } from '../components/ModelSelect'
import { Button, Card, Empty, fmtTime } from '../components/ui'
import { useProject } from '../hooks/project'

const ACCEPT = '.pdf,.md,.markdown,.txt,.text,.rst,.csv,.json,.html,.htm,.docx'

export function KnowledgeBase() {
  const { current: project, reload: reloadProjects } = useProject()
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [selected, setSelected] = useState<KBDocument | null>(null)
  const pid = project?.id

  const reload = useCallback(async () => {
    if (pid == null) return
    const [d, s] = await Promise.all([api.documents(pid), api.knowledge(pid)])
    setDocs(d)
    setStats(s)
  }, [pid])

  useEffect(() => {
    setSelected(null)
    setJobId(null)
    reload().catch(() => {})
  }, [reload])

  // Poll while anything is in flight.
  const busy = docs.some((d) => d.status === 'pending' || d.status === 'ingesting')
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => reload().catch(() => {}), 1500)
    return () => window.clearInterval(t)
  }, [busy, reload])

  if (!project) return <div className="text-sm text-muted">Loading project…</div>

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        subtitle={`Documents the models can search and cite · ${project.name}`}
        actions={stats && (
          <div className="flex gap-4 text-xs text-muted">
            <span><b className="text-text">{stats.documents}</b> docs</span>
            <span><b className="text-text">{stats.chunks.toLocaleString()}</b> chunks</span>
            <span><b className="text-text">{fmtBytes(stats.bytes)}</b></span>
            {stats.dimension && <span>{stats.dimension}-dim vectors</span>}
          </div>
        )}
      />

      {stats && stats.stale_doc_ids.length > 0 && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <span className="text-warn">
            {stats.stale_doc_ids.length} document(s) were embedded with a different model than{' '}
            <code className="font-mono text-xs">{stats.embed_model}</code>. Search mixes incompatible vectors until you re-index.
          </span>
          <Button className="ml-auto" onClick={() => api.reindex(project.id).then((j) => { setJobId(j.id); reload() })}>
            Re-index all
          </Button>
        </div>
      )}

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <UploadCard pid={project.id} onUploaded={(r) => { if (r.job) setJobId(r.job.id); reload() }} />
        <SettingsCard onSaved={reloadProjects} />
      </div>

      {jobId != null && <JobProgress jobId={jobId} title="Indexing" onFinished={reload} onDismiss={() => setJobId(null)} />}

      <Card title="Documents" className="mb-6">
        <DocumentTable
          docs={docs}
          selected={selected?.id ?? null}
          onSelect={(d) => setSelected(selected?.id === d.id ? null : d)}
          onDelete={async (d) => {
            if (!confirm(`Delete ${d.filename} and its ${d.chunk_count} chunks?`)) return
            await api.deleteDocument(project.id, d.id)
            if (selected?.id === d.id) setSelected(null)
            reload()
          }}
          onReindex={async (d) => { const j = await api.reindex(project.id, [d.id]); setJobId(j.id); reload() }}
        />
      </Card>

      {selected && <ChunkViewer pid={project.id} doc={selected} onClose={() => setSelected(null)} />}

      <SearchTester pid={project.id} disabled={!stats?.chunks} />
    </>
  )
}

function UploadCard({ pid, onUploaded }: { pid: number; onUploaded: (r: UploadResult) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async (files: File[]) => {
    if (!files.length) return
    setError(null)
    setResult(null)
    setProgress(0)
    try {
      const r = await uploadDocuments(pid, files, setProgress)
      setResult(r)
      onUploaded(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    send([...e.dataTransfer.files])
  }

  return (
    <Card title="Add documents" className="lg:col-span-2">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          over ? 'border-accent bg-accent/10' : 'border-line hover:border-muted'
        }`}
      >
        <div className="text-sm">Drop files here or <span className="text-accent">browse</span></div>
        <div className="mt-1 text-xs text-muted">PDF, Markdown, text, HTML, DOCX, CSV, JSON · up to 100 MB each</div>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden"
               onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
      {progress != null && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted">Uploading… {Math.round(progress * 100)}%</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
      {error && <div className="mt-3 text-sm text-bad">{error}</div>}
      {result && (
        <div className="mt-3 space-y-1 text-xs">
          {result.documents.length - result.held.length > 0 && (
            <div className="text-ok">Added {result.documents.length - result.held.length} document(s); indexing started.</div>
          )}
          {result.held.length > 0 && <HeldFiles pid={pid} held={result.held} onChange={() => onUploaded(result)} />}
          {result.skipped.map((s) => (
            <div key={s.filename} className="text-warn">Skipped {s.filename}: {s.reason}</div>
          ))}
        </div>
      )}
    </Card>
  )
}

function SettingsCard({ onSaved }: { onSaved: () => void }) {
  const { current: project } = useProject()
  const s = project!.settings
  const [embed, setEmbed] = useState(s.embed_model)
  const [size, setSize] = useState(s.chunk_size)
  const [overlap, setOverlap] = useState(s.chunk_overlap)
  const [topK, setTopK] = useState(s.top_k)
  const [mode, setMode] = useState(s.search_mode)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setEmbed(s.embed_model)
    setSize(s.chunk_size)
    setOverlap(s.chunk_overlap)
    setTopK(s.top_k)
    setMode(s.search_mode)
  }, [s.embed_model, s.chunk_size, s.chunk_overlap, s.top_k, s.search_mode])

  const dirty = embed !== s.embed_model || size !== s.chunk_size || overlap !== s.chunk_overlap || topK !== s.top_k
    || mode !== s.search_mode
  const save = async (e: FormEvent) => {
    e.preventDefault()
    await api.updateProject(project!.id, { settings: { embed_model: embed, chunk_size: size, chunk_overlap: overlap, top_k: topK, search_mode: mode } })
    onSaved()
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card title="Indexing settings">
      <form onSubmit={save} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Embedding model</span>
          <ModelSelect capability="embeddings" value={embed} onChange={(v) => v && setEmbed(v)} className="w-full" />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <Num label="Chunk size" value={size} onChange={setSize} min={100} max={8000} step={50} />
          <Num label="Overlap" value={overlap} onChange={setOverlap} min={0} max={2000} step={10} />
          <Num label="Top-k" value={topK} onChange={setTopK} min={1} max={50} />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Search</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'hybrid' | 'vector')}
                  className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent">
            <option value="hybrid">Hybrid: keywords + meaning (recommended)</option>
            <option value="vector">Meaning only (vectors)</option>
          </select>
        </label>
        <p className="text-xs text-muted">Chunk settings apply to documents indexed from now on. Changing the embedding model needs a re-index.</p>
        <Button type="submit" disabled={!dirty}>{saved ? 'Saved' : 'Save'}</Button>
      </form>
    </Card>
  )
}

function Num({ label, value, onChange, min, max, step = 1 }: {
  label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
             onChange={(e) => onChange(Number(e.target.value))}
             className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-accent" />
    </label>
  )
}

const DOC_STYLE: Record<DocStatus, string> = {
  pending: 'bg-muted/15 text-muted',
  ingesting: 'bg-accent/15 text-accent',
  ready: 'bg-ok/15 text-ok',
  failed: 'bg-bad/15 text-bad',
  held: 'bg-warn/15 text-warn',
}

function DocumentTable({ docs, selected, onSelect, onDelete, onReindex }: {
  docs: KBDocument[]
  selected: number | null
  onSelect: (d: KBDocument) => void
  onDelete: (d: KBDocument) => void
  onReindex: (d: KBDocument) => void
}) {
  if (!docs.length) return <Empty>No documents yet. Add some above.</Empty>
  return (
    <div className="overflow-x-auto">
    <table className="w-full min-w-[40rem] text-sm [&_td+td]:pl-4 [&_th+th]:pl-4">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th className="pb-2 font-normal">Document</th>
          <th className="pb-2 font-normal">Status</th>
          <th className="pb-2 text-right font-normal">Chunks</th>
          <th className="pb-2 text-right font-normal">Size</th>
          <th className="pb-2 font-normal">Indexed</th>
          <th className="pb-2" />
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className={`border-t border-line ${selected === d.id ? 'bg-accent/5' : 'hover:bg-panel-2'}`}>
            <td className="py-2">
              <button onClick={() => onSelect(d)} disabled={d.status !== 'ready'}
                      className="text-left hover:text-accent disabled:hover:text-text" title="Browse chunks">
                {d.filename}
              </button>
              {d.error && <div className={`text-xs ${d.status === 'held' ? 'text-warn' : 'text-bad'}`}>{d.error}</div>}
            </td>
            <td className="py-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${DOC_STYLE[d.status]}`}>
                {d.status === 'ingesting' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
                {d.status}
              </span>
            </td>
            <td className="py-2 text-right font-mono">{d.chunk_count || '—'}</td>
            <td className="whitespace-nowrap py-2 text-right font-mono text-muted">{fmtBytes(d.size_bytes)}</td>
            <td className="whitespace-nowrap py-2 text-muted">{d.ingested_at ? fmtTime(d.ingested_at) : '—'}</td>
            <td className="py-2 text-right text-xs whitespace-nowrap">
              <button onClick={() => onReindex(d)} disabled={d.status === 'ingesting' || d.status === 'pending'}
                      className={`mr-3 disabled:opacity-30 ${d.status === 'held' ? 'text-accent hover:underline' : 'text-muted hover:text-text'}`}>
                {d.status === 'held' ? 'Index anyway' : 'Re-index'}
              </button>
              <button onClick={() => onDelete(d)} disabled={d.status === 'ingesting'}
                      className="text-bad/80 hover:text-bad disabled:opacity-30">Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function ChunkViewer({ pid, doc, onClose }: { pid: number; doc: KBDocument; onClose: () => void }) {
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [total, setTotal] = useState(0)
  const PAGE = 20

  const load = useCallback(async (offset: number) => {
    const r = await api.chunks(pid, doc.id, offset, PAGE)
    setChunks((c) => (offset === 0 ? r.chunks : [...c, ...r.chunks]))
    setTotal(r.total)
  }, [pid, doc.id])

  useEffect(() => {
    load(0).catch(() => {})
  }, [load])

  return (
    <Card title={`Chunks · ${doc.filename}`} className="mb-6"
          actions={<button onClick={onClose} className="text-xs text-muted hover:text-text">Close</button>}>
      <div className="max-h-[32rem] space-y-2 overflow-auto">
        {chunks.map((c) => (
          <div key={c.id} className="rounded-md border border-line bg-bg/50 p-3">
            <div className="mb-1 flex gap-3 font-mono text-[11px] text-muted">
              <span>#{c.chunk_index}</span>
              {c.page != null && <span>page {c.page}</span>}
              <span>{c.text.length} chars</span>
            </div>
            <div className="whitespace-pre-wrap text-sm">{c.text}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-muted">
        <span>Showing {chunks.length} of {total}</span>
        {chunks.length < total && <Button variant="ghost" onClick={() => load(chunks.length)}>Load more</Button>}
      </div>
    </Card>
  )
}

function SearchTester({ pid, disabled }: { pid: number; disabled: boolean }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [timing, setTiming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (e: FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.search(pid, query.trim())
      setHits(r.results)
      setTiming(`${r.mode} · ${r.total_ms} ms (embedding ${r.embed_ms} ms)`)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    } finally {
      setBusy(false)
    }
  }

  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
  return (
    <Card title="Test retrieval">
      <form onSubmit={run} className="mb-4 flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} disabled={disabled}
               placeholder={disabled ? 'Add documents first' : 'Ask something your documents answer…'}
               className="flex-1 rounded border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <Button type="submit" disabled={disabled || busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</Button>
      </form>
      {error && <div className="mb-3 text-sm text-bad">{error}</div>}
      {timing && <div className="mb-3 text-xs text-muted">{hits?.length ?? 0} results · {timing}</div>}
      <div className="space-y-2">
        {hits?.map((h, i) => (
          <div key={h.id} className="rounded-md border border-line p-3">
            <div className="mb-1.5 flex items-center gap-3 text-xs">
              <span className="font-mono text-muted">{i + 1}</span>
              <span className="font-medium">{h.filename}</span>
              <span className="font-mono text-muted">#{h.chunk_index}{h.page != null ? ` · p.${h.page}` : ''}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
                  <span className="block h-full bg-accent" style={{ width: `${Math.max(0, h.score) * 100}%` }} />
                </span>
                <span className="w-12 text-right font-mono">{h.score.toFixed(3)}</span>
              </span>
            </div>
            <div className="line-clamp-4 whitespace-pre-wrap text-sm text-text/90">
              <Highlight text={h.text} terms={terms} />
            </div>
          </div>
        ))}
        {hits && hits.length === 0 && <Empty>No results.</Empty>}
      </div>
    </Card>
  )
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded bg-accent/25 px-0.5 text-text">{part}</mark> : part))}</>
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

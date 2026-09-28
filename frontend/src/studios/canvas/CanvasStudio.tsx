import '@fontsource-variable/manrope'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { applyNodeChanges, Background, Controls, MiniMap, ReactFlow, type Node, type NodeChange, type ReactFlowInstance } from '@xyflow/react'
import { ChevronDown, Loader2, Play, Plus } from 'lucide-react'
import { api, type Job, type PipelineGraph } from '../../api'
import { fmtTime } from '../../components/ui'
import { useProject } from '../../hooks/project'
import { usePolling } from '../../hooks/usePolling'
import { useSystemStream } from '../../hooks/streams'
import { StudioSwitcher } from '../StudioSwitcher'
import { rememberStudio, type StudioContext } from '../registry'
import { Drawer, JobLog } from './Drawer'
import { buildGraph, COLOR, lineage, type CardData } from './graph'
import { CardBody, NodeCard } from './NodeCard'

const nodeTypes = { card: NodeCard }
type Pos = Record<string, { x: number; y: number }>

function loadPositions(pid: number | undefined): Pos {
  if (pid == null) return {}
  try { return JSON.parse(localStorage.getItem(`llmcoach.canvas.${pid}`) ?? '{}') } catch { return {} }
}
function savePositions(pid: number, pos: Pos) {
  try { localStorage.setItem(`llmcoach.canvas.${pid}`, JSON.stringify(pos)) } catch { /* private window */ }
}

/** The selected node as something other studios can open. */
function selectionContext(id: string | null, g: PipelineGraph): StudioContext {
  const n = Number(id?.split('-')[1])
  if (id?.startsWith('ft-')) return { finetune: n }
  if (id?.startsWith('ev-')) return { evaluation: n }
  if (id?.startsWith('ds-')) return { dataset: n }
  if (id === 'chat') return { conversation: g.chat.last_id }
  return {}
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

function summarize(r: Awaited<ReturnType<typeof api.runPipeline>>): string {
  const files = r.sources.reduce((n, s) => n + Object.values(s.processed ?? {}).reduce((a, b) => a + (b ?? 0), 0), 0)
  const head = r.sources.length ? (files ? `${files} new file${files === 1 ? '' : 's'} from ${r.sources.length} folder${r.sources.length === 1 ? '' : 's'}. ` : 'No new files. ') : ''
  if (r.waiting) return `${head}Training waits until indexing and practice Q&A finish.`
  return `${head}${r.run ? r.run.reason ?? `Learning loop run #${r.run.id} is ${r.run.status}.` : ''}`
}

export default function CanvasStudio() {
  const { current: project, projects, select } = useProject()
  const pid = project?.id
  const { data: g, reload } = usePolling<PipelineGraph | null>(() => (pid ? api.pipeline(pid) : Promise.resolve(null)), 4000, [pid])
  const { data: jobs } = usePolling<Job[]>(() => (pid ? api.jobs({ limit: 40, project_id: pid }) : Promise.resolve([])), 5000, [pid])
  const { stats } = useSystemStream()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('node')
  const [view, setView] = useState<'pipeline' | 'jobs' | 'logs'>('pipeline')
  const [logJob, setLogJob] = useState<number | null>(null)
  const [positions, setPositions] = useState<Pos>(() => loadPositions(pid))
  const [toast, setToast] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [adding, setAdding] = useState(false)
  const narrow = useNarrow()
  const [rf, setRf] = useState<ReactFlowInstance<Node<CardData>> | null>(null)

  useEffect(() => rememberStudio('canvas'), [])
  useEffect(() => setPositions(loadPositions(pid)), [pid])
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(t)
  }, [toast])

  const built = useMemo(() => (g ? buildGraph(g) : { nodes: [], edges: [] }), [g])
  const hot = useMemo(() => lineage(built.edges, selectedId), [built.edges, selectedId])
  // React Flow keeps each node's measured size on the node objects it hands back through
  // onNodesChange, so the canvas holds those objects and merges fresh pipeline data into them.
  const [nodes, setNodes] = useState<Node<CardData>[]>([])
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return built.nodes.map((n) => {
        const o = old.get(n.id)
        return { ...o, ...n, position: positions[n.id] ?? n.position, data: { ...n.data, selected: n.id === selectedId } }
      })
    })
    // Positions come from drags (already applied) or a reset; both go through `positions`.
  }, [built.nodes, positions, selectedId])
  const edges = useMemo(() => built.edges.map((e) => {
    const lit = hot.size > 1 && hot.has(e.source) && hot.has(e.target)
    return { ...e, className: [e.className, lit ? 'hot' : ''].filter(Boolean).join(' '), animated: lit }
  }), [built.edges, hot])

  // Selecting a node frames it together with everything that fed it, clear of the drawer.
  useEffect(() => {
    if (!rf || !selectedId || hot.size === 0) return
    const t = window.setTimeout(() => rf.fitView({ nodes: [...hot].map((id) => ({ id })), padding: 0.3, maxZoom: 1.1, duration: 350 }), 60)
    return () => window.clearTimeout(t)
    // Only when the selection changes, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, selectedId])

  const onNodesChange = useCallback((changes: NodeChange<Node<CardData>>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
    const moved = changes.filter((c) => c.type === 'position')
    if (!moved.length) return
    setPositions((prev) => {
      let next = prev
      for (const c of moved) if (c.type === 'position' && c.position) next = { ...next, [c.id]: c.position }
      if (pid != null && moved.some((c) => c.type === 'position' && c.dragging === false)) savePositions(pid, next)
      return next
    })
  }, [pid])

  const selectNode = (id: string | null) => setParams(id ? { node: id } : {}, { replace: true })
  const selected: CardData | null = selectedId === 'add-source'
    ? { kind: 'add-source', title: 'Watch a folder', main: '', rest: '', status: 'idle', type: 'source' }
    : nodes.find((n) => n.id === selectedId)?.data ?? null

  const runPipeline = async () => {
    if (!pid) return
    setRunning(true)
    try { setToast(summarize(await api.runPipeline(pid))) } catch (e) { setToast(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e)) }
    setRunning(false)
    reload()
  }
  const addStep = (id: string) => { setAdding(false); setView('pipeline'); selectNode(id) }
  const resetLayout = () => { if (pid != null) { setPositions({}); savePositions(pid, {}) } }

  if (!project || !g) return <div className="studio-canvas grid h-full place-items-center text-[var(--mu)]">Loading the pipeline…</div>

  const hw = stats?.gpus[0] ? `${stats.gpus[0].name}` : stats ? `CPU · ${stats.ram_total_gb.toFixed(0)} GB` : ''
  const firstDataset = g.datasets[0]
  const selectedJob = jobs?.find((j) => j.id === logJob) ?? jobs?.[0]

  return (
    <div className="studio-canvas flex h-full flex-col">
      <header className="cv-top">
        <StudioSwitcher current="canvas" context={selectionContext(selectedId, g)}><span className="cv-logo cursor-pointer"><i />LLMCoach</span></StudioSwitcher>
        <label className="relative flex items-center gap-1.5 font-semibold text-[var(--mu)]">
          /
          <select aria-label="Project" value={project.id} onChange={(e) => select(Number(e.target.value))}
                  className="cursor-pointer appearance-none bg-transparent pr-4 font-bold text-[var(--ink)] outline-none">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3" />
        </label>
        <div className="cv-seg" role="tablist">
          {(['pipeline', 'jobs', 'logs'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs font-semibold text-[var(--mu)]">
          <span className="hidden sm:inline">{hw}</span>
          <button className="cv-btn pri" onClick={runPipeline} disabled={running} title="Look at every watched folder, index and learn what's new, then retrain if anything changed">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}Run pipeline
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {toast && <div className="cv-toast" role="status">{toast}</div>}

        {view === 'pipeline' && !narrow && (
          <div className="cv-canvas relative min-w-0 flex-1">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
                       onNodeClick={(_, n) => selectNode(n.id)} onPaneClick={() => selectNode(null)} onInit={setRf}
                       nodesConnectable={false} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.3} maxZoom={1.6}
                       proOptions={{ hideAttribution: true }}>
              <Background gap={18} size={1.2} color="var(--dot)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap position="bottom-right" pannable zoomable nodeColor={(n) => COLOR[(n.data as CardData).kind]} nodeBorderRadius={3}
                       maskColor="rgba(236,238,242,.7)" style={{ width: 150, height: 92 }} />
            </ReactFlow>
            <div className="absolute bottom-4 left-[64px] z-10 flex items-end gap-2">
              <div className="relative">
                <button className="cv-btn border-dashed" onClick={() => setAdding((a) => !a)} aria-expanded={adding}><Plus className="h-3.5 w-3.5" />Add step</button>
                {adding && (
                  <div className="absolute bottom-[calc(100%+6px)] left-0 w-64 rounded-xl border border-[var(--ln)] bg-white p-1.5 text-[12.5px] shadow-xl">
                    {[
                      ['add-source', 'Watch a folder', 'Files copied in join by themselves'],
                      ['docs', 'Add documents', 'Upload into the knowledge base'],
                      ...(firstDataset ? [[`ds-${firstDataset.id}`, 'Fine-tune a dataset', 'Train an adapter on examples']] : []),
                      ['loop', 'Retrain and gate', 'Promote only a better adapter'],
                    ].map(([id, label, hint]) => (
                      <button key={id} onClick={() => addStep(id)} className="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--soft)]">
                        <b className="block font-bold">{label}</b><span className="text-[var(--mu)]">{hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {Object.keys(positions).length > 0 && <button className="cv-btn" onClick={resetLayout}>Tidy up</button>}
            </div>
          </div>
        )}

        {view === 'pipeline' && narrow && (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="cv-list">
              {nodes.map((n) => (
                <button key={n.id} className={`cv-node text-left ${n.id === selectedId ? 'sel' : ''} ${n.data.kind === 'add-source' ? 'ghost' : ''}`} onClick={() => selectNode(n.id)}>
                  <CardBody data={n.data} />
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'jobs' && (
          <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-3xl divide-y divide-[var(--ln)] rounded-xl border border-[var(--ln)] bg-white">
              {jobs?.map((j) => (
                <button key={j.id} onClick={() => { setLogJob(j.id); setView('logs') }} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-[var(--soft)]">
                  <span className={`cv-st static ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'cancelled' ? 'idle' : 'run'}`} />
                  <b className="w-24 font-bold capitalize">{j.kind}</b>
                  <span className="text-[var(--mu)]">#{j.id} · {fmtTime(j.created_at)}</span>
                  <span className="ml-auto text-xs capitalize text-[var(--mu)]">{j.status}</span>
                </button>
              ))}
              {jobs?.length === 0 && <p className="p-6 text-center text-[var(--mu)]">No jobs yet.</p>}
            </div>
          </div>
        )}

        {view === 'logs' && (
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
            <select className="cv-input max-w-sm" value={selectedJob?.id ?? ''} onChange={(e) => setLogJob(Number(e.target.value))}>
              {jobs?.map((j) => <option key={j.id} value={j.id}>#{j.id} · {j.kind} · {j.status}</option>)}
            </select>
            {selectedJob && <JobLog jobId={selectedJob.id} />}
          </div>
        )}

        {selected && view === 'pipeline' && (
          <div className={narrow ? 'fixed inset-0 z-30 flex' : 'flex'}>
            <Drawer g={g} node={selected} pid={project.id} onClose={() => selectNode(null)} say={setToast} changed={reload} />
          </div>
        )}
      </div>
    </div>
  )
}

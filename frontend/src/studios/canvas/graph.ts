import type { Edge, Node } from '@xyflow/react'
import type { PipelineGraph } from '../../api'

export type Kind = 'source' | 'add-source' | 'docs' | 'kb' | 'chat' | 'dataset' | 'finetune' | 'eval' | 'loop'
export type Status = 'ok' | 'run' | 'bad' | 'idle'

export interface CardData extends Record<string, unknown> {
  kind: Kind
  title: string
  main: string // bold first line
  rest: string // muted second line
  status: Status
  type: string // corner label
  star?: string // bottom-left badge
  ref?: number // id of the source, dataset, fine-tune or eval
  selected?: boolean
}

export const COLOR: Record<Kind, string> = {
  source: 'var(--c-src)', 'add-source': '#9aa3b2', docs: 'var(--c-doc)', kb: 'var(--c-kb)', chat: 'var(--c-chat)',
  dataset: 'var(--c-ds)', finetune: 'var(--c-ft)', eval: 'var(--c-ev)', loop: 'var(--c-loop)',
}

const COL = [0, 300, 600, 900, 1200, 1500] // 100px between cards leaves room for edge labels
const ROW = 130

function mb(bytes: number) {
  return bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function localTime(hour: number, minute: number) {
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function buildGraph(g: PipelineGraph): { nodes: Node<CardData>[]; edges: Edge[] } {
  const active = g.active_jobs
  const running = (kind: string, key?: string, id?: number) =>
    active.some((j) => j.kind === kind && (key === undefined || Number(j.config[key]) === id))
  const nodes: Node<CardData>[] = []
  const edges: Edge[] = []
  const node = (id: string, x: number, y: number, data: CardData) => nodes.push({ id, position: { x, y }, data, type: 'card' })
  const edge = (source: string, target: string, label?: string, className?: string) =>
    edges.push({ id: `${source}->${target}`, source, target, label, className, type: 'default' })

  // Watched folders feed the documents.
  const srcRows = Math.max(1, g.sources.length)
  const docsY = ((srcRows - 1) * ROW) / 2 + ROW
  if (g.sources.length === 0) {
    node('add-source', COL[0], ROW, { kind: 'add-source', title: 'Watch a folder', main: 'Optional', rest: 'Files copied into it join by themselves', status: 'idle', type: 'source' })
  }
  g.sources.forEach((s, i) => {
    const held = s.counts.quarantined ?? 0
    node(`src-${s.id}`, COL[0], ROW + i * ROW, {
      kind: 'source', title: s.name, ref: s.id, type: 'folder',
      main: `${s.counts.added ?? 0} added${held ? ` · ${held} held` : ''}`,
      rest: `${s.mode === 'learn' ? 'Learns · ' : ''}${s.kind === 'bucket' ? `s3://${s.bucket}/${s.prefix ?? ''}` : s.folder === '.' ? 'inbox root' : s.folder}`,
      status: !s.enabled ? 'idle' : s.last_error || held ? 'bad' : (s.counts.waiting ?? 0) > 0 ? 'run' : 'ok',
    })
    edge(`src-${s.id}`, 'docs')
  })

  const d = g.documents
  const indexing = running('ingest')
  node('docs', COL[1], docsY, {
    kind: 'docs', title: 'Documents', type: 'files',
    main: `${d.count} file${d.count === 1 ? '' : 's'}${d.count ? ` · ${mb(d.bytes)}` : ''}`,
    rest: d.recent.join(', ') || 'Drop files in a chat, or watch a folder',
    status: indexing ? 'run' : d.by_status.failed ? 'bad' : d.count ? 'ok' : 'idle',
  })
  node('kb', COL[2], docsY, {
    kind: 'kb', title: 'Knowledge base', type: 'index',
    main: `${g.knowledge.chunks} chunks`, rest: g.knowledge.embed_model.split('/').slice(1).join('/') || g.knowledge.embed_model,
    status: indexing ? 'run' : g.knowledge.chunks ? 'ok' : 'idle',
  })
  edge('docs', 'kb')

  node('chat', COL[3], 0, {
    kind: 'chat', title: 'Chat', type: 'chat',
    main: `${g.chat.model?.split('/').slice(1).join('/') || 'default model'} + KB`,
    rest: `${g.chat.conversations} conversation${g.chat.conversations === 1 ? '' : 's'}`,
    status: g.chat.conversations ? 'ok' : 'idle',
  })
  edge('kb', 'chat')

  // Datasets, then what each one trained and was scored on.
  const dsY = new Map<number, number>()
  g.datasets.forEach((ds, i) => {
    const y = ROW + i * ROW
    dsY.set(ds.id, y)
    const s = ds.splits
    node(`ds-${ds.id}`, COL[3], y, {
      kind: 'dataset', title: ds.name, ref: ds.id, type: 'dataset',
      main: `${ds.rows} examples`, rest: s ? `${s.train} train · ${s.val} val · ${s.test} test` : ds.status,
      status: ds.status === 'generating' || running('generate', 'dataset_id', ds.id) ? 'run' : ds.status === 'failed' ? 'bad' : 'ok',
    })
    const label = { generated: 'generate', chat: 'learn · chat', inbox: 'learn · inbox', review: 'to review', upload: undefined }[ds.source]
    if (ds.source !== 'upload') edge('kb', `ds-${ds.id}`, label)
  })

  const loop = g.loop
  const lastRun = loop.runs[0]
  node('loop', COL[4], 0, {
    kind: 'loop', title: 'Learning loop', type: 'gate',
    main: loop.enabled ? `Nightly at ${localTime(loop.hour_utc, loop.minute)}` : 'Off · runs on demand',
    rest: lastRun ? `Last: ${lastRun.status}${lastRun.candidate_f1 != null ? ` · F1 ${lastRun.candidate_f1.toFixed(2)}` : ''}` : `Promotes only if F1 improves${loop.margin ? ` by ${loop.margin}` : ''}`,
    status: loop.pending_run || (lastRun && ['training', 'evaluating'].includes(lastRun.status)) ? 'run' : lastRun?.status === 'failed' ? 'bad' : loop.enabled ? 'ok' : 'idle',
  })
  if (loop.dataset_id_effective) edge(`ds-${loop.dataset_id_effective}`, 'loop', 'retrains')

  const ftY = new Map<number, number>()
  let nextFt = ROW
  g.finetunes.forEach((ft) => {
    const y = Math.max(nextFt, ft.dataset_id != null ? dsY.get(ft.dataset_id) ?? nextFt : nextFt)
    nextFt = y + ROW
    ftY.set(ft.id, y)
    const loss = ft.metrics?.train_loss
    node(`ft-${ft.id}`, COL[4], y, {
      kind: 'finetune', title: ft.name, ref: ft.id, type: 'train',
      main: `${ft.base_model.split('/').pop()} · ${ft.method.toUpperCase()}`,
      rest: ft.status === 'ready' ? (loss != null ? `train loss ${loss.toFixed(2)}` : 'ready') : ft.status,
      status: ft.status === 'ready' ? 'ok' : ft.status === 'failed' || ft.status === 'cancelled' ? 'bad' : 'run',
      star: ft.promoted_at ? '★ current' : undefined,
    })
    if (ft.dataset_id != null && dsY.has(ft.dataset_id)) edge(`ds-${ft.dataset_id}`, `ft-${ft.id}`, 'train')
    if (ft.promoted_at) edge('loop', `ft-${ft.id}`, 'promotes')
  })

  let nextEv = ROW
  g.evals.forEach((ev) => {
    const fts = (ev.variants ?? []).filter((v) => v.kind === 'finetune').map((v) => Number(v.ref))
    const anchor = Math.max(...fts.map((f) => ftY.get(f) ?? 0), ev.dataset_id != null ? dsY.get(ev.dataset_id) ?? 0 : 0)
    const y = Math.max(nextEv, anchor)
    nextEv = y + ROW
    const scores = Object.values(ev.summary ?? {}).map((v) => v.f1 ?? 0)
    node(`ev-${ev.id}`, COL[5], y, {
      kind: 'eval', title: ev.name, ref: ev.id, type: 'eval',
      main: `${ev.variants?.length ?? 0} variants`, rest: scores.length ? `best F1 ${Math.max(...scores).toFixed(3)}` : ev.status,
      status: ev.status === 'done' ? 'ok' : ev.status === 'failed' || ev.status === 'cancelled' ? 'bad' : 'run',
    })
    fts.forEach((f) => ftY.has(f) && edge(`ft-${f}`, `ev-${ev.id}`))
    // Where a fine-tune feeds the evaluation, the path through it already shows the dataset.
    if (!fts.some((f) => ftY.has(f)) && ev.dataset_id != null && dsY.has(ev.dataset_id)) edge(`ds-${ev.dataset_id}`, `ev-${ev.id}`, 'test set', 'test')
  })

  return { nodes, edges }
}

/** Every node upstream of `id` (what fed it), including itself. */
export function lineage(edges: Edge[], id: string | null): Set<string> {
  const out = new Set<string>()
  if (!id) return out
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    for (const e of edges) if (e.target === cur) stack.push(e.source)
  }
  return out
}

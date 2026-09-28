/**
 * The studios: distinct front ends over the same projects, knowledge bases, datasets, fine-tunes
 * and evaluations. Each owns its layout, look and shortcuts; everything else is shared.
 */
export interface StudioInfo {
  id: string
  name: string
  tagline: string
  path: string
  status: 'ready' | 'planned'
  milestone?: string // roadmap milestone for planned studios
  swatch: string[] // a few colors from the studio's own palette, for the switcher
}

export const STUDIOS: StudioInfo[] = [
  { id: 'chat', name: 'Just the Chat', tagline: 'Talk to your data; drop files in to teach it', path: '/chat', status: 'ready', swatch: ['#1a1917', '#a6cfae', '#e3b86c'] },
  { id: 'classic', name: 'Classic', tagline: 'Every page and setting, in one dashboard', path: '/', status: 'ready', swatch: ['#0b0d12', '#7c9cff', '#12151c'] },
  { id: 'canvas', name: 'Pipeline Canvas', tagline: 'Your project as a flow you can edit', path: '/canvas', status: 'ready', milestone: 'L3', swatch: ['#eceef2', '#2563eb', '#c026d3'] },
  { id: 'mission', name: 'Mission Control', tagline: 'Live tiles for watching runs', path: '/console', status: 'ready', milestone: 'L4', swatch: ['#060705', '#ffb000', '#9be07a'] },
  { id: 'workbench', name: 'Workbench', tagline: 'Tabs, panes and a command palette', path: '/workbench', status: 'ready', milestone: 'L5', swatch: ['#15171b', '#4ec3cf', '#e2b35a'] },
  { id: 'notebook', name: 'Field Notebook', tagline: 'A calm, guided, report-style studio', path: '/notebook', status: 'ready', milestone: 'L6', swatch: ['#fbfbf9', '#1e5a4b', '#f8e58c'] },
  { id: 'friendly', name: 'Friendly Studio', tagline: 'Plain language, recipes and next steps', path: '/friendly', status: 'ready', milestone: 'L7', swatch: ['#ff6a3d', '#1fb58f', '#ffbf2e'] },
]

const KEY = 'llmcoach.studio'

export function preferredStudio(): StudioInfo {
  let id = 'chat'
  try {
    id = localStorage.getItem(KEY) ?? 'chat'
  } catch {
    /* storage unavailable: use the default */
  }
  return STUDIOS.find((s) => s.id === id && s.status === 'ready') ?? STUDIOS[0]
}

export function rememberStudio(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable */
  }
}

/** What a studio is showing, so that switching studios lands on the same thing (roadmap L0). */
export interface StudioContext {
  conversation?: number | null
  finetune?: number | null
  evaluation?: number | null
  dataset?: number | null
  document?: number | null
}

/** Where `id` shows what `ctx` names, as close as that studio can get to it. */
export function studioLink(id: string, ctx: StudioContext = {}): string {
  const { conversation: c, finetune: f, evaluation: e, dataset: d, document: doc } = ctx
  switch (id) {
    case 'chat': return c ? `/chat/${c}` : '/chat'
    case 'canvas': return f ? `/canvas?node=ft-${f}` : e ? `/canvas?node=ev-${e}` : d ? `/canvas?node=ds-${d}` : doc ? '/canvas?node=docs' : c ? '/canvas?node=chat' : '/canvas'
    case 'workbench': return c ? `/workbench?open=chat:${c}` : f ? `/workbench?open=finetune:${f}` : e ? `/workbench?open=eval:${e}` : d ? `/workbench?open=dataset:${d}` : doc ? `/workbench?open=doc:${doc}` : '/workbench'
    case 'notebook': return e ? `/notebook/report/${e}` : f ? '/notebook/train' : d ? '/notebook/dataset' : doc ? '/notebook/documents' : c ? `/notebook?c=${c}` : '/notebook'
    case 'friendly': return e ? '/friendly/results' : f || d ? '/friendly/train' : doc ? '/friendly/knowledge' : c ? `/friendly/chat?c=${c}` : '/friendly'
    case 'mission': return f ? '/console/train' : e ? '/console/eval' : d ? '/console/data' : doc ? '/console/know' : c ? `/console?c=${c}` : '/console'
    case 'classic': return f ? '/train' : e ? '/compare' : d ? '/datasets' : doc ? '/knowledge' : c ? '/playground' : '/'
    default: return STUDIOS.find((s) => s.id === id)?.path ?? '/'
  }
}

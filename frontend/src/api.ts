export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: number
  project_id: number | null
  kind: string
  status: JobStatus
  config: Record<string, unknown>
  error: string | null
  exit_code: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface ProjectSettings {
  embed_model: string
  chunk_size: number
  chunk_overlap: number
  chat_model: string | null
  top_k: number
  search_mode: 'hybrid' | 'vector'
}

export interface Project {
  id: number
  name: string
  description: string
  settings: ProjectSettings
  created_at: string
}

export interface GpuStats {
  index: number
  name: string
  util_pct: number | null
  vram_used_gb: number | null
  vram_total_gb: number | null
  temp_c: number | null
  power_w: number | null
}

export interface SystemStats {
  backend: 'cpu' | 'cuda' | 'rocm'
  cpu_pct: number
  ram_used_gb: number
  ram_total_gb: number
  gpus: GpuStats[]
  running_job_id: number | null
}

export interface AppLog {
  id: number
  ts: number
  level: string
  logger: string
  message: string
}

/** Structured event written by a worker to metrics.jsonl. */
export interface JobEvent {
  type: 'metric' | 'progress' | 'device' | string
  ts: number
  [key: string]: unknown
}

export interface ModelInfo {
  name: string
  size_gb: number | null
  family: string | null
  parameters: string | null
  embedding: boolean
}

export type Capability = 'chat' | 'embeddings' | 'lora'

export interface Provider {
  id: number
  slug: string
  name: string
  kind: 'ollama' | 'openai'
  preset: string
  base_url: string
  has_api_key: boolean
  enabled: boolean
  builtin: boolean
  capabilities: Capability[]
  created_at: string
}

export interface ProviderPreset {
  name: string
  kind: 'ollama' | 'openai'
  base_url: string
  license: string | null
  hardware: string | null
  capabilities: Capability[]
  website: string | null
  note: string
}

export interface ReachStatus {
  reachable: boolean
  version: string | null
  models: ModelInfo[]
  error: string | null
  hint: string | null
}

export interface ProviderStatus extends ReachStatus {
  provider: Provider
}

/** A model on some provider, addressed as "<provider slug>/<model>". */
export interface ModelRef extends ModelInfo {
  ref: string
  provider: string
}

export interface AuthState {
  auth_enabled: boolean
  user: string | null
}

/** Fired when any request comes back 401 so the app can show the sign-in screen. */
export const AUTH_REQUIRED_EVENT = 'llmcoach:auth-required'

export type DocStatus = 'pending' | 'ingesting' | 'ready' | 'failed'

export interface KBDocument {
  id: number
  project_id: number
  filename: string
  size_bytes: number
  status: DocStatus
  chunk_count: number
  char_count: number
  embed_model: string | null
  error: string | null
  created_at: string
  ingested_at: string | null
}

export interface KnowledgeStats {
  documents: number
  by_status: Record<DocStatus, number>
  chunks: number
  dimension: number | null
  embed_model: string
  stale_doc_ids: number[]
  bytes: number
}

export interface SearchHit {
  id: string
  doc_id: number
  filename: string
  chunk_index: number
  page: number | null
  text: string
  score: number
}

export interface Chunk {
  id: string
  chunk_index: number
  page: number | null
  text: string
}

export interface UploadResult {
  documents: KBDocument[]
  skipped: { filename: string; reason: string }[]
  job: Job | null
}

export const isFinal = (s: JobStatus) => s === 'done' || s === 'failed' || s === 'cancelled'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* not json */
    }
    throw new Error(`${res.status}: ${detail}`)
  }
  if (res.status === 204) return undefined as T
  return res.headers.get('content-type')?.includes('json') ? res.json() : (res.text() as Promise<T>)
}

export const api = {
  me: () => request<AuthState>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<AuthState>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  presets: () => request<Record<string, ProviderPreset>>('/api/providers/presets'),
  providers: () => request<Provider[]>('/api/providers'),
  providerStatus: () => request<ProviderStatus[]>('/api/providers/status'),
  createProvider: (body: { preset: string; name?: string; slug?: string; base_url?: string; api_key?: string }) =>
    request<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (id: number, patch: { name?: string; base_url?: string; api_key?: string; enabled?: boolean }) =>
    request<Provider>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProvider: (id: number) => request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (body: { preset: string; base_url: string; api_key?: string }) =>
    request<ReachStatus>('/api/providers/test', { method: 'POST', body: JSON.stringify(body) }),
  documents: (pid: number) => request<KBDocument[]>(`/api/projects/${pid}/documents`),
  knowledge: (pid: number) => request<KnowledgeStats>(`/api/projects/${pid}/knowledge`),
  deleteDocument: (pid: number, id: number) => request<void>(`/api/projects/${pid}/documents/${id}`, { method: 'DELETE' }),
  reindex: (pid: number, doc_ids?: number[]) =>
    request<Job>(`/api/projects/${pid}/documents/reindex`, { method: 'POST', body: JSON.stringify({ doc_ids: doc_ids ?? null }) }),
  chunks: (pid: number, docId: number, offset = 0, limit = 50) =>
    request<{ chunks: Chunk[]; total: number }>(`/api/projects/${pid}/documents/${docId}/chunks?offset=${offset}&limit=${limit}`),
  search: (pid: number, query: string, top_k?: number) =>
    request<{ results: SearchHit[]; mode: 'hybrid' | 'vector'; embed_ms: number; total_ms: number }>(`/api/projects/${pid}/search`, {
      method: 'POST', body: JSON.stringify({ query, top_k }),
    }),
  models: (capability?: 'chat' | 'embeddings') =>
    request<ModelRef[]>(`/api/models${capability ? `?capability=${capability}` : ''}`),
  system: () => request<SystemStats>('/api/system'),
  jobs: (params: { status?: JobStatus; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.limit) q.set('limit', String(params.limit))
    return request<Job[]>(`/api/jobs?${q}`)
  },
  jobKinds: () => request<string[]>('/api/jobs/kinds'),
  job: (id: number) => request<Job>(`/api/jobs/${id}`),
  createJob: (kind: string, config: Record<string, unknown> = {}, project_id?: number) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify({ kind, config, project_id }) }),
  cancelJob: (id: number) => request<Job>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  projects: () => request<Project[]>('/api/projects'),
  createProject: (name: string, description = '') =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updateProject: (id: number, patch: { name?: string; description?: string; settings?: Partial<ProjectSettings> }) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
}

/** Multipart upload with progress (fetch can't report upload progress). */
export function uploadDocuments(pid: number, files: File[], onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/projects/${pid}/documents`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
      else {
        let detail = xhr.statusText
        try { detail = JSON.parse(xhr.responseText).detail ?? detail } catch { /* not json */ }
        reject(new Error(`${xhr.status}: ${detail}`))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed: network error'))
    xhr.send(form)
  })
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

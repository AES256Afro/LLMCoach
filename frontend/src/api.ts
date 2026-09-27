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

export interface Project {
  id: number
  name: string
  description: string
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

export const isFinal = (s: JobStatus) => s === 'done' || s === 'failed' || s === 'cancelled'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
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
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

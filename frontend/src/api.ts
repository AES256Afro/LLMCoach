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
  system_prompt: string | null
  qa_model?: string | null // writes practice Q&A; null = the chat's model unless it's an LLMCoach fine-tune
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

/** A fine-tune LLMCoach exported to Ollama (llmcoach-<project>-...). */
export const ownModel = (ref: string | null | undefined) => !!ref && (ref.split('/').slice(1).join('/') || ref).startsWith('llmcoach-')

/** The default chat model, as the server picks it: the smallest, with LLMCoach's own fine-tunes last. */
export function defaultModel(ms: ModelRef[]): string | null {
  const key = (m: ModelRef): [number, number] => [ownModel(m.ref) ? 1 : 0, m.size_gb ?? 1e9]
  return [...ms].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])[0]?.ref ?? null
}

export interface AuthState {
  auth_enabled: boolean
  user: string | null
}

/** Fired when any request comes back 401 so the app can show the sign-in screen. */
export const AUTH_REQUIRED_EVENT = 'llmcoach:auth-required'

export type DocStatus = 'pending' | 'ingesting' | 'ready' | 'failed' | 'held' // held: not indexed, may be private

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
  source_url: string | null // the web address it was fetched from, if any
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
  source_url?: string | null // set for pages fetched from the web
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
  held: HeldFile[] // stored but not indexed: they look like they hold secrets or personal data
  job: Job | null
}

export interface HeldFile {
  doc_id: number
  filename: string
  findings: Finding[]
}

export interface ChatStats {
  prompt_tokens: number | null
  completion_tokens: number | null
  tokens_per_sec: number | null
  total_ms: number | null
  first_token_ms: number | null
  retrieval_ms: number | null
}

/** Payload of an event card in a chat thread (role "event"). `card` says which kind. */
export interface ChatCardData {
  card: 'attach' | 'learn' | 'train' | 'eval' | 'logs' | string
  [key: string]: unknown
}

export interface ChatMessage {
  id: number
  conversation_id: number
  role: 'user' | 'assistant' | 'event'
  content: string
  thinking: string | null
  model: string | null
  sources: SearchHit[] | null
  stats: ChatStats | null
  data: ChatCardData | null
  error: string | null
  created_at: string
}

export interface AttachResult {
  conversation: Conversation
  message: ChatMessage
}

export interface Conversation {
  id: number
  project_id: number
  title: string
  model: string | null
  use_rag: boolean
  system_prompt: string | null
  created_at: string
  updated_at: string
  messages?: ChatMessage[]
}

export type ChatEvent =
  | { type: 'meta'; conversation: Conversation; model: string; sources: SearchHit[] | null; retrieval_ms: number | null }
  | { type: 'delta' | 'thinking'; text: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; message: string; message_id?: number }

export interface ChatRequest {
  message: string
  conversation_id?: number
  model?: string
  use_rag?: boolean
  system_prompt?: string
  temperature?: number
  think?: boolean
}

export type Split = 'train' | 'val' | 'test'

export interface DatasetStats {
  tokens_total: number
  tokens_mean: number
  tokens_p95: number
  tokens_max: number
  answer_tokens_mean: number
  multi_turn: number
  with_system: number
  length_histogram: { from: number; count: number }[]
}

export interface Dataset {
  id: number
  project_id: number
  name: string
  source: 'upload' | 'generated' | 'chat' | 'inbox' | 'review' // review: practice Q&A waiting to be looked over
  status: 'generating' | 'ready' | 'failed'
  row_count: number
  splits: Record<Split, number> | null
  stats: DatasetStats | null
  job_id: number | null
  error: string | null
  created_at: string
}

export interface DatasetRow {
  index: number
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  split: Split
  meta?: Record<string, unknown>
}

export interface GenerateRequest {
  name?: string
  model: string
  pairs_per_chunk: number
  max_chunks: number
  style: 'closed' | 'grounded'
  system_prompt?: string
  val: number
  test: number
}

export interface BaseModel {
  id: string
  params_b: number
  license: string
  gated: boolean
  note: string
}

export interface TrainPreset {
  label: string
  note: string
  epochs: number
  learning_rate: number
  lora_r: number
  lora_alpha: number
  lora_dropout: number
  effective_batch: number
  max_seq_len: number
}

export interface Hardware {
  backend: 'cpu' | 'cuda' | 'rocm'
  gpu: string | null
  vram_gb: number | null
  ram_gb: number
  cpu_threads: number
  unsloth_installed: boolean
  recommended_backend: 'hf' | 'unsloth'
}

export interface TrainingOptions {
  recommended_base_model: string
  base_models: BaseModel[]
  presets: Record<string, TrainPreset>
  hardware: Hardware
  cpu_max_params_b: number
  hf_token_set: boolean
}

export interface TrainPlan extends TrainPreset {
  base_model: string
  device: 'cpu' | 'cuda'
  backend: 'hf' | 'unsloth'
  method: 'lora' | 'qlora'
  params_b: number | null
  micro_batch: number
  grad_accum: number
  total_steps: number
  max_steps?: number
  memory: { gb: number | null; where: string; note: string; budget_gb: number | null; fits: boolean }
}

export interface FineTune {
  id: number
  project_id: number
  name: string
  base_model: string
  dataset_id: number | null
  method: 'lora' | 'qlora'
  backend: 'hf' | 'unsloth' | null
  status: 'queued' | 'training' | 'ready' | 'failed' | 'cancelled'
  config: (TrainPlan & { preset: string }) | null
  metrics: { train_loss: number; eval_loss: number | null; steps: number; seconds: number; trainable_params: number; train_examples: number } | null
  output_dir: string | null
  job_id: number | null
  error: string | null
  created_at: string
  finished_at: string | null
  promoted_at: string | null
  ollama_model: string | null // "ollama/<name>" once exported, usable as a chat model
}

export interface FineTuneRequest {
  name?: string
  base_model: string
  dataset_id: number
  preset: string
  method: 'lora' | 'qlora'
  backend: 'auto' | 'hf' | 'unsloth'
  overrides: Record<string, number | undefined>
  dry_run?: boolean
}

export interface EvalVariant {
  kind: 'model' | 'finetune'
  ref: string
  rag: boolean
  label: string
}

export interface VariantScore {
  n: number
  exact_match: number
  f1: number
  rouge_l: number
  judge: number | null
  latency_ms: number
  errors: number
}

export interface EvalOutput {
  answer: string
  latency_ms: number
  error: string | null
  sources: string[] | null
  exact_match: number
  f1: number
  rouge_l: number
  judge?: number
  judge_reason?: string
}

export interface EvalRun {
  id: number
  project_id: number
  name: string
  dataset_id: number | null
  split: string
  variants: EvalVariant[]
  judge_model: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  summary: Record<string, VariantScore> | null
  examples: number
  job_id: number | null
  error: string | null
  created_at: string
  results?: { index: number; question: string; reference: string; outputs: Record<string, EvalOutput> }[]
}

export const isFinal = (s: JobStatus) => s === 'done' || s === 'failed' || s === 'cancelled'

/**
 * FastAPI's `detail` as readable text: a string, {message, errors} (our validation errors), or
 * a list of {loc, msg} (request validation, 422). Anything else is shown as JSON.
 */
export function errorDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => {
      if (d && typeof d === 'object' && 'msg' in d) {
        const loc = Array.isArray(d.loc) ? d.loc.filter((p: unknown) => p !== 'body').join('.') : ''
        return loc ? `${loc}: ${d.msg}` : String(d.msg)
      }
      return typeof d === 'string' ? d : JSON.stringify(d)
    })
    return msgs.join('; ')
  }
  if (typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') return detail.message
  return JSON.stringify(detail)
}

// ---- inbox, tokens and the learning loop --------------------------------------------------------

export type SourceMode = 'remember' | 'learn'
/** What a file dropped into a chat is for; review writes practice Q&A to look over before it's kept. */
export type AttachMode = 'remember' | 'learn' | 'review'
export type SourceScan = 'all' | 'secrets' | 'off'
export type FileStatus = 'waiting' | 'added' | 'duplicate' | 'skipped' | 'quarantined' | 'rejected' | 'failed'
  | 'gone' | 'forgotten' // deleted from the folder: document kept | document removed too

export interface Source {
  id: number
  project_id: number
  name: string
  kind: 'folder' | 'bucket' | 'web'
  urls: string[] | null // web sources: pages re-read on each look
  folder: string // folder sources: relative to the inbox ("." is its root)
  endpoint: string | null // bucket sources (S3, MinIO...)
  bucket: string | null
  prefix: string | null
  region: string | null
  access_key: string | null
  has_secret: boolean
  path: string
  mode: SourceMode
  scan: SourceScan
  enabled: boolean
  poll_seconds: number
  mirror_deletes: boolean // a file deleted from the folder takes its document with it
  last_scan_at: string | null
  last_error: string | null
  created_at: string
  counts: Partial<Record<FileStatus, number>>
}

export interface Finding {
  category: 'secret' | 'personal'
  kind: string
  label: string
  count: number
  sample: string
}

export interface SourceFile {
  id: number
  source_id: number
  project_id: number
  relpath: string
  size_bytes: number
  status: FileStatus
  doc_id: number | null
  findings: Finding[] | null
  error: string | null
  first_seen_at: string
  processed_at: string | null
  reviewed_at: string | null
  missing_at: string | null
  source_name?: string | null
}

export interface InboxInfo {
  root: string
  settle_seconds: number
  supported: string[]
  max_file_mb: number
}

export interface PollResult {
  seen?: number
  processed?: Partial<Record<FileStatus, number>>
  waiting?: number
  ingest_job_id?: number
  learn_job_id?: number
  dataset_id?: number
  error?: string
  written?: string[]
  unchanged?: string[]
}

export interface ApiToken {
  id: number
  name: string
  prefix: string
  scope: 'inbox' | 'full'
  created_at: string
  last_used_at: string | null
  token?: string // only in the response that created it
}

export interface LearningLoop {
  id: number
  project_id: number
  enabled: boolean
  hour_utc: number
  minute: number
  dataset_id: number | null
  base_model: string | null
  preset: string
  min_new_rows: number
  margin: number
  max_examples: number
  export_on_promote: boolean // keep ollama/llmcoach-<project>-current built from the promoted adapter
  last_rows: number
  last_run_at: string | null
  next_run_at: string | null
}

export type LoopRunStatus = 'training' | 'evaluating' | 'promoted' | 'kept' | 'skipped' | 'failed'

export interface LoopRun {
  id: number
  trigger: 'schedule' | 'manual'
  status: LoopRunStatus
  dataset_id: number | null
  rows: number
  finetune_id: number | null
  eval_id: number | null
  baseline_finetune_id: number | null
  candidate_f1: number | null
  baseline_f1: number | null
  reason: string | null
  started_at: string
  finished_at: string | null
  finetune_name: string | null
  baseline_name: string | null
}

export interface RegistryEntry {
  id: number
  name: string
  base_model: string
  status: FineTune['status']
  dataset_id: number | null
  created_at: string
  promoted_at: string | null
  train_loss: number | null
}

export interface NotifyConfig {
  url: string
  token_set: boolean
  events: string[]
  available: Record<string, string> // event -> "a training run finishes"
}

export interface PipelineGraph {
  project: { id: number; name: string }
  sources: Source[]
  documents: { count: number; bytes: number; by_status: Record<string, number>; recent: string[]; from_sources: number }
  knowledge: { chunks: number; embed_model: string }
  chat: { conversations: number; model: string | null; last_title: string | null; last_id: number | null }
  datasets: { id: number; name: string; source: Dataset['source']; status: Dataset['status']; rows: number; splits: Record<Split, number> | null; job_id: number | null }[]
  finetunes: (Pick<FineTune, 'id' | 'name' | 'base_model' | 'dataset_id' | 'status' | 'job_id' | 'promoted_at' | 'metrics' | 'method' | 'config' | 'finished_at' | 'ollama_model'>)[]
  evals: (Pick<EvalRun, 'id' | 'name' | 'dataset_id' | 'status' | 'variants' | 'summary' | 'job_id'>)[]
  loop: LearningLoop & { dataset_id_effective: number | null; pending_run: boolean; runs: LoopRun[] }
  active_jobs: { id: number; kind: string; status: JobStatus; config: Record<string, unknown> }[]
}

export interface PipelineRunResult {
  sources: ({ source_id: number; name: string } & PollResult)[]
  run: LoopRun | null
  waiting: boolean
}

export interface LoopState {
  loop: LearningLoop
  dataset: { id: number; name: string; rows: number; splits: Record<Split, number> | null; status: string } | null
  recommended_base_model: string
  current_model: string | null // the Ollama model export_on_promote keeps up to date
  runs: LoopRun[]
  registry: RegistryEntry[]
}

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
      detail = errorDetail((await res.json()).detail) ?? detail
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
  addUrl: (pid: number, url: string) =>
    request<UploadResult>(`/api/projects/${pid}/documents/url`, { method: 'POST', body: JSON.stringify({ url }) }),
  deleteDocument: (pid: number, id: number) => request<void>(`/api/projects/${pid}/documents/${id}`, { method: 'DELETE' }),
  reindex: (pid: number, doc_ids?: number[]) =>
    request<Job>(`/api/projects/${pid}/documents/reindex`, { method: 'POST', body: JSON.stringify({ doc_ids: doc_ids ?? null }) }),
  chunks: (pid: number, docId: number, offset = 0, limit = 50) =>
    request<{ chunks: Chunk[]; total: number }>(`/api/projects/${pid}/documents/${docId}/chunks?offset=${offset}&limit=${limit}`),
  search: (pid: number, query: string, top_k?: number) =>
    request<{ results: SearchHit[]; mode: 'hybrid' | 'vector'; embed_ms: number; total_ms: number }>(`/api/projects/${pid}/search`, {
      method: 'POST', body: JSON.stringify({ query, top_k }),
    }),
  conversations: (pid: number) => request<Conversation[]>(`/api/projects/${pid}/conversations`),
  conversation: (pid: number, id: number) => request<Conversation>(`/api/projects/${pid}/conversations/${id}`),
  updateConversation: (pid: number, id: number, patch: Partial<Pick<Conversation, 'title' | 'model' | 'use_rag' | 'system_prompt'>>) =>
    request<Conversation>(`/api/projects/${pid}/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteConversation: (pid: number, id: number) =>
    request<void>(`/api/projects/${pid}/conversations/${id}`, { method: 'DELETE' }),
  createConversation: (pid: number, title?: string) =>
    request<Conversation>(`/api/projects/${pid}/conversations`, { method: 'POST', body: JSON.stringify({ title }) }),
  addEvent: (pid: number, conversationId: number, text: string, data: ChatCardData) =>
    request<ChatMessage>(`/api/projects/${pid}/conversations/${conversationId}/events`, {
      method: 'POST', body: JSON.stringify({ text, data }),
    }),
  learnFromKnowledge: (pid: number, body: { conversation_id?: number; model?: string; max_chunks?: number }) =>
    request<AttachResult>(`/api/projects/${pid}/chat/learn`, { method: 'POST', body: JSON.stringify(body) }),
  jobLog: (id: number) => request<string>(`/api/jobs/${id}/log`),
  jobMetrics: (id: number) => request<JobEvent[]>(`/api/jobs/${id}/metrics`),
  finetune: (pid: number, id: number) => request<FineTune>(`/api/projects/${pid}/finetunes/${id}`),
  datasets: (pid: number) => request<Dataset[]>(`/api/projects/${pid}/datasets`),
  dataset: (pid: number, id: number) => request<Dataset>(`/api/projects/${pid}/datasets/${id}`),
  datasetRows: (pid: number, id: number, opts: { split?: Split; q?: string; offset?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') p.set(k, String(v))
    return request<{ rows: DatasetRow[]; total: number }>(`/api/projects/${pid}/datasets/${id}/rows?${p}`)
  },
  acceptReview: (pid: number, id: number, rows: number[]) =>
    request<{ dataset: Dataset | null; accepted: number; discarded: number }>(`/api/projects/${pid}/datasets/${id}/accept`,
      { method: 'POST', body: JSON.stringify({ rows }) }),
  resplit: (pid: number, id: number, val: number, test: number, seed = 42) =>
    request<Dataset>(`/api/projects/${pid}/datasets/${id}/split`, { method: 'POST', body: JSON.stringify({ val, test, seed }) }),
  deleteDataset: (pid: number, id: number) => request<void>(`/api/projects/${pid}/datasets/${id}`, { method: 'DELETE' }),
  generateDataset: (pid: number, body: GenerateRequest) =>
    request<{ dataset: Dataset; job: Job }>(`/api/projects/${pid}/datasets/generate`, { method: 'POST', body: JSON.stringify(body) }),
  trainingOptions: () => request<TrainingOptions>('/api/training/options'),
  finetunes: (pid: number) => request<FineTune[]>(`/api/projects/${pid}/finetunes`),
  createFinetune: (pid: number, body: FineTuneRequest) =>
    request<{ finetune?: FineTune; job?: Job; plan: TrainPlan }>(`/api/projects/${pid}/finetunes`, { method: 'POST', body: JSON.stringify(body) }),
  deleteFinetune: (pid: number, id: number) => request<void>(`/api/projects/${pid}/finetunes/${id}`, { method: 'DELETE' }),
  evals: (pid: number) => request<EvalRun[]>(`/api/projects/${pid}/evals`),
  evalRun: (pid: number, id: number) => request<EvalRun>(`/api/projects/${pid}/evals/${id}`),
  createEval: (pid: number, body: { name?: string; dataset_id: number; variants: Omit<EvalVariant, 'label'>[]; judge_model?: string; max_examples: number }) =>
    request<{ eval: EvalRun; job: Job }>(`/api/projects/${pid}/evals`, { method: 'POST', body: JSON.stringify(body) }),
  deleteEval: (pid: number, id: number) => request<void>(`/api/projects/${pid}/evals/${id}`, { method: 'DELETE' }),
  models: (capability?: 'chat' | 'embeddings') =>
    request<ModelRef[]>(`/api/models${capability ? `?capability=${capability}` : ''}`),
  system: () => request<SystemStats>('/api/system'),
  jobs: (params: { status?: JobStatus; limit?: number; project_id?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.project_id != null) q.set('project_id', String(params.project_id))
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
  health: () => request<{ ok: boolean; version: string }>('/api/health'),
  inbox: () => request<InboxInfo>('/api/inbox'),
  sources: (pid: number) => request<Source[]>(`/api/projects/${pid}/sources`),
  createSource: (pid: number, body: { name?: string; kind?: Source['kind']; folder?: string; urls?: string[]; endpoint?: string; bucket?: string; prefix?: string
    region?: string; access_key?: string; secret_key?: string; mode: SourceMode; scan: SourceScan; poll_seconds?: number }) =>
    request<Source>(`/api/projects/${pid}/sources`, { method: 'POST', body: JSON.stringify(body) }),
  updateSource: (pid: number, id: number, patch: Partial<Pick<Source, 'name' | 'mode' | 'scan' | 'enabled' | 'poll_seconds' | 'mirror_deletes' | 'endpoint' | 'region' | 'access_key'>> & { secret_key?: string; urls?: string[] }) =>
    request<Source>(`/api/projects/${pid}/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSource: (pid: number, id: number) => request<void>(`/api/projects/${pid}/sources/${id}`, { method: 'DELETE' }),
  scanSource: (pid: number, id: number) => request<PollResult>(`/api/projects/${pid}/sources/${id}/scan`, { method: 'POST' }),
  sourceFiles: (pid: number, id: number, status?: FileStatus) =>
    request<{ files: SourceFile[]; total: number }>(`/api/projects/${pid}/sources/${id}/files?limit=200${status ? `&status=${status}` : ''}`),
  reviewQueue: (pid: number) => request<SourceFile[]>(`/api/projects/${pid}/inbox/review`),
  approveFile: (pid: number, fileId: number) =>
    request<PollResult & { file: SourceFile }>(`/api/projects/${pid}/inbox/files/${fileId}/approve`, { method: 'POST' }),
  rejectFile: (pid: number, fileId: number) =>
    request<SourceFile>(`/api/projects/${pid}/inbox/files/${fileId}/reject`, { method: 'POST' }),
  tokens: () => request<ApiToken[]>('/api/tokens'),
  createToken: (name: string, scope: ApiToken['scope']) =>
    request<ApiToken>('/api/tokens', { method: 'POST', body: JSON.stringify({ name, scope }) }),
  revokeToken: (id: number) => request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
  loop: (pid: number) => request<LoopState>(`/api/projects/${pid}/loop`),
  updateLoop: (pid: number, patch: Partial<Omit<LearningLoop, 'id' | 'project_id' | 'last_rows' | 'last_run_at' | 'next_run_at'>>) =>
    request<LoopState>(`/api/projects/${pid}/loop`, { method: 'PUT', body: JSON.stringify(patch) }),
  runLoop: (pid: number) => request<LoopRun>(`/api/projects/${pid}/loop/run`, { method: 'POST' }),
  promote: (pid: number, ftId: number) => request<LoopState>(`/api/projects/${pid}/finetunes/${ftId}/promote`, { method: 'POST' }),
  demote: (pid: number, ftId: number) => request<LoopState>(`/api/projects/${pid}/finetunes/${ftId}/demote`, { method: 'POST' }),
  notify: () => request<NotifyConfig>('/api/notify'),
  saveNotify: (body: { url: string; token?: string; events: string[] }) =>
    request<NotifyConfig>('/api/notify', { method: 'PUT', body: JSON.stringify(body) }),
  testNotify: () => request<{ ok: boolean }>('/api/notify/test', { method: 'POST' }),
  pipeline: (pid: number) => request<PipelineGraph>(`/api/projects/${pid}/pipeline`),
  finetuneCard: async (pid: number, ftId: number): Promise<string> => {
    const r = await fetch(`/api/projects/${pid}/finetunes/${ftId}/card`, { credentials: 'same-origin' })
    if (!r.ok) throw new Error(`${r.status}: couldn't write the model card`)
    return r.text()
  },
  exportFinetune: (pid: number, ftId: number, body: { name?: string; quantize?: 'q8_0' | 'q4_K_M' | null } = {}) =>
    request<{ job: Job; model: string }>(`/api/projects/${pid}/finetunes/${ftId}/export`, { method: 'POST', body: JSON.stringify(body) }),
  runPipeline: (pid: number) => request<PipelineRunResult>(`/api/projects/${pid}/pipeline/run`, { method: 'POST' }),
}

/** Drops files into a watched folder, as if they'd been copied there. */
export async function uploadToSource(pid: number, sourceId: number, files: File[]): Promise<PollResult> {
  const form = new FormData()
  files.forEach((f) => form.append('files', f))
  const res = await fetch(`/api/projects/${pid}/sources/${sourceId}/upload`, { method: 'POST', body: form })
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  if (!res.ok) {
    let detail = res.statusText
    try { detail = errorDetail((await res.json()).detail) ?? detail } catch { /* not json */ }
    throw new Error(detail)
  }
  return res.json()
}

/** Streams a chat reply as newline-delimited JSON events. Abort the signal to stop generation. */
export async function streamChat(pid: number, body: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/projects/${pid}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  if (!res.ok || !res.body) {
    let detail = res.statusText
    try { detail = errorDetail((await res.json()).detail) ?? detail } catch { /* not json */ }
    throw new Error(detail)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onEvent(JSON.parse(line))
    }
  }
}

export interface DatasetUploadResult {
  dataset: Dataset
  errors: { line: number; error: string }[]
  error_count: number
}

/** Imports a dataset file. On rejection the error carries the per-line problems. */
export async function uploadDataset(pid: number, file: File, name: string, val: number, test: number): Promise<DatasetUploadResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('name', name)
  form.append('val', String(val))
  form.append('test', String(test))
  const res = await fetch(`/api/projects/${pid}/datasets`, { method: 'POST', body: form })
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = body.detail
    const err = new Error(errorDetail(d) ?? res.statusText) as Error & { lines?: { line: number; error: string }[] }
    err.lines = d && typeof d === 'object' && !Array.isArray(d) ? d.errors : undefined
    throw err
  }
  return body
}

/** Files dropped (or text pasted) into a chat: remembered, or also learned from. */
export function attachToChat(pid: number, opts: {
  files: File[]; mode: AttachMode; text?: string; title?: string; url?: string; conversationId?: number; model?: string
}, onProgress: (fraction: number) => void = () => {}): Promise<AttachResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const f of opts.files) form.append('files', f, f.name)
    form.append('mode', opts.mode)
    if (opts.text) form.append('text', opts.text)
    if (opts.title) form.append('title', opts.title)
    if (opts.conversationId != null) form.append('conversation_id', String(opts.conversationId))
    if (opts.model) form.append('model', opts.model)
    if (opts.url) form.append('url', opts.url)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/projects/${pid}/chat/attach`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
      else {
        let detail = xhr.statusText
        try { detail = errorDetail(JSON.parse(xhr.responseText).detail) ?? detail } catch { /* not json */ }
        reject(new Error(detail))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed: network error'))
    xhr.send(form)
  })
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
        try { detail = errorDetail(JSON.parse(xhr.responseText).detail) ?? detail } catch { /* not json */ }
        reject(new Error(`${xhr.status}: ${detail}`))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed: network error'))
    xhr.send(form)
  })
}

export interface ImportResult {
  project: Project
  documents: number
  datasets: number
  finetunes: number
  conversations: number
  ingest_job_id: number | null
}

/** Creates a project from a bundle made by "Download" on another LLMCoach. */
export async function importProject(file: File): Promise<ImportResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  const r = await fetch('/api/projects/import', { method: 'POST', body: form, credentials: 'same-origin' })
  if (r.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  if (!r.ok) {
    let detail = r.statusText
    try { detail = errorDetail((await r.json()).detail) ?? detail } catch { /* not json */ }
    throw new Error(`${r.status}: ${detail}`)
  }
  return r.json()
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

import { api } from '../api'
import { usePolling } from '../hooks/usePolling'
import { Card } from './ui'

/** Connection to the Ollama server (BoxPilot's Ollama app on BigBox) and its models. */
export function OllamaPanel() {
  const { data: s } = usePolling(api.ollama, 15000)
  return (
    <Card
      title="Ollama"
      actions={
        s && (
          <span className={`rounded px-2 py-0.5 text-xs ${s.reachable ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad'}`}>
            {s.reachable ? `connected · v${s.version}` : 'unreachable'}
          </span>
        )
      }
    >
      {!s ? (
        <div className="text-sm text-muted">Checking…</div>
      ) : !s.reachable ? (
        <div className="space-y-1 text-sm">
          <p>Can't reach Ollama at <code className="font-mono text-xs">{s.url}</code>.</p>
          <p className="text-muted">On BigBox, install the Ollama app from BoxPilot's catalog. Otherwise set LLMCOACH_OLLAMA_URL.</p>
          <p className="font-mono text-xs text-muted/70">{s.error}</p>
        </div>
      ) : s.models.length === 0 ? (
        <div className="text-sm text-muted">
          Connected, but no models yet. Pull one from BoxPilot's Models panel. You'll want a chat model (e.g. qwen3:4b) and
          nomic-embed-text for documents.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {s.models.map((m) => (
            <span key={m.name} className="rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs">
              <span className="font-mono">{m.name}</span>
              <span className="ml-2 text-muted">
                {m.embedding ? 'embeddings' : m.parameters ?? ''} · {m.size_gb} GB
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 font-mono text-[11px] text-muted/60">{s?.url}</div>
    </Card>
  )
}

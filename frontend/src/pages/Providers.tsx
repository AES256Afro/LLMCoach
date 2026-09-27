import { useEffect, useState, type FormEvent } from 'react'
import { api, type ProviderPreset, type ReachStatus } from '../api'
import { PageHeader } from '../components/Layout'
import { ModelChips, ReachBadge, Unreachable } from '../components/ProvidersPanel'
import { Button, Card } from '../components/ui'
import { usePolling } from '../hooks/usePolling'

export function Providers() {
  const { data: statuses, reload } = usePolling(api.providerStatus, 15000)
  const { data: all, reload: reloadAll } = usePolling(api.providers, 30000)
  const [presets, setPresets] = useState<Record<string, ProviderPreset>>({})
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {})
  }, [])

  const refresh = () => {
    reload()
    reloadAll()
  }
  const statusById = new Map(statuses?.map((s) => [s.provider.id, s]))

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle='Where models run. Models are referenced as "provider/model", so you can mix providers per task.'
        actions={!adding && <Button onClick={() => setAdding(true)}>Add provider</Button>}
      />
      {adding && <AddProvider presets={presets} onDone={() => { setAdding(false); refresh() }} />}
      <div className="space-y-4">
        {all?.map((p) => {
          const s = statusById.get(p.id)
          const preset = presets[p.preset]
          return (
            <Card
              key={p.id}
              title={
                <span className="flex items-center gap-2">
                  {p.name}
                  <span className="font-mono text-xs font-normal text-muted">{p.slug}/</span>
                  {p.builtin && <span className="rounded bg-accent/15 px-1.5 text-[10px] uppercase text-accent">built-in</span>}
                </span>
              }
              actions={
                <>
                  {!p.enabled ? <span className="text-xs text-muted">disabled</span> : s && <ReachBadge s={s} />}
                  <Button variant="ghost" onClick={() => api.updateProvider(p.id, { enabled: !p.enabled }).then(refresh)}>
                    {p.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {!p.builtin && (
                    <Button variant="danger" onClick={() => confirm(`Remove ${p.name}?`) && api.deleteProvider(p.id).then(refresh)}>
                      Remove
                    </Button>
                  )}
                </>
              }
            >
              <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                <span>{preset?.name ?? p.preset}</span>
                <span className="font-mono">{p.base_url}</span>
                <span>{p.capabilities.join(' · ')}</span>
                {p.has_api_key && <span>API key set</span>}
                {preset?.license && <span>{preset.license}</span>}
              </div>
              {p.builtin && (
                <p className="mb-3 text-xs text-muted">
                  Address comes from LLMCOACH_OLLAMA_URL (BoxPilot: <em>Where Ollama is</em>).
                </p>
              )}
              {p.enabled && s && (s.reachable ? <ModelChips s={s} /> : <Unreachable s={s} />)}
            </Card>
          )
        })}
      </div>
    </>
  )
}

function AddProvider({ presets, onDone }: { presets: Record<string, ProviderPreset>; onDone: () => void }) {
  const [key, setKey] = useState('llamacpp')
  const preset = presets[key]
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<ReachStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (preset) {
      setName(preset.name)
      setBaseUrl(preset.base_url)
      setTest(null)
    }
  }, [key, preset])

  const runTest = async () => {
    setBusy(true)
    setTest(await api.testProvider({ preset: key, base_url: baseUrl, api_key: apiKey || undefined }).catch(() => null))
    setBusy(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.createProvider({ preset: key, name, base_url: baseUrl, api_key: apiKey || undefined })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
  }

  const choices = Object.entries(presets).filter(([k]) => k !== 'ollama')
  return (
    <Card title="Add provider" className="mb-6">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {choices.map(([k, p]) => (
            <button type="button" key={k} onClick={() => setKey(k)}
              className={`rounded-md border px-3 py-2 text-left text-sm ${key === k ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-2'}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted">{[p.license, p.hardware].filter(Boolean).join(' · ')}</div>
            </button>
          ))}
        </div>
        {preset && <p className="text-sm text-muted">{preset.note}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={input} /></Field>
          <Field label="Address (API root)">
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTest(null) }} className={`${input} font-mono`} />
          </Field>
          <Field label="API key (optional)">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" className={input} />
          </Field>
        </div>
        {test && (
          <div className="rounded-md border border-line p-3">
            <div className="mb-2"><ReachBadge s={test} /></div>
            {test.reachable
              ? <ModelChips s={{ ...test, provider: {} as never }} />
              : <Unreachable s={{ ...test, provider: { base_url: baseUrl } as never }} />}
          </div>
        )}
        {error && <div className="text-sm text-bad">{error}</div>}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={busy || !baseUrl} onClick={runTest}>{busy ? 'Testing…' : 'Test connection'}</Button>
          <Button type="submit" disabled={!name || !baseUrl}>Save</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  )
}

const input = 'w-full rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  )
}

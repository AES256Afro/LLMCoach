import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, attachToChat } from '../api'
import { PageHeader } from '../components/Layout'
import { Button, Card } from '../components/ui'
import { useProject } from '../hooks/project'

/**
 * Where the "Send to LLMCoach" bookmarklet lands: /add?url=…&title=…, opened from any web page.
 * It uses the browser's LLMCoach sign-in, so the bookmarklet needs no token.
 */
export function AddPage() {
  const [params] = useSearchParams()
  const { projects, current, select } = useProject()
  const [url, setUrl] = useState(params.get('url') ?? '')
  const [mode, setMode] = useState<'remember' | 'learn'>('remember')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = params.get('title')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'remember') {
        const r = await api.addUrl(current.id, url.trim())
        setDone(r.held.length ? `Held back ${r.held[0].filename}: it looks private. Decide on the Knowledge page.`
          : r.documents.length ? `Added “${r.documents[0].filename}” to ${current.name}. Answers can cite it in about a minute.`
          : `Nothing new: ${r.skipped[0]?.reason ?? 'already there'}.`)
      } else {
        const r = await attachToChat(current.id, { files: [], url: url.trim(), mode: 'learn' })
        setDone(`${r.message.content}. The chat “${r.conversation.title}” shows its progress.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
    setBusy(false)
  }

  return (
    <>
      <PageHeader title="Add a web page" subtitle={title ? `From “${title}”` : 'Fetch a page into a knowledge base'} />
      <Card className="max-w-2xl">
        {done ? (
          <div className="space-y-3 text-sm">
            <p>{done}</p>
            <div className="flex flex-wrap gap-2">
              <Link to="/knowledge" className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2">Open the Knowledge page</Link>
              {window.opener && <Button variant="ghost" onClick={() => window.close()}>Close this window</Button>}
            </div>
          </div>
        ) : (
          <form onSubmit={add} className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Address</span>
              <input className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
                     type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Project</span>
              <select className="w-full rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
                      value={current?.id ?? ''} onChange={(e) => select(Number(e.target.value))}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2"><input type="radio" checked={mode === 'remember'} onChange={() => setMode('remember')} className="accent-[var(--color-accent)]" />Remember it</label>
              <label className="flex items-center gap-2"><input type="radio" checked={mode === 'learn'} onChange={() => setMode('learn')} className="accent-[var(--color-accent)]" />Also write practice Q&amp;A</label>
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
            <Button type="submit" disabled={busy || !url.trim() || !current}>{busy ? 'Fetching…' : 'Add'}</Button>
          </form>
        )}
      </Card>
    </>
  )
}

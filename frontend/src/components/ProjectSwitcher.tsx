import { useState, type FormEvent } from 'react'
import { useProject } from '../hooks/project'

export function ProjectSwitcher() {
  const { projects, current, select, create } = useProject()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await create(name.trim())
      setAdding(false)
      setName('')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
    }
  }

  return (
    <div className="px-3 pb-3">
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted">Project</div>
      {adding ? (
        <form onSubmit={submit} className="space-y-1">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name"
                 onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
                 className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
          {error && <div className="text-xs text-bad">{error}</div>}
          <div className="flex gap-2 text-xs">
            <button type="submit" disabled={!name.trim()} className="text-accent disabled:opacity-40">Create</button>
            <button type="button" onClick={() => setAdding(false)} className="text-muted">Cancel</button>
          </div>
        </form>
      ) : (
        <div className="flex gap-1">
          <select value={current?.id ?? ''} onChange={(e) => select(Number(e.target.value))}
                  className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => setAdding(true)} title="New project"
                  className="rounded border border-line px-2 text-muted hover:text-text">+</button>
        </div>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { importProject } from '../api'
import { useProject } from '../hooks/project'
import { Button, Card } from './ui'

/** Moving a project between LLMCoach installs (a laptop and BigBox, say) as one zip. */
export function ProjectBundle() {
  const { current, select, reload } = useProject()
  const [adapters, setAdapters] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  if (!current) return null

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setNote(`Importing ${file.name}…`)
    try {
      const r = await importProject(file)
      await reload()
      select(r.project.id)
      setNote(`Imported “${r.project.name}”: ${r.documents} documents (being indexed), ${r.datasets} datasets, `
        + `${r.finetunes} fine-tunes, ${r.conversations} chats.`)
    } catch (e) {
      setNote(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e))
    }
    setBusy(false)
  }

  return (
    <Card title="Move a project">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a className="rounded-md bg-accent px-3 py-1.5 font-medium text-bg hover:opacity-90"
           href={`/api/projects/${current.id}/export${adapters ? '' : '?adapters=false'}`} download>
          Download “{current.name}”
        </a>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={adapters} onChange={(e) => setAdapters(e.target.checked)} />
          with trained adapters
        </label>
        <Button variant="ghost" className="ml-auto" disabled={busy} onClick={() => input.current?.click()}>Import a project…</Button>
        <input ref={input} type="file" accept=".zip,application/zip" className="hidden"
               onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
      </div>
      <p className="mt-2 text-xs text-muted">
        One zip with the documents, datasets, chats, settings and (if ticked) the adapters. Importing it on another
        LLMCoach creates a new project and indexes the documents there. Watched folders, evaluations and job history stay here.
      </p>
      {note && <p className="mt-2 text-xs text-text">{note}</p>}
    </Card>
  )
}

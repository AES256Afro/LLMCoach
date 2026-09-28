import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { api, type HeldFile } from '../api'

type Outcome = 'indexing' | 'removed' | 'decided' | { error: string }

/**
 * Files an upload held back because they look like they contain secrets or personal data: stored,
 * but not indexed (so no answer can quote them) until the owner indexes or removes them. Shared by
 * the Classic Knowledge page and the Chat studio's attach card.
 */
export function HeldFiles({ pid, held, onChange }: { pid: number; held: HeldFile[]; onChange?: () => void }) {
  const [outcome, setOutcome] = useState<Record<number, Outcome>>({})
  const key = held.map((h) => h.doc_id).join(',')

  // A chat card can be read long after the upload: show what was decided since.
  useEffect(() => {
    let alive = true
    api.documents(pid).then((docs) => {
      if (!alive) return
      const status = new Map(docs.map((d) => [d.id, d.status]))
      setOutcome((o) => {
        const next = { ...o }
        for (const id of key.split(',').map(Number)) {
          if (next[id]) continue
          if (!status.has(id)) next[id] = 'removed'
          else if (status.get(id) !== 'held') next[id] = 'decided'
        }
        return next
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [pid, key])

  const act = async (id: number, what: 'index' | 'remove') => {
    try {
      if (what === 'index') await api.reindex(pid, [id])
      else await api.deleteDocument(pid, id)
      setOutcome((o) => ({ ...o, [id]: what === 'index' ? 'indexing' : 'removed' }))
      onChange?.()
    } catch (e) {
      setOutcome((o) => ({ ...o, [id]: { error: e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e) } }))
    }
  }

  return (
    <div className="space-y-2">
      {held.map((h) => {
        const o = outcome[h.doc_id]
        return (
          <div key={h.doc_id} className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />
              <span className="font-medium text-text">{h.filename}</span>
              <span className="text-muted">held back: it may contain secrets or personal data, and answers could quote it</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {h.findings.map((f) => (
                <span key={f.kind} className={`rounded px-1.5 py-0.5 ${f.category === 'secret' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}>
                  {f.label}{f.count > 1 ? ` ×${f.count}` : ''} <span className="font-mono opacity-80">{f.sample}</span>
                </span>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-3">
              {o === 'indexing' && <span className="text-muted">Indexing it now.</span>}
              {o === 'removed' && <span className="text-muted">Removed.</span>}
              {o === 'decided' && <span className="text-muted">Added to the knowledge base.</span>}
              {(!o || typeof o === 'object') && (
                <>
                  <button type="button" className="text-accent hover:underline" onClick={() => act(h.doc_id, 'index')}>Index anyway</button>
                  <button type="button" className="text-muted hover:text-text hover:underline" onClick={() => act(h.doc_id, 'remove')}>Remove</button>
                  {typeof o === 'object' && <span className="text-bad">{o.error}</span>}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

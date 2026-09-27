import { useEffect, useState } from 'react'
import { api, type ModelRef } from '../api'

/** Picks a "<provider>/<model>" reference from every reachable provider. */
export function ModelSelect({ capability, value, onChange, allowDefault, className = '' }: {
  capability: 'chat' | 'embeddings'
  value: string | null
  onChange: (ref: string | null) => void
  allowDefault?: string // label for a "use default" (null) option
  className?: string
}) {
  const [models, setModels] = useState<ModelRef[] | null>(null)

  useEffect(() => {
    api.models(capability).then(setModels).catch(() => setModels([]))
  }, [capability])

  const known = models?.some((m) => m.ref === value)
  const groups = new Map<string, ModelRef[]>()
  for (const m of models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m])

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={`rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent ${className}`}
    >
      {allowDefault && <option value="">{allowDefault}</option>}
      {value && !known && <option value={value}>{value}{models ? ' (not available)' : ''}</option>}
      {[...groups].map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.name}{m.parameters ? ` · ${m.parameters}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
      {models && models.length === 0 && <option disabled>No {capability} models found on any provider</option>}
    </select>
  )
}

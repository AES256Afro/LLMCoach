import { useEffect, useMemo, useRef, useState } from 'react'
import { levelColor, parseAnsi, stripAnsi } from './ansi'

interface Props {
  lines: string[]
  title?: string
  height?: string
  live?: boolean
}

/** Terminal-style log view: ANSI colours, search filter, auto-scroll toggle, copy/download. */
export function LogConsole({ lines, title = 'Logs', height = 'h-96', live = false }: Props) {
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => {
    const indexed = lines.map((text, i) => ({ text, n: i + 1 }))
    if (!query) return indexed
    const q = query.toLowerCase()
    return indexed.filter((l) => stripAnsi(l.text).toLowerCase().includes(q))
  }, [lines, query])

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [shown, follow])

  // Pause following when the user scrolls up; resume at the bottom.
  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const download = () => {
    const blob = new Blob([lines.map(stripAnsi).join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${title.replace(/\W+/g, '_')}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="flex flex-col rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-sm font-medium">{title}</span>
        {live && <span className="h-2 w-2 animate-pulse rounded-full bg-ok" title="live" />}
        <span className="text-xs text-muted">
          {query ? `${shown.length} / ${lines.length}` : lines.length} lines
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-48 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        />
        <button
          onClick={() => setFollow((f) => !f)}
          className={`rounded px-2 py-1 text-xs ${follow ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text'}`}
          title="Auto-scroll"
        >
          ⤓ follow
        </button>
        <button onClick={download} className="rounded px-2 py-1 text-xs text-muted hover:text-text" title="Download">
          ⭳
        </button>
      </div>
      <div ref={boxRef} onScroll={onScroll} className={`${height} overflow-auto bg-bg/60 p-2 font-mono text-xs leading-5`}>
        {shown.length === 0 && <div className="p-2 text-muted">{lines.length ? 'No matching lines.' : 'No output yet.'}</div>}
        {shown.map(({ text, n }) => (
          <div key={n} className="flex whitespace-pre-wrap break-all hover:bg-panel-2">
            <span className="mr-3 w-10 shrink-0 select-none text-right text-muted/50">{n}</span>
            <span style={{ color: levelColor(text) }}>
              {parseAnsi(text).map((s, i) => (
                <span key={i} style={{ color: s.color, fontWeight: s.bold ? 600 : undefined }}>
                  {s.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

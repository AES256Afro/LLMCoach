import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { STUDIOS, rememberStudio } from './registry'

/**
 * Popover listing the studios. Each studio styles its own trigger; the menu itself uses the
 * surrounding studio's tokens, so it fits in wherever it opens.
 */
export function StudioSwitcher({ current, children, align = 'left', className = '' }: {
  current: string
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div ref={box} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
              title="Switch studio" className="block">
        {children}
      </button>
      {open && (
        <div role="menu"
             className={`absolute z-50 mt-2 w-72 rounded-xl border border-line bg-panel p-1.5 shadow-2xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wider text-muted">Studios</div>
          {STUDIOS.map((s) => {
            const ready = s.status === 'ready'
            const active = s.id === current
            return (
              <button key={s.id} type="button" role="menuitem" disabled={!ready}
                      onClick={() => {
                        rememberStudio(s.id)
                        setOpen(false)
                        navigate(s.path)
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${active ? 'bg-panel-2' : ready ? 'hover:bg-panel-2' : 'cursor-default opacity-50'}`}>
                <span className="flex h-7 w-7 shrink-0 overflow-hidden rounded-md border border-line">
                  {s.swatch.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm text-text">
                    {s.name}
                    {active && <span className="text-[10px] uppercase tracking-wide text-accent">current</span>}
                    {!ready && <span className="text-[10px] uppercase tracking-wide text-muted">{s.milestone}</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">{s.tagline}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

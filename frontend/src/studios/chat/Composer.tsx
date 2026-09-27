import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Brain, BookOpen, ChevronDown, FileText, Paperclip, Square, X } from 'lucide-react'
import { api, type ModelRef } from '../../api'
import { matchCommands, parseCommand } from './commands'

const LONG_PASTE = 3000 // characters: longer pastes become a note to remember instead of a message

export interface Staged {
  files: File[]
  mode: 'remember' | 'learn'
}

export function Composer({ streaming, busy, model, useRag, kbChunks, staged, onStage, onModel, onToggleRag, onSend, onAttach, onCommand, onStop, focusKey }: {
  streaming: boolean
  busy: boolean
  model: string | null
  useRag: boolean
  kbChunks: number
  staged: Staged
  onStage: (s: Staged) => void
  onModel: (ref: string) => void
  onToggleRag: () => void
  onSend: (text: string) => void
  onAttach: (files: File[], mode: 'remember' | 'learn', question: string) => void
  onCommand: (name: string, args: string) => void
  onStop: () => void
  focusKey: number
}) {
  const [text, setText] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [models, setModels] = useState<ModelRef[] | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const matches = matchCommands(text)

  useEffect(() => { ref.current?.focus() }, [focusKey])
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    }
  }, [text])
  useEffect(() => setMenuIndex(0), [text])
  useEffect(() => {
    if (modelsOpen && models == null) api.models('chat').then(setModels).catch(() => setModels([]))
  }, [modelsOpen, models])

  const submit = () => {
    const t = text.trim()
    if (busy) return
    if (staged.files.length) {
      onAttach(staged.files, staged.mode, t)
      onStage({ files: [], mode: staged.mode })
      setText('')
      return
    }
    if (!t || streaming) return
    const cmd = parseCommand(t)
    if (cmd) onCommand(cmd.name, cmd.args)
    else onSend(t)
    setText('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && !text.includes(' ')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text.slice(1) !== matches[menuIndex].name)) {
        e.preventDefault()
        const c = matches[menuIndex]
        setText(`/${c.name}${c.args ? ' ' : ''}`)
        if (!c.args) window.setTimeout(() => { onCommand(c.name, ''); setText('') }, 0)
        return
      }
      if (e.key === 'Escape') {
        setText('')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text')
    if (pasted.length > LONG_PASTE) {
      e.preventDefault()
      const file = new File([pasted], `Pasted text ${new Date().toLocaleString().replace(/[/:,]/g, '-')}.md`, { type: 'text/markdown' })
      onStage({ files: [...staged.files, file], mode: staged.mode })
    }
  }

  const unstage = (i: number) => onStage({ files: staged.files.filter((_, j) => j !== i), mode: staged.mode })
  const backToText = async (i: number) => {
    const body = await staged.files[i].text()
    setText((t) => (t ? `${t}\n\n` : '') + body)
    unstage(i)
  }
  const shortModel = model ? model.split('/').slice(1).join('/') || model : 'Default model'

  return (
    <div className="shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+14px)] pt-2">
      <div className="relative mx-auto w-full max-w-[700px] rounded-[20px] border border-line bg-card px-4 pb-2.5 pt-3.5 shadow-[0_18px_40px_-24px_rgba(0,0,0,.6)] focus-within:border-[#4a463f]">
        {/* slash menu */}
        {matches.length > 0 && !text.includes(' ') && (
          <div role="listbox" className="absolute bottom-[calc(100%+8px)] left-3 w-[360px] max-w-[calc(100%-24px)] rounded-2xl border border-line bg-panel-2 p-1.5 shadow-2xl">
            {matches.map((c, i) => (
              <button key={c.name} type="button" role="option" aria-selected={i === menuIndex}
                      onMouseEnter={() => setMenuIndex(i)}
                      onClick={() => { if (c.args) { setText(`/${c.name} `); ref.current?.focus() } else { onCommand(c.name, ''); setText('') } }}
                      className={`flex w-full items-baseline gap-3 rounded-xl px-3 py-1.5 text-left text-[13px] ${i === menuIndex ? 'bg-[#3a372f]' : ''}`}>
                <b className="w-20 shrink-0 font-medium">/{c.name}</b>
                <span className="truncate text-xs text-muted">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* staged attachments */}
        {staged.files.length > 0 && (
          <div className="mb-3 space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {staged.files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-panel-2 py-1 pl-2 pr-1 text-xs">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate">{f.name}</span>
                  {f.name.startsWith('Pasted text') && (
                    <button type="button" onClick={() => backToText(i)} className="text-muted underline decoration-dotted hover:text-text">use as message</button>
                  )}
                  <button type="button" onClick={() => unstage(i)} aria-label={`Remove ${f.name}`} className="rounded p-0.5 text-muted hover:text-text"><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
            </div>
            <div role="radiogroup" aria-label="What to do with these files" className="inline-flex rounded-full border border-line p-0.5 text-xs">
              {(['remember', 'learn'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={staged.mode === m} onClick={() => onStage({ ...staged, mode: m })}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 ${staged.mode === m ? (m === 'learn' ? 'bg-warm/15 text-warm' : 'bg-accent-dim text-accent') : 'text-muted hover:text-text'}`}>
                  {m === 'remember' ? <BookOpen className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
                  {m === 'remember' ? 'Remember' : 'Learn from it'}
                </button>
              ))}
            </div>
          </div>
        )}

        <textarea ref={ref} id="chat-composer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste} rows={1}
                  aria-label="Message"
                  placeholder={staged.files.length ? 'Ask about these files once they are read (optional)…' : 'Message, or type / for commands…'}
                  className="block w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-[#7c766c]" />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => fileInput.current?.click()} title="Attach files" aria-label="Attach files"
                  className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-panel-2 hover:text-text">
            <Paperclip className="h-4 w-4" />
          </button>
          <input ref={fileInput} type="file" multiple className="hidden"
                 accept=".pdf,.md,.markdown,.txt,.text,.rst,.csv,.json,.html,.htm,.docx"
                 onChange={(e) => { onStage({ files: [...staged.files, ...Array.from(e.target.files ?? [])], mode: staged.mode }); e.target.value = '' }} />

          <div className="relative">
            <button type="button" onClick={() => setModelsOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={modelsOpen}
                    className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12.5px] hover:border-[#4a463f]">
              <span className="truncate">{shortModel}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
            </button>
            {modelsOpen && (
              <div role="listbox" className="absolute bottom-[calc(100%+6px)] left-0 z-20 max-h-72 w-72 overflow-y-auto rounded-2xl border border-line bg-panel-2 p-1.5 shadow-2xl">
                {models == null && <div className="px-3 py-2 text-xs text-muted">Loading models…</div>}
                {models?.length === 0 && <div className="px-3 py-2 text-xs text-muted">No chat models found. Pull one in Ollama.</div>}
                {models?.map((m) => (
                  <button key={m.ref} type="button" role="option" aria-selected={m.ref === model}
                          onClick={() => { onModel(m.ref); setModelsOpen(false) }}
                          className={`flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] hover:bg-[#3a372f] ${m.ref === model ? 'text-accent' : ''}`}>
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    <span className="shrink-0 text-[11px] text-muted">{m.provider}{m.parameters ? ` · ${m.parameters}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" onClick={onToggleRag} disabled={!kbChunks} aria-pressed={useRag && kbChunks > 0}
                  title={kbChunks ? 'Answer from the knowledge base' : 'The knowledge base is empty'}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12.5px] hover:border-[#4a463f] disabled:opacity-50">
            <span className={`h-[7px] w-[7px] rounded-full ${useRag && kbChunks ? 'bg-accent' : 'bg-[#5a554c]'}`} />
            Knowledge · {kbChunks}
          </button>

          <span className="ml-1 hidden text-[11.5px] text-muted sm:inline">
            <kbd className="rounded border border-line px-1">/</kbd> commands · drop files anywhere
          </span>

          {streaming ? (
            <button type="button" onClick={onStop} aria-label="Stop" className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-text text-bg">
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button type="button" onClick={submit} aria-label="Send" disabled={busy || (!text.trim() && !staged.files.length)}
                    className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-text text-bg disabled:opacity-30">
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import { api, streamChat, type ChatMessage, type ChatStats, type Conversation, type SearchHit } from '../api'
import { ModelSelect } from '../components/ModelSelect'
import { Button } from '../components/ui'
import { useProject } from '../hooks/project'

/** A message being streamed, before the server has saved it. */
interface Pending {
  question: string
  answer: string
  thinking: string
  sources: SearchHit[] | null
  model: string | null
  error: string | null
}

export function Playground() {
  const { current: project } = useProject()
  const pid = project?.id
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [useRag, setUseRag] = useState(true)
  const [temperature, setTemperature] = useState(0.7)
  const [think, setThink] = useState(true)
  const [system, setSystem] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [kbChunks, setKbChunks] = useState(0)
  const abort = useRef<AbortController | null>(null)

  const loadList = useCallback(async () => {
    if (pid != null) setConversations(await api.conversations(pid))
  }, [pid])

  useEffect(() => {
    setActive(null)
    setPending(null)
    loadList().catch(() => {})
    if (pid != null) api.knowledge(pid).then((k) => setKbChunks(k.chunks)).catch(() => {})
  }, [pid, loadList])

  useEffect(() => {
    if (project) {
      setModel((m) => m ?? project.settings.chat_model)
      setSystem(project.settings.system_prompt ?? '')
    }
  }, [project])

  const open = async (id: number) => {
    if (pid == null) return
    const c = await api.conversation(pid, id)
    setActive(c)
    setPending(null)
    setModel(c.model)
    setUseRag(c.use_rag)
    setSystem(c.system_prompt ?? '')
  }

  const newChat = () => {
    abort.current?.abort()
    setActive(null)
    setPending(null)
    setSystem(project?.settings.system_prompt ?? '')
  }

  const send = async (question: string) => {
    if (pid == null || !question.trim() || pending) return
    const controller = new AbortController()
    abort.current = controller
    const p: Pending = { question, answer: '', thinking: '', sources: null, model, error: null }
    setPending(p)
    let convId = active?.id
    try {
      await streamChat(pid, {
        message: question,
        conversation_id: convId,
        model: model ?? undefined,
        use_rag: useRag,
        system_prompt: system,
        temperature,
        think,
      }, (e) => {
        if (e.type === 'meta') {
          convId = e.conversation.id
          p.sources = e.sources
          p.model = e.model
          if (!model) setModel(e.model)
        } else if (e.type === 'delta') p.answer += e.text
        else if (e.type === 'thinking') p.thinking += e.text
        else if (e.type === 'error') p.error = e.message
        setPending({ ...p })
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        p.error = err instanceof Error ? err.message : String(err)
        setPending({ ...p })
        return
      }
    }
    abort.current = null
    if (convId != null) {
      // The server saved both messages (a stopped reply is kept with what it had).
      window.setTimeout(async () => {
        const c = await api.conversation(pid, convId!)
        setActive(c)
        setPending(null)
        loadList()
      }, controller.signal.aborted ? 300 : 0)
    }
  }

  const remove = async (c: Conversation) => {
    if (pid == null || !confirm(`Delete "${c.title}"?`)) return
    await api.deleteConversation(pid, c.id)
    if (active?.id === c.id) newChat()
    loadList()
  }

  if (!project) return <div className="text-sm text-muted">Loading project…</div>
  const messages = active?.messages ?? []
  const streaming = pending != null && !pending.error && abort.current != null

  return (
    <div className="-mx-4 -my-5 flex h-[calc(100vh-49px)] md:-m-6 md:h-screen">
      {/* conversation list */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel/50 lg:flex">
        <div className="p-3"><Button className="w-full" onClick={newChat}>New chat</Button></div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <div key={c.id}
                 className={`group flex items-center rounded-md text-sm ${active?.id === c.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text'}`}>
              <button onClick={() => open(c.id)} className="min-w-0 flex-1 truncate px-3 py-2 text-left">{c.title}</button>
              <button onClick={() => remove(c)} title="Delete" className="px-2 opacity-0 group-hover:opacity-100 hover:text-bad">×</button>
            </div>
          ))}
          {!conversations.length && <div className="px-3 py-2 text-xs text-muted">No conversations yet.</div>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <button onClick={newChat} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-text lg:hidden">New</button>
          <ModelSelect capability="chat" value={model} onChange={setModel} allowDefault="Default model" className="max-w-[16rem]" />
          <label className={`flex items-center gap-1.5 text-sm ${kbChunks ? '' : 'opacity-50'}`}
                 title={kbChunks ? 'Answer from the knowledge base' : 'The knowledge base is empty'}>
            <input type="checkbox" checked={useRag && kbChunks > 0} disabled={!kbChunks}
                   onChange={(e) => setUseRag(e.target.checked)} className="accent-[var(--color-accent)]" />
            Knowledge base
          </label>
          <button onClick={() => setShowSettings((s) => !s)}
                  className={`ml-auto rounded px-2 py-1 text-xs ${showSettings ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
            Settings
          </button>
        </div>
        {showSettings && (
          <div className="grid gap-4 border-b border-line bg-panel/50 px-4 py-3 text-sm md:grid-cols-[1fr_14rem]">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">System prompt</span>
              <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={3}
                        placeholder="You are a helpful, accurate assistant. Answer concisely."
                        className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
            </label>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 flex justify-between text-xs text-muted"><span>Temperature</span><span className="font-mono">{temperature.toFixed(1)}</span></span>
                <input type="range" min={0} max={2} step={0.1} value={temperature}
                       onChange={(e) => setTemperature(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted" title="For reasoning models such as qwen3">
                <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} className="accent-[var(--color-accent)]" />
                Let reasoning models think first
              </label>
            </div>
          </div>
        )}

        {/* transcript */}
        <Transcript messages={messages} pending={pending} kbEmpty={!kbChunks} onSuggest={send} />

        {/* composer */}
        <Composer disabled={streaming} onSend={send} onStop={() => abort.current?.abort()} streaming={streaming} />
      </section>
    </div>
  )
}

function Transcript({ messages, pending, kbEmpty, onSuggest }: {
  messages: ChatMessage[]; pending: Pending | null; kbEmpty: boolean; onSuggest: (q: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, pending?.answer, pending?.thinking])

  if (!messages.length && !pending) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-lg font-medium">Ask anything</div>
        <p className="max-w-md text-sm text-muted">
          {kbEmpty
            ? <>Answers come from the model alone. <Link to="/knowledge" className="text-accent hover:underline">Add documents</Link> to ground them in your own material, with citations.</>
            : 'With the knowledge base on, answers cite the passages they used.'}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {['Summarize what these documents cover.', 'What are the main steps to get started?', 'What should I know before I begin?'].map((q) => (
            <button key={q} onClick={() => onSuggest(q)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-text">{q}</button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {messages.map((m) => m.role === 'user'
          ? <UserBubble key={m.id} text={m.content} />
          : <AssistantMessage key={m.id} content={m.content} thinking={m.thinking} sources={m.sources}
                              model={m.model} stats={m.stats} error={m.error} />)}
        {pending && (
          <>
            <UserBubble text={pending.question} />
            <AssistantMessage content={pending.answer} thinking={pending.thinking} sources={pending.sources}
                              model={pending.model} stats={null} error={pending.error} live={!pending.error} />
          </>
        )}
        <div ref={end} />
      </div>
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent/15 px-4 py-2.5 text-sm">{text}</div>
    </div>
  )
}

function AssistantMessage({ content, thinking, sources, model, stats, error, live }: {
  content: string; thinking: string | null; sources: SearchHit[] | null; model: string | null
  stats: ChatStats | null; error: string | null; live?: boolean
}) {
  const waiting = live && !content && !thinking
  return (
    <div className="space-y-2">
      {thinking && (
        <details className="rounded-md border border-line/60 bg-panel/40 px-3 py-2 text-xs text-muted" open={live && !content}>
          <summary className="cursor-pointer select-none">{live && !content ? 'Thinking…' : 'Reasoning'}</summary>
          <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap">{thinking}</div>
        </details>
      )}
      {waiting && <div className="flex gap-1 py-2">{[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 150}ms` }} />)}</div>}
      {content && (
        <div className="prose-chat text-sm leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          {live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />}
        </div>
      )}
      {error && (
        <div className={`rounded-md px-3 py-2 text-xs ${error === 'stopped' ? 'text-muted' : 'border border-bad/40 bg-bad/10 text-bad'}`}>
          {error === 'stopped' ? 'Stopped.' : error}
        </div>
      )}
      {sources && sources.length > 0 && <Sources sources={sources} />}
      {(model || stats) && !live && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted/70">
          {model && <span>{model}</span>}
          {stats?.tokens_per_sec != null && <span>{stats.tokens_per_sec} tok/s</span>}
          {stats?.completion_tokens != null && <span>{stats.completion_tokens} tokens</span>}
          {stats?.first_token_ms != null && <span>first token {(stats.first_token_ms / 1000).toFixed(1)}s</span>}
          {stats?.total_ms != null && <span>total {(stats.total_ms / 1000).toFixed(1)}s</span>}
          {stats?.retrieval_ms != null && <span>retrieval {stats.retrieval_ms}ms</span>}
        </div>
      )}
    </div>
  )
}

function Sources({ sources }: { sources: SearchHit[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s, i) => (
          <button key={s.id} onClick={() => setOpen(open === i ? null : i)}
                  className={`rounded-md border px-2 py-0.5 text-xs ${open === i ? 'border-accent text-accent' : 'border-line text-muted hover:text-text'}`}
                  title={`similarity ${s.score.toFixed(3)}`}>
            [{i + 1}] {s.filename}{s.page != null ? ` p.${s.page}` : ''}
          </button>
        ))}
      </div>
      {open != null && (
        <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-bg/50 p-3 text-xs text-text/80">
          {sources[open].text}
        </div>
      )}
    </div>
  )
}

function Composer({ disabled, streaming, onSend, onStop }: {
  disabled: boolean; streaming: boolean; onSend: (q: string) => void; onStop: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
  }, [text])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form onSubmit={submit} className="border-t border-line p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={1}
                  placeholder="Message… (Enter to send, Shift+Enter for a new line)"
                  className="flex-1 resize-none rounded-lg border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent" />
        {streaming
          ? <Button type="button" variant="danger" onClick={onStop}>Stop</Button>
          : <Button type="submit" disabled={!text.trim()}>Send</Button>}
      </div>
    </form>
  )
}

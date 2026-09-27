import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Brain, Check, Copy, MessageCircleQuestion, RotateCcw } from 'lucide-react'
import type { ChatMessage, ChatStats, SearchHit } from '../../api'
import { AttachCard, EvalCard, LearnCard, LocalCardView, LogsCard, TrainCard } from './cards'
import type { ChatSession } from './useChatSession'

export interface SelectedSource {
  hit: SearchHit
  index: number
  stats: ChatStats | null
  model: string | null
}

/** "[1]" and "[2][3]" in an answer become links the renderer turns into citation chips. */
function withCitations(text: string, count: number): string {
  if (!count) return text
  return text.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => (Number(n) >= 1 && Number(n) <= count ? `[${n}](#cite-${n})` : m))
}

function shortModel(ref: string | null) {
  return ref ? ref.split('/').slice(1).join('/') || ref : null
}

function Answer({ content, thinking, sources, model, stats, error, live, onSelect, onRetry }: {
  content: string; thinking: string | null; sources: SearchHit[] | null; model: string | null; stats: ChatStats | null
  error: string | null; live?: boolean; onSelect: (s: SelectedSource) => void; onRetry?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const n = sources?.length ?? 0
  const select = (i: number) => sources && onSelect({ hit: sources[i], index: i, stats, model })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard refused */ }
  }

  return (
    <div className="rise space-y-3">
      {thinking && (
        <details className="group rounded-xl border border-line/70 px-3 py-2 text-[12.5px] text-muted" open={live && !content}>
          <summary className="flex cursor-pointer select-none items-center gap-2 marker:content-none">
            <Brain className="h-3.5 w-3.5" />{live && !content ? 'Thinking…' : 'Reasoning'}
          </summary>
          <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">{thinking}</div>
        </details>
      )}
      {live && !content && !thinking && (
        <div className="flex gap-1 py-2" aria-label="Waiting for the reply">
          {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />)}
        </div>
      )}
      {content && (
        <div className="prose-chat">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            a: ({ href, children }) => {
              const m = /^#cite-(\d+)$/.exec(href ?? '')
              if (m) {
                return (
                  <button type="button" onClick={() => select(Number(m[1]) - 1)}
                          className="mx-0.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-accent-dim px-1 align-[1px] text-[11px] font-semibold text-accent hover:brightness-125"
                          title={sources?.[Number(m[1]) - 1]?.filename}>
                    {m[1]}
                  </button>
                )
              }
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>
            },
          }}>
            {withCitations(content, n)}
          </ReactMarkdown>
          {live && <span className="ml-0.5 inline-block h-4 w-[3px] animate-pulse rounded-sm bg-accent align-middle" />}
        </div>
      )}
      {error && (
        <div className={`rounded-xl px-3 py-2 text-xs ${error === 'stopped' ? 'text-muted' : 'border border-bad/40 bg-bad/10 text-bad'}`}>
          {error === 'stopped' ? 'Stopped.' : error}
        </div>
      )}
      {n > 0 && (
        <div className="flex flex-wrap gap-2">
          {sources!.slice(0, 4).map((s, i) => (
            <button key={s.id} type="button" onClick={() => select(i)}
                    className="w-[210px] max-w-full rounded-xl border border-line bg-card px-3 py-2 text-left text-xs hover:border-accent/60">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-accent-dim px-1 text-[11px] text-accent">{i + 1}</span>
                <span className="truncate">{s.filename}{s.page != null ? ` · p.${s.page}` : ''}</span>
              </span>
              <span className="mt-1 block truncate text-muted">“{s.text.replace(/\s+/g, ' ').slice(0, 80)}…”</span>
            </button>
          ))}
          {n > 4 && <button type="button" onClick={() => select(4)} className="self-center text-xs text-muted hover:text-text">+{n - 4} more</button>}
        </div>
      )}
      {!live && (model || stats) && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
          {model && <span>{shortModel(model)}</span>}
          {stats?.tokens_per_sec != null && <span className="tabular-nums">{stats.tokens_per_sec} tok/s</span>}
          {stats?.first_token_ms != null && <span className="tabular-nums">{(stats.first_token_ms / 1000).toFixed(1)}s to first token</span>}
          {content && <button type="button" onClick={copy} className="inline-flex items-center gap-1 hover:text-text">{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}</button>}
          {onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 hover:text-text"><RotateCcw className="h-3 w-3" />Retry</button>}
        </div>
      )}
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return <div className="rise ml-auto max-w-[80%] whitespace-pre-wrap rounded-[18px] bg-panel-2 px-4 py-2.5">{text}</div>
}

export function Thread({ session, kbChunks, projectName, onSelect, onCommand, onAsk, onPick }: {
  session: ChatSession
  kbChunks: number
  projectName: string
  onSelect: (s: SelectedSource) => void
  onCommand: (name: string, args?: string) => void
  onAsk: (q: string) => void
  onPick: (mode: 'remember' | 'learn') => void
}) {
  const { active, pending, streaming, local, busy } = session
  const messages: ChatMessage[] = active?.messages ?? []
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, pending?.answer, pending?.thinking, local.length, busy])

  if (!messages.length && !pending && !local.length && !busy) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-5 py-10">
        <div className="w-full max-w-[600px] space-y-7">
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold tracking-tight">What should {projectName} know?</h1>
            <p className="text-muted">Drop files anywhere to teach it, or just ask. Answers cite the documents they come from.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <button type="button" onClick={() => onPick('remember')} className="rounded-2xl border border-line bg-card p-4 text-left hover:border-accent/60">
              <BookOpen className="mb-3 h-5 w-5 text-accent" /><b className="block font-medium">Remember files</b>
              <span className="text-xs text-muted">Indexed in a minute; answers cite them.</span>
            </button>
            <button type="button" onClick={() => onPick('learn')} className="rounded-2xl border border-line bg-card p-4 text-left hover:border-warm/60">
              <Brain className="mb-3 h-5 w-5 text-warm" /><b className="block font-medium">Learn from files</b>
              <span className="text-xs text-muted">Also writes practice Q&amp;A for fine-tuning.</span>
            </button>
            <button type="button" onClick={() => onAsk(kbChunks ? 'Summarize what these documents cover.' : 'What can you help me with?')}
                    className="rounded-2xl border border-line bg-card p-4 text-left hover:border-accent/60">
              <MessageCircleQuestion className="mb-3 h-5 w-5 text-muted" /><b className="block font-medium">Just ask</b>
              <span className="text-xs text-muted">{kbChunks ? `${kbChunks} passages are ready to search.` : 'The knowledge base is empty for now.'}</span>
            </button>
          </div>
          <p className="text-xs text-muted">Type <kbd className="rounded border border-line px-1">/</kbd> for commands: /train, /compare, /learn all, /model, /help.</p>
        </div>
      </div>
    )
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] space-y-6 px-5 pb-6 pt-4">
        {messages.map((m, i) => {
          if (m.role === 'user') return <UserBubble key={m.id} text={m.content} />
          if (m.role === 'event') {
            const d = m.data ?? { card: 'info' }
            if (d.card === 'attach') return <AttachCard key={m.id} data={d} onCommand={onCommand} onAsk={onAsk} />
            if (d.card === 'learn') return <LearnCard key={m.id} data={d} onCommand={onCommand} />
            if (d.card === 'train') return <TrainCard key={m.id} data={d} onCommand={onCommand} />
            if (d.card === 'eval') return <EvalCard key={m.id} data={d} />
            if (d.card === 'logs') return <LogsCard key={m.id} data={d} />
            return <div key={m.id} className="text-xs text-muted">{m.content}</div>
          }
          const isLast = i === messages.length - 1
          return (
            <Answer key={m.id} content={m.content} thinking={m.thinking} sources={m.sources} model={m.model} stats={m.stats}
                    error={m.error} onSelect={onSelect}
                    onRetry={isLast && lastUser && !streaming ? () => onAsk(lastUser.content) : undefined} />
          )
        })}
        {pending && (
          <>
            <UserBubble text={pending.question} />
            <Answer content={pending.answer} thinking={pending.thinking} sources={pending.sources} model={pending.model}
                    stats={null} error={pending.error} live={streaming && !pending.error} onSelect={onSelect} />
          </>
        )}
        {local.map((c) => <LocalCardView key={c.id} card={c} onDismiss={() => session.clearLocal()} />)}
        {busy && <div className="rise flex items-center gap-2 text-xs text-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warm" />{busy}</div>}
        <div ref={end} />
      </div>
    </div>
  )
}

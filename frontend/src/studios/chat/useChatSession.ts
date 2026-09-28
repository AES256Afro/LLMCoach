import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api, attachToChat, isFinal, streamChat,
  type AttachMode, type ChatCardData, type Conversation, type Project, type SearchHit,
} from '../../api'

/** A reply being streamed, before the server has saved it. */
export interface Pending {
  question: string
  answer: string
  thinking: string
  sources: SearchHit[] | null
  model: string | null
  error: string | null
}

/** Cards that live only on screen (help, an error from a command), never saved. */
export interface LocalCard {
  id: string
  kind: 'help' | 'error' | 'info'
  text: string
}

export interface ChatSettings {
  model: string | null
  useRag: boolean
  temperature: number
  think: boolean
  system: string
}

export function useChatSession(project: Project | null) {
  const pid = project?.id ?? null
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [local, setLocal] = useState<LocalCard[]>([])
  const [busy, setBusy] = useState<string | null>(null) // e.g. "Uploading 2 files… 40%"
  const [settings, setSettings] = useState<ChatSettings>({ model: null, useRag: true, temperature: 0.7, think: true, system: '' })
  const abort = useRef<AbortController | null>(null)
  // Bumped whenever the view moves on (send, open, new chat, project switch). A request that
  // finishes after that must not touch the screen: it belongs to a chat that's no longer shown.
  const view = useRef(0)

  const leave = useCallback(() => {
    view.current++
    abort.current?.abort()
    abort.current = null
    setStreaming(false)
    setPending(null)
    setLocal([])
    setBusy(null)
  }, [])

  const loadList = useCallback(async () => {
    if (pid != null) setConversations(await api.conversations(pid))
  }, [pid])

  useEffect(() => {
    leave()
    setActive(null)
    loadList().catch(() => {})
  }, [pid, loadList, leave])

  useEffect(() => {
    if (project) setSettings((s) => ({ ...s, model: s.model ?? project.settings.chat_model, system: project.settings.system_prompt ?? '' }))
  }, [project])

  const reload = useCallback(async (id?: number): Promise<Conversation | null> => {
    const cid = id ?? active?.id
    if (pid == null || cid == null) return null
    const my = view.current
    const c = await api.conversation(pid, cid)
    if (view.current !== my) return null
    setActive(c)
    return c
  }, [pid, active?.id])

  const open = useCallback(async (id: number) => {
    if (pid == null || active?.id === id) return
    leave()
    const my = view.current
    const c = await api.conversation(pid, id)
    if (view.current !== my) return
    setActive(c)
    setSettings((s) => ({ ...s, model: c.model ?? s.model, useRag: c.use_rag, system: c.system_prompt ?? s.system }))
  }, [pid, active?.id, leave])

  const newChat = useCallback(() => {
    leave()
    setActive(null)
    setSettings((s) => ({ ...s, system: project?.settings.system_prompt ?? '' }))
  }, [leave, project])

  const remove = useCallback(async (id: number) => {
    if (pid == null) return
    await api.deleteConversation(pid, id)
    if (active?.id === id) newChat()
    loadList().catch(() => {})
  }, [pid, active?.id, newChat, loadList])

  const note = useCallback((kind: LocalCard['kind'], text: string) => {
    setLocal((l) => [...l, { id: `${Date.now()}-${Math.random()}`, kind, text }])
  }, [])

  /** The active conversation, creating an empty one if this is a fresh chat. */
  const ensureConversation = useCallback(async (): Promise<Conversation | null> => {
    if (pid == null) return null
    if (active) return active
    const c = await api.createConversation(pid)
    setActive(c)
    loadList().catch(() => {})
    return c
  }, [pid, active, loadList])

  const addEvent = useCallback(async (text: string, data: ChatCardData) => {
    const c = await ensureConversation()
    if (!c || pid == null) return
    await api.addEvent(pid, c.id, text, data)
    setLocal([])
    await reload(c.id)
    loadList().catch(() => {})
  }, [ensureConversation, pid, reload, loadList])

  /** Asks a question. `into` names the conversation when the caller has just created or changed it
   *  (this callback may still hold the previous one). */
  const send = useCallback(async (question: string, into?: Conversation) => {
    if (pid == null || !question.trim() || streaming) return
    const target = into ?? active
    const my = ++view.current
    const controller = new AbortController()
    abort.current = controller
    const p: Pending = { question, answer: '', thinking: '', sources: null, model: settings.model, error: null }
    setLocal([]) // help and error notes belong to the moment they were shown, not below the new reply
    setPending(p)
    setStreaming(true)
    let convId = target?.id
    const expected = (target?.messages?.length ?? 0) + 2 // the question and the reply, once saved
    try {
      await streamChat(pid, {
        message: question, conversation_id: convId, model: settings.model ?? undefined, use_rag: settings.useRag,
        system_prompt: settings.system, temperature: settings.temperature, think: settings.think,
      }, (e) => {
        if (view.current !== my) return
        if (e.type === 'meta') {
          convId = e.conversation.id
          p.sources = e.sources
          p.model = e.model
          setSettings((s) => (s.model ? s : { ...s, model: e.model }))
        } else if (e.type === 'delta') p.answer += e.text
        else if (e.type === 'thinking') p.thinking += e.text
        else if (e.type === 'error') p.error = e.message
        setPending({ ...p })
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted && view.current === my) {
        p.error = err instanceof Error ? err.message : String(err)
        setPending({ ...p })
        setStreaming(false)
        abort.current = null
        return
      }
    }
    if (view.current !== my) return
    abort.current = null
    setStreaming(false)
    if (controller.signal.aborted) {
      p.error = p.error ?? 'stopped'
      setPending({ ...p })
    }
    if (convId == null) return
    // Keep the pending bubble until the saved copy is there, so a stopped reply doesn't blink.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const c = await api.conversation(pid, convId)
        if (view.current !== my) return
        if ((c.messages?.length ?? 0) >= expected || attempt === 19) {
          setActive(c)
          setPending(null)
          loadList().catch(() => {})
          return
        }
      } catch {
        if (view.current !== my) return
      }
      await new Promise((r) => window.setTimeout(r, 250))
      if (view.current !== my) return
    }
  }, [pid, streaming, settings, active, loadList])

  const stop = useCallback(() => abort.current?.abort(), [])

  /**
   * Adds dropped files (or pasted text) to the knowledge base, optionally learning from them.
   * With a question, waits until the files are indexed and then asks it, so "what does this PDF
   * say about X?" with the PDF attached just works.
   */
  const attach = useCallback(async (files: File[], mode: AttachMode, question?: string) => {
    if (pid == null || (!files.length && !question)) return
    const my = view.current
    const label = files.length === 1 ? files[0].name : `${files.length} files`
    setBusy(`Uploading ${label}…`)
    try {
      const r = await attachToChat(pid, { files, mode, conversationId: active?.id, model: settings.model ?? undefined },
        (f) => view.current === my && setBusy(`Uploading ${label}… ${Math.round(f * 100)}%`))
      if (view.current !== my) return
      setBusy(null)
      const conv = await reload(r.conversation.id)
      loadList().catch(() => {})
      const ingestJob = r.message.data?.ingest_job_id as number | null | undefined
      if (question?.trim()) {
        if (ingestJob != null) {
          setBusy('Indexing before answering…')
          for (let i = 0; i < 600; i++) { // up to ~10 minutes
            const j = await api.job(ingestJob)
            if (view.current !== my) return
            if (isFinal(j.status)) break
            await new Promise((res) => window.setTimeout(res, 1000))
          }
          setBusy(null)
        }
        if (view.current === my) await send(question, conv ?? r.conversation)
      }
    } catch (err) {
      if (view.current === my) {
        setBusy(null)
        note('error', err instanceof Error ? err.message : String(err))
      }
    }
  }, [pid, active, settings.model, reload, loadList, send, note])

  /** /add <url> and /learn <url>: the server fetches the page and treats it like a dropped file. */
  const attachUrl = useCallback(async (url: string, mode: AttachMode) => {
    if (pid == null) return
    const my = view.current
    setBusy(`Fetching ${url}…`)
    try {
      const r = await attachToChat(pid, { files: [], url, mode, conversationId: active?.id, model: settings.model ?? undefined })
      if (view.current !== my) return
      setBusy(null)
      await reload(r.conversation.id)
      loadList().catch(() => {})
    } catch (err) {
      if (view.current === my) {
        setBusy(null)
        note('error', err instanceof Error ? err.message.replace(/^\d+: /, '') : String(err))
      }
    }
  }, [pid, active, settings.model, reload, loadList, note])

  return {
    conversations, active, pending, streaming, local, busy, settings, setSettings,
    open, newChat, remove, send, stop, attach, attachUrl, addEvent, ensureConversation, reload, note, loadList,
    clearLocal: () => setLocal([]),
  }
}

export type ChatSession = ReturnType<typeof useChatSession>

/** The conversation a studio should open first: the one named by ?c= in the URL (another studio
 *  switching here), else the most recent. */
export function startingConversation(list: Conversation[]): number | undefined {
  const wanted = Number(new URLSearchParams(window.location.search).get('c'))
  return (list.find((c) => c.id === wanted) ?? list[0])?.id
}

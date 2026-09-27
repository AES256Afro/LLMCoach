import { useEffect, useRef, useState } from 'react'
import { wsUrl, type AppLog, type Job, type JobEvent, type SystemStats } from '../api'

const MAX_LOG_LINES = 20_000
const MAX_HISTORY = 150 // ~5 min of 2s samples

export interface StatsSample {
  t: number
  cpu: number
  ram: number
  gpuUtil: number | null
  vram: number | null
}

/**
 * Live system stats and server logs over /ws/system. Reconnects automatically.
 */
export function useSystemStream() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [history, setHistory] = useState<StatsSample[]>([])
  const [logs, setLogs] = useState<AppLog[]>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: number | undefined
    let closed = false

    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/system'))
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type !== 'stats') return
        const s: SystemStats = msg.stats
        setStats(s)
        const g = s.gpus[0]
        setHistory((h) =>
          [
            ...h,
            {
              t: Date.now(),
              cpu: s.cpu_pct,
              ram: (s.ram_used_gb / s.ram_total_gb) * 100,
              gpuUtil: g?.util_pct ?? null,
              vram: g?.vram_used_gb != null && g.vram_total_gb ? (g.vram_used_gb / g.vram_total_gb) * 100 : null,
            },
          ].slice(-MAX_HISTORY),
        )
        if (msg.logs?.length) setLogs((l) => [...l, ...msg.logs].slice(-5000))
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      ws?.close()
    }
  }, [])

  return { stats, history, logs, connected }
}

/**
 * Live log lines, structured events and status for one job over /ws/jobs/:id.
 * The server replays history first, so this works for finished jobs too.
 */
export function useJobStream(jobId: number | null) {
  const [job, setJob] = useState<Job | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [events, setEvents] = useState<JobEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    setJob(null)
    setLines([])
    setEvents([])
    if (jobId == null) return
    const ws = new WebSocket(wsUrl(`/ws/jobs/${jobId}`))
    wsRef.current = ws
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'log') setLines((l) => [...l, ...msg.lines].slice(-MAX_LOG_LINES))
      else if (msg.type === 'events') setEvents((ev) => [...ev, ...msg.events])
      else if (msg.type === 'status') setJob(msg.job)
    }
    return () => ws.close()
  }, [jobId])

  return { job, lines, events }
}

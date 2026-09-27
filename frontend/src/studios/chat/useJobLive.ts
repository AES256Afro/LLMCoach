import { useEffect, useState } from 'react'
import { api, isFinal, type Job, type JobEvent } from '../../api'

export interface JobLive {
  job: Job | null
  events: JobEvent[]
  progress: { current: number; total: number; message: string } | null
}

/**
 * A job's status (and optionally its events) for a card in the thread. Polls while the job runs
 * and stops once it's final, so an old conversation full of finished cards costs one request each.
 */
export function useJobLive(jobId: number | null | undefined, withEvents = true): JobLive {
  const [state, setState] = useState<JobLive>({ job: null, events: [], progress: null })

  useEffect(() => {
    if (jobId == null) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const [job, events] = await Promise.all([api.job(jobId), withEvents ? api.jobMetrics(jobId) : Promise.resolve([])])
        if (!alive) return
        const last = [...events].reverse().find((e) => e.type === 'progress')
        setState({
          job,
          events,
          progress: last ? { current: Number(last.current), total: Number(last.total), message: String(last.message ?? '') } : null,
        })
        if (!isFinal(job.status)) timer = window.setTimeout(tick, document.hidden ? 5000 : 1500)
      } catch {
        if (alive) timer = window.setTimeout(tick, 5000)
      }
    }
    tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [jobId, withEvents])

  return state
}

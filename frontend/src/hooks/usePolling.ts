import { useCallback, useEffect, useState } from 'react'

/** Fetches on mount and every `intervalMs`; `reload()` forces a refresh. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fetcher, deps)

  const reload = useCallback(async () => {
    try {
      setData(await load())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  useEffect(() => {
    reload()
    const t = window.setInterval(reload, intervalMs)
    return () => window.clearInterval(t)
  }, [reload, intervalMs])

  return { data, error, reload }
}

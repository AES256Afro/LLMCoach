import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Project } from '../api'

interface ProjectCtx {
  projects: Project[]
  current: Project | null
  select: (id: number) => void
  create: (name: string) => Promise<Project>
  reload: () => Promise<void>
}

const Ctx = createContext<ProjectCtx | null>(null)
const KEY = 'llmcoach.project'

function readStored(): number | null {
  try {
    const v = localStorage.getItem(KEY)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

/** The project every page works in. Remembered per browser. */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [currentId, setCurrentId] = useState<number | null>(readStored)

  const reload = useCallback(async () => {
    let list = await api.projects()
    if (list.length === 0) {
      await api.createProject('My first project', 'Created automatically')
      list = await api.projects()
    }
    setProjects(list)
    setCurrentId((id) => (id != null && list.some((p) => p.id === id) ? id : list[0].id))
  }, [])

  useEffect(() => {
    reload().catch(() => {})
  }, [reload])

  useEffect(() => {
    try {
      if (currentId != null) localStorage.setItem(KEY, String(currentId))
    } catch {
      /* storage unavailable */
    }
  }, [currentId])

  const create = useCallback(async (name: string) => {
    const p = await api.createProject(name)
    await reload()
    setCurrentId(p.id)
    return p
  }, [reload])

  const current = projects.find((p) => p.id === currentId) ?? null
  return (
    <Ctx.Provider value={{ projects, current, select: setCurrentId, create, reload }}>{children}</Ctx.Provider>
  )
}

export function useProject(): ProjectCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useProject outside ProjectProvider')
  return c
}

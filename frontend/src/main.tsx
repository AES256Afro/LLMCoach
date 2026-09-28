import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { Compare } from './pages/Compare'
import { Dashboard } from './pages/Dashboard'
import { Datasets } from './pages/Datasets'
import { JobDetail } from './pages/JobDetail'
import { Jobs } from './pages/Jobs'
import { KnowledgeBase } from './pages/KnowledgeBase'
import { Inbox } from './pages/Inbox'
import { Logs } from './pages/Logs'
import { Playground } from './pages/Playground'
import { Providers } from './pages/Providers'
import { Train } from './pages/Train'
import { ProjectProvider } from './hooks/project'
import { preferredStudio } from './studios/registry'

// Each studio is its own bundle, loaded only when it's opened.
const ChatStudio = lazy(() => import('./studios/chat/ChatStudio'))
const MissionStudio = lazy(() => import('./studios/mission/MissionStudio'))
const CanvasStudio = lazy(() => import('./studios/canvas/CanvasStudio'))

function StudioLoading() {
  return <div className="grid h-full place-items-center text-sm text-muted">Loading studio…</div>
}

/** "/" is the Classic dashboard for people who chose Classic; everyone else lands in their studio. */
function Home() {
  const studio = preferredStudio()
  return studio.id === 'classic' ? <Dashboard /> : <Navigate to={studio.path} replace />
}

const router = createBrowserRouter([
  { path: '/chat', element: <Suspense fallback={<StudioLoading />}><ChatStudio /></Suspense> },
  { path: '/chat/:conversationId', element: <Suspense fallback={<StudioLoading />}><ChatStudio /></Suspense> },
  { path: '/console', element: <Suspense fallback={<StudioLoading />}><MissionStudio /></Suspense> },
  { path: '/console/:view', element: <Suspense fallback={<StudioLoading />}><MissionStudio /></Suspense> },
  { path: '/canvas', element: <Suspense fallback={<StudioLoading />}><CanvasStudio /></Suspense> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/jobs', element: <Jobs /> },
      { path: '/jobs/:id', element: <JobDetail /> },
      { path: '/logs', element: <Logs /> },
      { path: '/providers', element: <Providers /> },
      { path: '/knowledge', element: <KnowledgeBase /> },
      { path: '/inbox', element: <Inbox /> },
      { path: '/datasets', element: <Datasets /> },
      { path: '/train', element: <Train /> },
      { path: '/playground', element: <Playground /> },
      { path: '/compare', element: <Compare /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <ProjectProvider>
        <RouterProvider router={router} />
      </ProjectProvider>
    </AuthGate>
  </StrictMode>,
)

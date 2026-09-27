import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { Compare } from './pages/Compare'
import { Dashboard } from './pages/Dashboard'
import { Datasets } from './pages/Datasets'
import { JobDetail } from './pages/JobDetail'
import { Jobs } from './pages/Jobs'
import { KnowledgeBase } from './pages/KnowledgeBase'
import { Logs } from './pages/Logs'
import { Playground } from './pages/Playground'
import { Providers } from './pages/Providers'
import { Train } from './pages/Train'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/jobs', element: <Jobs /> },
      { path: '/jobs/:id', element: <JobDetail /> },
      { path: '/logs', element: <Logs /> },
      { path: '/providers', element: <Providers /> },
      { path: '/knowledge', element: <KnowledgeBase /> },
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
      <RouterProvider router={router} />
    </AuthGate>
  </StrictMode>,
)

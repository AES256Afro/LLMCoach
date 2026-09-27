import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { ComingSoon } from './pages/ComingSoon'
import { Dashboard } from './pages/Dashboard'
import { JobDetail } from './pages/JobDetail'
import { Jobs } from './pages/Jobs'
import { Logs } from './pages/Logs'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/jobs', element: <Jobs /> },
      { path: '/jobs/:id', element: <JobDetail /> },
      { path: '/logs', element: <Logs /> },
      {
        path: '/knowledge',
        element: <ComingSoon title="Knowledge Base" phase={2} bullets={[
          'Drag-drop PDF / MD / TXT / HTML / DOCX', 'Chunking + embeddings into LanceDB',
          'Chunk browser', 'Test-retrieval box with scores']} />,
      },
      {
        path: '/datasets',
        element: <ComingSoon title="Datasets" phase={3} bullets={[
          'Upload JSONL / CSV instruction pairs', 'Validation errors + token-length histogram',
          'Train / val / test split', 'Generate Q&A pairs from your docs']} />,
      },
      {
        path: '/train',
        element: <ComingSoon title="Train" phase={3} bullets={[
          'LoRA / QLoRA presets (Quick / Balanced / Thorough)', 'VRAM estimate before launch',
          'Live loss, eval loss, LR (already working: see a demo job)', 'GPU selection per job']} />,
      },
      {
        path: '/playground',
        element: <ComingSoon title="Playground" phase={2} bullets={[
          'Chat with base / RAG / fine-tuned variants', 'Retrieved sources shown inline', 'Tokens/sec and latency']} />,
      },
      {
        path: '/compare',
        element: <ComingSoon title="Compare" phase={4} bullets={[
          'Same prompts across 2–4 variants', 'Scores table (EM / F1 / ROUGE / judge)', 'Diff highlighting']} />,
      },
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

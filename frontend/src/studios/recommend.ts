/**
 * "What to try next": a few concrete steps, in plain words, from where the project stands.
 * Shared by the studios. Each step names a target area rather than a URL, so a studio can send
 * people to its own page for it.
 */
import type { EvalRun, PipelineGraph } from '../api'
import { findings } from './findings'

export type Target = 'knowledge' | 'practice' | 'train' | 'results' | 'inbox' | 'loop'
export type Tone = 'sun' | 'mint' | 'sky' | 'pri'

export interface NextStep {
  id: string
  title: string
  detail: string
  target: Target
  tone: Tone
}

const GOOD_DATASET = 100

export function latestResult(g: PipelineGraph): EvalRun | null {
  const done = [...g.evals].reverse().find((e) => e.status === 'done' && e.summary && Object.keys(e.summary).length)
  return (done as unknown as EvalRun) ?? null
}

export function nextSteps(g: PipelineGraph, heldForReview = 0): NextStep[] {
  const out: NextStep[] = []
  const add = (s: NextStep) => out.push(s)
  const docs = g.documents.count
  const failedDocs = g.documents.by_status.failed ?? 0
  const questions = g.datasets.reduce((n, d) => n + d.rows, 0)
  const testable = g.datasets.some((d) => (d.splits?.test ?? 0) > 0)
  const trained = g.finetunes.filter((f) => f.status === 'ready')
  const result = latestResult(g)
  const f = result ? findings(result, g.datasets.find((d) => d.id === result.dataset_id)?.name) : null

  if (heldForReview) add({ id: 'review', title: `${heldForReview} file${heldForReview === 1 ? ' is' : 's are'} waiting for your OK`, detail: 'They may contain passwords or personal details.', target: 'inbox', tone: 'pri' })
  const heldDocs = g.documents.by_status.held ?? 0
  if (heldDocs) add({ id: 'held', title: `${heldDocs} upload${heldDocs === 1 ? ' is' : 's are'} held back`, detail: 'They look private, so nothing can quote them until you index or remove them.', target: 'knowledge', tone: 'pri' })
  if (!docs) {
    add({ id: 'docs', title: 'Add your documents', detail: 'Manuals, notes, PDFs: whatever your bot should know about.', target: 'knowledge', tone: 'sky' })
    return out
  }
  if (failedDocs) add({ id: 'failed', title: `${failedDocs} document${failedDocs === 1 ? '' : 's'} couldn't be read`, detail: 'Scanned PDFs without text are the usual reason.', target: 'knowledge', tone: 'pri' })
  if (questions < GOOD_DATASET) {
    add({ id: 'practice', title: questions ? 'Add more practice questions' : 'Write practice questions', detail: questions ? `You have ${questions}. Aim for ${GOOD_DATASET}+.` : 'Made from your documents, to teach and to test your bot.', target: 'practice', tone: 'sun' })
  }
  if (questions && !testable) add({ id: 'testable', title: 'A few more questions, then you can test', detail: 'Testing needs about ten, so some can be kept aside.', target: 'practice', tone: 'sun' })
  if (testable && !trained.length) add({ id: 'train', title: 'Teach your bot your style', detail: 'A small model practises on your questions. It takes minutes.', target: 'train', tone: 'pri' })
  const newest = trained[trained.length - 1]
  const tested = new Set((g.evals ?? []).flatMap((e) => (e.variants ?? []).filter((v) => v.kind === 'finetune').map((v) => Number(v.ref))))
  if (testable && (!result || (newest && !tested.has(newest.id)))) {
    add({ id: 'test', title: result ? 'Test your newest version' : 'Test your bot', detail: 'See how much your documents and training help, on questions it has never seen.', target: 'results', tone: 'sky' })
  }
  if (f && result) {
    const best = f.ranked[0]
    if (best?.kind === 'kb' || best?.kind === 'ft-kb') add({ id: 'keep-kb', title: 'Keep documents switched on', detail: "It's your best setup so far.", target: 'results', tone: 'mint' })
    if (best?.kind === 'base' && f.ranked.some((v) => v.kind === 'kb')) add({ id: 'coverage', title: 'Check your documents cover the questions', detail: "They didn't help yet, so the answers may be elsewhere.", target: 'knowledge', tone: 'sun' })
    if (f.small && !out.some((s) => s.id === 'practice')) add({ id: 'sample', title: 'Test on more questions', detail: `Only ${f.questions} so far, which makes small differences unreliable.`, target: 'practice', tone: 'sun' })
  }
  const learned = g.datasets.some((d) => d.source === 'chat' || d.source === 'inbox')
  if (learned && !g.loop.enabled && trained.length) add({ id: 'loop', title: 'Let it keep learning every night', detail: 'It retrains on what it learned and keeps the new version only if it does better.', target: 'loop', tone: 'mint' })
  if (!g.sources.length && docs >= 3) add({ id: 'folder', title: 'Drop files in a folder instead', detail: 'Anything copied into a watched folder is picked up by itself.', target: 'inbox', tone: 'sky' })
  return out.slice(0, 4)
}

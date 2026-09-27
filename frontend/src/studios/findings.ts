/**
 * Plain-language findings from an evaluation: the headline a report leads with, a lede that says
 * what was measured, and notes on how far to trust it. Shared by the studios that write results up
 * in words (Field Notebook, Friendly Studio).
 */
import type { EvalRun, VariantScore } from '../api'

export type VariantKind = 'base' | 'kb' | 'ft' | 'ft-kb'

export interface Scored {
  label: string
  kind: VariantKind
  ref: string
  score: VariantScore
}

export interface Findings {
  headline: string
  lede: string
  notes: string[]
  ranked: Scored[] // best first, by F1
  questions: number
  small: boolean
}

export const KIND_WORDS: Record<VariantKind, string> = {
  base: 'the model on its own', kb: 'the model with your documents', ft: 'your fine-tune', 'ft-kb': 'your fine-tune with your documents',
}

export function ranked(run: EvalRun): Scored[] {
  const out: Scored[] = []
  for (const v of run.variants ?? []) {
    const score = run.summary?.[v.label]
    if (!score) continue
    const kind: VariantKind = v.kind === 'finetune' ? (v.rag ? 'ft-kb' : 'ft') : v.rag ? 'kb' : 'base'
    out.push({ label: v.label, kind, ref: v.ref, score })
  }
  return out.sort((a, b) => (b.score.f1 ?? 0) - (a.score.f1 ?? 0))
}

const pct = (a: number, b: number) => Math.round(((a - b) / Math.max(b, 0.01)) * 100)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export function findings(run: EvalRun, datasetName?: string | null): Findings {
  const vs = ranked(run)
  const questions = Math.max(0, ...vs.map((v) => v.score.n))
  const small = questions > 0 && questions < 10
  const from = datasetName ? ` from “${datasetName}”` : ''
  const judge = run.judge_model ? ` ${run.judge_model.split('/').slice(1).join('/') || run.judge_model} graded every answer from 1 to 5.` : ''
  const lede = vs.length > 1
    ? `Each version answered the same ${questions} held-out test question${questions === 1 ? '' : 's'}${from}.${judge}`
    : `It answered ${questions} held-out test question${questions === 1 ? '' : 's'}${from}.${judge}`
  const notes: string[] = []

  if (!vs.length) return { headline: 'This evaluation has no scores yet.', lede: '', notes, ranked: vs, questions, small }

  const best = vs[0], worst = vs[vs.length - 1]
  const base = vs.find((v) => v.kind === 'base')
  const kb = vs.find((v) => v.kind === 'kb')
  const ft = vs.find((v) => v.kind === 'ft' || v.kind === 'ft-kb')
  let headline: string
  if (vs.length === 1) {
    headline = `${best.label} scored F1 ${best.score.f1.toFixed(2)}.`
  } else if (best.score.f1 - worst.score.f1 < 0.02) {
    headline = `All ${vs.length} versions scored about the same.`
    notes.push('A tie usually means the questions are easy for every version, or too few to tell them apart.')
  } else if (best.kind === 'kb' && ft) {
    headline = 'Your knowledge base helped more than fine-tuning did.'
  } else if (best.kind === 'kb' && base) {
    headline = `Your documents made answers ${pct(best.score.f1, base.score.f1)}% more accurate.`
  } else if ((best.kind === 'ft' || best.kind === 'ft-kb') && base) {
    headline = best.kind === 'ft-kb' ? 'Your fine-tune did best with your documents behind it.' : 'Your fine-tune beat the base model.'
  } else if (best.kind === 'base' && (kb || ft)) {
    headline = `The model did best on its own: ${kb ? 'your documents' : 'your fine-tune'} didn't help yet.`
  } else {
    headline = `${best.label} did best.`
  }

  if (small) notes.push(`Before you trust small gaps: ${questions} test question${questions === 1 ? ' is' : 's is'} a small sample.`)
  for (const v of vs) if (v.score.errors) notes.push(`${v.label} failed to answer ${v.score.errors} question${v.score.errors === 1 ? '' : 's'}.`)
  const fastest = [...vs].sort((a, b) => a.score.latency_ms - b.score.latency_ms)[0]
  const slowest = [...vs].sort((a, b) => b.score.latency_ms - a.score.latency_ms)[0]
  if (vs.length > 1 && slowest.score.latency_ms > fastest.score.latency_ms * 2 && fastest.score.latency_ms > 0) {
    notes.push(`${fastest.label} answered in ${secs(fastest.score.latency_ms)}, ${(slowest.score.latency_ms / fastest.score.latency_ms).toFixed(1)}× faster than ${slowest.label}.`)
  }
  return { headline, lede, notes, ranked: vs, questions, small }
}

/** The report as Markdown, for copying into an email or a wiki. */
export function reportMarkdown(run: EvalRun, f: Findings, datasetName?: string | null): string {
  const lines = [`# ${f.headline}`, '', f.lede, '', '| Version | F1 | ROUGE-L | Judge | Latency |', '|---|---|---|---|---|']
  for (const v of f.ranked) {
    lines.push(`| ${v.label} | ${v.score.f1.toFixed(3)} | ${v.score.rouge_l.toFixed(3)} | ${v.score.judge != null ? v.score.judge.toFixed(1) : '—'} | ${secs(v.score.latency_ms)} |`)
  }
  if (f.notes.length) lines.push('', ...f.notes.map((n) => `- ${n}`))
  const examples = (run.results ?? []).slice(0, 3)
  if (examples.length) {
    lines.push('', '## Examples')
    for (const r of examples) {
      lines.push('', `**Q:** ${r.question}`, '', `*Reference:* ${r.reference}`)
      for (const v of f.ranked) {
        const o = r.outputs[v.label]
        if (o) lines.push('', `*${v.label}* (F1 ${o.f1.toFixed(2)}): ${o.answer.replace(/\n+/g, ' ')}`)
      }
    }
  }
  lines.push('', `---`, `Evaluation #${run.id}${datasetName ? ` on “${datasetName}”` : ''}, written by LLMCoach. F1 is word overlap with the reference answer, from 0 to 1.`)
  return lines.join('\n')
}

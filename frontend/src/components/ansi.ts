/** Minimal ANSI SGR -> styled spans. Covers the colours training libs actually emit. */

const COLORS: Record<number, string> = {
  30: '#6b7280', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24',
  34: '#60a5fa', 35: '#c084fc', 36: '#22d3ee', 37: '#e5e7eb',
  90: '#9ca3af', 91: '#fca5a5', 92: '#86efac', 93: '#fde68a',
  94: '#93c5fd', 95: '#d8b4fe', 96: '#67e8f9', 97: '#ffffff',
}

export interface AnsiSpan {
  text: string
  color?: string
  bold?: boolean
}

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([\d;]*)m/g

export function parseAnsi(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let color: string | undefined
  let bold = false
  let last = 0
  for (const m of line.matchAll(SGR)) {
    if (m.index! > last) spans.push({ text: line.slice(last, m.index), color, bold })
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) [color, bold] = [undefined, false]
      else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 39) color = undefined
      else if (COLORS[code]) color = COLORS[code]
    }
    last = m.index! + m[0].length
  }
  if (last < line.length) spans.push({ text: line.slice(last), color, bold })
  return spans
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;]*m/g, '')

/** Heuristic colouring for plain lines (Python tracebacks, warnings). */
export function levelColor(line: string): string | undefined {
  if (/\b(error|exception|traceback|fail(ed)?)\b/i.test(line)) return '#f87171'
  if (/\bwarn(ing)?\b/i.test(line)) return '#fbbf24'
  return undefined
}

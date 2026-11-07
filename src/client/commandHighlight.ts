import { commandTool } from '../shared/commands'
import { BoundedCache } from './boundedCache'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'

type ShellGrammar = 'bash' | 'powershell'

const GRAMMARS: Partial<Record<string, ShellGrammar>> = { bash: 'bash', pwsh: 'powershell' }

export function grammarOfTool(tool: string): ShellGrammar | undefined {
  const kind = commandTool(tool)
  return kind === null ? undefined : GRAMMARS[kind]
}

const MAX_LINE_CHARS = 1000
const LONG_LINE = new RegExp(`^.{${MAX_LINE_CHARS + 1},}`, 'm')

const RUNS_MAX = 600

const runs = new BoundedCache<string, readonly HighlightSpan[][]>({ maxEntries: RUNS_MAX })

export function highlightRuns(highlight: CodeHighlighter, grammar: ShellGrammar, text: string): readonly HighlightSpan[][] | undefined {
  if (LONG_LINE.test(text)) return undefined
  const key = grammar + '\u0000' + text
  const hit = runs.get(key)
  if (hit !== undefined) return hit
  const value = highlight(text)
  if (value !== undefined) runs.set(key, value)
  return value
}

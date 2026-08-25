/**
 * Tool-call argument summaries — shared between the Context browser (row
 * previews) and the step brief (input chips / reply enrichment). A call's
 * preview is its bash-style `description`, or the target path
 * (`file_path`/`path`/`filePath`) for edit/read/write tools.
 */

import type { ConversationNodeLike } from './services'

export function parseCallArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function summaryInArgs(args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  for (const k of ['description', 'file_path', 'path', 'filePath']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

export function callSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  return summaryInArgs(parseCallArgs(conv?.call?.argsRaw))
}

export function blockSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  if (conv === undefined || !Array.isArray(conv.blocks)) return null
  for (const b of conv.blocks) {
    const blk = b !== null && typeof b === 'object' ? b as { kind?: string; argsRaw?: unknown } : null
    if (blk === null || blk.kind !== 'tool-call') continue
    const s = summaryInArgs(parseCallArgs(blk.argsRaw))
    if (s !== null) return s
  }
  return null
}

/**
 * All tool-call names in an assistant conversation node, in order. The fold's surface node keeps `calls` only for TEXT-LESS replies,
 * so a reply carrying both text and calls recovers its call breadcrumb here through the conversation join.
 */
export function callNamesOf(conv: ConversationNodeLike | undefined): string[] {
  if (conv === undefined || !Array.isArray(conv.blocks)) return []
  const names: string[] = []
  for (const b of conv.blocks) {
    const blk = b !== null && typeof b === 'object' ? b as { kind?: string; name?: unknown } : null
    if (blk !== null && blk.kind === 'tool-call' && typeof blk.name === 'string') names.push(blk.name)
  }
  return names
}

/**
 * Token pricing — the same fixed-density heuristic as the harness's own
 * token-meter (`dsh-token-meter/estimate.ts`): ~4 chars ≈ 1 token, +4 per
 * content block, +4 role framing. Pure functions over message payloads.
 */

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Whole-array tool-schema price (the header's tools total). */
export function estimateToolsTotal(tools: unknown[]): number {
  return tools.length > 0
    ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    : 0
}

export interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
}

function estimateBlocks(blocks: ContentBlock[] | undefined): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * Price one surface message exactly like dsh's token-meter estimate:
 * an empty-content assistant/message projects to NO message (it only hosts
 * usage), so it prices 0; every other message pays content + role framing.
 */
export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero && (message === null || message === undefined
    || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

export function estimateSystem(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Per-tool price for the top-tools display (the total uses dsh's whole-array price). */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// ---- content extraction (display previews for surface nodes) ----------------

export function firstText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

export function toolCallNames(blocks: ContentBlock[] | undefined): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const b of blocks) {
    if (b && b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  sections?: { name?: string }[]
}

export function isInjection(source: MessageSource | undefined): source is MessageSource {
  // plugin context (AGENTS.md, snapshots, notices, …) and user-explicit skill
  // invocations both ride user-role messages with a declared form.
  return source !== null && typeof source === 'object'
    && (source.kind === 'plugin' || source.kind === 'skill-invocation' || typeof source.form === 'string')
}

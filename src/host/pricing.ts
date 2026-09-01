/**
 * Token pricing — the same fixed-density heuristic as the harness's own
 * token-meter (`dsh-token-meter/estimate.ts`): ~4 chars ≈ 1 token, +4 per
 * content block, +4 role framing. Pure functions over message payloads.
 *
 * One deliberate refinement over the meter: `image` blocks. The meter prices
 * them through its generic JSON branch (~40 tokens for the durable ref),
 * while DeepSeek's vision model actually bills 117-384 tokens per image by
 * pixel dimensions (https://api-docs.deepseek.com/zh-cn/guides/vision/).
 * Image blocks therefore price through the official docs calculator port
 * (shared/imageTokens.ts), falling back to the meter's JSON price when the
 * attachment's dimensions are unknown.
 */

import { estimateImageTokens } from '../shared/imageTokens'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

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
  /** dsh 0.1.1 multimodal image block payload (durable attachment ref; the
   * log is untrusted input, so the fold re-proves its shape — null included). */
  attachment?: { width?: unknown; height?: unknown } | null
}

/** The `ContentBlock` walkers take `unknown`: block arrays ride the untrusted
 * log, so their element shapes (null and primitives included) are re-proved
 * here, not trusted from the declared message types. */

function estimateBlocks(blocks: unknown): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    // A null or primitive element prices as bare overhead instead of
    // throwing the whole fold.
    if (item === null || typeof item !== 'object') {
      tokens += BLOCK_OVERHEAD
      continue
    }
    const block = item as ContentBlock
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil((block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD
        break
      case 'image': {
        const ref = block.attachment
        const priced = ref !== null && typeof ref === 'object'
          && typeof ref.width === 'number' && typeof ref.height === 'number'
          ? estimateImageTokens(ref.width, ref.height)
          : null
        tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD
        break
      }
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

/** The shared meter heuristic over rendered system-prompt text (shared/estimate.ts). */
/** Per-tool price for the top-tools display (the total uses dsh's whole-array price). */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
  * Count image blocks in a message payload, recursing into nested content (tool-result blocks carry their inner blocks) — seeds each node's
  * `imgs`, which the stats board's image cell sums over the LIVE surface (compacted/pruned messages stop counting).
 */
export function imageCountOf(blocks: unknown): number {
  let count = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'image') count++
    else if (Array.isArray(block.content)) count += imageCountOf(block.content)
  }
  return count
}

export function firstText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

export function toolCallNames(blocks: unknown): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  // Entries stay nullable: any plugin may author a snapshot source, so the
  // fold's preview read must not trust the element shape.
  sections?: ({ name?: string } | null)[]
  // agent-instructions reconciliation entries (same nullable-entry caution).
  changes?: ({ path?: string } | null)[]
}

/**
 * Producer label for an injection event, mirroring the dsh transcript's
 * context provenance (client-runtime context-provenance.ts): workspace
 * instructions name the files they were reconciled from, a plugin source its
 * plugin id, and any other producer its own durable kind. Returns '' when
 * the source carries no readable identity at all.
 */
export function injectionSourceName(source: MessageSource): string {
  if (source.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  if (typeof source.plugin === 'string' && source.plugin !== '') return source.plugin
  return typeof source.kind === 'string' && source.kind !== '' ? source.kind : ''
}

export function isInjection(source: MessageSource | null | undefined): source is MessageSource {
  // Mirrors the dsh transcript's classification (ui-conversation
  // conversation-nodes/message.ts): a user/message is injected context when
  // its durable source kind is anything but 'user' — plugin context, skill
  // invocations/catalogs, goal continuation rounds, team relays, and any
  // future producer kind all land here ('user-rpc' keeps kind 'user', so
  // transport annotations never flip the class). The form check stays as a
  // fallback for a foreign source that declares a form without a readable
  // kind. `null` stays in the parameter type: a foreign message may carry
  // it, and the fold must not crash on it.
  return source !== null && source !== undefined
    && ((typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'user')
      || typeof source.form === 'string')
}

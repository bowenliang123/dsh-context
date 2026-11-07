import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, ROLE_OVERHEAD, estimateTextTokens } from '../shared/estimate'
import { estimateImageTokens } from '../shared/imageTokens'

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
  attachment?: { width?: unknown; height?: unknown } | null
}

const textBlockPrice = (block: ContentBlock): number => estimateTextTokens(block.text || '')

const callBlockPrice = (block: ContentBlock): number =>
  Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
  + Math.ceil((block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD

function sumBlocks(blocks: unknown, type: string, price: (block: ContentBlock) => number): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return tokens
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === type) tokens += price(block)
  }
  return tokens
}

function estimateBlocks(blocks: unknown): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') {
      tokens += BLOCK_OVERHEAD
      continue
    }
    const block = item as ContentBlock
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += textBlockPrice(block)
        break
      case 'tool-call':
        tokens += callBlockPrice(block)
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

export function estimateReasoningTokens(blocks: unknown): number {
  return sumBlocks(blocks, 'reasoning', textBlockPrice)
}

export function estimateCallTokens(blocks: unknown): number {
  return sumBlocks(blocks, 'tool-call', callBlockPrice)
}

export function estimateAnswerTokens(blocks: unknown): number {
  return sumBlocks(blocks, 'text', textBlockPrice)
}

export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero && (message === null || message === undefined
    || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

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
  sections?: ({ name?: string } | null)[]
  changes?: ({ path?: string } | null)[]
}

export function injectionSourceName(source: MessageSource | null | undefined): string {
  if (source?.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  const plugin = source?.plugin
  if (typeof plugin === 'string' && plugin !== '') return plugin
  const kind = source?.kind
  return typeof kind === 'string' && kind !== '' ? kind : ''
}

export function isInjection(source: MessageSource | null | undefined): source is MessageSource {
  return source !== null && source !== undefined
    && ((typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'user')
      || typeof source.form === 'string')
}

export const CHARS_PER_TOKEN = 4
export const ROLE_OVERHEAD = 4
export const BLOCK_OVERHEAD = 4

export function estimateSystemTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

export function estimateSystemContent(blocks: unknown): number {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0
  let characters = 0
  for (const block of blocks) {
    const text = block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? (block as { text?: unknown }).text
      : undefined
    if (typeof text === 'string') {
      characters += text.length
      continue
    }
    try {
      const json: unknown = JSON.stringify(block)
      if (typeof json === 'string') characters += json.length
    } catch {
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

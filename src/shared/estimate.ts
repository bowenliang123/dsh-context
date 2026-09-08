/**
 * Token heuristics shared by the host fold and the client boundary — the
 * harness token-meter's own fixed-density figure (dsh-token-meter/estimate.ts:
 * ~4 chars ≈ 1 token, +4 role framing). Priced identically on both sides so a
 * legacy value normalized at the client boundary matches what the host view
 * would have served.
 */

const CHARS_PER_TOKEN = 4
const ROLE_OVERHEAD = 4

/** Price rendered system-prompt text; 0 for absent/empty/non-string input. */
export function estimateSystemTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * Price a `system/message` payload's content exactly like the harness's
 * token-meter (`estimateSystemMessage`): text density over EVERY text block
 * plus role framing, with no per-block overhead — an adapter serializes the
 * prompt as plain text, so a text block costs its characters alone. Any other
 * block (or a hostile element) falls back to its JSON length. 0 for empty
 * content, which the harness reads as "no system prompt".
 */
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
      // A cyclic/hostile block contributes no characters instead of throwing the fold.
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

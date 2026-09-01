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

/** A first-party listing: the vendor's own catalog entry for a model. */
export interface OfficialFace {
  pid: string
  mid: string
}

interface OfficialAlias {
  /** Model ids this row claims, tested against the bare (lowercased) id. */
  pattern: RegExp
  face: OfficialFace
}

/**
 * Billed ids that mirrors rename. Each row only decides *whose* listing prices
 * the call; the rate itself stays in the book, so it follows the vendor's page.
 */
const ALIASES: readonly OfficialAlias[] = [
  { pattern: /^glm-?5[.-]?3[.-]?flash(?:[.-](?:\d{2,}|new|latest))*$/, face: { pid: 'zai', mid: 'glm-5.3-flash' } },
  { pattern: /^glm-?5[.-]?3(?:[.-](?:\d{2,}|new|latest))*$/, face: { pid: 'zai', mid: 'glm-5.3' } },
  { pattern: /^deepseek-(?:v?\d+(?:[.-]\d+)*-)?flash(?:[.-](?:\d{2,}|new|latest))*$/, face: { pid: 'deepseek', mid: 'deepseek-flash' } },
  { pattern: /^claude-sonnet-5[.-]5$/, face: { pid: 'anthropic', mid: 'claude-sonnet-5-5' } },
]

/** The id with any `vendor/` prefix and `@variant` suffix stripped. */
function bareIdOf(model: string): string {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const bare = slash >= 0 ? lower.slice(slash + 1) : lower
  const at = bare.indexOf('@')
  return at >= 0 ? bare.slice(0, at) : bare
}

/** The first-party face a billed id aliases, or null when no mirror renamed it. */
export function officialFaceOf(model: string): OfficialFace | null {
  const bare = bareIdOf(model)
  for (const alias of ALIASES) {
    if (alias.pattern.test(bare)) return alias.face
  }
  return null
}

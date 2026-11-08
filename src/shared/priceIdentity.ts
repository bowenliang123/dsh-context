const GATEWAY_PREFIXES = [
  'accounts/fireworks/models/',
  'accounts/fireworks/routers/',
  'workers-ai/',
  '@cf/',
  'hf:',
] as const

const RESOURCE_PREFIXES = ['global.', 'us.', 'eu.', 'apac.'] as const

const RESOURCE_SUFFIXES = [
  /@default$/i,
  /@\d{8}$/,
  /-v\d+(?::\d+)?$/i,
  /:\d+$/,
  /-\d{8}$/,
  /-\d{6}$/,
] as const

const FAMILY_VENDORS: ReadonlyArray<readonly [prefix: string, vendor: string]> = [
  ['codestral-', 'mistral'],
  ['pixtral-', 'mistral'],
  ['nemotron-', 'nvidia'],
  ['deepseek-', 'deepseek'],
  ['minimax-', 'minimax'],
  ['mimo-', 'xiaomi'],
  ['command-', 'cohere'],
  ['gemini-', 'google'],
  ['gemma-', 'google'],
  ['claude-', 'anthropic'],
  ['llama-', 'meta'],
  ['mistral-', 'mistral'],
  ['grok-', 'xai'],
  ['kimi-', 'moonshotai'],
  ['glm-', 'zhipuai'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
  ['qwen', 'alibaba'],
]

export function lowerModelId(id: string): string {
  return id.trim().toLowerCase()
}

export function bareModelOf(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

export function orgOf(id: string): string | undefined {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined
}

export function labOf(canonical: string): string | undefined {
  const slash = canonical.indexOf('/')
  return slash > 0 ? canonical.slice(0, slash).toLowerCase() : undefined
}

function stripPrefixes(input: string, prefixes: readonly string[]): string {
  let out = input
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of prefixes) {
      if (!out.startsWith(prefix)) continue
      out = out.slice(prefix.length)
      changed = true
      break
    }
  }
  return out
}

export function normalizeModelId(id: string): string {
  let out = stripPrefixes(lowerModelId(id), GATEWAY_PREFIXES)
  out = stripPrefixes(out, RESOURCE_PREFIXES)
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of RESOURCE_SUFFIXES) {
      if (!suffix.test(out)) continue
      out = out.replace(suffix, '')
      changed = true
      break
    }
    if (!changed && out.endsWith('-latest')) {
      out = out.slice(0, -'-latest'.length)
      changed = true
    }
  }
  out = out.replace(/v(\d+)p(\d+)/g, 'v$1-$2')
  out = out.replace(/[._]/g, '-')
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '')
  return out
}

export function suffixKeys(key: string): string[] {
  const parts = key.split(/[/-]+/).filter(part => part.length > 0)
  const tails: string[] = []
  for (let index = 1; index < parts.length; index++) tails.push(parts.slice(index).join('-'))
  return tails
}

export function isSubscriptionPlanProvider(pid: string): boolean {
  return /(?:^|-)(?:coding|code|token)-plan(?:-|$)/.test(pid.toLowerCase())
}

export function familyVendorOf(model: string): string | undefined {
  const bare = normalizeModelId(bareModelOf(model))
  return FAMILY_VENDORS.find(([prefix]) => bare.startsWith(prefix))?.[1]
}

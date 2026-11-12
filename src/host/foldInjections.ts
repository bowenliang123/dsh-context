import { TALLY_NAME_CHARS_MAX, type AgentAlias, type TimelineState } from './foldState'
import type { ContentBlock, MessageSource } from './pricing'

export interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  isError?: unknown
}

export function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

function firstFullText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

export function skillNameOf(msg: unknown): string {
  const content = msg !== null && typeof msg === 'object' ? (msg as MessageLike).content : undefined
  const text = firstFullText(content)
  const match = text.match(/<skill_content\s+name="([^"]+)"/)
  return match === null ? '' : match[1]
}

const AGENT_ALIASES_MAX = 512
const AGENT_SOURCE_KINDS: ReadonlySet<string> = new Set(['agent-message', 'subagent-settled', 'team-message', 'session-reference'])
const RELAY_AGENT = /^Agent (\S+) sent a message:/
const SETTLED_AGENT = /^Background subagent (\S+)/

function agentNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > TALLY_NAME_CHARS_MAX ? trimmed.slice(0, TALLY_NAME_CHARS_MAX - 1) + '…' : trimmed
}

function textAgentOf(kind: string, content: unknown, summary: string | undefined): string | undefined {
  if (kind === 'subagent-settled') {
    const text = firstFullText(content)
    const match = SETTLED_AGENT.exec(text) ?? (summary === undefined ? null : SETTLED_AGENT.exec(summary))
    return match?.[1]
  }
  return kind === 'agent-message' ? RELAY_AGENT.exec(firstFullText(content))?.[1] : undefined
}

function referenceAgentOf(source: MessageSource): string | undefined {
  const references = Array.isArray(source.references) ? source.references : []
  const labels: string[] = []
  for (const reference of references) {
    const label = agentNameOf(reference?.label)
    if (label === undefined) continue
    if (typeof reference?.sessionId === 'string' && reference.sessionId === reference.label) continue
    labels.push(label)
  }
  if (labels.length === 0) return undefined
  return labels.length === 1 ? labels[0] : labels[0] + ' +' + String(labels.length - 1)
}

function senderIdOf(source: MessageSource): string | undefined {
  if (typeof source.senderSessionId === 'string' && source.senderSessionId !== '') return source.senderSessionId
  if (typeof source.senderId === 'string' && source.senderId !== '') return source.senderId
  return undefined
}

function agentAliasOf(state: TimelineState, id: string | undefined): AgentAlias | undefined {
  if (id === undefined) return undefined
  const agents = state.agents
  return agents !== undefined && Object.hasOwn(agents, id) ? agents[id] : undefined
}

export function agentOfInjection(source: MessageSource | null | undefined, content: unknown, state: TimelineState): string | undefined {
  if (source === undefined || source === null) return undefined
  const kind = typeof source.kind === 'string' ? source.kind : ''
  if (!AGENT_SOURCE_KINDS.has(kind)) return undefined
  if (kind === 'session-reference') return referenceAgentOf(source)
  const senderId = senderIdOf(source)
  const token = textAgentOf(kind, content, source.summary)
  if (token !== undefined && token !== senderId) return agentNameOf(token)
  const alias = agentAliasOf(state, senderId)
  const aliasName = agentNameOf(alias?.catalogName)
  if (aliasName !== undefined) return aliasName
  if (kind === 'team-message') {
    const sender = agentNameOf(source.senderName)
    if (sender !== undefined && sender !== senderId) return sender
  }
  const member = agentNameOf(alias?.memberName)
  if (member !== undefined) return member
  return agentNameOf(alias?.catalogLabel)
}

function agentAliasEvent(type: string, data: Record<string, unknown> | undefined): { id: string; alias: AgentAlias } | null {
  if (type === 'subagent/catalog') {
    const childId = data?.childId
    if (typeof childId !== 'string' || childId === '' || childId === '__proto__') return null
    const name = agentNameOf(data?.name)
    const label = agentNameOf(data?.label)
    if (name === undefined && label === undefined) return null
    return {
      id: childId,
      alias: {
        ...(name !== undefined ? { catalogName: name } : {}),
        ...(label !== undefined ? { catalogLabel: label } : {}),
      },
    }
  }
  const member = data?.member
  if (member === null || typeof member !== 'object') return null
  const record = member as { id?: unknown; name?: unknown }
  if (typeof record.id !== 'string' || record.id === '' || record.id === '__proto__') return null
  const name = agentNameOf(record.name)
  return name === undefined ? null : { id: record.id, alias: { memberName: name } }
}

function noteAgentAlias(st: TimelineState, id: string, alias: AgentAlias): boolean {
  const agents = { ...(st.agents ?? {}) }
  if (Object.hasOwn(agents, id)) {
    agents[id] = { ...agents[id], ...alias }
    st.agents = agents
    return true
  }
  if (Object.keys(agents).length >= AGENT_ALIASES_MAX) return false
  agents[id] = alias
  st.agents = agents
  return true
}

export function applyAgentAliasEvent(
  state: TimelineState,
  type: string,
  data: Record<string, unknown> | undefined,
): TimelineState | undefined {
  const fact = agentAliasEvent(type, data)
  if (fact === null) return undefined
  const st = { ...state }
  return noteAgentAlias(st, fact.id, fact.alias) ? st : undefined
}

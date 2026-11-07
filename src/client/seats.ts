export interface ConversationNodeLike {
  kind: string
  seq: number
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  subCalls?: readonly unknown[]
  meta?: unknown
}

export type UseChatLike = <T>(selector: (snapshot: unknown) => T) => T

export function seatOf<T>(value: unknown, fallback: T): T {
  return typeof value === 'function' ? value as T : fallback
}

const NO_CHAT = (() => undefined) as UseChatLike

const SEAT_PROP = /^use[A-Z]/

export function seatKeyOf(props: object): string {
  let key = ''
  for (const name of Object.keys(props)) {
    if (!SEAT_PROP.test(name)) continue
    const value: unknown = (props as Record<string, unknown>)[name]
    key += `${name}:${typeof value === 'function' ? '1' : '0'};`
  }
  return key
}

export function conversationNodesOf(props: {
  useChat?: UseChatLike
}): readonly ConversationNodeLike[] | undefined {
  const read = seatOf(props.useChat, NO_CHAT)
  try {
    const slice = read((s: unknown) =>
      s !== null && typeof s === 'object' ? (s as { legacy?: unknown }).legacy : undefined)
    const nodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes as readonly ConversationNodeLike[] : undefined
  } catch {}
  return undefined
}

export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  useChat?: UseChatLike
}

export interface ContextViewProps extends SessionStandardProps {
  host?: 'sidebar'
}

const NO_PROJECTION = ((): null => null) as (key: string) => unknown

export function projectionOf<T>(props: SessionStandardProps, key: string, narrow: (value: unknown) => T | null): T | null {
  const read = seatOf(props.useProjection, NO_PROJECTION)
  return narrow(read(key))
}

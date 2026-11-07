import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { AttachmentRef } from '../shared/attachment'
import type { HeaderEpochContent } from '../shared/types'
import { PLUGIN_NAME } from './meta'
import { asRecord } from './wire'
import type { ConversationNodeLike } from './seats'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
  subscribe?(listener: () => void): () => void
}

export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  key?: string
  locale?: string
  label?: () => string
  inject?: (sessionId?: string) => unknown
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  ): unknown
  entries?(name: string): unknown
}

export function entrySeated(ctx: ClientCtx, name: string, id: string): boolean {
  try {
    const entries = ctx.slots.entries?.(name)
    if (!Array.isArray(entries)) return false
    for (const entry of entries) {
      const options = asRecord(asRecord(entry)?.options)
      if (options !== null && options.id === id) return true
    }
    return false
  } catch {
    return false
  }
}

interface SidebarGuideEntryLike {
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: ComponentType<{ size?: number }>
}

export interface SidebarTabDefinitionLike {
  id: string
  kind: string
  title: () => string
  guide?: readonly SidebarGuideEntryLike[]
}

export interface SidebarTabsFace {
  register(definition: SidebarTabDefinitionLike): () => void
}

interface SidebarResourceOpenOptions {
  kind?: string
  preferNewPane?: boolean
}

interface SidebarResourceFace {
  openResource(address: string, options?: SidebarResourceOpenOptions): void
}

export interface ImageRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

export type ImageLoader = (attachment: ImageRefLike) => Promise<string>

interface UiConversationFace {
  imageUrl?(sessionId: string, attachment: ImageRefLike): Promise<string>
}

export function imageLoaderOf(
  ctx: ClientCtx,
  sessionId: string | undefined,
): ImageLoader | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const conversation = ctx.get('uiConversation') as UiConversationFace | undefined
    if (conversation !== undefined && typeof conversation.imageUrl === 'function') {
      const imageUrl = conversation.imageUrl.bind(conversation)
      return attachment => imageUrl(sessionId, attachment)
    }
  } catch {}
  return undefined
}

export type AttachmentLocator = (attachment: AttachmentRef) => Promise<string | null>

export type AttachmentOpener = (attachment: AttachmentRef) => Promise<boolean>

export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

interface TriggerCandidate {
  name: string
  label?: string
  section?: string
  description?: string
  icon?: ComponentType<{ size?: number }>
}

export interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

interface TriggerPick {
  candidate: TriggerCandidate
  session: { sessionId: string }
  position: string
  via: string
  span: TokenSpan
}

type SourcePickOutcome = 'handled' | undefined

export interface InputTriggersFace {
  registerSource(src: {
    trigger: '/'
    name: string
    order?: number
    candidates(
      session: { sessionId: string },
      req: { query: string; position: string; signal: AbortSignal },
    ): Promise<readonly TriggerCandidate[]>
    onPick(pick: TriggerPick): SourcePickOutcome
    matchEnter?(
      session: { sessionId: string },
      line: string,
      signal: AbortSignal,
    ): Promise<SourcePickOutcome>
  }): () => void
}

interface SessionScopeFace {
  bail(subject: unknown, event: string, payload: unknown): unknown
}

export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
  refresh?(): Promise<unknown>
  subagentAddress?(id: string): unknown
}

export interface HistoryEntryLike {
  event?: unknown
}

export type SessionAddressLike =
  | { kind: 'session'; sessionId: string }
  | {
    kind: 'subagent'
    parentSessionId: string
    childSessionId: string
    mode: 'one-shot' | 'continuable' | 'unknown'
  }

export interface SessionPageFace {
  page(request: {
    address: SessionAddressLike
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}

interface ConnectionFace {
  isLoopback?: boolean
  rpc?: {
    call?(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

const OPEN_CHANNEL = '/api'
const CAN_OPEN_ENDPOINT = 'session/canOpenWorkspacePath'
const OPEN_ENDPOINT = 'session/openWorkspacePath'

function rpcCallOf(ctx: ClientCtx): ((channel: string, endpoint: string, payload: unknown) => Promise<unknown>) | undefined {
  try {
    const rpc = asRecord((ctx.get('connection') as ConnectionFace | undefined)?.rpc)
    const fn = rpc?.call
    if (rpc !== null && typeof fn === 'function') {
      return (fn as (channel: string, endpoint: string, payload: unknown) => Promise<unknown>).bind(rpc)
    }
  } catch {}
  return undefined
}

export function workspaceOf(ctx: ClientCtx, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessions = ctx.get('sessions') as { list?: { getSnapshot(): unknown } } | undefined
    const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    const byId = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
    const row: unknown = byId !== null && typeof byId === 'object' ? (byId as Record<string, unknown>)[sessionId] : undefined
    const cwd = row !== null && typeof row === 'object' ? (row as { cwd?: unknown }).cwd : undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

export function sessionAddressOf(ctx: ClientCtx, sessionId: string): SessionAddressLike {
  const plain: SessionAddressLike = { kind: 'session', sessionId }
  if (typeof sessionId !== 'string' || sessionId === '') return plain
  try {
    const sessions = asRecord(ctx.get('sessions'))
    if (sessions === null) return plain
    const resolve = sessions.subagentAddress
    const address = asRecord(typeof resolve === 'function' ? resolve.call(sessions, sessionId) : undefined)
    const parentSessionId = address?.parentSessionId
    if (typeof parentSessionId === 'string' && parentSessionId !== '' && parentSessionId !== sessionId) {
      const mode = address?.mode
      return {
        kind: 'subagent',
        parentSessionId,
        childSessionId: sessionId,
        mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown',
      }
    }
    const list = asRecord(sessions.list)
    const getSnapshot = list?.getSnapshot
    const snapshot = typeof getSnapshot === 'function' ? asRecord((getSnapshot as () => unknown).call(list)) : null
    const row = asRecord(asRecord(snapshot?.byId)?.[sessionId])
    const parentId = row?.parentId
    if (row?.origin === 'subagent' && typeof parentId === 'string' && parentId !== '' && parentId !== sessionId) {
      return { kind: 'subagent', parentSessionId: parentId, childSessionId: sessionId, mode: 'unknown' }
    }
  } catch {}
  return plain
}

export async function canOpenPathsOf(ctx: ClientCtx): Promise<boolean> {
  const call = rpcCallOf(ctx)
  if (call === undefined) return false
  try {
    const connection = ctx.get('connection') as ConnectionFace | undefined
    if (connection?.isLoopback !== true) return false
    const result = await call(OPEN_CHANNEL, CAN_OPEN_ENDPOINT, { args: {} })
    const r = asRecord(result)
    return r !== null && r.ok === true && r.value === true
  } catch {
    return false
  }
}

export function openPathVia(ctx: ClientCtx): ((path: string) => void) | undefined {
  const call = rpcCallOf(ctx)
  if (call === undefined) return undefined
  return (path: string): void => {
    try {
      void call(OPEN_CHANNEL, OPEN_ENDPOINT, { args: { request: { path } } })
        .catch(() => {})
    } catch {}
  }
}

export function openResourceVia(ctx: ClientCtx): ((address: string, options?: SidebarResourceOpenOptions) => boolean) | undefined {
  const faceOf = (): SidebarResourceFace | undefined => {
    try {
      const face = asRecord(ctx.get('sidebarRight'))
      return face !== null && typeof face.openResource === 'function'
        ? face as unknown as SidebarResourceFace
        : undefined
    } catch {
      return undefined
    }
  }
  if (faceOf() === undefined) return undefined
  return (address: string, options?: SidebarResourceOpenOptions): boolean => {
    const face = faceOf()
    if (face === undefined) return false
    try {
      face.openResource(address, options)
      return true
    } catch {
      return false
    }
  }
}

export function openSessionVia(ctx: ClientCtx, id: string): void {
  try {
    const workspace = asRecord(ctx.get('uiWorkspace'))
    const open = workspace?.openSession
    if (typeof open === 'function') open.call(workspace, id)
  } catch {}
}

export const CONTEXT_VIEW_ID = 'context'

export function seedConversationViewVia(sessionId: string, view: string): void {
  try {
    const key = `dsh.conversation.${sessionId}`
    let stored: Record<string, unknown> = {}
    try {
      const raw = localStorage.getItem(key)
      const parsed: unknown = raw !== null ? JSON.parse(raw) : null
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
    } catch {}
    stored.view = view
    localStorage.setItem(key, JSON.stringify(stored))
  } catch {}
}

export function openPluginSettings(ctx: ClientCtx): void {
  try {
    const navigation = asRecord(ctx.get('pluginNavigation'))
    const open = navigation?.openBundle
    if (typeof open === 'function') open.call(navigation, PLUGIN_NAME)
  } catch {}
}

export function subagentChatAddressOf(address: { parentSessionId: string; childSessionId: string; mode: string }): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`
}

interface SubagentAddressLike {
  parentSessionId?: string
  childSessionId: string
  mode?: 'one-shot' | 'continuable' | 'unknown'
}

export function openChildAsideVia(ctx: ClientCtx, address: SubagentAddressLike): boolean {
  const { parentSessionId, childSessionId, mode } = address
  if (parentSessionId === undefined) return false
  const open = openResourceVia(ctx)
  return open !== undefined && open(
    subagentChatAddressOf({ parentSessionId, childSessionId, mode: mode ?? 'unknown' }),
    { kind: 'subagentchat', preferNewPane: true },
  )
}

export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>

export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>

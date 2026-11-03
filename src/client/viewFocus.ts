import { useEffect, useState } from 'react'
import { lruTrim } from './lru'
import { asRecord, type ClientCtx } from './services'
import { SIDEBAR_CONTEXT_KIND } from './sidebar'

const pendingFocus = new Map<string, number>()

const focusListeners = new Set<() => void>()

export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  for (const listener of focusListeners) listener()
}

export function subscribeContextFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

const memberFocus = new Map<string, string>()

const MEMBER_FOCUS_MAX = 8

const memberListeners = new Set<() => void>()

export function requestFleetMemberFocus(sessionId: string, memberId: string): void {
  memberFocus.set(sessionId, memberId)
  lruTrim(memberFocus, MEMBER_FOCUS_MAX)
  for (const listener of memberListeners) listener()
}

export function currentFleetMemberFocus(sessionId: string): string | null {
  return memberFocus.get(sessionId) ?? null
}

export function subscribeFleetMemberFocus(listener: () => void): () => void {
  memberListeners.add(listener)
  return () => { memberListeners.delete(listener) }
}

export function useFleetMemberFocus(sessionId: string | undefined): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    const sync = (): void => { setId(currentFleetMemberFocus(sessionId)) }
    sync()
    return subscribeFleetMemberFocus(sync)
  }, [sessionId])
  return id
}

export function openContextSidebar(ctx: ClientCtx): boolean {
  try {
    const face = asRecord(ctx.get('sidebarRight'))
    if (face === null || typeof face.openTab !== 'function') return false
    ;(face.openTab as (kind: string) => void).call(face, SIDEBAR_CONTEXT_KIND)
    return true
  } catch {
    return false
  }
}

export function activateViewTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}

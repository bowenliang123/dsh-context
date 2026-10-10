/** Chat → Context jump relay: the assistant-message action records the clicked reply's request seq and opens
 * the Context view — the right Sidebar's tab when served, else the conversation tab — which consumes the
 * one-shot focus once its projection data is in. */

import { asRecord, type ClientCtx } from './services'
import { SIDEBAR_CONTEXT_KIND } from './sidebar'

const pendingFocus = new Map<string, number>()

const focusListeners = new Set<() => void>()

export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  for (const listener of focusListeners) listener()
}

/** Wake every subscribed view on each record; a listener takes its OWN session's entry, so other sessions'
 * records stay pending for their views. */
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

/** Open the Context tab over `ctx.sidebarRight.openTab` (the column expands in the same step). OPTIONAL seam,
 * re-proved at call time: a stripped service, no registered tab type, or a hostile face all report false so
 * the caller keeps its conversation-tab fallback. */
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

/** Activate a conversation view tab by clicking its own `button[role="tab"]` chrome: the harness hands `openView`
 * only to the ACTIVE view entry, so a nested action cannot call it; a missing tab reports failure. The label is the
 * tab's rendered text, so it addresses the Context tab and the Fleet tab alike. */
export function activateViewTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}

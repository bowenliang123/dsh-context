/**
 * Chat → Context jump relay. The assistant-message action records the clicked
 * reply's request seq here and activates the Context tab; the Context view
 * consumes the one-shot focus once its projection data is in. Module-level
 * per-session map — the same life pattern as the modal open-state stores.
 */

const pendingFocus = new Map<string, number>()

/** Record the Context step (request seq) to reveal for `sessionId` — replaces any unconsumed request. */
export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
}

/** Take the pending focus request, if any — one-shot, the map entry is consumed. */
export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

/**
 * Activate the Context tab by clicking its own tab-bar button (the semantic
 * `button[role="tab"]` chrome the conversation shell renders for every view).
 * The harness hands `openView` only to the ACTIVE view entry, so a nested
 * chat action cannot call it — this rides the same button a user click would.
 * Already-active is a no-op that still reports success; no matching tab (any
 * dsh layout without the tab bar) reports failure and nothing happens.
 */
export function activateContextTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}

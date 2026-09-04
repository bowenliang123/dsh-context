/**
 * The chat page's stats line — the harness's own StatsLine entry on the
 * `conversation.composer.dock` seat — becomes a jump affordance: hovering
 * underlines it, a click (or Enter/Space) opens the Context tab. The plugin
 * wires this from a sibling dock entry that renders no UI of its own: an
 * invisible anchor mounts inside the slot's `[data-slot]` wrapper and spots
 * the stats row beside it, and a MutationObserver re-spots it on dock churn
 * (the row mounts only once the first stats exist, tooltip bubbles come and
 * go beside it, and switching conversations remounts the pair together).
 *
 * EVERY step degrades silently: a host without the dock seat never mounts
 * the entry; a dock without exactly one spotless candidate row (another
 * plugin's entry, a crash face, an unexpected layout) decorates nothing; a
 * row that throws mid-wiring stays unwired; a drag-selection click is
 * ignored. The affordance is simply absent — nothing here can take the chat
 * page down.
 */

import type * as ReactNS from 'react'
import { React, h } from '../react'
import { activateContextTab } from '../viewFocus'
import type { ViewKit } from '../viewkit'

/** The plugin's invisible dock anchor, and the class it brands the stats row with. */
const ANCHOR_CLASS = 'lc-stats-jump'
const ROW_CLASS = 'lc-stats-jump-row'

/**
 * The stats row beside `anchor`: the single element child that is neither
 * the anchor nor a tooltip bubble. Children are untrusted input — one that
 * throws on attribute access is skipped whole, and two live candidates at
 * once (another plugin's dock entry, a crash face) answer null so nothing
 * is ever decorated on a guess.
 */
export function statsRowOf(anchor: Element): Element | null {
  const parent = anchor.parentElement
  if (parent === null) return null
  let row: Element | null = null
  for (const child of parent.children) {
    try {
      if (child === anchor || child.getAttribute('role') === 'tooltip') continue
    } catch { continue }
    if (row !== null) return null
    row = child
  }
  return row
}

/** The listeners and strip for one wired row. */
interface Wired {
  row: Element
  off(): void
}

/**
 * Wire the dock beside `anchor`: decorate today's stats row and re-spot it
 * on dock churn. Returns the teardown that disconnects the observer and
 * strips every mark the wiring left on the row.
 */
export function wireDock(anchor: Element | null, label: string, activate: () => void): () => void {
  if (anchor === null) return () => {}
  let wired: Wired | null = null

  const unwire = (): void => {
    wired?.off()
    wired = null
  }
  const scan = (): void => {
    try {
      const row = statsRowOf(anchor)
      if (wired?.row === row) return
      unwire()
      // The typed key listener below needs a real HTML element; an exotic
      // candidate (SVG, foreign markup) is not the stats row — feature off.
      if (row === null || !(row instanceof HTMLElement)) return
      row.classList.add(ROW_CLASS)
      row.setAttribute('role', 'button')
      row.setAttribute('tabindex', '0')
      row.setAttribute('aria-label', label)
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        activate()
      }
      const onClick = (): void => {
        // A drag that started on the numbers must not switch tabs on release.
        const selection = anchor.ownerDocument.getSelection()
        if (selection !== null && !selection.isCollapsed) return
        activate()
      }
      row.addEventListener('click', onClick)
      row.addEventListener('keydown', onKey)
      wired = {
        row,
        off(): void {
          row.removeEventListener('click', onClick)
          row.removeEventListener('keydown', onKey)
          row.classList.remove(ROW_CLASS)
          row.removeAttribute('role')
          row.removeAttribute('tabindex')
          row.removeAttribute('aria-label')
        },
      }
    } catch { /* a hostile dock or row throws mid-wiring: stay unwired */ }
  }

  scan()
  const parent = anchor.parentElement
  if (parent === null) return unwire
  const observer = new MutationObserver(scan)
  observer.observe(parent, { childList: true })
  return () => {
    observer.disconnect()
    unwire()
  }
}

/** The dock entry component: the invisible anchor plus the wiring around it. */
export function makeStatsJump(kit: ViewKit): () => ReactNS.ReactElement {
  const { t } = kit
  return function StatsJump(): ReactNS.ReactElement {
    const anchorRef = React.useRef<Element | null>(null)
    const label = t('jump.statsLine')
    React.useEffect(() => wireDock(anchorRef.current, label, () => { activateContextTab(t('tab')) }), [label])
    return h('span', { ref: anchorRef, className: ANCHOR_CLASS, hidden: true, 'aria-hidden': 'true' })
  }
}

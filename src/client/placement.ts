/**
 * Placement gating for the Context view: the per-user `defaultPlacement`
 * preference (the settings namespace's `defaultPlacement` field) picks which
 * registrations carry it — the conversation tab, the right Sidebar panel, or
 * both.
 *
 * Each mount is a factory returning its own disposer, so a preference flip
 * takes down only what the new value drops and mounts only what it adds; the
 * underlying `slots.inject` / deferred-inject disposers are the harness's own
 * dynamic-mount idiom. A mount landing no disposer (a harness face that
 * returns nothing) simply has nothing to unwind.
 *
 * @module dsh-context/client/placement
 */

import type { ContextSettings } from './settings'
import type { DefaultPlacement } from '../shared/types'

/** One registration factory per placement; each returns its mount's disposer. */
export interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

/**
 * Mount per the current preference and keep the registrations glued to it
 * until the returned disposer runs.
 */
export function watchPlacement(settings: ContextSettings, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  const own = (result: unknown): (() => void) | undefined =>
    typeof result === 'function' ? result as () => void : undefined
  const mount = (placement: DefaultPlacement): void => {
    const wantTab = placement !== 'sidebar'
    const wantSidebar = placement !== 'tab'
    if (wantTab && tab === undefined) tab = own(mounts.tab())
    if (!wantTab && tab !== undefined) { tab(); tab = undefined }
    if (wantSidebar && sidebar === undefined) sidebar = own(mounts.sidebar())
    if (!wantSidebar && sidebar !== undefined) { sidebar(); sidebar = undefined }
  }
  mount(settings.defaultPlacement())
  const unsubscribe = settings.store.subscribe(() => { mount(settings.defaultPlacement()) })
  return () => {
    unsubscribe()
    tab?.()
    sidebar?.()
    tab = undefined
    sidebar = undefined
  }
}

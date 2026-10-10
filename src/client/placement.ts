/** Placement gating for this plugin's conversation views: the per-user `defaultPlacement` preference picks
 *  which registrations carry them — the Context and Fleet tabs, the right Sidebar panel, or both. */

import type { ContextSettings } from './settings'
import type { DefaultPlacement } from '../shared/types'

export interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

/** Whether the preference serves this plugin's conversation-view tabs at all ('sidebar' serves none) — the
 *  rule the Fleet tab's own switch layers on top of (fleetTab.ts). */
export function wantsConversationTabs(settings: ContextSettings): boolean {
  return settings.defaultPlacement() !== 'sidebar'
}

export function watchPlacement(settings: ContextSettings, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  const own = (result: unknown): (() => void) | undefined =>
    typeof result === 'function' ? result as () => void : undefined
  const mount = (placement: DefaultPlacement): void => {
    const wantTab = wantsConversationTabs(settings)
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

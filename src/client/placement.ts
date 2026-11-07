import type { ContextSettings } from './settings'
import type { DefaultPlacement } from '../shared/types'

interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

export function placementSurfaces(placement: DefaultPlacement): { tab: boolean; sidebar: boolean } {
  return {
    tab: placement === 'all' || placement === 'tab',
    sidebar: placement === 'all' || placement === 'sidebar',
  }
}

export function watchPlacement(settings: ContextSettings, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  let tabMounted = false
  let sidebarMounted = false
  const mount = (placement: DefaultPlacement): void => {
    const { tab: wantTab, sidebar: wantSidebar } = placementSurfaces(placement)
    if (wantTab && !tabMounted) {
      const result: unknown = mounts.tab()
      tab = typeof result === 'function' ? result as () => void : undefined
      tabMounted = true
    }
    if (!wantTab && tabMounted) {
      tab?.()
      tab = undefined
      tabMounted = false
    }
    if (wantSidebar && !sidebarMounted) {
      const result: unknown = mounts.sidebar()
      sidebar = typeof result === 'function' ? result as () => void : undefined
      sidebarMounted = true
    }
    if (!wantSidebar && sidebarMounted) {
      sidebar?.()
      sidebar = undefined
      sidebarMounted = false
    }
  }
  mount(settings.defaultPlacement())
  const unsubscribe = settings.store.subscribe(() => { mount(settings.defaultPlacement()) })
  return () => {
    unsubscribe()
    tab?.()
    sidebar?.()
    tab = undefined
    sidebar = undefined
    tabMounted = false
    sidebarMounted = false
  }
}

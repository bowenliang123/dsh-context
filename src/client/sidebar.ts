/**
 * The right Sidebar's Context tab. It reuses the Context conversation-view component verbatim:
 * `sidebar.right.pane.tab` is a session-scoped seat delivering the same framework standard kit as
 * `conversation.view`, so panel and tab are one component with one data path.
 *
 * OPTIONAL BY CONTRACT: `ctx.sidebarRightTabs` may be stripped, so the registration rides a deferred
 * inject (the plugin's hard injects stay `slots` + `locale`) and the plugin fiber never pends. A hostile
 * registry is guarded: a throwing `register` or a taken id/kind costs only the sidebar tab.
 */

import { ContextIcon, makeContextTabTitle } from './icon'
import type { ClientCtx, ContextViewProps, SidebarTabsFace } from './services'
import type { Translate } from './i18n'

/** The tab type's identity in the sidebar's tab system (also its body-seat key). */
export const SIDEBAR_CONTEXT_ID = 'dsh-context'

/** Namespaced rather than the bare `context`: the registry throws when a kind collides with another
 * registration in a non-coexisting band, and a foreign plugin may well own `context`. */
export const SIDEBAR_CONTEXT_KIND = 'dsh-context'

/** The guide capsule's position: after the shipped Files entry (order 10). */
const GUIDE_ORDER = 20

/** @returns the deferred inject's disposer; a no-op on faces that return no handle. */
export function watchSidebarContextTab(
  ctx: ClientCtx,
  view: (props: ContextViewProps) => unknown,
  t: Translate,
  ns: string,
): () => void {
  const fiber = ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as unknown as ClientCtx & { sidebarRightTabs?: SidebarTabsFace }
    const disposers: (() => void)[] = []
    const own = (result: unknown): void => {
      if (typeof result === 'function') disposers.push(result as () => void)
    }
    try {
      const tabs = injected.sidebarRightTabs
      if (tabs === undefined || typeof tabs.register !== 'function') return
      own(tabs.register({
        id: SIDEBAR_CONTEXT_ID,
        kind: SIDEBAR_CONTEXT_KIND,
        title: () => t('tab.context'),
        guide: [{
          order: GUIDE_ORDER,
          title: () => t('tab.context'),
          description: () => t('sidebar.guideDescription'),
          icon: ContextIcon,
        }],
      }))
      own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab', key: SIDEBAR_CONTEXT_ID, locale: ns },
        (props: { sessionId?: string } & Record<string, unknown>) => view({ ...props, host: 'sidebar' }),
      )))
      // Under the type id, so the kit dispatches it for this type's tabs only.
      own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_CONTEXT_ID },
        makeContextTabTitle(t),
      )))
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    // The inject callback's own disposer owns every registration; cordis unloads them with the injected fiber.
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
  // Re-proved at runtime: a harness face may return no handle at all.
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}

/**
 * The right Sidebar's Context tab (dsh 0.1.5-rc.1+).
 *
 * The tab reuses the Context conversation-view component VERBATIM: the
 * `sidebar.right.pane.tab` seat is session-scoped and delivers the same
 * framework standard kit (`sessionId`, `useProjection`, `useChat`, the locale
 * `t` seat) the `conversation.view` seat does, so the panel and the tab are
 * one component with one data path. The tab type contributes a guide entry, so
 * the sidebar's guide page offers "Context" and picking it opens the panel —
 * the product's own path, exactly as the shipped Files type does: a capsule of
 * glyph, title, and description line, plus the chip-title seat that puts the
 * same glyph beside the label once the tab is open (`icon.tsx`).
 *
 * OPTIONAL BY CONTRACT. `ctx.sidebarRightTabs` and the seat ship only on the
 * 0.1.5 line (0.1.5-rc.1+ supported); the registration therefore rides a
 * DEFERRED inject (the plugin's hard injects stay `slots` + `locale`), so on
 * every older supported line the callback never fires, the plugin fiber never
 * pends, and nothing is registered. The registry is re-proved structurally and
 * the whole registration is guarded: a foreign or hostile registry (a throwing
 * `register`, a taken id/kind) leaves the sidebar without the tab instead of
 * taking the browser down.
 *
 * @module dsh-context/client/sidebar
 */

import { ContextIcon, makeContextTabTitle } from './icon'
import type { ClientCtx, ContextViewProps, SidebarTabsFace } from './services'
import type { Translate } from './i18n'

/** The tab type's identity in the sidebar's tab system (also its body-seat key). */
export const SIDEBAR_CONTEXT_ID = 'dsh-context'

/**
 * The kind `openTab` names. Namespaced rather than the bare `context`: the
 * registry THROWS when a kind collides with another registration in a
 * non-coexisting band, and a foreign plugin may well own `context`.
 */
export const SIDEBAR_CONTEXT_KIND = 'dsh-context'

/** The guide capsule's position: after the shipped Files entry (order 10). */
const GUIDE_ORDER = 20

/**
 * Register the Context tab type, its body, and its chip title on the right
 * Sidebar, if — and only if — this harness serves the sidebar tab registry.
 * @param ctx - client root context carrying `slots` and the locale service.
 * @param view - the Context view component factory result (the same one the
 *   conversation tab mounts).
 * @param t - the plugin-namespace translate; the label thunks read the active
 *   locale at call time, so a language switch relabels the guide entry.
 * @param ns - the plugin's locale namespace, put on the body registration so
 *   the framework synthesizes the `t` seat for the panel too.
 * @returns the deferred inject's disposer (placement toggling calls it to
 *   take the mount down; a no-op on faces that return no handle).
 */
export function watchSidebarContextTab(
  ctx: ClientCtx,
  view: (props: ContextViewProps) => unknown,
  t: Translate,
  ns: string,
): () => void {
  // Deferred: a harness without the right Sidebar never fires this, and the
  // plugin is simply a conversation tab there — no pending fiber, no error.
  const fiber = ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as unknown as ClientCtx & { sidebarRightTabs?: SidebarTabsFace }
    // Every registration that already landed, so a partial failure below
    // unwinds exactly what this callback owns.
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
        title: () => t('tab'),
        guide: [{
          order: GUIDE_ORDER,
          title: () => t('tab'),
          description: () => t('sidebar.guideDescription'),
          icon: ContextIcon,
        }],
      }))
      own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab', key: SIDEBAR_CONTEXT_ID, locale: ns },
        (props: { sessionId?: string } & Record<string, unknown>) => view({ ...props, host: 'sidebar' }),
      )))
      // The chip title seat (0.1.5-rc.1+): the emblem beside the label, the
      // files type's own idiom. Registered under the type id so the kit
      // dispatches it for this type's tabs only.
      own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_CONTEXT_ID },
        makeContextTabTitle(t),
      )))
    } catch {
      // A foreign registry that throws on register leaves the sidebar without
      // this tab; the conversation tab and every other seat keep working.
      for (const dispose of disposers) dispose()
      return undefined
    }
    // The inject callback's own disposer owns every registration: cordis
    // unloads them with the injected fiber (plugin stop, HMR reload).
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
  // The cordis inject handle disposes the callback's fiber; re-proved at
  // runtime because a harness face may return no handle at all.
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}

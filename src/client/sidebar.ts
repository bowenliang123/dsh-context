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
 * glyph, title, and description line.
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

import { IconContextInjectionOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientCtx, ContextViewProps, SidebarGuideEntryLike, SidebarTabsFace } from './services'
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
 * The guide capsule's glyph, read defensively: the icon is OPTIONAL in the
 * entry, and a primitives module that does not serve it — or whose namespace
 * THROWS on the read (an interop/mock shape does exactly that) — must cost the
 * glyph, never the whole tab.
 * @returns the icon component, or undefined to register the tab without one.
 */
function guideIcon(): SidebarGuideEntryLike['icon'] {
  try {
    return IconContextInjectionOutline16
  } catch {
    return undefined
  }
}

/**
 * Register the Context tab type and its body on the right Sidebar, if — and
 * only if — this harness serves the sidebar tab registry.
 * @param ctx - client root context carrying `slots` and the locale service.
 * @param view - the Context view component factory result (the same one the
 *   conversation tab mounts).
 * @param t - the plugin-namespace translate; the label thunks read the active
 *   locale at call time, so a language switch relabels the guide entry.
 * @param ns - the plugin's locale namespace, put on the body registration so
 *   the framework synthesizes the `t` seat for the panel too.
 */
export function watchSidebarContextTab(
  ctx: ClientCtx,
  view: (props: ContextViewProps) => unknown,
  t: Translate,
  ns: string,
): void {
  // Deferred: a harness without the right Sidebar never fires this, and the
  // plugin is simply a conversation tab there — no pending fiber, no error.
  ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as unknown as ClientCtx & { sidebarRightTabs?: SidebarTabsFace }
    try {
      const tabs = injected.sidebarRightTabs
      if (tabs === undefined || typeof tabs.register !== 'function') return
      const disposeType = tabs.register({
        id: SIDEBAR_CONTEXT_ID,
        kind: SIDEBAR_CONTEXT_KIND,
        title: () => t('tab'),
        guide: [{
          order: GUIDE_ORDER,
          title: () => t('tab'),
          description: () => t('sidebar.guideDescription'),
          icon: guideIcon(),
        }],
      })
      const disposeBody = injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab', key: SIDEBAR_CONTEXT_ID, locale: ns },
        (props: { sessionId?: string } & Record<string, unknown>) => view({ ...props, host: 'sidebar' }),
      ))
      // The inject callback's own disposer owns both registrations: cordis
      // unloads them with the injected fiber (plugin stop, HMR reload).
      return () => {
        disposeType()
        if (typeof disposeBody === 'function') (disposeBody as () => void)()
      }
    } catch {
      // A foreign registry that throws on register leaves the sidebar without
      // this tab; the conversation tab and every other seat keep working.
      return undefined
    }
  })
}

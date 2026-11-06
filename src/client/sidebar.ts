import { ContextIcon, makeContextTabTitle } from './icon'
import type { ClientCtx, ContextViewProps, SidebarTabsFace } from './services'
import type { Translate } from './i18n'

export const SIDEBAR_CONTEXT_ID = 'dsh-context'

export const SIDEBAR_CONTEXT_KIND = 'dsh-context'

const GUIDE_ORDER = 20

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
          id: SIDEBAR_CONTEXT_ID,
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
      own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_CONTEXT_ID },
        makeContextTabTitle(t),
      )))
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}

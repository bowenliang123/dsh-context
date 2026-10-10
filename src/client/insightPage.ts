/** The Context Insights page: two registrations under one id — the page on the layout's root keyed `main`
 * slot (keyed entry switching makes the page's mount its open) and the shell-owned sidebar row on
 * `sidebar.panellist`. The `insightsEntry` preference gates the pair: 'hide' unwinds both, leaving the
 * page no opener. */

import { createElement as h } from 'react'
import { InsightPanelIcon } from './icon'
import type { Translate } from './i18n'
import type { ContextSettings } from './settings'
import type { ClientCtx } from './services'
import { watchGate } from './toggleGate'

/** The id shared by the sidebar entry and the `main` panel it opens — namespaced, like the right-Sidebar
 *  kind, so no shipped or foreign panel collides with it. */
export const INSIGHT_PANEL_ID = 'dsh-context'

/** The sidebar row's position: after the shipped Plugins (0) and Automation tasks (10) entries. */
export const INSIGHT_PANEL_ORDER = 20

/**
 * Mount the page and its sidebar entry while the preference shows them.
 * @returns the watcher's disposer (unsubscribes and unwinds any live mount).
 */
export function watchInsightPage(
  ctx: ClientCtx,
  settings: ContextSettings,
  page: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  return watchGate(
    settings.store,
    () => settings.insightsEntry() === 'show',
    () => [
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: INSIGHT_PANEL_ID, locale: ns },
        page,
      )),
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: INSIGHT_PANEL_ID, order: INSIGHT_PANEL_ORDER, label: () => t('ov.title'), locale: ns },
        // The owner share is the icon's size (the row's active flag goes unread);
        // the registry's component typing widens it to the generic slot props.
        props => h(InsightPanelIcon, { size: typeof props.size === 'number' ? props.size : undefined }),
      )),
    ],
  )
}

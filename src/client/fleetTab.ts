/**
 * The Fleet conversation tab. `defaultPlacement` decides whether this plugin serves conversation tabs at all
 * (placement.ts), and `fleetTab` is the reader's own switch for this one; the pair is re-evaluated live, so a
 * flip either way registers or unwinds the tab without touching the Context tab.
 */

import type { Translate } from './i18n'
import { wantsConversationTabs } from './placement'
import type { ContextSettings } from './settings'
import type { ClientCtx } from './services'
import { watchGate } from './toggleGate'

/** Right of the Context tab (order 20). */
const FLEET_ORDER = 30

export function watchFleetTab(
  ctx: ClientCtx,
  settings: ContextSettings,
  view: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  return watchGate(
    settings.store,
    () => wantsConversationTabs(settings) && settings.fleetTab() === 'show',
    () => [ctx.slots.inject('conversation.view', () => ctx.slots.register(
      { name: 'conversation.view', id: 'fleet', order: FLEET_ORDER, locale: ns, label: () => t('tab.fleet') },
      view,
    ))],
  )
}

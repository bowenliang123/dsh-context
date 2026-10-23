/** Client half bundle entry: the slim `contextTimeline` head, with heavy collections fetched on demand. */

import { createElement as h } from 'react'
import { DICT_EN, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewPanel } from './components/overviewPanel'
import { makePluginConfigCard } from './components/settingsCard'
import { watchInsightPage } from './insightPage'
import { modalStoreOf } from './modalStore'
import { entrySeated, type ClientCtx } from './services'
import { createContextSettings, type ConfigFormsFace, type SettingsField } from './settings'
import { makeContextView } from './components/contextView'
import { makeContextJumpButton } from './components/contextJump'
import { makeFleetView } from './components/fleetView'
import { watchFleetTab } from './fleetTab'
import { makeAgentHeads } from './agentHeads'
import { watchHistoryFaces } from './historyPage'
import { watchPlacement } from './placement'
import { watchSidebarContextTab } from './sidebar'
import { makeViewKit } from './viewkit'

// Import order IS cascade order among same-specificity rules: Tailwind utilities, then base, then per-component sheets.
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/commandPanel.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/fleet.css'
import './styles/overview.css'
import './styles/dateRange.css'

const NS = 'dsh-context'

/** The chat→Context jump doubles as the mount marker: no preference gates it, so a seated ledger means a mount is live. */
const JUMP_SLOT = 'conversation.chat.assistant-actions'
const JUMP_ID = 'context-jump'

function apply(ctx: ClientCtx): void {
  // One live mount per page: a seated marker means a mount is live; the runner's priority defeats the
  // registry guard (docs/compatibility.md §5).
  if (entrySeated(ctx, JUMP_SLOT, JUMP_ID)) return
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t, ctx.locale)
  // History faces ride the DECLARED inject: an undeclared read of the traced proxy throws (historyPage.ts).
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  // One page-scope cold-head cache for every agent-data reader: the Context view's cells and the Fleet card.
  const heads = makeAgentHeads()
  const ContextView = makeContextView(ctx, kit, settings, heads)
  const FleetView = makeFleetView(ctx, kit, heads, settings)

  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab.context') },
      props => h(ContextView, props),
    )),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-context: placement')

  // The Fleet tab: its own show/hide preference on top of the placement gate (fleetTab.ts).
  ctx.effect(() => watchFleetTab(
    ctx,
    settings,
    props => h(FleetView, props as unknown as Parameters<typeof FleetView>[0]),
    t,
    NS,
  ), 'dsh-context: fleet tab')

  // Chat → Context jump: the right Sidebar tab pinned to the reply's turn where served, else the conversation tab.
  const ContextJump = makeContextJumpButton(ctx, kit)
  ctx.slots.inject(JUMP_SLOT, () => {
    return ctx.slots.register(
      // After the shipped feedback entry (10), still inside the icon row.
      { name: JUMP_SLOT, id: JUMP_ID, order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit, settings)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay',
        id: 'context-modal',
        order: 10,
        locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // Context Insights: the keyed `main` panel and its `sidebar.panellist` entry, gated by `insightsEntry`.
  const OverviewPanel = makeOverviewPanel(ctx, kit, settings)
  ctx.effect(() => watchInsightPage(
    ctx,
    settings,
    // Root-scope seats: the owner props (the standard kit) arrive untyped.
    props => h(OverviewPanel, props as unknown as Parameters<typeof OverviewPanel>[0]),
    t,
    NS,
  ), 'dsh-context: insight page')

  const cardFace = (): {
    hooks: { contextSettings: typeof settings.store }
    set: (field: SettingsField, value: string) => void
  } => ({
    hooks: { contextSettings: settings.store },
    set: (field, value) => { settings.set(field, value) },
  })

  // Preferences ride configForms and the Plugins page's keyed slot; without the service the schema defaults stay.
  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(NS)), 'dsh-context: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([NS], () => {
      // slots.inject's disposer is the registration's disposer.
      return c.slots.inject('plugins.bundle.config', () => {
        return c.slots.register(
          { name: 'plugins.bundle.config', key: NS, locale: NS, inject: cardFace },
          props => h(PluginConfigCard, props as unknown as Parameters<typeof PluginConfigCard>[0]),
        )
      }) as () => void
    }), 'dsh-context: plugins-page card')
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}

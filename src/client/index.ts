import { createElement as h } from 'react'
import { DICTS } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewPanel } from './components/overviewPanel'
import { resetSessionWarm } from './prefetch'
import { resetTimelineDetailStores } from './timelineSource'
import { clearAttachmentPaths } from './attachmentSource'
import { makePluginConfigCard } from './components/settingsCard'
import { watchInsightPage } from './insightPage'
import { modalStoreOf } from './modalStore'
import { CONTEXT_VIEW_ID, entrySeated, type ClientCtx } from './services'
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
import './styles/pulse.css'
import './styles/overview.css'
import './styles/dateRange.css'
import './styles/recom.css'

const NS = 'dsh-context'

const JUMP_SLOT = 'conversation.chat.assistant-actions'
const JUMP_ID = 'context-jump'

function apply(ctx: ClientCtx): void {
  if (entrySeated(ctx, JUMP_SLOT, JUMP_ID)) return
  ctx.effect(() => {
    return ctx.locale.register(NS, DICTS)
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t, ctx.locale)
  ctx.effect(() => () => {
    resetSessionWarm()
    resetTimelineDetailStores()
    clearAttachmentPaths()
  }, 'dsh-context: warm-up timers')
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  const heads = makeAgentHeads()
  const ContextView = makeContextView(ctx, kit, settings, heads)
  const FleetView = makeFleetView(ctx, kit, heads)

  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => ctx.slots.register(
      { name: 'conversation.view', id: CONTEXT_VIEW_ID, order: 20, locale: NS, label: () => t('tab.context') },
      props => h(ContextView, props),
    )),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-context: placement')

  ctx.effect(() => watchFleetTab(
    ctx,
    settings,
    props => h(FleetView, props as unknown as Parameters<typeof FleetView>[0]),
    t,
    NS,
  ), 'dsh-context: fleet tab')

  const ContextJump = makeContextJumpButton(ctx, kit, settings)
  ctx.slots.inject(JUMP_SLOT, () => {
    return ctx.slots.register(
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
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) }, warm: true }) },
      props => h(ContextModal, props),
    )
  })

  const OverviewPanel = makeOverviewPanel(ctx, kit, settings)
  ctx.effect(() => watchInsightPage(
    ctx,
    settings,
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

  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(NS)), 'dsh-context: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([NS], () => {
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

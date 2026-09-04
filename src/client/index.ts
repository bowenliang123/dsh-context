/**
 * dsh-context — Client half (installed package bundle entry).
 *
 * Registers a "上下文/Context" tab in the conversation view ring
 * (`conversation.view` slot, beside Chat/Trajectory) and renders the
 * context-composition timeline: current makeup, per-request stacked-bar
 * history, context events, and the live message list.
 *
 * Since v0.9 the tab needs no custom data plane: the Host half pushes its
 * fold through the harness's session-projection pipeline
 * (`contextTimeline` projection key), and this half reads the finished value
 * from the framework standard kit (`useProjection('contextTimeline')`, a
 * standard prop on every session-scope slot component). No polling, no RPC,
 * no client-side cache.
 *
 * This module is the body of the package's `./client` bundle: tsdown
 * (tsdown.config.ts) bundles it (external `react` — the browser module table
 * supplies it via the injected `require`) into the web boot handoff
 * (`window.__ModuleLoader__.load({id, factory})`). All imports from other
 * client modules are inlined by the bundler; everything here is zero-runtime
 * beyond the bundled source.
 */

import { DICT_EN, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeSettingsCard } from './components/settingsCard'
import { modalStoreOf } from './modalStore'
import type { ClientCtx } from './services'
import { createContextSettings, type SettingsField, type SettingsScopeBinderFace } from './settings'
import { makeContextView } from './components/contextView'
import { makeContextJumpButton } from './components/contextJump'
import { watchHistoryFaces } from './historyPage'
import { makeViewKit } from './viewkit'

// Theme-native styles: the bundle's global-CSS channel injects each sheet as
// a plugin-owned <style data-plugin> tag at factory execution (the web boot
// loader and the HMR receiver claim tags carrying data-plugin). Import order
// IS cascade order across same-specificity rules: base first, then the
// per-component sheets in their original section order.
import './styles/base.css'
import './styles/stats.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'

import { h } from './react'

const NS = 'dsh-context'

function apply(ctx: ClientCtx): void {
  // Bilingual dictionaries, registered via ctx.effect so a stop or HMR reload
  // disposes them; the tab label thunk and all UI text follow the active
  // locale through the bound translate — missing keys resolve through the
  // harness chain (en fallback, then the key).
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  // History face of the harness gateway remotes, resolved through the
  // DECLARED inject — a non-declared read of the traced `remote.session`
  // proxy throws ("cannot get property … without inject") and would take
  // the browser down with the view. Injection waits for the service; a
  // harness that never composes the namespace never fires the callback and
  // the targeted fetches simply stay absent.
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  const ContextView = makeContextView(ctx, kit, settings)

  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10); the locale
      // namespace put the framework `t` seat on the component's props too.
      { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab') },
      props => h(ContextView, props),
    )
  })

  // Chat → Context jump: an icon in each finalized reply's action row that
  // opens this tab pinned to that reply's turn (see contextJump.tsx; the
  // relay and tab activation live in viewFocus.ts).
  const ContextJump = makeContextJumpButton(kit)
  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    return ctx.slots.register(
      // After the shipped feedback entry (10), still inside the icon row.
      { name: 'conversation.chat.assistant-actions', id: 'context-jump', order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  // `/context` slash command: opens the context modal (see command.ts for
  // the trigger source). The modal itself renders from the input overlay
  // slot, opened per session through the hooks-compartment store.
  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay', id: 'context-modal', order: 10, locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // Per-user display preferences: bind the Host-served `dsh-context`
  // namespace and claim its Plugin configuration card. Optional composition
  // — a deployment without the settings surface keeps the schema defaults
  // and shows no card.
  ctx.inject(['settingsScope'], (raw) => {
    const c = raw as ClientCtx & { settingsScope?: SettingsScopeBinderFace }
    const binder = c.settingsScope
    if (binder === undefined) return
    c.effect(() => settings.attach(binder.bind({ namespace: NS })), 'dsh-context: settings scope')
    const SettingsCard = makeSettingsCard(kit)
    c.slots.inject('settings.plugin.item', () => {
      return c.slots.register(
        { name: 'settings.plugin.item', key: NS, locale: NS,
          inject: () => ({
            hooks: { contextSettings: settings.store },
            set: (field: SettingsField, value: string) => { settings.set(field, value) },
          }) },
        // Root-scope keyed slot: no sessionId on these props — the face
        // (hooks + set) arrives through the registration's inject.
        props => h(SettingsCard, props as unknown as Parameters<typeof SettingsCard>[0]),
      )
    })
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}

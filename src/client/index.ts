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
import { modalStoreOf } from './modalStore'
import type { ClientCtx, SessionsFace } from './services'
import { makeContextView } from './components/contextView'
import { makeViewKit } from './viewkit'

// Theme-native styles: the bundle's global-CSS channel injects the sheet as
// a plugin-owned <style data-plugin> tag at factory execution (the web boot
// loader and the HMR receiver claim tags carrying data-plugin).
import './styles.css'

import { React, h } from './react'

const NS = 'dsh-context'

function apply(ctx: ClientCtx): void {
  // Bilingual dictionaries; the tab label thunk and all UI text follow the
  // active locale through the bound translate (missing keys fall back to
  // zh, then the key itself). The registration rides ctx.effect, so a stop
  // or HMR reload disposes it.
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  const ContextView = makeContextView(ctx, kit)

  // Contribute the history-pagination verb as a standard prop, so the
  // Context browser can pull older conversation pages on demand when the
  // reader expands an element outside the loaded window. Fail-soft: hosts
  // without the provide channel (or a duplicate-name refusal) keep the
  // preview-plus-hint degradation.
  ctx.effect(() => {
    const noop = (): void => {}
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.provide !== 'function') return noop
    try {
      return sessions.provide({
        props: ['loadOlderHistory'],
        resolve: binding => ({ props: { loadOlderHistory: () => binding.session.loadOlder() } }),
      })
    } catch {
      return noop
    }
  }, 'dsh-context: loadOlderHistory prop')

  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10); the locale
      // namespace put the framework `t` seat on the component's props too.
      { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab') },
      props => h(ContextView, props),
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
        inject: (sessionId: string) => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['slots', 'locale'],
  apply,
}

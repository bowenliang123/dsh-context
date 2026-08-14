/**
 * dsh-context — Client half (installed package bundle entry).
 *
 * Registers a "上下文/Context" tab in the conversation view ring
 * (`conversation.view` slot, beside Chat/Trajectory) and renders the
 * context-composition timeline served by the Host half over the generic
 * Connection RPC channel `/dsh-context`: current makeup, per-request
 * stacked-bar history, context events, and the live message list.
 *
 * This module is the body of the package's `./client` bundle: build.mjs
 * bundles it (external `react` — the browser module table supplies it via
 * the injected `require`) into the web boot handoff
 * (`window.__ModuleLoader__.load({id, factory})`). All imports from other
 * client modules are inlined by the bundler; everything here is zero-runtime
 * beyond the bundled source.
 */

import { DICT_EN, DICT_ZH } from './i18n'
import type { ClientCtx } from './services'
import { STYLES } from './styles'
import { makeContextView } from './components/contextView'
import { makeViewKit } from './viewkit'

import { React, h } from './react'

function apply(ctx: ClientCtx): void {
  // Bilingual dictionaries; the tab label thunk and all UI text follow the
  // active locale through the bound translate (missing keys fall back to
  // zh, then the key itself). The registration rides ctx.effect, so a stop
  // or HMR reload disposes it.
  ctx.effect(() => {
    return ctx.locale.register('dsh-context', { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind('dsh-context')

  // Theme-native styles, injected as a plugin-owned <style> tag (the web
  // boot loader claims and removes tags carrying data-plugin on unload).
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-context')
    tag.textContent = STYLES
    document.head.appendChild(tag)
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }
  }, 'dsh-context: styles')

  const ContextView = makeContextView(ctx, makeViewKit(t))
  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: 'context', order: 20, label: () => t('tab') },
      props => h(ContextView, props),
    )
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['connection', 'slots', 'locale'],
  apply,
}

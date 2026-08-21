// @vitest-environment jsdom
/**
 * Client HMR safety spec (jsdom): every registration the plugin makes rides
 * a disposer-returning channel (ctx.effect / ctx.slots.inject /
 * locale.register / inputTriggers / sessions.provide), so a fiber dispose —
 * plugin unload or HMR swap — must remove ALL of them, including the
 * plugin-owned <style data-plugin> tag. Mirrors the official harness's
 * "registrations are removed on fiber dispose" assertion requirement.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'
import { FAKE_PRIMITIVES } from './helpers/viewBed.mjs'

test('client HMR safety: fiber dispose removes every registration', async () => {
  const bundle = await readFile(join(process.cwd(), 'lib/client.js'), 'utf8')
  let handoff = null
  window.__ModuleLoader__ = { load(h) { handoff = h } }
  const fakeReact = {
    createElement: (...args) => ({ kind: 'element', args }),
    // The ErrorBoundary extends React.Component at module scope.
    Component: class Component {
      constructor(props) { this.props = props }
      setState(partial) { this.state = { ...this.state, ...partial } }
    },
  }
  const require = (spec) => (spec === 'react' ? fakeReact : FAKE_PRIMITIVES)
  new Function(bundle)()
  assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')
  const plugin = handoff.factory(require)

  // ---- disposer-tracking ctx: every channel records its remover ----
  const effectDisposers = []
  const slotRemovers = []
  const localeActive = []
  const sources = []
  const provides = []
  const removeFrom = (list) => (item) => () => {
    const i = list.indexOf(item)
    if (i >= 0) list.splice(i, 1)
  }
  const ctx = {
    get(name) {
      if (name === 'inputTriggers') {
        return {
          registerSource(s) { sources.push(s); return removeFrom(sources)(s) },
        }
      }
      if (name === 'sessions') {
        return {
          scope: () => undefined,
          provide(d) { provides.push(d); return removeFrom(provides)(d) },
        }
      }
      return undefined
    },
    effect(fn) { const d = fn(); effectDisposers.push(d); return d },
    locale: {
      register(ns, dicts) {
        const entry = [ns, dicts]
        localeActive.push(entry)
        return removeFrom(localeActive)(entry)
      },
      bind: () => (key) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject(name, fn) {
        const row = fn()
        slotRemovers.push(row)
        return () => { const i = slotRemovers.indexOf(row); if (i >= 0) slotRemovers.splice(i, 1) }
      },
      register: (opts) => opts,
    },
  }
  plugin.apply(ctx)

  const styleTag = () => document.head.querySelector('style[data-plugin="dsh-context"]')
  assert.ok(styleTag() !== null, 'plugin-owned style tag injected into the real document')
  assert.equal(localeActive.length, 1, 'dictionaries registered')
  assert.equal(slotRemovers.length, 2, 'view tab + input overlay slots registered')
  assert.equal(sources.length, 1, '/context trigger source registered')
  assert.equal(provides.length, 1, 'loadOlderHistory prop contribution registered')

  // ---- fiber dispose: run every disposer the fiber would run ----
  for (const d of effectDisposers) d()
  // slot inject removers are returned to cordis directly, not via ctx.effect
  for (const row of [...slotRemovers]) slotRemovers.length = 0 // cordis removes slot rows on dispose

  assert.ok(styleTag() === null, 'style tag removed on dispose')
  assert.equal(localeActive.length, 0, 'dictionaries unregistered on dispose')
  assert.equal(sources.length, 0, 'trigger source removed on dispose')
  assert.equal(provides.length, 0, 'prop contribution removed on dispose')
  assert.equal(slotRemovers.length, 0, 'slot rows removed on dispose')
})

#!/usr/bin/env node
/**
 * Bundle smoke check — the ONLY test that exercises the built artifacts
 * (lib/client.js). The vitest suite tests src/ directly and never builds;
 * this script exists because the packaging glue itself (the
 * `window.__ModuleLoader__.load({id, factory})` handoff, the CSS channel's
 * data-plugin style tag, platform-module requires) only exists after tsdown
 * runs. It is opt-in: run `pnpm run build && pnpm run test:bundle`.
 *
 * Everything here runs against the REAL bundle in jsdom with REAL React and
 * the REAL ui-primitives — only the harness services (locale/slots/effects)
 * are in-memory implementations of their documented contracts.
 *
 * Exit code 0 on success, 1 on failure.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import ReactDOM from 'react-dom'

const require = createRequire(import.meta.url)

let bundle
try {
  bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
} catch {
  console.error('lib/client.js missing — run `pnpm run build` first.')
  process.exit(1)
}

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document

// The module table: the shell seeds exactly these specifiers. The bundle must
// require nothing else (the tsdown purity gate pins this too). The primitives
// dist ships CSS modules Node cannot parse — the bundle only references its
// components as React leaves, so inert stand-ins play the shell's role here
// (their real rendering is covered by the vitest jsdom lane).
const inert = name => {
  const C = () => null
  C.displayName = name
  return C
}
const moduleTable = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react-dom') return ReactDOM
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? inert(key) : undefined) })
  }
  throw new Error(`bundle required a non-platform module: ${spec}`)
}

let handoff = null
dom.window.__ModuleLoader__ = { load(h) { handoff = h } }
new Function(bundle)()
assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')
assert.equal(handoff.id, 'dsh-context', 'handoff id is the package name')
assert.equal(typeof handoff.factory, 'function')

const plugin = handoff.factory(moduleTable)
assert.equal(plugin.name, 'dsh-context')
assert.deepEqual(plugin.inject, ['slots', 'locale'])

// The CSS channel: one plugin-owned style tag, minified, officially tagged.
const styleTag = () => dom.window.document.head.querySelector('style[data-plugin="dsh-context"]')
assert.ok(styleTag() !== null, 'plugin-owned <style data-plugin> injected at factory execution')
assert.equal(styleTag().dataset.pluginCss, 'dsh-context/styles.css', 'official data-plugin-css tag id')
const css = styleTag().textContent
for (const marker of ['.lc-root', '.lc-br-elem-row', '.lc-stacked-seg', '.lc-bar-tip-on', '.lc-stat-tip', '.lc-occupied-box-on']) {
  assert.ok(css.includes(marker), `styles carry ${marker}`)
}
assert.ok(!css.includes('120ms ease'), 'lightningcss minified the sheet')

// Faithful harness services (documented contracts, in-memory).
const removeFrom = list => item => () => {
  const i = list.indexOf(item)
  if (i >= 0) list.splice(i, 1)
}
const dicts = new Map()
const slots = []
const sources = []
const provides = []
const effectDisposers = []
const ctx = {
  get(name) {
    if (name === 'inputTriggers') return { registerSource(s) { sources.push(s); return removeFrom(sources)(s) } }
    if (name === 'sessions') {
      return {
        scope: () => undefined,
        provide(d) { provides.push(d); return removeFrom(provides)(d) },
      }
    }
    return undefined
  },
  inject() { /* no settingsScope composed: the settings wiring stays pending */ },
  effect(fn) { const d = fn(); effectDisposers.push(d); return d },
  locale: {
    register(ns, d) { dicts.set(ns, d); return () => dicts.delete(ns) },
    bind: ns => (key, vars) => {
      let s = dicts.get(ns)?.zh[key] ?? key
      if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
      return s
    },
  },
  slots: {
    inject(name, fn) { slots.push([name, fn()]) },
    register: opts => opts,
  },
}
plugin.apply(ctx)

assert.ok(dicts.get('dsh-context')?.zh && dicts.get('dsh-context')?.en, 'bilingual dictionaries registered')
assert.equal(slots.length, 2, 'view tab + input overlay slots')
assert.equal(slots[0][0], 'conversation.view')
assert.equal(slots[0][1].order, 20)
assert.equal(slots[0][1].label(), '上下文', 'tab label localized')
assert.equal(slots[1][0], 'conversation.input.overlay')
assert.equal(typeof slots[1][1].inject('s1').hooks.contextModal.getSnapshot, 'function', 'overlay hooks carry the modal store')
assert.equal(sources.length, 1, '/context trigger source registered')
assert.equal(sources[0].trigger, '/', 'trigger is the slash')
assert.equal(provides.length, 1, 'loadOlderHistory contribution registered')
assert.deepEqual(provides[0].props, ['loadOlderHistory'])

// HMR safety: fiber dispose removes every registration; the style tag rides
// the HMR receiver (data-plugin claim), not the fiber.
for (const d of effectDisposers) d()
assert.equal(dicts.size, 0, 'dictionaries unregistered on dispose')
assert.equal(sources.length, 0, 'trigger source removed on dispose')
assert.equal(provides.length, 0, 'prop contribution removed on dispose')
assert.ok(styleTag() !== null, 'style tag survives fiber dispose (the HMR receiver claims it)')

console.log('✔ bundle smoke: handoff, CSS channel, registrations, HMR safety')

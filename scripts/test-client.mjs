#!/usr/bin/env node
/**
 * Functional smoke test for the packaged client bundle: simulates the web
 * boot handoff (window.__ModuleLoader__.load), the module-table require,
 * and the client ctx (connection/locale/slots/effect + a fake DOM), then
 * asserts the plugin registers its dictionaries, styles, and the
 * conversation.view tab entry.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- fake browser environment ----
const registered = new Map() // style tags keyed by data-plugin
const fakeDoc = {
  createElement: (tag) => {
    const el = { tagName: tag, attrs: {}, textContent: '', parentNode: null }
    el.setAttribute = (k, v) => { el.attrs[k] = String(v) }
    return el
  },
  head: {
    appendChild(el) {
      el.parentNode = { removeChild: () => { el.parentNode = null } }
      registered.set(el.attrs['data-plugin'], el)
    },
  },
  querySelectorAll: () => [],
}
const fakeReact = {
  createElement: (...args) => ({ kind: 'element', args }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
}

let handoff = null
globalThis.window = {
  __ModuleLoader__: {
    load(h) {
      assert.ok(h.id === 'dsh-context', 'handoff id must be the package name')
      assert.equal(typeof h.factory, 'function')
      handoff = h
    },
  },
}
globalThis.document = fakeDoc

// The module table answers 'react'; everything else the bundle needs rides ctx.
const require = (spec) => {
  assert.equal(spec, 'react', `bundle must only require platform modules (got "${spec}")`)
  return fakeReact
}

// ---- materialize the bundle the way the loader does ----
// Extract the factory body (between the handoff's factory opening and the
// loader-facing `return module.exports;`) and evaluate it with our own
// module/exports so the closure shape matches the real bundle.
const start = bundle.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
const end = bundle.indexOf('    return module.exports;')
const factory = new Function('require', 'module', 'window', 'document',
  bundle.slice(start, end) + '\n    return module.exports;')
const m = { exports: {} }
const pluginExports = factory(require, m, globalThis.window, fakeDoc)

assert.equal(pluginExports.name, 'dsh-context')
assert.deepEqual(pluginExports.inject, ['connection', 'slots', 'locale'])

// ---- apply the client plugin ----
const localeRegistrations = []
const slotInjections = []
const effects = []
const fakeCtx = {
  get: () => undefined,
  effect(fn) { effects.push(fn); fn(); return () => {} }, // Cordis runs the effect body immediately
  locale: {
    register: (ns, dicts) => { localeRegistrations.push([ns, dicts]); return () => {} },
    bind: (ns) => (key, vars) => {
      const dict = localeRegistrations[0][1].zh
      let s = dict[key] !== undefined ? dict[key] : key
      if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
      return s
    },
  },
  connection: {
    rpc: { call: async () => ({ ok: true, value: { current: { total: 100 }, requests: [], events: [], nodes: [] } }) },
  },
  slots: {
    inject: (name, fn) => { slotInjections.push([name, fn]) },
    register: (opts, component) => {
      assert.equal(typeof component, 'function')
      return opts
    },
  },
}
pluginExports.apply(fakeCtx)

assert.equal(effects.length, 2, 'dictionaries + styles effects')
assert.deepEqual(localeRegistrations[0][0], 'dsh-context')
assert.ok(localeRegistrations[0][1].zh && localeRegistrations[0][1].en, 'bilingual dicts')
const styleTag = registered.get('dsh-context')
assert.ok(styleTag, 'plugin-owned <style data-plugin="dsh-context"> injected')
assert.ok(styleTag.textContent.includes('.lc-root'), 'styles content present')
assert.equal(slotInjections.length, 1)
assert.equal(slotInjections[0][0], 'conversation.view')
const registeredOpts = slotInjections[0][1]() // slots.inject callback returns the register result
assert.equal(registeredOpts.name, 'conversation.view')
assert.equal(registeredOpts.id, 'context')
assert.equal(registeredOpts.order, 20)
assert.equal(typeof registeredOpts.label, 'function')
assert.equal(registeredOpts.label(), '上下文', 'tab label localized')

console.log('✔ client bundle test passed (handoff, require table, dicts, styles, slot registration)')

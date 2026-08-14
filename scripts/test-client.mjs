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

// ---- chart render test: fixed-width bars, horizontal scroll, turn ranges ----
// Materialize the bundle a second time with a STATEFUL fake React so the
// view component can be driven from loading -> data, then walk the element
// tree the component produces. Hooks are tracked PER component function
// (like React fibers), so re-rendering re-reads the same slots.
const hookStates = new Map() // component fn -> [value, setter][] slots
let currentHooks = null
let hookCursor = 0
const statefulReact = {
  createElement: (...args) => ({ kind: 'element', args }),
  useState(init) {
    const i = hookCursor++
    if (currentHooks[i] === undefined) {
      const set = (v) => { currentHooks[i][0] = typeof v === 'function' ? v(currentHooks[i][0]) : v }
      currentHooks[i] = [typeof init === 'function' ? init() : init, set]
    }
    return currentHooks[i]
  },
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
}
const requireStateful = (spec) => {
  assert.equal(spec, 'react')
  return statefulReact
}
const m2 = { exports: {} }
const pluginExports2 = factory(requireStateful, m2, globalThis.window, fakeDoc)

const DICT_FOR_TEST = { 'tab': 'Context', 'loading': '…', 'error': 'x' }
let viewComponent = null
const fakeCtx2 = {
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
  locale: {
    register: () => () => {},
    bind: () => (key, vars) => {
      let s = DICT_FOR_TEST[key] !== undefined ? DICT_FOR_TEST[key] : key
      if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
      return s
    },
  },
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  slots: {
    inject: (name, fn) => { fn() }, // the register call inside captures the component
    register: (opts, component) => { viewComponent = component; return opts },
  },
}
pluginExports2.apply(fakeCtx2)
assert.ok(viewComponent !== null, 'view component captured')

/** Invoke function-typed elements so hooks run and the tree materializes. */
function evaluate(node) {
  if (node === null || typeof node !== 'object') return node
  if (node.kind === 'element') {
    const [type, props, ...children] = node.args
    if (typeof type === 'function') {
      currentHooks = hookStates.get(type)
      if (currentHooks === undefined) {
        currentHooks = []
        hookStates.set(type, currentHooks)
      }
      hookCursor = 0
      return evaluate(type(props))
    }
    return { kind: 'element', args: [type, props, ...children.map(evaluate)] }
  }
  if (Array.isArray(node)) return node.map(evaluate)
  return node
}

/** Walk the h() element tree, returning every node whose className matches. */
function byClass(root, className) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.kind === 'element') {
      const props = node.args[1] || {}
      if (typeof props.className === 'string' && props.className.split(' ').includes(className)) found.push(node)
      for (let i = 2; i < node.args.length; i++) walk(node.args[i])
    } else if (Array.isArray(node)) {
      for (const child of node) walk(child)
    }
  }
  walk(root)
  return found
}

// Render 1 (loading): creates the ContextView hook slots.
evaluate(viewComponent({ sessionId: 's1' }))
const snapshot = {
  ok: true, model: 'deepseek-v4', provider: 'deepseek', contextWindow: 128000,
  current: { system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100 },
  toolList: [], requests: [
    { seq: 1, turn: 1, step: 0, time: 1000, system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100, prompt: 95 },
    { seq: 2, turn: 1, step: 1, time: 2000, system: 10, tools: 20, user: 25, inject: 5, assistant: 10, tool: 20, total: 90 },
    { seq: 3, turn: 2, step: 0, time: 3000, system: 10, tools: 20, user: 40, inject: 5, assistant: 12, tool: 20, total: 107 },
    { seq: 4, turn: 3, step: 0, time: 4000, system: 10, tools: 20, user: 20, inject: 5, assistant: 8, tool: 20, total: 83 },
  ],
  events: [], nodes: [], droppedNodes: 0,
}
// setData: slot 0 of the ContextView fiber holds the data state.
const contextViewFn = viewComponent({ sessionId: 's1' }).args[0]
hookStates.get(contextViewFn)[0][1](snapshot)
const tree = evaluate(viewComponent({ sessionId: 's1' }))

const bars = byClass(tree, 'lc-bar')
assert.equal(bars.length, 4, 'one bar per request')
const turns = byClass(tree, 'lc-turn')
assert.equal(turns.length, 3, 'three turn ranges (T1 has two bars, T2/T3 one each)')
assert.deepEqual(turns.map(t => t.args[2]), ['T1', 'T2', 'T3'], 'turn labels in order')
const turnWidths = turns.map(t => t.args[1].style.width)
assert.equal(turnWidths[0], '30px', 'T1 tick spans two columns (2*16-2)')
assert.equal(turnWidths[1], '14px', 'T2 tick spans one column')
assert.ok(byClass(tree, 'lc-chart-scroll').length === 1, 'scroll container present')
assert.ok(byClass(tree, 'lc-turns').length === 1, 'turn tick row present')

console.log('✔ chart render test passed (fixed-width bars, scroll container, turn ranges)')

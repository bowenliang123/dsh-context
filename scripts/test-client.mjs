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
    const slots = currentHooks // captured by the setter: stable per fiber
    if (slots[i] === undefined) {
      const set = (v) => { slots[i][0] = typeof v === 'function' ? v(slots[i][0]) : v }
      slots[i] = [typeof init === 'function' ? init() : init, set]
    }
    return slots[i]
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

const DICT_FOR_TEST = { 'tab': 'Context', 'loading': '…', 'error': 'x', 'detail.step': 'T{t} · step {s}', 'gran.step': 'Step', 'gran.turn': 'Turn' }
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

/** Invoke function-typed elements so hooks run and the tree materializes.
 * Hooks are keyed by the component's fiber path (e.g. root/ContextView#0/
 * StackedBar#0), so distinct instances of the same component keep state. */
function evaluate(node, path = '', fnIdx = 0) {
  if (node === null || typeof node !== 'object') return node
  if (node.kind === 'element') {
    const [type, props, ...children] = node.args
    if (typeof type === 'function') {
      const key = path + '/' + (type.name || 'anon') + '#' + fnIdx
      currentHooks = hookStates.get(key)
      if (currentHooks === undefined) {
        currentHooks = []
        hookStates.set(key, currentHooks)
      }
      hookCursor = 0
      return evaluate(type(props), key)
    }
    const kids = []
    let f = 0
    const walkChildren = (c) => {
      if (Array.isArray(c)) { for (const x of c) walkChildren(x); return }
      if (c !== null && typeof c === 'object' && c.kind === 'element' && typeof c.args[0] === 'function') {
        kids.push(evaluate(c, path, f++))
      } else {
        kids.push(evaluate(c, path, f))
      }
    }
    for (const c of children) walkChildren(c)
    return { kind: 'element', args: [type, props, ...kids] }
  }
  if (Array.isArray(node)) return node.map(n => evaluate(n, path, fnIdx))
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
const ctxKey = [...hookStates.keys()].find(k => k.includes('ContextView'))
assert.ok(ctxKey, 'ContextView fiber registered')
hookStates.get(ctxKey)[0][1](snapshot)
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

// ---- hover linking: hovering a trend bar updates the detail below ----
const ctxSlots = hookStates.get(ctxKey) // data(0) error(1) selected(2) hovered(3) tick(4)
const renderView = () => evaluate(viewComponent({ sessionId: 's1' }))
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (node.kind === 'element') return node.args.slice(2).map(textOf).join('')
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}
const detailStep = (tr) => {
  const head = byClass(tr, 'lc-detail-head')[0]
  return head === undefined ? '' : textOf(head).trim()
}

let tr = renderView()
assert.match(detailStep(tr), /T3/, 'detail defaults to the newest request (T3)')
assert.equal(byClass(tr, 'lc-bar-hovered').length, 0, 'no hovered bar initially')

ctxSlots[3][1](3) // setHoveredSeq(seq 3, turn 2)
tr = renderView()
assert.match(detailStep(tr), /T2/, 'hovering a bar links the detail below to it')
const hovered = byClass(tr, 'lc-bar-hovered')
assert.equal(hovered.length, 1, 'exactly one hovered bar')
assert.equal(hovered[0].args[1].key, 3, 'hovered bar is seq 3')
const bar3 = byClass(tr, 'lc-bar').find(b => b.args[1].key === 3)
assert.equal(typeof bar3.args[1].onMouseEnter, 'function', 'bars carry onMouseEnter')
assert.equal(typeof bar3.args[1].onClick, 'function', 'bars carry onClick')

ctxSlots[3][1](null) // leave the plot
tr = renderView()
assert.match(detailStep(tr), /T3/, 'leaving the plot reverts the detail to the newest request')

// ---- overview stacked bar: themed hover tooltip per segment ----
const overviewStack = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
assert.ok(overviewStack, 'overview stacked bar present')
const segment = overviewStack.args.slice(2).flat().find(s => s !== null)
assert.ok(segment, 'overview has segments')
assert.equal(segment.args[1].title, undefined, 'native title replaced by the custom tooltip')
assert.equal(typeof segment.args[1].onMouseEnter, 'function', 'segments carry onMouseEnter')
segment.args[1].onMouseEnter({ clientX: 120 }) // fake pointer; ref is null in tests -> centered fallback
tr = renderView()
const tip = byClass(tr, 'lc-bar-tip')
assert.equal(tip.length, 1, 'hovering a segment shows the tooltip')
assert.match(textOf(tip[0]), /\(10%\)/, 'tooltip shows the segment share of the total')
assert.equal(typeof tip[0].args[1].style.left, 'string', 'tooltip is positioned along the pointer')

// ---- turn strip: one color block per turn, aligned with the bars above ----
let turnBlocks = byClass(tr, 'lc-turn')
assert.equal(turnBlocks.length, 3, 'one turn block per turn')
assert.equal(typeof turnBlocks[0].args[1].onMouseEnter, 'function', 'turn blocks carry onMouseEnter')
const blockColors = turnBlocks.map(b => b.args[1].style.background)
assert.ok(blockColors.every(c => typeof c === 'string' && c.length > 0), 'turn blocks carry a color')
assert.notEqual(blockColors[0], blockColors[1], 'consecutive turns get distinct colors')
assert.equal(turnBlocks[0].args[1].title, 'T1', 'turn blocks carry a full-label tooltip')
turnBlocks[0].args[1].onMouseEnter() // T1 (covers seq 1 and 2)
tr = renderView()
const inTurn = byClass(tr, 'lc-bar-in-turn')
assert.equal(inTurn.length, 2, 'hovering T1 highlights its two bars')
assert.deepEqual(inTurn.map(b => b.args[1].key), [1, 2], 'highlighted bars are seq 1 and 2')
const onBlocks = byClass(tr, 'lc-turn-on')
assert.equal(onBlocks.length, 1, 'exactly one turn block highlighted')
assert.equal(onBlocks[0].args[2], 'T1', 'highlighted block is T1')

// leaving the strip clears the turn highlight
const strip = byClass(tr, 'lc-turns')[0]
assert.equal(typeof strip.args[1].onMouseLeave, 'function', 'strip carries onMouseLeave')
strip.args[1].onMouseLeave()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar-in-turn').length, 0, 'leaving the strip clears bar highlights')

// hovering a bar highlights its turn block (bidirectional)
ctxSlots[3][1](3) // hover seq 3 (turn 2)
tr = renderView()
const onBlocks2 = byClass(tr, 'lc-turn-on')
assert.equal(onBlocks2.length, 1, 'bar hover highlights exactly one turn block')
assert.equal(onBlocks2[0].args[2], 'T2', 'hovering a bar highlights its turn block')
ctxSlots[3][1](null)

// ---- granularity toggle: one bar per step vs one bar per turn ----
let granBtns = byClass(tr, 'lc-gran-btn')
assert.equal(granBtns.length, 2, 'granularity toggle has two buttons')
assert.equal(granBtns[0].args[2], 'Step', 'first button is step granularity')
assert.equal(granBtns[1].args[2], 'Turn', 'second button is turn granularity')
assert.equal(byClass(tr, 'lc-gran-on').length, 1, 'step is active by default')
assert.equal(byClass(tr, 'lc-bar').length, 4, 'step mode: one bar per step')

// switch to turn granularity: the 4 steps collapse into 3 turn bars
granBtns[1].args[1].onClick()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 3, 'turn mode: one bar per turn')
assert.equal(byClass(tr, 'lc-turn').length, 3, 'turn strip still has one block per turn')
const turnOn = byClass(tr, 'lc-gran-on')
assert.equal(turnOn[0].args[2], 'Turn', 'turn button is active after switching')

// the turn bar carries the LAST step's info: hover T1's bar (seq 2, step 1)
const turnBars = byClass(tr, 'lc-bar')
const t1Bar = turnBars.find(b => b.args[1].key === 2)
assert.ok(t1Bar, 'T1 is aggregated into its last step (seq 2)')
t1Bar.args[1].onMouseEnter()
tr = renderView()
assert.match(detailStep(tr), /T1 · step 1/, 'turn bar shows the last step info')
ctxSlots[3][1](null)

// back to step granularity
granBtns = byClass(tr, 'lc-gran-btn')
granBtns[0].args[1].onClick()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 4, 'back to one bar per step')
assert.equal(byClass(tr, 'lc-gran-on')[0].args[2], 'Step', 'step button active again')

// ---- edge fades signal reachable history beyond the viewport ----
let scroller = byClass(tr, 'lc-chart-scroll')[0]
const fakeScroller = { scrollLeft: 200, clientWidth: 120, scrollWidth: 800 }
scroller.args[1].onScroll({ currentTarget: fakeScroller })
tr = renderView()
assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade shown while scrolled into history')
assert.equal(byClass(tr, 'lc-chart-fade-r').length, 1, 'right fade shown while more bars follow')
fakeScroller.scrollLeft = 680
scroller.args[1].onScroll({ currentTarget: fakeScroller })
tr = renderView()
assert.equal(byClass(tr, 'lc-chart-fade-r').length, 0, 'right fade gone at the right end')
assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade stays at the right end')
fakeScroller.scrollLeft = 0
scroller.args[1].onScroll({ currentTarget: fakeScroller })
tr = renderView()
assert.equal(byClass(tr, 'lc-chart-fade-l').length, 0, 'left fade gone at the start')

// ---- no 80-bar cap: every request the host sends is rendered ----
const bigRequests = []
for (let i = 0; i < 120; i++) {
  bigRequests.push({
    seq: 1000 + i, turn: 1 + Math.floor(i / 4), step: i % 4, time: 1000 * i,
    system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100,
  })
}
ctxSlots[0][1]({ ...snapshot, requests: bigRequests })
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 120, 'all requests render — earlier turns/steps stay reachable')
assert.equal(byClass(tr, 'lc-turn').length, 30, 'turn strip follows the full history')
ctxSlots[0][1](snapshot) // restore
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 4, 'snapshot restored')

console.log('✔ chart render test passed (fixed-width bars, scroll container, turn ranges, hover linking, overview tooltip, turn strip, granularity toggle, edge fades, full history)')

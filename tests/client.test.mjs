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

// The module table answers the platform seeds this bundle uses ('react' and
// the shared primitives singleton); everything else rides ctx or is inlined.
// Icons are stubbed as inert elements (glyph rendering is never asserted).
const fakePrimitives = {
  IconPlusOutline16: (p) => ({ kind: 'icon', name: 'IconPlusOutline16', props: p }),
  IconBranchOutline16: (p) => ({ kind: 'icon', name: 'IconBranchOutline16', props: p }),
}
const require = (spec) => {
  assert.ok(spec === 'react' || spec === '@deepseek-ai/dsh-client-ui-primitives',
    `bundle must only require platform modules (got "${spec}")`)
  return spec === 'react' ? fakeReact : fakePrimitives
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
assert.deepEqual(pluginExports.inject, ['slots', 'locale'])

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
  slots: {
    inject: (name, fn) => { slotInjections.push([name, fn]) },
    register: (opts, component) => {
      assert.equal(typeof component, 'function')
      return opts
    },
  },
}
pluginExports.apply(fakeCtx)

assert.equal(effects.length, 4, 'dictionaries + styles + loadOlderHistory prop + /context command effects')
assert.deepEqual(localeRegistrations[0][0], 'dsh-context')
assert.ok(localeRegistrations[0][1].zh && localeRegistrations[0][1].en, 'bilingual dicts')
const styleTag = registered.get('dsh-context')
assert.ok(styleTag, 'plugin-owned <style data-plugin="dsh-context"> injected')
assert.ok(styleTag.textContent.includes('.lc-root'), 'styles content present')
assert.ok(styleTag.textContent.includes('transition: background-color 120ms ease'), 'row hovers ease in/out')
assert.ok(styleTag.textContent.includes('transition: filter 120ms ease, opacity 120ms ease'), 'composition bar hover eases in/out')
assert.ok(styleTag.textContent.includes('lc-bar-tip-on'), 'composition tooltip fades in and out')
assert.ok(styleTag.textContent.includes('lc-occupied-box-on'), 'occupied frame fades in and out')
assert.equal(slotInjections.length, 2, 'view tab + input overlay injections')
assert.equal(slotInjections[0][0], 'conversation.view')
const registeredOpts = slotInjections[0][1]() // slots.inject callback returns the register result
assert.equal(registeredOpts.name, 'conversation.view')
assert.equal(registeredOpts.id, 'context')
assert.equal(registeredOpts.order, 20)
assert.equal(typeof registeredOpts.label, 'function')
assert.equal(registeredOpts.label(), '上下文', 'tab label localized')
assert.equal(slotInjections[1][0], 'conversation.input.overlay')
const overlayOpts = slotInjections[1][1]()
assert.equal(overlayOpts.name, 'conversation.input.overlay')
assert.equal(overlayOpts.id, 'context-modal')
assert.ok(typeof overlayOpts.inject === 'function', 'overlay injects the modal store hook')
const injected = overlayOpts.inject('s1')
assert.equal(typeof injected.hooks.contextModal.getSnapshot, 'function', 'hooks compartment carries the modal store')
assert.equal(injected.hooks.contextModal.getSnapshot(), false, 'modal closed initially')

// ---- /context command: the plugin's own '/' trigger source ----
// The first fake ctx has no inputTriggers service: the command effect must
// stay inert (soft dependency), which the apply above already proved by not
// throwing. Now apply again with the trigger service present.
{
  const sources = []
  let localeDict = null
  const ctx3 = {
    get: (name) => name === 'inputTriggers'
      ? { registerSource: (s) => { sources.push(s); return () => {} } }
      : undefined,
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (ns, dicts) => { localeDict = dicts.zh; return () => {} },
      bind: () => (key, vars) => {
        let s = localeDict !== null && localeDict[key] !== undefined ? localeDict[key] : key
        if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
        return s
      },
      subscribe: () => () => {},
    },
    slots: { inject: () => {}, register: () => ({}) },
  }
  pluginExports.apply(ctx3)
  assert.equal(sources.length, 1, 'one /context trigger source registered')
  const src = sources[0]
  assert.equal(src.trigger, '/')
  assert.equal(src.name, 'context')

  // Candidates: leading-only, prefix-filtered, description localized.
  const req = (query, position = 'leading') => ({ query, position, signal: new AbortController().signal })
  assert.deepEqual(await src.candidates({ sessionId: 's1' }, req('')), [{ name: 'context', description: '查看上下文的构成和变化' }])
  assert.deepEqual((await src.candidates({ sessionId: 's1' }, req('cont'))).length, 1, 'prefix match')
  assert.deepEqual(await src.candidates({ sessionId: 's1' }, req('xyz')), [], 'non-prefix miss')
  assert.deepEqual(await src.candidates({ sessionId: 's1' }, req('', 'inline')), [], 'inline positions never offer the command')

  // Menu pick: opens the session's modal and answers 'handled'; the token
  // stays in the composer while the modal is open (consumed on close).
  const outcome = src.onPick({ candidate: { name: 'context' }, session: { sessionId: 's1' }, position: 'leading', via: 'menu', span: { start: 0, end: 8, draftRev: 1 } })
  assert.equal(outcome, 'handled', 'menu pick is handled internally')
  assert.equal(injected.hooks.contextModal.getSnapshot(), true, 'menu pick opens the modal')

  // Bare enter: also 'handled' (nothing is submitted, the draft keeps the
  // token until the modal closes).
  assert.equal(await src.matchEnter({ sessionId: 's1' }, '/context', new AbortController().signal), 'handled', 'bare enter opens the modal without submitting')
  assert.equal(await src.matchEnter({ sessionId: 's1' }, '/context now', new AbortController().signal), undefined, 'argued lines miss')
  assert.equal(await src.matchEnter({ sessionId: 's1' }, '/compact', new AbortController().signal), undefined, 'other commands miss')
}

console.log('✔ client bundle test passed (handoff, require table, dicts, styles, slot registration, /context command)')

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
  useCallback: (fn) => fn,
  useState(init) {
    const i = hookCursor++
    const slots = currentHooks // captured by the setter: stable per fiber
    if (slots[i] === undefined) {
      const set = (v) => { slots[i][0] = typeof v === 'function' ? v(slots[i][0]) : v }
      slots[i] = [typeof init === 'function' ? init() : init, set]
    }
    return slots[i]
  },
  useEffect(fn) {
    // Store the callback in a hook slot (never auto-run) so tests can drive
    // effects explicitly, with the LATEST render's closure — like React.
    const i = hookCursor++
    if (currentHooks[i] === undefined) currentHooks[i] = { effect: undefined }
    currentHooks[i].effect = fn
    return currentHooks[i]
  },
  // Memo values are recomputed every render in tests (no staleness assertions).
  useMemo: (fn) => fn(),
  useRef(init) {
    // Like React: the SAME ref object is returned on every render (stored
    // in the fiber slot), so tree ref props and effect closures agree.
    const i = hookCursor++
    if (currentHooks[i] === undefined) currentHooks[i] = { ref: { current: init } }
    return currentHooks[i].ref
  },
  useLayoutEffect(fn) {
    // Store the callback in a hook slot so tests can drive the layout effect.
    // Always overwrite: real React runs the LATEST render's closure.
    const i = hookCursor++
    currentHooks[i] = { effect: fn }
    return currentHooks[i]
  },
}
const requireStateful = (spec) => {
  assert.ok(spec === 'react' || spec === '@deepseek-ai/dsh-client-ui-primitives',
    `bundle must only require platform modules (got "${spec}")`)
  return spec === 'react' ? statefulReact : fakePrimitives
}
const m2 = { exports: {} }
const pluginExports2 = factory(requireStateful, m2, globalThis.window, fakeDoc)

const DICT_FOR_TEST = { 'tab': 'Context', 'loading': '…', 'error': 'x', 'detail.step': 'Turn {t} · Step {s}', 'gran.step': 'Step', 'gran.turn': 'Turn', 'detail.turn': 'Turn {t} · {n} steps', 'detail.lastStep': 'last step', 'overview.used': 'of context used', 'overview.free': 'Free window', 'events.at': 'Turn {t} · Step {s}', 'events.range': 'Turn {t} · Step {a}→{b}', 'events.rangeTo': 'Turn {a} · Step {as} → Turn {b} · Step {bs}', 'stats.recycleSub': '{c} compactions · {p} prunes', 'tip.step': 'Turn {t} · Step {s}', 'tip.turn': 'Turn {t} · {n} steps', 'tip.total': 'total ≈ {n}', 'tip.actual': ' (actual {n})', 'trend.title': 'History', 'trend.empty': 'empty trend', 'cmd.close': 'Close', 'cat.user': 'User', 'browser.live': 'Live (next request)', 'browser.liveNow': 'Live · next request', 'browser.items': '{n} items', 'browser.noContent': 'outside the loaded window', 'browser.loading': 'loading older history', 'browser.preview': 'preview', 'browser.noHeader': 'older plugin build', 'tool.desc': 'Description', 'tool.params': 'Parameters', 'tool.paramsEmpty': '(no parameters)', 'tool.jsonToggle': 'View Raw JSON', 'tool.jsonHide': 'Collapse' }
let viewComponent = null
let modalComponent = null
let modalSource = null
const bailCalls = []
const provideDescriptors = []
const fakeCtx2 = {
  get: (name) => {
    if (name === 'inputTriggers') return { registerSource: (s) => { modalSource = s; return () => {} } }
    if (name === 'sessions') return {
      scope: (id) => id === 's1' ? { bail: (...args) => { bailCalls.push(args); return true } } : undefined,
      provide: (d) => { provideDescriptors.push(d); return () => {} },
    }
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
  locale: {
    register: () => () => {},
    bind: () => (key, vars) => {
      let s = DICT_FOR_TEST[key] !== undefined ? DICT_FOR_TEST[key] : key
      if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
      return s
    },
  },
  slots: {
    inject: (name, fn) => { fn() }, // the register call inside captures the component
    register: (opts, component) => {
      if (opts.name === 'conversation.view') viewComponent = component
      if (opts.name === 'conversation.input.overlay') modalComponent = component
      return opts
    },
  },
}
pluginExports2.apply(fakeCtx2)
assert.ok(viewComponent !== null, 'view component captured')

// The loadOlderHistory contribution rides the harness's sessions.provide
// channel: one declared prop, resolved per session to the session's own
// history-pagination verb.
assert.equal(provideDescriptors.length, 1, 'one sessions.provide contribution registered')
assert.deepEqual(provideDescriptors[0].props, ['loadOlderHistory'], 'the contributed prop is loadOlderHistory')
{
  let olderPulled = 0
  const contribution = provideDescriptors[0].resolve({ session: { loadOlder: async () => { olderPulled += 1 } } })
  assert.equal(typeof contribution.props.loadOlderHistory, 'function', 'resolved prop is a function')
  await contribution.props.loadOlderHistory()
  assert.equal(olderPulled, 1, 'the prop delegates to session.loadOlder()')
}

// The framework standard kit delivers the context timeline as a push-fed
// projection (`useProjection('contextTimeline')`) and the official
// token-meter occupancy as another (`useProjection('contextPressure')`); the
// test drives renders by swapping the holders the stub reads, exactly like
// session/projection frames.
let dataValue = null
let pressureValue = undefined
let headersValue = undefined
// Optional session-snapshot hook + pagination verb holders: undefined until
// the auto-load test arms them, so every earlier render exercises the
// no-`useSession` degradation exactly as before.
let useSessionHolder = undefined
let loadOlderHolder = undefined
const renderView = () => evaluate(viewComponent({
  sessionId: 's1',
  useProjection: (key) => (key === 'contextTimeline' ? dataValue
    : (key === 'contextPressure' ? pressureValue
      : (key === 'contextHeaders' ? headersValue : undefined))),
  useSession: useSessionHolder,
  loadOlderHistory: loadOlderHolder,
}))

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

// Render 1 (no value yet): creates the ContextView hook slots and shows loading.
renderView()
const snapshot = {
  ok: true, model: 'deepseek-v4', provider: 'deepseek', contextWindow: 128000,
  current: { system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100 },
  toolList: [], requests: [
    { seq: 1, turn: 1, step: 0, time: 1000, system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100, prompt: 95 },
    { seq: 2, turn: 1, step: 1, time: 2000, system: 10, tools: 20, user: 25, inject: 5, assistant: 10, tool: 20, total: 90 },
    { seq: 3, turn: 2, step: 0, time: 3000, system: 10, tools: 20, user: 40, inject: 5, assistant: 12, tool: 20, total: 107 },
    { seq: 4, turn: 3, step: 0, time: 4000, system: 10, tools: 20, user: 20, inject: 5, assistant: 8, tool: 20, total: 83, prompt: 83000 },
  ],
  events: [], nodes: [
    { seq: 1, cat: 'user', tokens: 10, text: 'first message', time: 1000 },
    { seq: 2, cat: 'assistant', tokens: 20, text: 'second message', time: 65000 },
  ], droppedNodes: 0,
}
// Deliver the timeline like a session/projection frame: swap the holder the
// useProjection stub reads, then re-render the view.
const ctxKey = [...hookStates.keys()].find(k => k.includes('ContextView'))
assert.ok(ctxKey, 'ContextView fiber registered')
dataValue = snapshot
const tree = renderView()

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

// ---- context stats board: totals over the retained window ----
// fixture: 4 requests (turns 1,1,2,3), no events yet -> all event counters 0.
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const statVals = byClass(tree, 'lc-stat-value').map(n => n.args[2])
assert.equal(statVals.length, 5, 'five stats cells (turns / steps / injections / compactions / prunes)')
assert.equal(statVals[0], '3', 'turns counted by distinct turn')
assert.equal(statVals[1], '4', 'steps = request count')
assert.equal(statVals[2], '0', 'no injections yet')
assert.equal(statVals[3], '0', 'no compactions yet')
assert.equal(statVals[4], '0', 'no prunes yet')

// ---- plugin info card: two full-width rows; every row is itself a link ----
function plainText(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (node.kind === 'element') return node.args.slice(2).map(plainText).join('')
  if (Array.isArray(node)) return node.map(plainText).join('')
  return ''
}
const piLabels = byClass(tree, 'lc-pi-label').map(n => n.args[2])
const piValues = byClass(tree, 'lc-pi-value').map(n => n.args[2])
const piGrid = byClass(tree, 'lc-pi-grid')
assert.equal(piGrid.length, 1, 'plugin info rendered as one grid')
assert.equal(piLabels.length, 2, 'plugin info: two rows (Plugin / GitHub)')
assert.equal(plainText(piValues[0]), 'dsh-context (v' + pkg.version + ')', 'Plugin row combines package id + version (update chip only after the npm check resolves)')
assert.equal(plainText(piValues[1]), 'bowenliang123/dsh-context', 'GitHub row shows the short owner/repo')

// Each row IS the link — Plugin goes to the repo's releases page, GitHub to
// the repo root.
const linkRows = byClass(tree, 'lc-pi-row')
assert.equal(linkRows.length, 2, 'every row is a whole-row link')
assert.equal(linkRows[0].args[1].href, 'https://github.com/bowenliang123/dsh-context/releases', 'Plugin → GitHub releases page')
assert.equal(linkRows[1].args[1].href, 'https://github.com/bowenliang123/dsh-context', 'GitHub → GitHub repo')
// Hover affordance is CSS-driven (row-level `:hover` underlines the value);
// no JS state needed, so no onMouseEnter/onMouseLeave handlers.

// ---- hover linking: hovering a trend bar updates the detail below ----
const ctxSlots = hookStates.get(ctxKey) // selected(0) hovered(1) hoverTurn(2) tick(3) gran(4) hoverCat(5)
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
assert.match(detailStep(tr), /Turn 3/, 'detail defaults to the newest request (Turn 3)')
assert.equal(byClass(tr, 'lc-bar-hovered').length, 0, 'no hovered bar initially')

ctxSlots[1][1](3) // setHoveredSeq(seq 3, turn 2)
tr = renderView()
assert.match(detailStep(tr), /Turn 2/, 'hovering a bar links the detail below to it')
const hovered = byClass(tr, 'lc-bar-hovered')
assert.equal(hovered.length, 1, 'exactly one hovered bar')
assert.equal(hovered[0].args[1].key, 3, 'hovered bar is seq 3')
const bar3 = byClass(tr, 'lc-bar').find(b => b.args[1].key === 3)
assert.equal(typeof bar3.args[1].onMouseEnter, 'function', 'bars carry onMouseEnter')
assert.equal(typeof bar3.args[1].onClick, 'function', 'bars carry onClick')
// the instant custom tooltip replaces the delayed native title
const chartTip = byClass(tr, 'lc-chart-tip')
assert.equal(chartTip.length, 1, 'hovering shows the custom tooltip immediately')
assert.match(textOf(chartTip[0]), /Turn 2 · Step 0/, 'tooltip names the hovered request')
assert.match(textOf(chartTip[0]), /total ≈ 107/, 'tooltip carries the estimated total')
assert.equal(typeof chartTip[0].args[1].style.left, 'string', 'tooltip is positioned at the bar column')
// turn-aware dimming: the chart is in dim mode while a turn is focused
assert.equal(byClass(tr, 'lc-chart-dim').length, 1, 'bar hover activates the turn-aware dim')

ctxSlots[1][1](null) // leave the plot
tr = renderView()
assert.match(detailStep(tr), /Turn 3/, 'leaving the plot reverts the detail to the newest request')
assert.equal(byClass(tr, 'lc-chart-tip').length, 0, 'tooltip clears with the hover')
assert.equal(byClass(tr, 'lc-chart-dim').length, 0, 'dim clears with the hover')

// ---- overview stacked bar: themed hover tooltip per segment ----
const overviewStack = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
assert.ok(overviewStack, 'overview stacked bar present')
const segment = overviewStack.args.slice(2).flat().find(s => s !== null)
assert.ok(segment, 'overview has segments')
assert.equal(segment.args[1].title, undefined, 'native title replaced by the custom tooltip')
assert.equal(typeof segment.args[1].onMouseEnter, 'function', 'segments carry onMouseEnter')
segment.args[1].onMouseEnter({ clientX: 120 }) // fake pointer; ref is null in tests -> centered fallback
tr = renderView()
const tip = byClass(tr, 'lc-bar-tip-on')
assert.equal(tip.length, 1, 'hovering a segment shows the tooltip')
assert.match(textOf(tip[0]), /\(10%\)/, 'tooltip shows the segment share of the total')
// The occupied-region reference frame appears on hover (there is a free
// track here, so the legend % refers to the boxed part, not the bar width).
assert.equal(byClass(tr, 'lc-occupied-box-on').length, 1, 'hovered segment frames the occupied region')
const occBox = byClass(tr, 'lc-occupied-box-on')[0]
assert.equal(typeof occBox.args[1].style.width, 'string', 'frame width follows the used share')
assert.equal(typeof tip[0].args[1].style.left, 'string', 'tooltip is positioned along the pointer')

// ---- composition bar hover highlights the matching legend chip (and back) ----
// the tooltip test above left the first segment hovered -> its chip is on
let chipsOn = byClass(tr, 'lc-chip-on')
assert.equal(chipsOn.length, 1, 'hovered segment highlights its legend chip')
const chip0 = byClass(tr, 'lc-chip')[0]
assert.equal(typeof chip0.args[1].onMouseEnter, 'function', 'legend chips carry onMouseEnter')
chip0.args[1].onMouseEnter()
tr = renderView()
assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 2, 'hovering a chip highlights its segment (overview + mirrored browser bar)')
assert.equal(byClass(tr, 'lc-bar-tip-on').length, 1, 'hovering a chip also shows the tooltip above its segment')
assert.match(textOf(byClass(tr, 'lc-bar-tip-on')[0]), /\(10%\)/, 'chip-driven tooltip carries the share')
chip0.args[1].onMouseLeave()
tr = renderView()
assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'leaving the chip clears the segment highlight')
assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'leaving the chip clears the chip highlight')
assert.equal(byClass(tr, 'lc-bar-tip-on').length, 0, 'leaving the chip fades the tooltip out')
// segment -> chip, on a different category
const seg1 = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
  .args.slice(2).flat().filter(s => s !== null)[1]
seg1.args[1].onMouseEnter({ clientX: 80 })
tr = renderView()
const chipsOn2 = byClass(tr, 'lc-chip-on')
assert.equal(chipsOn2.length, 1, 'hovering another segment moves the chip highlight')
assert.equal(chipsOn2[0].args[3], byClass(tr, 'lc-chip')[1].args[3], 'the matching chip is highlighted')
assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 2, 'the hovered segment is marked (overview + mirrored browser bar)')

// ---- the free window space (blank track) is hoverable too ----
// fixture: window 128000 vs anchored occupancy 83017 -> 44983 free (35%)
const freeSeg = byClass(tr, 'lc-stacked-free')[0]
assert.ok(freeSeg, 'free window segment present when contextWindow > usage')
assert.equal(typeof freeSeg.args[1].onMouseEnter, 'function', 'free segment carries onMouseEnter')
freeSeg.args[1].onMouseEnter()
tr = renderView()
const freeTip = byClass(tr, 'lc-bar-tip-on')
assert.equal(freeTip.length, 1, 'hovering the blank space shows the tooltip')
assert.equal(byClass(tr, 'lc-occupied-box-on').length, 1, 'hovering the free track still frames the occupied region')
assert.match(textOf(freeTip[0]), /Free window 45\.0k \(35%\)/, 'tooltip names the free window and its share')
assert.equal(byClass(tr, 'lc-stacked-free-on').length, 1, 'free segment highlights on hover')
assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'no legend chip matches the free space')
const stackEl = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
stackEl.args[1].onMouseLeave()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar-tip-on').length, 0, 'leaving the stack fades the free tooltip out')
assert.equal(byClass(tr, 'lc-occupied-box-on').length, 0, 'leaving the stack fades the occupied frame out')

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
assert.equal(byClass(tr, 'lc-chart-dim').length, 1, 'strip hover also dims bars outside the turn')

// leaving the strip clears the turn highlight
const strip = byClass(tr, 'lc-turns')[0]
assert.equal(typeof strip.args[1].onMouseLeave, 'function', 'strip carries onMouseLeave')
strip.args[1].onMouseLeave()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar-in-turn').length, 0, 'leaving the strip clears bar highlights')
assert.equal(byClass(tr, 'lc-chart-dim').length, 0, 'leaving the strip clears the dim')

// hovering a bar highlights its turn block (bidirectional)
ctxSlots[1][1](3) // hover seq 3 (turn 2)
tr = renderView()
const onBlocks2 = byClass(tr, 'lc-turn-on')
assert.equal(onBlocks2.length, 1, 'bar hover highlights exactly one turn block')
assert.equal(onBlocks2[0].args[2], 'T2', 'hovering a bar highlights its turn block')
ctxSlots[1][1](null)

// ---- granularity toggle: one bar per step vs one bar per turn ----
// the trend card scopes its own toggle row: the events card kind toggles
// reuse the pill-button classes, so address the row, not the buttons.
const granRow = () => byClass(tr, 'lc-gran')[0].args.slice(2)
const onBtns = (row) => row.filter(b => String(b.args[1].className || '').includes('lc-gran-on'))
let granBtns = granRow()
assert.equal(granBtns.length, 2, 'granularity toggle has two buttons')
assert.equal(granBtns[0].args[2], 'Step', 'first button is step granularity')
assert.equal(granBtns[1].args[2], 'Turn', 'second button is turn granularity')
assert.equal(onBtns(granRow()).length, 1, 'step is active by default')
assert.equal(byClass(tr, 'lc-bar').length, 4, 'step mode: one bar per step')

// switch to turn granularity: the 4 steps collapse into 3 turn bars
granBtns[1].args[1].onClick()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 3, 'turn mode: one bar per turn')
assert.equal(byClass(tr, 'lc-turn').length, 3, 'turn strip still has one block per turn')
const turnOn = onBtns(granRow())
assert.equal(turnOn[0].args[2], 'Turn', 'turn button is active after switching')

// turn bars keep the uniform column width and align with their strip blocks
const turnBars = byClass(tr, 'lc-bar')
const t1Bar = turnBars.find(b => b.args[1].key === 2)
assert.ok(t1Bar, 'T1 is aggregated into its last step (seq 2)')
for (const b of turnBars) assert.equal(b.args[1].style.width, '14px', 'every turn bar keeps the uniform column width')
const turnBlocks2 = byClass(tr, 'lc-turn')
for (const blk of turnBlocks2) assert.equal(blk.args[1].style.width, '14px', 'every turn block matches the bar width (aligned)')
assert.equal(turnBlocks2[0].args[1].style.width, t1Bar.args[1].style.width, 'T1 bar and block align 1:1')

// the turn detail is labeled with the step count and tagged as the last step
t1Bar.args[1].onMouseEnter()
tr = renderView()
assert.match(detailStep(tr), /Turn 1 · 2 steps/, 'turn detail shows the step count, not a bare step number')
assert.equal(byClass(tr, 'lc-detail-tag').length, 1, 'the last-step tag marks the shown breakdown')
assert.equal(byClass(tr, 'lc-detail-tag')[0].args[2], 'last step', 'tag text localized')
ctxSlots[1][1](null)

// back to step granularity
granBtns = granRow()
granBtns[0].args[1].onClick()
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 4, 'back to one bar per step')
assert.equal(onBtns(granRow())[0].args[2], 'Step', 'step button active again')

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
dataValue = { ...snapshot, requests: bigRequests }
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 120, 'all requests render — earlier turns/steps stay reachable')
assert.equal(byClass(tr, 'lc-turn').length, 30, 'turn strip follows the full history')
dataValue = snapshot
tr = renderView()
assert.equal(byClass(tr, 'lc-bar').length, 4, 'snapshot restored')

// ---- default anchor: the newest bars sit at the right edge ----
const scrollNode = byClass(tr, 'lc-chart-scroll')[0]
const scrollEl = { scrollLeft: 0, clientWidth: 120, scrollWidth: 800 }
scrollNode.args[1].ref.current = scrollEl // attach a fake layout element
const trendKey = [...hookStates.keys()].find(k => k.includes('TrendChart'))
assert.ok(trendKey, 'TrendChart fiber registered')
const layoutEffectSlot = hookStates.get(trendKey).find(s => s && typeof s.effect === 'function')
assert.ok(layoutEffectSlot, 'chart layout effect captured')
layoutEffectSlot.effect()
assert.equal(scrollEl.scrollLeft, 800, 'initial layout anchors at the right (newest bars)')
scrollEl.scrollLeft = 200
layoutEffectSlot.effect()
assert.equal(scrollEl.scrollLeft, 200, 'scrolling away from the end is respected')
scrollEl.scrollLeft = 780
layoutEffectSlot.effect()
assert.equal(scrollEl.scrollLeft, 800, 'stays anchored at the end while near it')
tr = renderView()
assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade shown once anchored at the newest bars')
assert.equal(byClass(tr, 'lc-chart-fade-r').length, 0, 'no right fade at the end')

// ---- granularity switches re-anchor at the newest bars ----
// (the turn->step report: returning to step must show the right edge)
const latestEffect = () => hookStates.get(trendKey).find(s => s && typeof s.effect === 'function')
scrollEl.scrollLeft = 0 // stale left edge from the narrow turn chart
const granTurnBtn = granRow()[1]
granTurnBtn.args[1].onClick() // step -> turn
tr = renderView()
latestEffect().effect()
assert.equal(scrollEl.scrollLeft, 800, 'switching to turn re-anchors at the newest bars')
scrollEl.scrollLeft = 0
const granStepBtn = granRow()[0]
granStepBtn.args[1].onClick() // turn -> step
tr = renderView()
latestEffect().effect()
assert.equal(scrollEl.scrollLeft, 800, 'switching back to step re-anchors at the newest bars')
// a plain re-render (poll) without a switch must NOT yank a scrolled-away view
scrollEl.scrollLeft = 200
latestEffect().effect()
assert.equal(scrollEl.scrollLeft, 200, 'plain re-renders still respect the scroll position')

// ---- message list: newest first, with timestamps when available ----
const nodeRows = byClass(tr, 'lc-node')
assert.equal(nodeRows.length, 2, 'message rows rendered')
assert.equal(nodeRows[0].args[1].key, 2, 'newest message on top')
assert.equal(nodeRows[1].args[1].key, 1, 'older message below')
const nodeTimes = byClass(tr, 'lc-node-time')
assert.equal(nodeTimes.length, 2, 'timestamps shown for every node')
// fmtTime renders LOCAL time; mirror the same formatting for expectations.
const fmtTimeLocal = (t) => {
  const d = new Date(t)
  const p = (x) => (x < 10 ? '0' : '') + x
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
assert.equal(nodeTimes[0].args[2], fmtTimeLocal(65000), 'formatted time (65000ms)')
assert.equal(nodeTimes[1].args[2], fmtTimeLocal(1000), 'formatted time (1000ms)')

// ---- context events show where they sit in the request timeline ----
// The host sends events oldest->newest; the list reverses them. Boundary
// events (compaction/prune) show the GAP between the request before and the
// request after (same-turn "Step a→b", cross-turn "Turn a·s → Turn b·s");
// inject/model switches keep the single point of the request they belong
// to; events with no following request (in flight) stay bare. The same
// attachment drives the ✂ marker and the detail header chip.
dataValue = {
  ...snapshot,
  events: [
    { seq: 3, kind: 'compaction', time: 1200, tokens: 900, count: 2, fromTurn: 1, fromStep: 0, turn: 2, step: 0 }, // attaches to request seq 3 (Turn 2 · Step 0)
    { seq: 6, kind: 'prune', time: 1500, tokens: 60, fromTurn: 1, fromStep: 0, turn: 1, step: 1 },
    { seq: 7, kind: 'prune', time: 2000, tokens: 100, fromTurn: 1, fromStep: 1, turn: 2, step: 0 },
    { seq: 8, kind: 'model', time: 3000, from: 'a', to: 'b', turn: 1, step: 1 },
    { seq: 9, kind: 'inject', time: 4000, tokens: 5, form: 'notice', turn: 2, step: 0 },
    { seq: 10, kind: 'compaction', time: 5000, tokens: 5000, count: 4, fromTurn: 2, fromStep: 0 }, // no request after -> unlabeled
  ],
}
tr = renderView()
const evRows = byClass(tr, 'lc-event')
assert.equal(evRows.length, 6, 'event rows rendered newest first')
const kindChips = byClass(tr, 'lc-kind')
assert.equal(kindChips.length, 6, 'every event row carries a kind chip (注入/压缩/剪枝/切换)')
const atLabels = byClass(tr, 'lc-event-at')
assert.equal(atLabels.length, 5, 'boundary + single-point events carry labels; in-flight stays bare')
assert.equal(atLabels[0].args[2], 'Turn 2 · Step 0', 'inject keeps the single point of the request it fed')
assert.equal(atLabels[1].args[2], 'Turn 1 · Step 1', 'model switch keeps the single point')
assert.equal(atLabels[2].args[2], 'Turn 1 · Step 1 → Turn 2 · Step 0', 'cross-turn boundary shows the gap')
assert.equal(atLabels[3].args[2], 'Turn 1 · Step 0→1', 'same-turn boundary compresses to a step range')
assert.equal(atLabels[4].args[2], 'Turn 1 · Step 0 → Turn 2 · Step 0', 'oldest boundary event shows its gap')

// the events card header carries the four kind buttons as a picker, all
// picked by default: clicking an unpicked kind adds it (A -> A+B -> ...),
// clicking a picked one removes it, clicking the last one resets to all
let kindsRow = byClass(tr, 'lc-kinds')
assert.equal(kindsRow.length, 1, 'events card shows the kind buttons inline')
const kindBtns = () => byClass(tr, 'lc-kinds')[0].args.slice(2)
assert.equal(kindBtns().length, 4, 'four kind buttons (注入/压缩/剪枝/切换)')
assert.equal(onBtns(kindBtns()).length, 4, 'all four kinds are picked by default')
assert.equal(byClass(tr, 'lc-event').length, 6, 'default shows every event')
const click = (i) => { kindBtns()[i].args[1].onClick(); tr = renderView() }
click(0) // pick-only 注入
assert.equal(byClass(tr, 'lc-event').length, 1, 'clicking 注入 among all shows only injections')
assert.ok(String(kindBtns()[0].args[1].className || '').includes('lc-gran-on'), 'picked button is highlighted')
assert.ok(String(kindBtns()[0].args[1].className || '').includes('lc-kind-inject'), 'highlight carries the kind color')
assert.equal(onBtns(kindBtns()).length, 1, 'the other three turned off')
click(1) // add 压缩
assert.equal(byClass(tr, 'lc-event').length, 3, 'adding 压缩 shows 注入 + 压缩')
click(2) // add 剪枝
assert.equal(byClass(tr, 'lc-event').length, 5, 'adding 剪枝 shows 注入 + 压缩 + 剪枝')
click(0) // remove 注入
assert.equal(byClass(tr, 'lc-event').length, 4, 'removing 注入 leaves 压缩 + 剪枝')
click(3) // add 切换
assert.equal(byClass(tr, 'lc-event').length, 5, 'adding 切换 shows 压缩 + 剪枝 + 切换')
click(1); click(2) // remove 压缩 and 剪枝
assert.equal(byClass(tr, 'lc-event').length, 1, 'only 切换 stays picked')
click(3) // remove the last one -> reset to all
assert.equal(byClass(tr, 'lc-event').length, 6, 'removing the last picked kind restores all')
assert.equal(onBtns(kindBtns()).length, 4, 'all four kinds picked again')

// the stats board picks up the event counters
const statVals2 = byClass(tr, 'lc-stat-value').map(n => n.args[2])
assert.equal(statVals2[2], '1', 'one injection counted')
assert.equal(statVals2[3], '2', 'two compactions counted')
assert.equal(statVals2[4], '2', 'two prunes counted')

// the ✂ marker sits on the bar it attaches to and tooltips the event gap
const barMark = byClass(tr, 'lc-bar-marker')
assert.equal(barMark.length, 1, 'one ✂ marker on the attached bar')
assert.match(barMark[0].args[1].title, /Turn 1 · Step 0 → Turn 2 · Step 0/, '✂ tooltip carries the event gap')

// the detail header shows the same gap as a chip when that bar is active
ctxSlots[1][1](3) // hover the attached bar (seq 3, Turn 2 · Step 0)
tr = renderView()
const markerChip = byClass(tr, 'lc-detail-marker')
assert.equal(markerChip.length, 1, 'detail header shows the attached boundary event')
assert.equal(markerChip[0].args[2], '✂ Turn 1 · Step 0 → Turn 2 · Step 0', 'chip shows the event gap')
assert.equal(typeof markerChip[0].args[1].title, 'string', 'chip tooltips the event text')
ctxSlots[1][1](null) // leave the plot
tr = renderView()
assert.equal(byClass(tr, 'lc-detail-marker').length, 0, 'chip clears with the hover')
dataValue = snapshot
tr = renderView()
assert.equal(byClass(tr, 'lc-event').length, 0, 'event list restored to the empty state')

// ---- overview headline is the provider-based occupancy (like the chat
// ring); the composition is anchored to it, proportions stay heuristic ----
// fixture (no `contextPressure` projection -> derived fallback): last request
// prompt 83000, last total 83, current total 100, window 128000
// -> occupancy = 83000 + (100 - 83) = 83017 (65%), raw heuristic = 100.
const overviewNum = byClass(tr, 'lc-overview-num')[0]
assert.ok(overviewNum, 'overview number row present')
assert.match(textOf(overviewNum), /83\.0k/, 'headline shows the provider-based occupancy')
assert.match(textOf(overviewNum), /\/ 128\.0k tokens/, 'window shown next to the occupancy')
assert.match(textOf(overviewNum), /65%/, 'occupancy percent is the emphasized figure of the line')
assert.ok(!/~65%/.test(textOf(overviewNum)), 'no conflicting heuristic percentage next to the headline')

// ---- the OFFICIAL token-meter `contextPressure` projection wins over the
// derived fallback (the chat ring's own value, read as a second projection) ----
pressureValue = { pressureTokens: 90000, projectedTokens: 90010, contextWindow: 200000 }
tr = renderView()
const overviewNum2 = byClass(tr, 'lc-overview-num')[0]
assert.match(textOf(overviewNum2), /90\.0k/, 'official contextPressure projection is the headline when present')
assert.match(textOf(overviewNum2), /45%/, 'contextPressure window is the percent denominator')
pressureValue = undefined
dataValue = snapshot
tr = renderView()

console.log('✔ chart render test passed (context stats board, free window hover, fixed-width bars, scroll container, turn ranges, hover linking, overview tooltip, turn strip, granularity toggle, edge fades, full history, right-anchored default, message times, event range labels, detail marker chip, overview actual)')

// ---- Context browser card: step picker + category accordion + element
// content. Fixture: the snapshot's two live nodes (seq 1 user, seq 2
// assistant) plus one archived (removed) node that was still alive at the
// early steps; one header epoch with full prompt/schema content. ----
dataValue = {
  ...snapshot,
  archive: [{ seq: 0, cat: 'user', tokens: 5, text: 'archived message', gone: 3, time: 500 }],
}
headersValue = {
  headers: [{
    seq: 1, time: 900, system: 'SYSTEM-PROMPT-TEXT',
    // Listed in producer order (tiny BEFORE bash) — the tools section must
    // re-rank them by token price, largest first. `bash` carries a real
    // JSON-Schema parameter object so the parsed parameter table has rows
    // to render; `tiny` ships an empty-parameter schema (table falls back
    // to the "no parameters" line).
    tools: [
      { name: 'tiny', tokens: 2, description: 'a tiny helper', schema: { name: 'tiny', parameters: { type: 'object' } } },
      {
        name: 'bash', tokens: 5, description: 'run a command',
        schema: {
          name: 'bash',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'shell command to run' },
              cwd: { type: 'string', description: 'working directory' },
              timeout: { type: 'number' },
              flags: {
                type: 'array',
                items: { type: 'string' },
                description: 'extra flags',
              },
            },
            required: ['command'],
          },
        },
      },
    ],
  }],
}
tr = renderView()
const brKey = [...hookStates.keys()].find(k => k.includes('ContextBrowser'))
assert.ok(brKey, 'ContextBrowser fiber registered')
const brSlots = hookStates.get(brKey) // sel(0) openCat(1) openElem(2)

// Live view (default): six category rows; message counts follow the live nodes.
assert.equal(byClass(tr, 'lc-br-cat-row').length, 6, 'six category sections (system/tools + four message cats)')
assert.equal(byClass(tr, 'lc-br-pick').length, 1, 'step picker present')
const pickOptions = byClass(tr, 'lc-br-pick')[0].args.slice(2).flat()
assert.equal(pickOptions.length, 5, 'picker lists live + one option per retained step')
assert.equal(byClass(tr, 'lc-br-body').length, 0, 'all categories collapsed by default (no flat dump)')

// Open the user category -> one live element row; open the element -> content
// falls back to the preview + the window note (no useSession in this harness).
const catRowOf = (label) => byClass(tr, 'lc-br-cat-row').find(r => textOf(r).includes(label))
assert.ok(catRowOf('User'), 'user category row present')
brSlots[1][1]('user') // openCat('user')
tr = renderView()
assert.equal(byClass(tr, 'lc-br-body').length, 1, 'one category body open')
assert.equal(byClass(tr, 'lc-br-elem-row').length, 1, 'live view lists the live user node')
brSlots[2][1]('n1') // openElem(seq 1)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-content').length, 1, 'element content area open')
assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /first message/, 'content falls back to the node preview')
assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /outside the loaded window/, 'window note follows the fallback preview')

// Pick step seq 2 (Turn 1 · Step 1): the reconstruction includes the archived
// node (gone 3 > 2) — the accordion resets on picking, so reopen the category.
byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: '2' } })
tr = renderView()
assert.equal(byClass(tr, 'lc-br-body').length, 0, 'picking a step collapses the accordion')
brSlots[1][1]('user')
tr = renderView()
assert.equal(byClass(tr, 'lc-br-elem-row').length, 2, 'a past step reconstructs archived + live nodes')
assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /archived message/, 'the archived node appears in its step')

// The live view must NOT show the archived node.
byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: 'live' } })
tr = renderView()
brSlots[1][1]('user')
tr = renderView()
assert.equal(byClass(tr, 'lc-br-elem-row').length, 1, 'live view excludes removed nodes')

// Header content sections: the system prompt and tool schemas ride the
// contextHeaders projection (full content, not just prices).
brSlots[1][1]('system')
tr = renderView()
brSlots[2][1]('sys')
tr = renderView()
assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /SYSTEM-PROMPT-TEXT/, 'system section shows the full prompt')
brSlots[1][1]('tools')
tr = renderView()
assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /bash/, 'tools section lists the schema rows')
const toolRowOrder = byClass(tr, 'lc-br-elem-row').map(r => textOf(r))
assert.equal(toolRowOrder.length, 2, 'both schemas listed')
assert.match(toolRowOrder[0], /bash/, 'tools ranked by tokens: largest first')
assert.match(toolRowOrder[1], /tiny/, 'tools ranked by tokens: smallest last')
brSlots[2][1]('tool:bash')
tr = renderView()
const toolContent = textOf(byClass(tr, 'lc-br-content')[0])
assert.match(toolContent, /run a command/, 'tool row expands to its description')
// The description sits inside its own titled card, with a "Description" head
// and a body carrying the prose — the same chrome the parameter table uses.
const descCards = byClass(tr, 'lc-ts-card').filter(c => {
  const head = byClass(c, 'lc-ts-card-head')[0]
  return head !== undefined && textOf(head).includes('Description')
})
assert.equal(descCards.length, 1, 'description is rendered inside a titled card')
assert.match(textOf(byClass(descCards[0], 'lc-ts-desc-body')[0]), /run a command/, 'description card body carries the prose')
// Parsed parameter table sits above the (still-collapsed) raw JSON: one row
// per declared property, type labels carry the JSON-Schema type, required
// ones marked with ✓, descriptions shown on a second line.
const paramRows = byClass(tr, 'lc-ts-param-row')
assert.equal(paramRows.length, 4, 'parameter table renders one row per property')
const bashRowText = paramRows.map(r => textOf(r))
assert.ok(bashRowText.some(s => /command/.test(s) && /string/.test(s) && /shell command to run/.test(s)),
  'command row carries name + type + description')
assert.ok(bashRowText.some(s => /command/.test(s) && /✓/.test(s)),
  'command is marked required')
assert.ok(bashRowText.some(s => /timeout/.test(s) && /number/.test(s) && !/✓/.test(s)),
  'optional property shows type without the required mark')
assert.ok(bashRowText.some(s => /flags/.test(s) && /array<string>/.test(s)),
  'array parameters render their element type')
// Raw JSON is collapsed by default — the toggle is visible but the schema
// string does NOT appear in the rendered text yet.
assert.equal(byClass(tr, 'lc-br-pre').filter(n => /"parameters"/.test(textOf(n))).length, 0,
  'raw JSON stays collapsed behind the toggle by default')
const toggle = byClass(tr, 'lc-ts-json-toggle')[0]
assert.ok(toggle, 'JSON toggle button is rendered')
assert.match(textOf(toggle), /View Raw JSON|查看原始 JSON/, 'toggle shows the open label')
// Expanding the toggle reveals the schema; clicking again collapses it.
toggle.args[1].onClick()
tr = renderView()
assert.match(textOf(byClass(tr, 'lc-br-pre')[0]), /"parameters"/, 'expanding reveals the raw JSON')
const collapseToggle = byClass(tr, 'lc-ts-json-toggle')[0]
assert.match(textOf(collapseToggle), /Collapse|收起/, 'toggle label flips to the hide label')
collapseToggle.args[1].onClick()
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pre').length, 0, 'collapsing the toggle removes the JSON block')

// Without the contextHeaders key (older host), those sections degrade to a note.
headersValue = undefined
brSlots[1][1]('system')
brSlots[2][1](null)
tr = renderView()
assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /older plugin build/, 'absent headers projection degrades gracefully')
brSlots[1][1](null)
dataValue = snapshot
tr = renderView()

console.log('✔ context browser test passed (picker, category accordion, per-step reconstruction, archived nodes, header content, graceful degradation)')

// ---- trend-chart hover linkage: the bar under the pointer transiently
// previews its step in the browser (picker value + meta follow); leaving
// the chart returns to the picker's own selection. Driven through
// ContextView's hoveredSeq state, exactly like TrendChart's onHover. ----
ctxSlots[1][1](2) // hover the seq-2 bar (Turn 1 · Step 1)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'hovered bar drives the browser picker')
assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /Turn 1 · Step 1/, 'meta shows the hovered step')
assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /preview/, 'hover preview is marked')
ctxSlots[1][1](3)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '3', 'hover moves across bars')
ctxSlots[1][1](9999)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'an unknown (trimmed) preview seq is ignored')
ctxSlots[1][1](null)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'leaving the chart returns to the picker selection')

console.log('✔ hover linkage test passed (bar hover previews its step, unknown seq ignored, picker resumes)')

// ---- trend-chart pin linkage: clicking a bar locks its step in the browser
// too (the picker follows the pin); unpinning (selectedSeq back to null)
// returns the browser to the live step. Driven through ContextView's
// selectedSeq state + the browser's pin-linkage effect (hook slot 8). ----
ctxSlots[0][1](2) // pin the seq-2 bar (Turn 1 · Step 1)
tr = renderView()
brSlots[8].effect() // the pin effect applies the new pinSeq
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'pinned bar drives the browser picker')
assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /Turn 1 · Step 1/, 'meta shows the pinned step')
ctxSlots[1][1](3) // hovering another bar still previews transiently over the pin
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '3', 'hover previews over the pin')
ctxSlots[1][1](null)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'leaving the chart returns to the pinned step')
ctxSlots[0][1](null) // unpin
tr = renderView()
brSlots[8].effect()
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'unpinning returns the browser to live')

console.log('✔ pin linkage test passed (pinned bar drives the browser picker, hover previews over the pin, unpin returns to live)')

// ---- current-composition hover link: while the browser shows the LIVE step,
// hover is shared bidirectionally with the Current Composition card. A
// browser category row or the browser's own composition bar lights the
// overview's segment + legend chip (and the browser echoes back); hovering
// the overview lights the browser's matching category row and bar segment.
// A pinned/previewed step has a different composition, so its hover never
// leaks into the overview and the overview's hover never highlights it. ----
const brWrap = () => byClass(tr, 'lc-br-bar')[0]
const brStack = () => byClass(brWrap(), 'lc-stacked')[0]
const ovrStack = () => byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
const segOf = (stack, key) => stack.args.slice(2).flat().filter(s => s !== null)
  .find(s => s.args[1].key === key)
const barSegsOn = (stack) => stack.args.slice(2).flat().filter(s => s !== null)
  .filter(s => String(s.args[1].className || '').includes('lc-stacked-seg-on'))
assert.ok(brStack(), 'browser composition bar present (height 10 wrapper hook)')
ctxSlots[1][1](null) // no trend hover: the browser is on the live step
brSlots[1][1](null)
brSlots[2][1](null)
tr = renderView()
assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'no linked category row before any hover')

// browser category row -> overview (both bars, the legend, and the row echo)
const liveUserRow = catRowOf('User')
assert.equal(typeof liveUserRow.args[1].onMouseEnter, 'function', 'live browser rows carry the hover link')
liveUserRow.args[1].onMouseEnter()
tr = renderView()
assert.equal(ctxSlots[5][0], 'user', 'browser row hover updates the shared hover category')
assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'browser row hover links its own row')
assert.equal(barSegsOn(brStack()).length, 1, 'browser row hover lights the browser bar segment')
assert.equal(barSegsOn(brStack())[0].args[1].key, 'user', 'the lit browser segment is user')
assert.equal(barSegsOn(ovrStack()).length, 1, 'browser row hover lights the overview bar segment')
assert.equal(byClass(tr, 'lc-chip-on').length, 1, 'browser row hover lights the overview legend chip')
assert.match(textOf(byClass(tr, 'lc-chip-on')[0]), /User/, 'the lit chip is the user category')
liveUserRow.args[1].onMouseLeave()
tr = renderView()
assert.equal(ctxSlots[5][0], null, 'leaving the browser row clears the shared hover')
assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'the row echo clears with the leave')
assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'both bars clear with the row leave')
assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'the legend chip clears with the row leave')

// overview -> browser: the overview segment lights the browser's category
// row and bar segment, but only the overview floats its tooltip (the
// mirrored browser bar stays silent).
segOf(ovrStack(), 'assistant').args[1].onMouseEnter({ clientX: 80 })
tr = renderView()
assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'overview hover lights the browser category row')
assert.match(textOf(byClass(tr, 'lc-br-cat-on')[0]), /assistant/, 'the echoed row is the assistant category')
assert.equal(barSegsOn(brStack()).length, 1, 'the browser bar mirrors the overview hover')
assert.equal(barSegsOn(brStack())[0].args[1].key, 'assistant', 'the mirrored segment is the assistant')
assert.equal(byClass(tr, 'lc-bar-tip-on').length, 1, 'exactly one tooltip floats (only over the overview bar)')
ovrStack().args[1].onMouseLeave()
tr = renderView()
assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'overview leave clears the browser row echo')
assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'overview leave clears both bars')

// browser composition bar -> overview (the browser's bart joins the link)
segOf(brStack(), 'user').args[1].onMouseEnter()
tr = renderView()
assert.equal(ctxSlots[5][0], 'user', 'browser bar hover updates the shared hover category')
assert.equal(barSegsOn(ovrStack()).length, 1, 'browser bar hover lights the overview segment')
assert.equal(byClass(tr, 'lc-chip-on').length, 1, 'browser bar hover lights the overview legend chip')
assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'browser bar hover links the browser category row too')
brStack().args[1].onMouseLeave()
tr = renderView()
assert.equal(ctxSlots[5][0], null, 'leaving the browser bar clears the shared hover')

// pinned/previewed step: the compositions differ, so no linkage either way
ctxSlots[1][1](2) // trend hover previews step 2 in the browser
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'browser is previewing a past step')
assert.equal(catRowOf('User').args[1].onMouseEnter, undefined, 'pinned browser rows carry no hover link')
segOf(brStack(), 'user').args[1].onMouseEnter() // handler exists; the live gate must make it a no-op
tr = renderView()
assert.equal(ctxSlots[5][0], null, 'pinned browser bar hover does not leak into the overview')
segOf(ovrStack(), 'assistant').args[1].onMouseEnter({ clientX: 80 })
tr = renderView()
assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'overview hover does not echo into a pinned step')
assert.equal(barSegsOn(brStack()).length, 0, 'overview hover does not light the pinned composition bar')
assert.equal(barSegsOn(ovrStack()).length, 1, 'the overview itself still highlights normally')
ovrStack().args[1].onMouseLeave()
tr = renderView()

// back on the live step the link returns
ctxSlots[1][1](null)
tr = renderView()
assert.equal(typeof catRowOf('User').args[1].onMouseEnter, 'function', 'live browser rows carry the link again')

console.log('✔ current-composition hover link test passed (browser rows + composition bar <-> overview, gated on the live step)')

// ---- overview tool-chip bridge: the "工具定义 Top" label and each tool chip
// are clickable buttons that link into the Context browser — the label opens
// the tools category, a chip also expands that specific tool's row. The
// request is one-shot: applied by the browser's toolFocus effect (hook slot
// 9) and cleared back so the same chip can be clicked again. ----
dataValue = {
  ...snapshot,
  toolList: [
    { name: 'bash', tokens: 5 },
    { name: 'rg', tokens: 3 },
  ],
}
headersValue = {
  headers: [{
    seq: 1, time: 900,
    tools: [{ name: 'bash', tokens: 5, description: 'run a command', schema: { name: 'bash', parameters: { type: 'object' } } }],
  }],
}
brSlots[2][1](null) // no element open from the previous test
tr = renderView()
const toolsLabel = byClass(tr, 'lc-tools-label')[0]
assert.ok(toolsLabel, '"工具定义 Top" label rendered as a button')
assert.equal(typeof toolsLabel.args[1].onClick, 'function', 'tools label is clickable')
let chips = byClass(tr, 'lc-tool-chip')
assert.equal(chips.length, 2, 'tool chips rendered (two tools)')
assert.ok(chips.every(c => typeof c.args[1].onClick === 'function'), 'every tool chip is clickable')
// Clicking the label opens the tools category only (no specific tool).
toolsLabel.args[1].onClick()
tr = renderView()
assert.deepEqual(ctxSlots[7][0], {}, 'label click records a category-only focus')
brSlots[9].effect() // the tool-bridge effect applies the one-shot request
tr = renderView()
assert.equal(ctxSlots[7][0], null, 'one-shot focus is cleared once applied')
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'focus switches the browser to the live step')
assert.equal(byClass(tr, 'lc-br-body').length, 1, 'tools category opens in the browser')
assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /bash/, 'tools category lists the schema rows')
assert.equal(byClass(tr, 'lc-br-content').length, 0, 'category-only focus expands no specific tool')
// Clicking a specific tool also expands that tool's row.
chips = byClass(tr, 'lc-tool-chip')[0].args[1].onClick()
tr = renderView()
assert.deepEqual(ctxSlots[7][0], { tool: 'bash' }, 'chip click records a specific-tool focus')
brSlots[9].effect()
tr = renderView()
assert.equal(ctxSlots[7][0], null, 'tool focus cleared once applied')
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'stays on the live step')
const bridgeContent = byClass(tr, 'lc-br-content')
assert.equal(bridgeContent.length, 1, 'the clicked tool row expands open')
assert.match(textOf(bridgeContent[0]), /run a command/, 'the expanded body carries the clicked tool description')
// The "等 N 个" overflow link (more than five tools) also opens the category.
dataValue = {
  ...snapshot,
  toolList: ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ name, tokens: 10 - i })),
}
brSlots[1][1](null) // retract the previously opened category
brSlots[2][1](null)
tr = renderView()
const moreBtn = byClass(tr, 'lc-tools-more')[0]
assert.ok(moreBtn, '"等 N 个" overflow link rendered as a button')
assert.equal(byClass(tr, 'lc-tool-chip').length, 5, 'still shows only the top five chips')
assert.equal(typeof moreBtn.args[1].onClick, 'function', 'the overflow link is clickable')
moreBtn.args[1].onClick()
tr = renderView()
assert.deepEqual(ctxSlots[7][0], {}, 'overflow link opens the tools category (no specific tool)')
brSlots[9].effect()
tr = renderView()
assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'stays on the live step')
assert.equal(byClass(tr, 'lc-br-body').length, 1, 'tools category opens in the browser')
headersValue = undefined
dataValue = snapshot
tr = renderView()

console.log('✔ overview tool-chip bridge test passed (label opens the tools category, chip expands the tool row, overflow link opens the category too, one-shot focus clears)')

// ---- Context browser auto-load: expanding an element whose seq is outside
// the loaded conversation window pages older history in (via the plugin's
// own `sessions.provide` contribution) until the join hits. ----
let sessionSnap = { nodes: [], hasMore: true, loadingOlder: false }
let loadCalls = 0
useSessionHolder = (sel) => sel(sessionSnap)
loadOlderHolder = async () => {
  loadCalls += 1
  // The page lands: seq 1's full content enters the window, history ends.
  sessionSnap = {
    nodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'FULL-MESSAGE-TEXT' }] }],
    hasMore: false,
    loadingOlder: false,
  }
}
dataValue = snapshot
brSlots[1][1]('user') // reopen the user category
brSlots[2][1]('n1')   // expand the out-of-window element
tr = renderView()
assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /loading older history/, 'loading note while the page is being pulled')
// ContextBrowser hook slots: 0 sel, 1 openCat, 2 openElem, 3 exhausted,
// 4 pagesRef, 5 reset effect, 6 auto-load effect, 7 history-end effect,
// 8 pin-linkage effect.
// React runs effects in order post-render; drive them the same way.
brSlots[5].effect()
brSlots[6].effect()
assert.equal(loadCalls, 1, 'expanding pulls one older page')
tr = renderView()
const joined = textOf(byClass(tr, 'lc-br-content')[0])
assert.match(joined, /FULL-MESSAGE-TEXT/, 'joined content replaces the preview once the page lands')
assert.ok(!/outside the loaded window/.test(joined), 'window note gone after the join hits')
// No further pages once the seq joined.
brSlots[6].effect()
assert.equal(loadCalls, 1, 'no extra pages after the join hits')
useSessionHolder = undefined
loadOlderHolder = undefined

console.log('✔ context browser auto-load test passed (loading note, one page pulled, joined content, no over-paging)')

// ---- /context modal render: centered dialog with the same overview +
// last-10-turn trend, driven by the modal store hook ----
assert.ok(modalComponent !== null, 'overlay component captured')
// 14 turns of growing totals; the modal must show exactly the last 10.
const modalRequests = []
for (let turn = 1; turn <= 14; turn++) {
  modalRequests.push({
    turn, step: 0, time: 1000 * turn, seq: turn * 10,
    system: 10, tools: 20, user: 10 * turn, inject: 0, assistant: 15, tool: 20, total: 65 + 10 * turn,
  })
}
const modalData = {
  ...snapshot,
  current: { system: 10, tools: 20, user: 140, inject: 0, assistant: 15, tool: 20, total: 205 },
  requests: modalRequests,
  events: [{ seq: 95, time: 9500, kind: 'compaction', tokens: 50, count: 2 }],
}
let modalOpen = false
const renderModal = () => evaluate(modalComponent({
  sessionId: 's1',
  useProjection: (key) => (key === 'contextTimeline' ? modalData : undefined),
  useContextModal: (sel) => sel(modalOpen),
}))

assert.equal(renderModal(), null, 'modal renders nothing while closed')
modalOpen = true
const modalTree = renderModal()
assert.equal(byClass(modalTree, 'lc-modal-backdrop').length, 1, 'centered backdrop rendered')
const modalBars = byClass(modalTree, 'lc-bar')
assert.equal(modalBars.length, 10, 'trend shows exactly the last 10 turns')
// First visible bar is turn 5 (seq 50); turns 1-4 are cut.
const modalTurns = byClass(modalTree, 'lc-turn')
assert.deepEqual(modalTurns.map(t => t.args[2]), ['T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14'], 'turn ticks 5..14')
// The compaction (seq 95) attaches to the first request after it (turn 10).
assert.equal(byClass(modalTree, 'lc-bar-marker').length, 1, '✂ marker rides the turn after the compaction')
const modalOverview = byClass(modalTree, 'lc-overview-num')[0]
assert.match(textOf(modalOverview), /205/, 'modal headline falls back to the heuristic total (no prompt on last request)')
assert.match(textOf(modalOverview), /0%/, 'percent against the 128k window')
assert.equal(byClass(modalTree, 'lc-modal-trend').length, 1, 'trend section title present')
const closeBtn = byClass(modalTree, 'lc-modal-close')[0]
assert.equal(closeBtn.args[1]['aria-label'], 'Close', 'close button localized')

// Deferred token consumption: the enter path left `/context` in the draft
// and recorded a bare-token guard; closing the modal dispatches the scoped
// consume-token event through the session scope.
assert.ok(modalSource !== null, 'trigger source registered on this instance')
await modalSource.matchEnter({ sessionId: 's1' }, '/context', new AbortController().signal)
const backdrop = byClass(modalTree, 'lc-modal-backdrop')[0]
backdrop.args[1].onClick()
assert.equal(bailCalls.length, 1, 'closing the modal dispatches consume-token')
assert.equal(bailCalls[0][1], 'slash/input-consume-token')
assert.deepEqual(bailCalls[0][2], { guard: { kind: 'bare-token', token: '/context' } }, 'enter-path guard consumed on close')
// A second close without a prior open records nothing.
backdrop.args[1].onClick()
assert.equal(bailCalls.length, 1, 'no pending guard -> no dispatch')

modalOpen = false
assert.equal(renderModal(), null, 'modal closes again')

console.log('✔ modal render test passed (open/close, last-10-turn window, ✂ marker, headline, localized chrome, deferred token consume on close)')

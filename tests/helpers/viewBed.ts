/**
 * Shared client-view test bed: materializes the built client bundle with a
 * STATEFUL fake React so a view component can be driven from loading -> data,
 * then walks the element tree the component produces. Hooks are tracked PER
 * component function (like React fibers), so re-rendering re-reads the same
 * slots. Every spec module boots its own bed — fresh hook fibers, fresh
 * holders, fresh plugin instance — so modules run in isolation.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ---- fake browser document (style-injection target) ----
export function makeFakeDoc() {
  const registered = new Map() // style tags keyed by data-plugin
  const fakeDoc = {
    createElement: (tag) => {
      const el = { tagName: tag, attrs: {}, textContent: '', parentNode: null }
      el.setAttribute = (k, v) => { el.attrs[k] = String(v) }
      // The bundle's CSS injector writes tag.dataset.plugin / .pluginCss;
      // mirror dataset writes into attrs so registration tracking sees them.
      el.dataset = new Proxy({}, {
        set: (t, k, v) => {
          const attr = 'data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
          el.attrs[attr] = String(v)
          t[k] = v
          return true
        },
      })
      return el
    },
    head: {
      appendChild(el) {
        el.parentNode = { removeChild: () => { el.parentNode = null } }
        registered.set(el.attrs['data-plugin'], el)
      },
    },
    // The injector's dedupe guard queries for an existing tag; the fake
    // document never has one (each bed boots a fresh document).
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  return { fakeDoc, registered }
}

// The module table answers the platform seeds this bundle uses ('react' and
// the shared primitives singleton); everything else rides ctx or is inlined.
// Icons are stubbed as inert elements (glyph rendering is never asserted);
// MarkdownText resolves to a plain div carrying its source text, so the
// raw/markdown toggle assertions can find it by class and text.
export const FAKE_PRIMITIVES = {
  IconPlusOutline16: (p) => ({ kind: 'icon', name: 'IconPlusOutline16', props: p }),
  IconBranchOutline16: (p) => ({ kind: 'icon', name: 'IconBranchOutline16', props: p }),
  IconCloseOutline16: (p) => ({ kind: 'icon', name: 'IconCloseOutline16', props: p }),
  MarkdownText: (p) => ({ kind: 'element', args: ['div', { className: 'lc-md-stub' }, p.text] }),
}

export const DICT_FOR_TEST = { 'tab': 'Context', 'loading': '…', 'error': 'ERR:', 'error.retry': 'retry', 'detail.step': 'Turn {t} · Step {s}', 'gran.step': 'Step', 'gran.turn': 'Turn', 'detail.turn': 'Turn {t} · {n} steps', 'detail.lastStep': 'last step', 'overview.used': 'of context used', 'overview.free': 'Free window', 'events.at': 'Turn {t} · Step {s}', 'events.range': 'Turn {t} · Step {a}→{b}', 'events.rangeTo': 'Turn {a} · Step {as} → Turn {b} · Step {bs}', 'form.notice': 'Notice', 'ev.mode.plan.on': 'Plan mode on', 'stats.recycleSub': '{c} compactions · {p} prunes', 'tip.step': 'Turn {t} · Step {s}', 'tip.turn': 'Turn {t} · {n} steps', 'tip.total': 'total ≈ {n}', 'tip.actual': ' (actual {n})', 'trend.title': 'History', 'trend.empty': 'empty trend', 'cmd.close': 'Close', 'cat.user': 'User', 'browser.live': 'Live (next request)', 'browser.liveNow': 'Live · next request', 'browser.items': '{n} items', 'browser.noContent': 'outside the loaded window', 'browser.loading': 'loading older history', 'browser.preview': 'preview', 'browser.noHeader': 'older plugin build',
  'browser.deltaHint': 'vs previous turn', 'overview.compactReserve': 'compact reserve {pct}%', 'tool.desc': 'Description', 'tool.params': 'Parameters', 'tool.paramsEmpty': '(no parameters)', 'tool.jsonToggle': 'View Raw JSON', 'tool.jsonHide': 'Collapse', 'rich.raw': 'Raw', 'rich.md': 'Markdown', 'rich.toMd': 'View as Markdown', 'rich.toRaw': 'View Raw Text', 'block.thinking': 'Reasoning', 'block.answer': 'Response', 'attach.images': 'Images', 'attach.other': 'Other content', 'attach.image': 'Image', 'attach.open': 'Open full image', 'attach.preview': 'Image preview', 'attach.close': 'Close', 'attach.loading': '…', 'attach.loadFailed': 'Load failed · click to retry', 'attach.raw': 'Raw', 'attach.sent': 'Sent', 'attach.token': 'Token', 'attach.tokensTip': 'estimated tokens' }

/** Base timeline fixture: 4 requests across 3 turns, 2 live nodes. */
export const snapshot = {
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

/** Walk the h() element tree, returning every node whose className matches. */
export function byClass(root, className) {
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

export function textOf(node) {
  if (typeof node === 'string') return node
  // React renders number children as text (booleans it does not).
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (node.kind === 'element') return node.args.slice(2).map(textOf).join('')
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}

export function plainText(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (node.kind === 'element') return node.args.slice(2).map(plainText).join('')
  if (Array.isArray(node)) return node.map(plainText).join('')
  return ''
}

/** Find a browser category row by its label text. */
export function catRowOf(tr, label) {
  return byClass(tr, 'lc-br-cat-row').find(r => textOf(r).includes(label))
}

/**
 * Boot a fresh view bed: evaluate the bundle through the boot handoff,
 * materialize it with the stateful fake React, apply it on a fake ctx, and
 * run the initial (loading) render so the ContextView fiber exists.
 * @returns the bed: holders the tests arm, captured registrations, the
 * render/evaluate drivers, and fiber-slot accessors.
 */
export async function bootViewBed() {
  const bundle = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
  const { fakeDoc } = makeFakeDoc()
  let handoff = null
  globalThis.window = { __ModuleLoader__: { load(h) { handoff = h } } }
  globalThis.document = fakeDoc
  new Function(bundle)()
  assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')

  const bed = {
    // projection/service holders the tests arm between renders
    dataValue: null,
    pressureValue: undefined,
    breakdownValue: undefined,
    usageValue: undefined,
    headersValue: undefined,
    useSessionHolder: undefined,
    loadOlderHolder: undefined,
    conversationHolder: undefined,
    // captured at apply time
    bailCalls: [],
    provideDescriptors: [],
    modalSource: null,
    viewComponent: null,
    modalComponent: null,
    hookStates: new Map(), // component fn -> [value, setter][] slots
    classInstances: new Map(),
  }

  let currentHooks = null
  let hookCursor = 0
  const statefulReact = {
    createElement: (...args) => ({ kind: 'element', args }),
    // Fragment marker: evaluate() flattens it to its evaluated children.
    Fragment: 'lc-fragment',
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
    // Same no-memoization stance for component memo: the plain function.
    memo: (fn) => fn,
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
    Component: class Component {
      constructor(props) { this.props = props }
      setState(partial) { this.state = { ...this.state, ...partial } }
    },
  }
  const requireStateful = (spec) => {
    assert.ok(spec === 'react' || spec === 'react-dom' || spec === '@deepseek-ai/dsh-client-ui-primitives',
      `bundle must only require platform modules (got "${spec}")`)
    if (spec === 'react') return statefulReact
    // Portals flatten to their tree: the lightbox stays walkable in tests.
    if (spec === 'react-dom') return { createPortal: (node) => node }
    return FAKE_PRIMITIVES
  }
  const pluginExports = handoff.factory(requireStateful)

  const fakeCtx = {
    get: (name) => {
      if (name === 'conversation') return bed.conversationHolder
      if (name === 'inputTriggers') return { registerSource: (s) => { bed.modalSource = s; return () => {} } }
      if (name === 'sessions') return {
        scope: (id) => id === 's1' ? { bail: (...args) => { bed.bailCalls.push(args); return true } } : undefined,
        provide: (d) => { bed.provideDescriptors.push(d); return () => {} },
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
        if (opts.name === 'conversation.view') bed.viewComponent = component
        if (opts.name === 'conversation.input.overlay') bed.modalComponent = component
        return opts
      },
    },
  }
  pluginExports.apply(fakeCtx)
  assert.ok(bed.viewComponent !== null, 'view component captured')

  /** Invoke function-typed elements so hooks run and the tree materializes.
   * Hooks are keyed by the component's fiber path (e.g. root/ContextView#0/
   * StackedBar#0), so distinct instances of the same component keep state.
   * Class components (the ErrorBoundary) are simulated with a React-like
   * lifecycle: an instance is created from the prototype with props + empty
   * state, render errors are caught through the static getDerivedStateFromError
   * (the boundary protocol) and the fallback re-renders, and instances are
   * registered so tests can inspect the caught error. */
  function evaluate(node, path = '', fnIdx = 0) {
    if (node === null || typeof node !== 'object') return node
    if (node.kind === 'element') {
      const [type, props, ...children] = node.args
      // A fragment flattens to its evaluated children (an array), which every
      // tree walker here already understands.
      if (type === statefulReact.Fragment) {
        const kids = []
        let f = 0
        const walkFragment = (c) => {
          if (Array.isArray(c)) { for (const x of c) walkFragment(x); return }
          if (c !== null && typeof c === 'object' && c.kind === 'element' && typeof c.args[0] === 'function') {
            kids.push(evaluate(c, path, f++))
          } else {
            kids.push(evaluate(c, path, f))
          }
        }
        for (const c of children) walkFragment(c)
        return kids
      }
      // The fake createElement keeps children in args; real React puts them
      // on props.children (single child as-is, several as an array) — merge
      // them back for BOTH component kinds, exactly what React would pass.
      const childrenOf = children.length === 0 ? {} : children.length === 1 ? { children: children[0] } : { children }
      if (typeof type === 'function' && type.prototype !== undefined && typeof type.prototype.render === 'function') {
        const key = path + '/' + (type.name || 'anon') + '#' + fnIdx
        // Constructing with `new` runs the real constructor, so props AND
        // the initial state are exactly what React would set.
        const inst = new type(Object.assign({}, props || {}, childrenOf))
        bed.classInstances.set(key, inst)
        try {
          return evaluate(inst.render(), key)
        } catch (err) {
          if (typeof type.getDerivedStateFromError === 'function') {
            inst.state = type.getDerivedStateFromError(err)
            return evaluate(inst.render(), key)
          }
          throw err
        }
      }
      if (typeof type === 'function') {
        const key = path + '/' + (type.name || 'anon') + '#' + fnIdx
        currentHooks = bed.hookStates.get(key)
        if (currentHooks === undefined) {
          currentHooks = []
          bed.hookStates.set(key, currentHooks)
        }
        hookCursor = 0
        return evaluate(type(Object.assign({}, props || {}, childrenOf)), key)
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

  // The framework standard kit delivers the context timeline as a push-fed
  // projection (`useProjection('contextTimeline')`) and the official
  // token-meter occupancy as another (`useProjection('contextPressure')`);
  // tests drive renders by swapping the holders the stub reads, exactly like
  // session/projection frames.
  const renderView = () => evaluate(bed.viewComponent({
    sessionId: 's1',
    useProjection: (key) => (key === 'contextTimeline' ? bed.dataValue
      : (key === 'contextPressure' ? bed.pressureValue
        : (key === 'contextBreakdown' ? bed.breakdownValue
          : (key === 'contextHeaders' ? bed.headersValue
            : (key === 'tokenUsage' ? bed.usageValue : undefined))))),
    useSession: bed.useSessionHolder,
    loadOlderHistory: bed.loadOlderHolder,
  }))

  /** Hook slots of one mounted fiber, by component-name substring. */
  const fiberSlots = (name, { nonEmpty = false } = {}) => {
    const key = [...bed.hookStates.keys()].find(k => k.includes(name) && (!nonEmpty || bed.hookStates.get(k).length > 0))
    assert.ok(key, `${name} fiber registered`)
    return bed.hookStates.get(key)
  }
  // The ContextView fiber: the boundary wrapper owns an EMPTY hook slot array,
  // so the data-driven body's fiber is the one carrying the view hooks.
  const ctxSlots = () => fiberSlots('ContextView', { nonEmpty: true })
  const brSlots = () => fiberSlots('ContextBrowser')

  // Initial loading render: creates the ContextView hook slots.
  renderView()

  // Attach the drivers ONTO the bed: tests arm holders via `bed.x = ...`,
  // and the closures above read the same object — a spread copy would
  // silently disconnect the two.
  return Object.assign(bed, {
    evaluate,
    renderView,
    fiberSlots,
    ctxSlots,
    brSlots,
    snapshot,
  })
}

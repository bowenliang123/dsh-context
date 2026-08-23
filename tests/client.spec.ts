/**
 * Registration-surface spec for the packaged client bundle: simulates the
 * web boot handoff (window.__ModuleLoader__.load), the module-table require,
 * and the client ctx (locale/slots/effect + a fake DOM), then asserts the
 * plugin registers its dictionaries, styles, the conversation.view tab
 * entry, and the /context command trigger source.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { bootViewBed, FAKE_PRIMITIVES, makeFakeDoc } from './helpers/viewBed'

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- fake browser environment ----
const { fakeDoc, registered } = makeFakeDoc()
const fakeReact = {
  createElement: (...args) => ({ kind: 'element', args }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  memo: (fn) => fn,
  // The ErrorBoundary extends React.Component; a minimal base keeps the
  // class construction working (props assigned, state merge via setState).
  Component: class Component {
    constructor(props) { this.props = props }
    setState(partial) { this.state = { ...this.state, ...partial } }
  },
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

const require = (spec) => {
  assert.ok(spec === 'react' || spec === 'react-dom' || spec === '@deepseek-ai/dsh-client-ui-primitives',
    `bundle must only require platform modules (got "${spec}")`)
  if (spec === 'react') return fakeReact
  if (spec === 'react-dom') return { createPortal: () => null }
  return FAKE_PRIMITIVES
}

// ---- materialize the bundle the way the loader does ----
// Run the bundle verbatim: it registers itself through the boot handoff
// (window.__ModuleLoader__.load), and the loader materializes the plugin by
// invoking the captured factory with the module-table require. The factory
// body declares its own module/exports (the bundle intro), so no string
// surgery on the artifact — the test stays decoupled from bundler layout.
new Function(bundle)()
assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')
const pluginExports = handoff.factory(require)

test('client bundle: handoff, dicts, styles, slot registration, /context command', async () => {
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
    inject: () => {}, // no settingsScope composed: the settings wiring never fires
    slots: {
      inject: (name, fn) => { slotInjections.push([name, fn]) },
      register: (opts, component) => {
        assert.equal(typeof component, 'function')
        return opts
      },
    },
  }
  pluginExports.apply(fakeCtx)

  assert.equal(effects.length, 3, 'dictionaries + loadOlderHistory prop + /context command effects (styles inject at bundle materialization)')
  assert.deepEqual(localeRegistrations[0][0], 'dsh-context')
  assert.ok(localeRegistrations[0][1].zh && localeRegistrations[0][1].en, 'bilingual dicts')
  // The sheet rides the bundle's CSS channel: injected at factory execution,
  // lightningcss-minified (`120ms ease` -> `.12s`), tagged data-plugin.
  const styleTag = registered.get('dsh-context')
  assert.ok(styleTag, 'plugin-owned <style data-plugin="dsh-context"> injected')
  assert.equal(styleTag.attrs['data-plugin-css'], 'dsh-context/styles.css', 'style tag carries the official data-plugin-css tag id')
  assert.ok(styleTag.textContent.includes('.lc-root'), 'styles content present')
  assert.ok(styleTag.textContent.includes('.lc-br-elem-row') && styleTag.textContent.includes('transition:background-color'), 'row hovers ease in/out')
  assert.ok(styleTag.textContent.includes('.lc-stacked-seg') && styleTag.textContent.includes('transition:filter'), 'composition bar hover eases in/out')
  assert.ok(styleTag.textContent.includes('.lc-bar-tip-on'), 'composition tooltip fades in and out')
  assert.ok(styleTag.textContent.includes('.lc-stat-tip'), 'stats cell tooltip bubble styles present')
  assert.ok(styleTag.textContent.includes('.lc-stat-tipped:hover .lc-stat-tip'), 'stats tooltip reveals on cell hover')
  assert.ok(styleTag.textContent.includes('.lc-occupied-box-on'), 'occupied frame fades in and out')
  assert.ok(styleTag.textContent.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), 'image attachment grid is two equal-width columns')
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
      inject: () => {},
      slots: { inject: () => {}, register: () => ({}) },
    }
    pluginExports.apply(ctx3)
    assert.equal(sources.length, 1, 'one /context trigger source registered')
    const src = sources[0]
    assert.equal(src.trigger, '/')
    assert.equal(src.name, 'context')

    // Candidates: leading-only, prefix-filtered, description localized.
    const req = (query, position = 'leading') => ({ query, position, signal: new AbortController().signal })
    assert.deepEqual(await src.candidates({ sessionId: 's1' }, req('')), [{ name: 'context', description: '查看当前上下文构成，浏览各步骤组成' }])
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
})

test('sessions.provide contributes the loadOlderHistory prop', async () => {
  // The contribution rides the harness's sessions.provide channel: one
  // declared prop, resolved per session to the session's own
  // history-pagination verb.
  const bed = await bootViewBed()
  assert.equal(bed.provideDescriptors.length, 1, 'one sessions.provide contribution registered')
  assert.deepEqual(bed.provideDescriptors[0].props, ['loadOlderHistory'], 'the contributed prop is loadOlderHistory')
  let olderPulled = 0
  const contribution = bed.provideDescriptors[0].resolve({ session: { loadOlder: async () => { olderPulled += 1 } } })
  assert.equal(typeof contribution.props.loadOlderHistory, 'function', 'resolved prop is a function')
  await contribution.props.loadOlderHistory()
  assert.equal(olderPulled, 1, 'the prop delegates to session.loadOlder()')
})

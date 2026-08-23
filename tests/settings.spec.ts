/**
 * User-settings seam tests: the Host half serves the `dsh-context` namespace
 * (Settings → Plugins → Plugin configuration pairs it with the browser card
 * by key), and the browser half binds it for the default trend granularity —
 * read at view mount, written by the card through the settings scope.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { apply } from '../lib/index.js'
import { bootViewBed, byClass } from './helpers/viewBed.ts'

/** A fake ctx.settingsScope binder over one fixed namespace section. */
function fakeBinder(value, { status = 'ready', writable = true } = {}) {
  const writes = []
  const scope = {
    getSnapshot: () => ({ status, value, writable }),
    subscribe: () => () => {},
    set: (field, v) => { writes.push([field, v]); return Promise.resolve() },
  }
  const binder = {
    bind: (spec) => {
      assert.equal(spec.namespace, 'dsh-context', 'the scope binds the plugin namespace')
      return scope
    },
  }
  return { writes, scope, binder }
}

test('host half: registers the dsh-context settings namespace when a provider is composed', () => {
  const registrations = []
  const fakeCtx = {
    inject(list, cb) { if (list.every(d => this[d] !== undefined)) cb(this) },
    effect(fn) { fn(); return () => {} },
    sessionProjections: { register: () => () => {} },
    settings: { register: (ns, schema) => { registrations.push({ ns: String(ns), schema }) } },
  }
  apply(fakeCtx)
  assert.equal(registrations.length, 1, 'one settings namespace registered')
  assert.equal(registrations[0].ns, 'dsh-context', 'namespace key the browser card is keyed on')
  assert.deepEqual(registrations[0].schema({}), { defaultGranularity: 'step' }, 'schema fills the step default')
  assert.throws(() => registrations[0].schema({ defaultGranularity: 'week' }), 'schema rejects unknown granularity')
})

test('client half: default granularity comes from the settings scope at mount', async () => {
  const { binder } = fakeBinder({ defaultGranularity: 'turn' })
  const bed = await bootViewBed({ settingsScope: binder })
  // The ContextView fiber's hook slots: gran is index 4 (see chart.spec).
  const gran = bed.ctxSlots()[4][0]
  assert.equal(gran, 'turn', 'a freshly mounted view opens with the stored granularity')
  bed.dataValue = bed.snapshot
  const tree = bed.renderView()
  const granRow = byClass(tree, 'lc-gran')[0].args.slice(2)
  const on = granRow.filter(b => String(b.args[1].className || '').includes('lc-gran-on'))
  assert.equal(on.length, 1, 'exactly one active granularity button')
  assert.equal(on[0].args[2], 'Turn', 'the turn option renders active')
})

test('client half: no settings surface -> no card, step default (degraded)', async () => {
  const bed = await bootViewBed()
  assert.equal(bed.settingsCardComponent, null, 'no card registered without settingsScope')
  assert.equal(bed.ctxSlots()[4][0], 'step', 'granularity falls back to the schema default')
})

test('client half: the Plugin configuration card reads and writes the preference', async () => {
  const { writes, binder } = fakeBinder({ defaultGranularity: 'step' })
  const bed = await bootViewBed({ settingsScope: binder })
  assert.equal(bed.settingsCardRegistration.key, 'dsh-context', 'card keyed by the served namespace')

  const face = bed.settingsCardRegistration.inject()
  const store = face.hooks.contextSettings
  const render = () => bed.evaluate(bed.settingsCardComponent({
    useContextSettings: (sel) => sel(store.getSnapshot()),
    choose: face.choose,
  }))

  const tree = render()
  assert.equal(tree.args[0], 'li', 'the card is a list item inside the section ul')
  const options = byClass(tree, 'lc-gran-btn')
  assert.equal(options.length, 2, 'step/turn segmented control')
  assert.equal(options[0].args[1].disabled, false, 'writable scope enables the control')
  assert.ok(String(options[0].args[1].className).includes('lc-gran-on'), 'step renders active')
  assert.equal(byClass(tree, 'lc-settings-note').length, 0, 'no read-only note when writable')

  options[1].args[1].onClick() // choose Turn
  assert.deepEqual(writes, [['defaultGranularity', 'turn']], 'the choice lands as a fenced scope write')
  assert.equal(store.getSnapshot().granularity, 'turn', 'local echo before the write settles')
  const rerendered = render()
  assert.ok(String(byClass(rerendered, 'lc-gran-btn')[1].args[1].className).includes('lc-gran-on'), 'turn renders active after the choice')
})

test('client half: card states — read-only note and unavailable absence', async () => {
  const ro = await bootViewBed({ settingsScope: fakeBinder({ defaultGranularity: 'step' }, { writable: false }).binder })
  const roFace = ro.settingsCardRegistration.inject()
  const roStore = roFace.hooks.contextSettings
  const roTree = ro.evaluate(ro.settingsCardComponent({
    useContextSettings: (sel) => sel(roStore.getSnapshot()),
    choose: roFace.choose,
  }))
  assert.equal(byClass(roTree, 'lc-settings-note').length, 1, 'read-only scope shows the note')
  assert.equal(byClass(roTree, 'lc-gran-btn')[0].args[1].disabled, true, 'read-only scope disables the control')

  const off = await bootViewBed({ settingsScope: fakeBinder(undefined, { status: 'unavailable' }).binder })
  const offFace = off.settingsCardRegistration.inject()
  const offStore = offFace.hooks.contextSettings
  const offTree = off.evaluate(off.settingsCardComponent({
    useContextSettings: (sel) => sel(offStore.getSnapshot()),
    choose: offFace.choose,
  }))
  assert.equal(offTree, null, 'an unserved namespace shows no trace of the card')
})

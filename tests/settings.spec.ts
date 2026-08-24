import assert from 'node:assert/strict'
import { test } from 'vitest'
import { apply } from '../lib/index.js'
import { bootViewBed, byClass, textOf } from './helpers/viewBed.ts'

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

/** Render the captured settings card against one bed's store. */
function cardRig(bed) {
  const face = bed.settingsCardRegistration.inject()
  const store = face.hooks.contextSettings
  const render = () => bed.evaluate(bed.settingsCardComponent({
    useContextSettings: (sel) => sel(store.getSnapshot()),
    set: face.set,
  }))
  return { face, store, render }
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
  assert.deepEqual(registrations[0].schema({}), { defaultGranularity: 'step', defaultTrendMode: 'total' }, 'schema fills both defaults')
  assert.throws(() => registrations[0].schema({ defaultGranularity: 'week' }), 'schema rejects unknown granularity')
  assert.throws(() => registrations[0].schema({ defaultTrendMode: 'net' }), 'schema rejects unknown trend mode')
})

test('client half: default granularity and trend mode come from the settings scope at mount', async () => {
  const { binder } = fakeBinder({ defaultGranularity: 'turn', defaultTrendMode: 'diff' })
  const bed = await bootViewBed({ settingsScope: binder })
  // The ContextView fiber's hook slots: gran is index 4, trend mode 5 (see chart.spec).
  assert.equal(bed.ctxSlots()[4][0], 'turn', 'a freshly mounted view opens with the stored granularity')
  assert.equal(bed.ctxSlots()[5][0], 'diff', 'a freshly mounted view opens with the stored trend mode')
  bed.dataValue = bed.snapshot
  const tree = bed.renderView()
  const granRow = byClass(tree, 'lc-gran')[0].args.slice(2)
  const on = granRow.filter(b => String(b.args[1].className || '').includes('lc-gran-on'))
  assert.equal(on.length, 1, 'exactly one active granularity button')
  assert.equal(on[0].args[2], 'Turn', 'the turn option renders active')
})

test('client half: no settings surface -> no card, schema defaults (degraded)', async () => {
  const bed = await bootViewBed()
  assert.equal(bed.settingsCardComponent, null, 'no card registered without settingsScope')
  assert.equal(bed.ctxSlots()[4][0], 'step', 'granularity falls back to the schema default')
  assert.equal(bed.ctxSlots()[5][0], 'total', 'trend mode falls back to the schema default')
})

test('client half: the Plugin configuration card reads and writes both preferences', async () => {
  const { writes, binder } = fakeBinder({ defaultGranularity: 'step', defaultTrendMode: 'total' })
  const bed = await bootViewBed({ settingsScope: binder })
  assert.equal(bed.settingsCardRegistration.key, 'dsh-context', 'card keyed by the served namespace')

  const { store, render } = cardRig(bed)
  let tree = render()
  assert.equal(tree.args[0], 'li', 'the card is a list item inside the section ul')
  assert.equal(byClass(tree, 'lc-settings-head').length, 1, 'the header renders while collapsed')
  assert.equal(byClass(tree, 'lc-settings-row').length, 0, 'collapsed by default like the official plugin cards')

  byClass(tree, 'lc-settings-head')[0].args[1].onClick()
  tree = render()
  assert.equal(byClass(tree, 'lc-settings-row').length, 2, 'granularity + trend-mode preference rows')
  const menus = byClass(tree, 'lc-menu')
  assert.equal(menus.length, 2, 'each row is a Menu dropdown')
  assert.equal(menus[0].args[1]['data-selected'], 'step', 'the stored granularity is selected')
  const pill = byClass(menus[0], 'lc-settings-select')[0]
  assert.equal(pill.args[1].disabled, false, 'writable scope enables the control')
  assert.equal(textOf(pill), 'Step', 'the selector pill names the active option')
  assert.equal(byClass(tree, 'lc-settings-note').length, 0, 'no read-only note when writable')

  menus[0].args[1].onSelect('turn')
  assert.deepEqual(writes, [['defaultGranularity', 'turn']], 'the choice lands as a fenced scope write')
  assert.equal(store.getSnapshot().granularity, 'turn', 'local echo before the write settles')
  tree = render()
  assert.equal(byClass(tree, 'lc-menu')[0].args[1]['data-selected'], 'turn', 'turn renders selected after the choice')

  byClass(tree, 'lc-menu')[1].args[1].onSelect('diff')
  assert.deepEqual(writes[1], ['defaultTrendMode', 'diff'], 'the trend-mode choice lands as a fenced scope write')
  assert.equal(store.getSnapshot().mode, 'diff', 'local echo before the write settles')
})

test('client half: card states — read-only note and unavailable absence', async () => {
  const ro = await bootViewBed({ settingsScope: fakeBinder({ defaultGranularity: 'step' }, { writable: false }).binder })
  const roRig = cardRig(ro)
  byClass(roRig.render(), 'lc-settings-head')[0].args[1].onClick()
  const roTree = roRig.render()
  assert.equal(byClass(roTree, 'lc-settings-note').length, 1, 'read-only scope shows the note')
  assert.equal(byClass(roTree, 'lc-settings-select')[0].args[1].disabled, true, 'read-only scope disables the control')

  const off = await bootViewBed({ settingsScope: fakeBinder(undefined, { status: 'unavailable' }).binder })
  const offTree = cardRig(off).render()
  assert.equal(offTree, null, 'an unserved namespace shows no trace of the card')
})

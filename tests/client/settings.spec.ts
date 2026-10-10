// Settings binding (src/client/settings.ts): the local-echo store over the harness configForms section.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings, type SettingsScopeLike } from '../../src/client/settings'

/** A faithful in-memory settings form (the harness configForms.get contract:
 * getSnapshot/subscribe/set), not a mock of plugin code. */
class TestSettingsScope implements SettingsScopeLike {
  private snapshot: { status: string; value: unknown; writable: boolean }
  private readonly listeners = new Set<() => void>()
  readonly sets: { field: string; value: unknown }[] = []

  constructor(snapshot: { status: string; value: unknown; writable: boolean }) {
    this.snapshot = snapshot
  }

  getSnapshot(): { status: string; value: unknown; writable: boolean } {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** When true the write rejects, like a transport failure on the wire call. */
  failSet = false

  set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value })
    return this.failSet ? Promise.reject(new Error('write failed')) : Promise.resolve()
  }

  /** Push a new snapshot, like the Host delivering a section update. */
  emit(snapshot: { status: string; value: unknown; writable: boolean }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

describe('createContextSettings defaults', () => {
  test('starts loading with schema defaults and not writable', () => {
    const s = createContextSettings()
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'loading',
      placement: 'all',
      granularity: 'step',
      mode: 'total',
      deltaBase: 'step',
      toolSort: 'count',
      fileSort: 'count',
      insightsEntry: 'show',
      durationCurve: 'show',
      fleetTab: 'show',
      writable: false,
    })
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'count')
    assert.equal(s.insightsEntry(), 'show')
    assert.equal(s.defaultDurationCurve(), 'show')
    assert.equal(s.fleetTab(), 'show')
  })
})

describe('store', () => {
  test('subscribers are notified on change and unsubscribe stops', () => {
    const s = createContextSettings()
    let calls = 0
    const unsubscribe = s.store.subscribe(() => { calls++ })
    s.set('defaultTrendMode', 'delta')
    assert.equal(calls, 1)
    assert.equal(s.store.getSnapshot().mode, 'delta')
    unsubscribe()
    s.set('defaultTrendMode', 'total')
    assert.equal(calls, 1)
  })
})

describe('set', () => {
  test('without attach it echoes locally and never throws', () => {
    const s = createContextSettings()
    s.set('defaultGranularity', 'turn')
    assert.equal(s.defaultGranularity(), 'turn')
    s.set('defaultPlacement', 'sidebar')
    assert.equal(s.defaultPlacement(), 'sidebar')
    s.set('defaultDeltaBase', 'turn')
    assert.equal(s.defaultDeltaBase(), 'turn')
  })

  test('an unchanged value does not notify listeners', () => {
    const s = createContextSettings()
    let calls = 0
    s.store.subscribe(() => { calls++ })
    s.set('defaultGranularity', 'step')
    assert.equal(calls, 0)
  })

  test('an invalid value is dropped without notifying', () => {
    const s = createContextSettings()
    let calls = 0
    s.store.subscribe(() => { calls++ })
    s.set('defaultGranularity', 'bogus')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(calls, 0)
  })

  test('with attach it echoes locally and writes through the scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta')
    assert.deepEqual(scope.sets, [{ field: 'defaultTrendMode', value: 'delta' }])
  })

  test('a rejected scope write settles handled and rolls the echo back to the scope truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultTrendMode: 'total' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta', 'the optimistic echo lands first')
    // Let the rejection settle: the catch re-syncs from the scope's snapshot.
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultTrendMode(), 'total', 'the echo rolls back to the scope truth')
  })

  test('a rejected write keeps a preference the scope does not carry', async () => {
    // The scope's snapshot lacks the field entirely (older Host half): the
    // rollback sync keeps the in-session choice rather than dropping it.
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultFileSort', 'path')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultFileSort(), 'path')
  })

  test('a rejected placement write degrades to all when the scope carries no valid value', async () => {
    // Fail open: the unpersisted echo must not keep hiding an entry until
    // the next reload — with nothing valid in the scope's truth, fall back to `all`.
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultPlacement', 'sidebar')
    assert.equal(s.defaultPlacement(), 'sidebar', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultPlacement(), 'all', 'the echo degrades instead of staying unpersisted')
  })

  test('a rejected placement write rolls back to the scope\'s valid truth', async () => {
    // The scope truth itself is a valid placement: the rollback restores it, no forced degrade.
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultPlacement: 'sidebar' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultPlacement', 'tab')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultPlacement(), 'sidebar')
  })

  test('a rejected insights-entry write degrades to show when the scope carries no valid value', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('insightsEntry', 'hide')
    assert.equal(s.insightsEntry(), 'hide', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.insightsEntry(), 'show', 'the echo degrades instead of staying unpersisted')
  })

  test('a rejected insights-entry write rolls back to the scope\'s valid truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { insightsEntry: 'hide' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('insightsEntry', 'show')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.insightsEntry(), 'hide')
  })

  test('a rejected fleet-tab write degrades to show when the scope carries no valid value', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('fleetTab', 'hide')
    assert.equal(s.fleetTab(), 'hide', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.fleetTab(), 'show', 'an unpersisted hide must not keep the tab away')
  })

  test('a rejected fleet-tab write rolls back to the scope\'s valid truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { fleetTab: 'hide' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('fleetTab', 'show')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.fleetTab(), 'hide')
  })
})

describe('attach', () => {
  test('syncs a ready snapshot with parsed preferences', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: {
        defaultPlacement: 'sidebar',
        defaultGranularity: 'turn',
        defaultTrendMode: 'delta',
        defaultDeltaBase: 'turn',
        defaultToolSort: 'name',
        defaultFileSort: 'path',
        insightsEntry: 'hide',
        defaultDurationCurve: 'hide',
        fleetTab: 'hide',
      },
      writable: true,
    })
    s.attach(scope)
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      placement: 'sidebar',
      granularity: 'turn',
      mode: 'delta',
      deltaBase: 'turn',
      toolSort: 'name',
      fileSort: 'path',
      insightsEntry: 'hide',
      durationCurve: 'hide',
      fleetTab: 'hide',
      writable: true,
    })
  })

  test('an unavailable snapshot keeps parsed preferences', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'unavailable', value: {}, writable: false })
    s.attach(scope)
    assert.equal(s.store.getSnapshot().status, 'unavailable')
  })

  test('any other snapshot status reads as loading', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'pending', value: {}, writable: false })
    s.attach(scope)
    assert.equal(s.store.getSnapshot().status, 'loading')
  })

  test('null/non-object section values keep the defaults', () => {
    for (const value of [null, 42]) {
      const s = createContextSettings()
      s.attach(new TestSettingsScope({ status: 'ready', value, writable: false }))
      assert.deepEqual(s.store.getSnapshot(), {
        status: 'ready',
        placement: 'all',
        granularity: 'step',
        mode: 'total',
        deltaBase: 'step',
        toolSort: 'count',
        fileSort: 'count',
        insightsEntry: 'show',
        durationCurve: 'show',
        fleetTab: 'show',
        writable: false,
      })
    }
  })

  test('invalid preference values keep the defaults', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'window', defaultGranularity: 'bogus', defaultTrendMode: 7, defaultDeltaBase: 'bogus', defaultToolSort: 'alpha', defaultFileSort: 'alpha', insightsEntry: 42, defaultDurationCurve: 'always', fleetTab: 7 },
      writable: false,
    }))
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'count')
    assert.equal(s.insightsEntry(), 'show')
    assert.equal(s.defaultDurationCurve(), 'show')
    assert.equal(s.fleetTab(), 'show')
  })

  test('an invalid scope placement degrades to all instead of keeping the current one', () => {
    // Fail open on the read path too: a value the plugin cannot understand must not strand a previously chosen placement.
    const s = createContextSettings()
    s.set('defaultPlacement', 'tab')
    assert.equal(s.defaultPlacement(), 'tab')
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultPlacement: 42 }, writable: false })
    s.attach(scope)
    assert.equal(s.defaultPlacement(), 'all')
  })

  test('an invalid scope insights entry degrades to show instead of keeping the current one', () => {
    // Fail open on the read path too: a config problem must not leave the panel's entry hidden.
    const s = createContextSettings()
    s.set('insightsEntry', 'hide')
    assert.equal(s.insightsEntry(), 'hide')
    const scope = new TestSettingsScope({ status: 'ready', value: { insightsEntry: 'visible' }, writable: false })
    s.attach(scope)
    assert.equal(s.insightsEntry(), 'show')
  })

  test('an invalid scope duration-curve value degrades to show instead of keeping the current one', () => {
    const s = createContextSettings()
    s.set('defaultDurationCurve', 'hide')
    assert.equal(s.defaultDurationCurve(), 'hide')
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultDurationCurve: 'always' }, writable: false })
    s.attach(scope)
    assert.equal(s.defaultDurationCurve(), 'show')
  })

  test('explicit schema-default values are accepted', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'all', defaultGranularity: 'step', defaultTrendMode: 'total', defaultDeltaBase: 'step', defaultToolSort: 'count', defaultFileSort: 'count', insightsEntry: 'show' },
      writable: false,
    }))
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'count')
    assert.equal(s.insightsEntry(), 'show')
  })

  test('missing fields keep the current state', () => {
    const s = createContextSettings()
    s.set('defaultPlacement', 'tab')
    s.set('defaultToolSort', 'size')
    s.set('insightsEntry', 'hide')
    s.set('defaultDurationCurve', 'hide')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultFileSort: 'latest' }, writable: false }))
    assert.equal(s.defaultPlacement(), 'tab', 'the in-session choice survives a section without the field')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultToolSort(), 'size', 'the in-session tool sort survives a section without the field')
    assert.equal(s.defaultFileSort(), 'latest')
    assert.equal(s.insightsEntry(), 'hide', 'the in-session entry choice survives a section without the field')
    assert.equal(s.defaultDurationCurve(), 'hide', 'the in-session curve choice survives a section without the field')
  })

  test('scope updates republish to subscribers', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 1)
    assert.equal(s.defaultGranularity(), 'turn')
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' }, writable: true })
    assert.equal(calls, 2)
    assert.equal(s.defaultTrendMode(), 'delta')
    scope.emit({ status: 'ready', value: { defaultFileSort: 'path' }, writable: true })
    assert.equal(calls, 3)
    assert.equal(s.defaultFileSort(), 'path')
    scope.emit({ status: 'ready', value: { defaultPlacement: 'sidebar' }, writable: true })
    assert.equal(calls, 4)
    assert.equal(s.defaultPlacement(), 'sidebar')
    scope.emit({ status: 'ready', value: { defaultToolSort: 'name' }, writable: true })
    assert.equal(calls, 5)
    assert.equal(s.defaultToolSort(), 'name')
    scope.emit({ status: 'ready', value: { defaultDeltaBase: 'turn' }, writable: true })
    assert.equal(calls, 6)
    assert.equal(s.defaultDeltaBase(), 'turn')
    scope.emit({ status: 'ready', value: { defaultFileSort: 'path' }, writable: false })
    assert.equal(calls, 7)
    assert.equal(s.store.getSnapshot().writable, false)
    scope.emit({ status: 'ready', value: { insightsEntry: 'hide' }, writable: false })
    assert.equal(calls, 8)
    assert.equal(s.insightsEntry(), 'hide')
  })

  test('an identical scope snapshot does not notify listeners', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'turn', defaultFileSort: 'latest' },
      writable: true,
    })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultFileSort: 'latest' }, writable: true })
    assert.equal(calls, 0)
  })

  test('the returned disposer detaches the scope subscription', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detach = s.attach(scope)
    detach()
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 0)
    assert.equal(s.defaultGranularity(), 'step')
  })
})

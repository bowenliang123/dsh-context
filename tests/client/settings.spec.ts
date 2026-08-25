// Settings binding (src/client/settings.ts): defaults, the observable store,
// scope attach/sync, preference parsing, and the local-echo set path.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings, type SettingsScopeLike } from '../../src/client/settings'

/**
 * A faithful in-memory settings scope (the harness settingsScope.bind
 * contract: getSnapshot/subscribe/set), not a mock of plugin code.
 */
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

  set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value })
    return Promise.resolve()
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
      granularity: 'step',
      mode: 'total',
      writable: false,
    })
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
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
})

describe('attach', () => {
  test('syncs a ready snapshot with parsed preferences', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' },
      writable: true,
    })
    s.attach(scope)
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      granularity: 'turn',
      mode: 'delta',
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
        granularity: 'step',
        mode: 'total',
        writable: false,
      })
    }
  })

  test('invalid preference values keep the defaults', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'bogus', defaultTrendMode: 7 },
      writable: false,
    }))
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
  })

  test('explicit schema-default values are accepted', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'step', defaultTrendMode: 'total' },
      writable: false,
    }))
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
  })

  test('missing fields keep the current state', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: false }))
    assert.equal(s.defaultGranularity(), 'turn')
    assert.equal(s.defaultTrendMode(), 'total')
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
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' }, writable: false })
    assert.equal(calls, 3)
    assert.equal(s.store.getSnapshot().writable, false)
  })

  test('an identical scope snapshot does not notify listeners', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
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

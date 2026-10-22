// Settings binding (src/client/settings.ts): the local-echo store over the harness configForms section.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { OFFICIAL_PREFS } from '../../src/client/cost'
import { createContextSettings, costPrefsOf, overviewThresholdOf, type ContextSettings, type SettingsScopeLike } from '../../src/client/settings'

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
      overviewAutoSteps: '200',
      overviewRange: '30d',
      fleetTab: 'show',
      usageWindow: '7d',
      costFxRate: 'official',
      costPeakFactor: '2',
      costMultiplier: '1',
      costActualPrice: 'hide',
      promptPrefix: '',
      promptSuffix: '',
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
    assert.equal(s.overviewAutoSteps(), '200')
    assert.equal(s.defaultOverviewRange(), '30d')
    assert.equal(s.fleetTab(), 'show')
    assert.equal(s.usageWindow(), '7d')
    assert.equal(s.costFxRate(), 'official')
    assert.equal(s.costPeakFactor(), '2')
    assert.equal(s.costMultiplier(), '1')
    assert.equal(s.costActualPrice(), 'hide')
  })
})

describe('overviewThresholdOf', () => {
  test('maps the numeric steps to a threshold and off to null', () => {
    assert.equal(overviewThresholdOf('100'), 100)
    assert.equal(overviewThresholdOf('200'), 200)
    assert.equal(overviewThresholdOf('300'), 300)
    assert.equal(overviewThresholdOf('off'), null)
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
    s.set('promptPrefix', 'Be terse.')
    assert.equal(s.store.getSnapshot().promptPrefix, 'Be terse.')
    s.set('overviewAutoSteps', 'off')
    assert.equal(s.overviewAutoSteps(), 'off')
    s.set('defaultOverviewRange', 'today')
    assert.equal(s.defaultOverviewRange(), 'today')
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

  test('a rejected prompt write rolls back to the scope truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { promptPrefix: 'kept' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('promptPrefix', 'draft')
    assert.equal(s.store.getSnapshot().promptPrefix, 'draft', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.store.getSnapshot().promptPrefix, 'kept', 'the echo rolls back to the scope truth')
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
        overviewAutoSteps: '300',
        defaultOverviewRange: '7d',
        fleetTab: 'hide',
        usageWindow: '30d',
        costFxRate: '7.2',
        costPeakFactor: '1.5',
        costMultiplier: '0.8',
        costActualPrice: 'show',
        promptPrefix: 'Be terse.',
        promptSuffix: 'Sign as Atlas.',
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
      overviewAutoSteps: '300',
      overviewRange: '7d',
      fleetTab: 'hide',
      usageWindow: '30d',
      costFxRate: '7.2',
      costPeakFactor: '1.5',
      costMultiplier: '0.8',
      costActualPrice: 'show',
      promptPrefix: 'Be terse.',
      promptSuffix: 'Sign as Atlas.',
      writable: true,
    })
    assert.equal(s.usageWindow(), '30d')
    assert.equal(s.costFxRate(), '7.2')
    assert.equal(s.costPeakFactor(), '1.5')
    assert.equal(s.costMultiplier(), '0.8')
    assert.equal(s.costActualPrice(), 'show')
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
        overviewAutoSteps: '200',
        overviewRange: '30d',
        fleetTab: 'show',
        usageWindow: '7d',
        costFxRate: 'official',
        costPeakFactor: '2',
        costMultiplier: '1',
        costActualPrice: 'hide',
        promptPrefix: '',
        promptSuffix: '',
        writable: false,
      })
    }
  })

  test('invalid preference values keep the defaults', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'window', defaultGranularity: 'bogus', defaultTrendMode: 7, defaultDeltaBase: 'bogus', defaultToolSort: 'alpha', defaultFileSort: 'alpha', insightsEntry: 42, defaultDurationCurve: 'always', overviewAutoSteps: 200, defaultOverviewRange: 'week', fleetTab: 7, promptPrefix: 9, promptSuffix: {} },
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
    assert.equal(s.overviewAutoSteps(), '200')
    assert.equal(s.defaultOverviewRange(), '30d')
    assert.equal(s.fleetTab(), 'show')
    assert.equal(s.store.getSnapshot().promptPrefix, '', 'a non-string prompt value degrades to the empty default')
    assert.equal(s.store.getSnapshot().promptSuffix, '')
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

  test('an invalid scope auto-overview value degrades to the default instead of keeping the current one', () => {
    const s = createContextSettings()
    s.set('overviewAutoSteps', '100')
    assert.equal(s.overviewAutoSteps(), '100')
    const scope = new TestSettingsScope({ status: 'ready', value: { overviewAutoSteps: '50' }, writable: false })
    s.attach(scope)
    assert.equal(s.overviewAutoSteps(), '200')
  })

  test('an invalid scope overview range degrades to the default instead of keeping the current one', () => {
    const s = createContextSettings()
    s.set('defaultOverviewRange', '7d')
    assert.equal(s.defaultOverviewRange(), '7d')
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultOverviewRange: 'quarter' }, writable: false })
    s.attach(scope)
    assert.equal(s.defaultOverviewRange(), '30d')
  })

  test('explicit schema-default values are accepted', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'all', defaultGranularity: 'step', defaultTrendMode: 'total', defaultDeltaBase: 'step', defaultToolSort: 'count', defaultFileSort: 'count', insightsEntry: 'show', overviewAutoSteps: '200', defaultOverviewRange: 'all' },
      writable: false,
    }))
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'count')
    assert.equal(s.insightsEntry(), 'show')
    assert.equal(s.overviewAutoSteps(), '200')
    assert.equal(s.defaultOverviewRange(), 'all')
  })

  test('missing fields keep the current state', () => {
    const s = createContextSettings()
    s.set('defaultPlacement', 'tab')
    s.set('defaultToolSort', 'size')
    s.set('insightsEntry', 'hide')
    s.set('defaultDurationCurve', 'hide')
    s.set('overviewAutoSteps', '100')
    s.set('defaultOverviewRange', 'today')
    s.set('promptPrefix', 'drafted')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultFileSort: 'latest' }, writable: false }))
    assert.equal(s.defaultPlacement(), 'tab', 'the in-session choice survives a section without the field')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultToolSort(), 'size', 'the in-session tool sort survives a section without the field')
    assert.equal(s.defaultFileSort(), 'latest')
    assert.equal(s.insightsEntry(), 'hide', 'the in-session entry choice survives a section without the field')
    assert.equal(s.defaultDurationCurve(), 'hide', 'the in-session curve choice survives a section without the field')
    assert.equal(s.overviewAutoSteps(), '100', 'the in-session auto-overview choice survives a section without the field')
    assert.equal(s.defaultOverviewRange(), 'today', 'the in-session overview range survives a section without the field')
    assert.equal(s.store.getSnapshot().promptPrefix, 'drafted', 'the in-session prompt text survives a section without the field')
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
    scope.emit({ status: 'ready', value: { defaultFileSort: 'name' }, writable: true })
    assert.equal(calls, 3)
    assert.equal(s.defaultFileSort(), 'name')
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

  test('a set after the disposer runs never reaches the dead scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detach = s.attach(scope)
    detach()
    s.set('defaultTrendMode', 'delta')
    assert.deepEqual(scope.sets, [])
  })

  test('disposing a superseded attach keeps the newer scope bound', () => {
    const s = createContextSettings()
    const first = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const second = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detachFirst = s.attach(first)
    s.attach(second)
    detachFirst()
    s.set('defaultTrendMode', 'delta')
    assert.deepEqual(first.sets, [])
    assert.deepEqual(second.sets, [{ field: 'defaultTrendMode', value: 'delta' }])
  })

  test('a snapshot value that throws on property access keeps the current state', () => {
    const s = createContextSettings()
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    s.attach(new TestSettingsScope({ status: 'ready', value: hostile, writable: true }))
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
      overviewAutoSteps: '200',
      overviewRange: '30d',
      fleetTab: 'show',
      usageWindow: '7d',
      costFxRate: 'official',
      costPeakFactor: '2',
      costMultiplier: '1',
      costActualPrice: 'hide',
      promptPrefix: '',
      promptSuffix: '',
      writable: true,
    })
  })
})

describe('cost preferences', () => {
  const getters: Record<string, (s: ContextSettings) => string> = {
    usageWindow: s => s.usageWindow(),
    costFxRate: s => s.costFxRate(),
    costPeakFactor: s => s.costPeakFactor(),
    costMultiplier: s => s.costMultiplier(),
    costActualPrice: s => s.costActualPrice(),
  }

  test('every accepted enum value parses through prefsOf and its getter', () => {
    const values: [string, string[]][] = [
      ['usageWindow', ['7d', '30d']],
      ['costFxRate', ['official', '7.0', '7.2', '7.4']],
      ['costPeakFactor', ['1', '1.5', '2']],
      ['costMultiplier', ['1', '0.95', '0.9', '0.8', '0.7', '0.5']],
      ['costActualPrice', ['show', 'hide']],
    ]
    for (const [field, options] of values) {
      for (const option of options) {
        const s = createContextSettings()
        s.attach(new TestSettingsScope({ status: 'ready', value: { [field]: option }, writable: true }))
        assert.equal(getters[field](s), option, `${field}=${option}`)
      }
    }
  })

  test('costPrefsOf converts the enum presets into numeric factors', () => {
    assert.deepEqual(
      costPrefsOf({ costFxRate: 'official', costPeakFactor: '2', costMultiplier: '1', costActualPrice: 'hide' }),
      { usdPerCny: OFFICIAL_PREFS.usdPerCny, peakFactor: 2, multiplier: 1 },
    )
    assert.deepEqual(
      costPrefsOf({ costFxRate: '7.2', costPeakFactor: '1.5', costMultiplier: '0.8', costActualPrice: 'show' }),
      { usdPerCny: 1 / 7.2, peakFactor: 1.5, multiplier: 0.8 },
    )
  })

  test('the multiplier prices in only when the actual-price switch is on', () => {
    assert.deepEqual(
      costPrefsOf({ costFxRate: '7.0', costPeakFactor: '1', costMultiplier: '0.5', costActualPrice: 'hide' }),
      { usdPerCny: 1 / 7, peakFactor: 1, multiplier: 1 },
    )
  })

  test('a cost field write echoes locally and reaches the scope', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    s.set('costFxRate', '7.2')
    assert.equal(s.costFxRate(), '7.2', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(scope.sets[0], { field: 'costFxRate', value: '7.2' })
    assert.equal(s.costFxRate(), '7.2')
  })
})

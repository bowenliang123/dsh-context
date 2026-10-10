// The entry `Config` schema (src/host/config.ts): schemastery serves two consumers — cordis validates the `config:` block through its
// Standard Schema face before apply, and the harness's Config-form generation derives the Plugins page's live form from it (the
// volatile-marked preferences). Exercised through the REAL schemastery the tests install.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Config, DEFAULT_BOUNDS, resolveBounds, volatileField } from '../../src/host/config'

/** Dereference a resolved value: volatile fields resolve to references. */
function deref(value: unknown): unknown {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

describe('Config validator (cordis Standard Schema face)', () => {
  test('an absent config (a loader row without config:) resolves to defaults', () => {
    const resolved = Config(undefined) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(DEFAULT_BOUNDS)) {
      assert.equal(resolved[key], value, key)
    }
    const resolvedPrefs = Object.fromEntries(
      Object.entries(resolved).map(([key, value]) => [key, deref(value)]),
    )
    assert.deepEqual(resolvedPrefs, {
      ...DEFAULT_BOUNDS,
      defaultPlacement: 'all',
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultDeltaBase: 'step',
      defaultToolSort: 'count',
      defaultFileSort: 'count',
      insightsEntry: 'show',
      defaultDurationCurve: 'show',
      fleetTab: 'show',
    })
    assert.deepEqual(resolveBounds(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds({}), DEFAULT_BOUNDS)
  })

  test('each field overrides independently', () => {
    assert.equal(resolveBounds({ maxRequestSteps: 7 }).maxRequestSteps, 7)
    assert.equal(resolveBounds({ maxKeptTurns: 7 }).maxKeptTurns, 7)
    assert.equal(resolveBounds({ maxEvents: 7 }).maxEvents, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxNodes, 7)
    assert.equal(resolveBounds({ maxArchiveNodes: 7 }).maxArchiveNodes, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxEvents, DEFAULT_BOUNDS.maxEvents)
  })

  test('rejects zero/negative bounds (min 1)', () => {
    assert.throws(() => Config({ maxRequestSteps: 0 }))
    assert.throws(() => Config({ maxNodes: -1 }))
  })

  test('rejects non-integer bounds (step 1)', () => {
    assert.throws(() => Config({ maxEvents: 1.5 }))
  })

  test('rejects non-number bounds', () => {
    assert.throws(() => Config({ maxKeptTurns: '300' } as unknown as Config))
  })

  test('unknown keys merge through (schemastery objects are not key-strict)', () => {
    // A deliberate relaxation of the zod `.strict()` this schema replaced:
    // an unrecognized key rides along instead of failing the entry load.
    assert.equal(deref(Config({ unknown: 1 } as unknown as Config).maxEvents), DEFAULT_BOUNDS.maxEvents)
  })
})

describe('preference fields (the Config-form generation surface)', () => {
  test('every preference is volatile-marked; the bounds are not', () => {
    const dict = Config.dict ?? {}
    for (const pref of ['defaultPlacement', 'defaultGranularity', 'defaultTrendMode', 'defaultDeltaBase', 'defaultToolSort', 'defaultFileSort', 'insightsEntry', 'defaultDurationCurve', 'fleetTab']) {
      assert.equal((dict[pref] as z['dict'] extends undefined ? never : { meta?: { volatile?: boolean } }).meta?.volatile, true, pref)
    }
    for (const bound of ['maxRequestSteps', 'maxKeptTurns', 'maxEvents', 'maxNodes', 'maxArchiveNodes', 'maxFileOps']) {
      assert.notEqual((dict[bound] as { meta?: { volatile?: boolean } }).meta?.volatile, true, bound)
    }
  })

  test('preferences resolve to schema defaults; a stale value degrades to its default (loose)', () => {
    const resolved = Config({ defaultGranularity: 'bogus' } as unknown as Config)
    assert.equal(deref(resolved.defaultPlacement), 'all')
    assert.equal(deref(resolved.defaultGranularity), 'step')
    assert.equal(deref(resolved.defaultTrendMode), 'total')
    assert.equal(deref(resolved.defaultDeltaBase), 'step')
    assert.equal(deref(resolved.defaultToolSort), 'count')
    assert.equal(deref(resolved.defaultFileSort), 'count')
    assert.equal(deref(resolved.insightsEntry), 'show')
    assert.equal(deref(resolved.defaultDurationCurve), 'show')
    assert.equal(deref(resolved.fleetTab), 'show')
  })

  test('a stored preference survives the resolve', () => {
    const resolved = Config({ defaultPlacement: 'sidebar', insightsEntry: 'hide', fleetTab: 'hide' })
    assert.equal(deref(resolved.defaultPlacement), 'sidebar')
    assert.equal(deref(resolved.insightsEntry), 'hide')
    assert.equal(deref(resolved.fleetTab), 'hide')
  })
})

describe('volatileField', () => {
  test('marks the field where schemastery ships the modifier', () => {
    assert.equal(volatileField(z.union(['a', 'b']).default('a')).meta?.volatile, true)
  })

  test('returns the field unchanged on a schemastery without the modifier (the older lines)', () => {
    const plain = z.union(['a', 'b']).default('a')
    // A schema-shaped value with no `volatile` member at all — the shape the older lines' schemastery presents.
    const legacy = { meta: plain.meta } as typeof plain
    assert.equal(volatileField(legacy), legacy)
    assert.equal(legacy.meta?.volatile, undefined)
  })
})

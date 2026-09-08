// The auto-compact tuning pass (src/host/compactionTune.ts): overlay/restore
// semantics over engine-shaped fixtures, the hostile-object guards, the
// pre-step wiring, and a REAL cordis composition covering both deployment
// shapes at once (the CLI host-plane row plus two web per-preset realms).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context, type Context as Ctx } from '@deepseek-ai/cordis'
import { installCompactionTune, reconcileCompaction } from '../../src/host/compactionTune'
import type { PluginSettings } from '../../src/shared/types'

// The engine fixture mirrors the harness BasicCompactionEngine's consumed
// face: a `config` property holding the frozen resolved object.
interface EngineLike { config: unknown }

function engine(config: Record<string, unknown>): EngineLike {
  return { config: Object.freeze({ retainRatio: 0.16, modelPolicies: [], ...config }) }
}

interface StoreEntry {
  name?: string
  value?: unknown
  /** The impl record itself throws on any property read. */
  hostile?: boolean
  /** The store slot holds null instead of an impl record. */
  nullImpl?: boolean
}

function storeCtx(entries: StoreEntry[]): Ctx {
  const store: Record<symbol, unknown> = {}
  for (const entry of entries) {
    if (entry.nullImpl === true) {
      store[Symbol('impl')] = null
    } else if (entry.hostile === true) {
      const impl: Record<string, unknown> = {}
      Object.defineProperty(impl, 'name', { get() { throw new Error('boom') } })
      store[Symbol('impl')] = impl
    } else {
      store[Symbol('impl')] = { name: entry.name, value: entry.value }
    }
  }
  return { reflect: { store } } as unknown as Ctx
}

describe('reconcileCompaction overlay semantics', () => {
  test('overlays the threshold onto the engine config, leaving the original untouched', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const original = e.config
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionThresholdRatio: 0.5 })
    assert.deepEqual(e.config, { thresholdRatio: 0.5, retainRatio: 0.16, modelPolicies: [] })
    assert.notEqual(e.config, original)
    assert.equal(Object.isFrozen(e.config), true, 'the overlay keeps the frozen contract')
    assert.deepEqual(original, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] })
  })

  test('the same setting twice is a no-op (identical overlay object)', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    const tuned = e.config
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    assert.equal(e.config, tuned)
  })

  test('a changed setting rebuilds from the ORIGINAL (no overlay stacking)', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.6 })
    assert.deepEqual(e.config, { thresholdRatio: 0.6, retainRatio: 0.16, modelPolicies: [] })
  })

  test('clearing the setting restores the exact original config and drops the stash', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    const original = e.config
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    reconcileCompaction(ctx, undefined)
    // Reference identity is the contract: the engine's own frozen object is back.
    assert.equal(e.config, original)
    // A second pass over the restored engine stays a no-op.
    reconcileCompaction(ctx, undefined)
    assert.equal(e.config, original)
  })

  test('an untouched engine with no setting is never rewritten', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const original = e.config
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), undefined)
    assert.equal(e.config, original)
  })

  test('a reconfigured engine re-bases: the overlay applies over the NEW config', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    // The harness itself never mutates in place — a reload mounts a fresh
    // engine; treat an external replacement the same way.
    e.config = Object.freeze({ thresholdRatio: 0.7, retainRatio: 0.2, modelPolicies: [] })
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 })
    assert.deepEqual(e.config, { thresholdRatio: 0.5, retainRatio: 0.2, modelPolicies: [] })
    // Clearing after a re-base restores the replacement, not the first original.
    reconcileCompaction(ctx, undefined)
    assert.deepEqual(e.config, { thresholdRatio: 0.7, retainRatio: 0.2, modelPolicies: [] })
  })
})

describe('reconcileCompaction retention overlay', () => {
  test('a valid retain ratio lands alongside the threshold', () => {
    const e = engine({ thresholdRatio: 0.8 })
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.1 })
    assert.deepEqual(e.config, { thresholdRatio: 0.5, retainRatio: 0.1, modelPolicies: [] })
  })

  test('a retain-only setting overlays the tail alone', () => {
    const e = engine({ thresholdRatio: 0.8 })
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionRetainRatio: 0.1 })
    assert.deepEqual(e.config, { thresholdRatio: 0.8, retainRatio: 0.1, modelPolicies: [] })
  })

  test('an engine pinning retainTokens keeps its absolute tail (threshold still applies)', () => {
    const e = engine({ thresholdRatio: 0.8, retainTokens: 4096, retainRatio: undefined })
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.1 })
    assert.equal((e.config as { retainTokens?: unknown }).retainTokens, 4096)
    assert.equal((e.config as { retainRatio?: unknown }).retainRatio, undefined, 'no ratio tail is invented beside the pin')
    assert.equal((e.config as { thresholdRatio?: unknown }).thresholdRatio, 0.5)
  })

  test('an overlay that would break retention-below-trigger leaves the engine as found', () => {
    // Original tail 0.5 vs a lowered trigger 0.3 — the engine would refuse
    // every compaction, so nothing is written (and nothing is stashed).
    const e = engine({ thresholdRatio: 0.8, retainRatio: 0.5 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    const original = e.config
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.3 })
    assert.equal(e.config, original)
    // Clearing later must not "restore" over an engine that was never touched.
    reconcileCompaction(ctx, undefined)
    assert.equal(e.config, original)
  })

  test('a requested tail at or above the effective trigger is rejected whole', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    const original = e.config
    reconcileCompaction(ctx, { compactionRetainRatio: 0.9 })
    assert.equal(e.config, original, 'tail >= trigger: no write')
    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.5 })
    assert.equal(e.config, original, 'tail == trigger: no write')
  })

  test('the tuned tail clears every per-model threshold override, not just the default', () => {
    // A policy pins model B's trigger at 0.3 while inheriting the DEFAULT
    // tail; a tuned tail of 0.4 would strand that model (the engine validates
    // exactly this cross-product at load).
    const e = engine({ thresholdRatio: 0.8, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.3 }] })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    const original = e.config
    reconcileCompaction(ctx, { compactionRetainRatio: 0.4 })
    assert.equal(e.config, original, 'tail above a policy trigger: no write')
    reconcileCompaction(ctx, { compactionRetainRatio: 0.3 })
    assert.equal(e.config, original, 'tail equal to a policy trigger: no write')
    reconcileCompaction(ctx, { compactionRetainRatio: 0.29 })
    assert.deepEqual(e.config, { thresholdRatio: 0.8, retainRatio: 0.29, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.3 }] })
  })

  test('a lowered default trigger stays valid: policy overrides keep their own thresholds', () => {
    const e = engine({ thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.6 }] })
    const original = e.config
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionThresholdRatio: 0.5 })
    assert.deepEqual(e.config, { thresholdRatio: 0.5, retainRatio: 0.16, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.6 }] })
    assert.deepEqual(original, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.6 }] })
  })

  test('a tuned tail below a policy trigger, with the policy carrying its own tail, is free to rise', () => {
    // Model B overrides BOTH its trigger and its tail: it never inherits the
    // default tail, so it cannot constrain the overlay. The conservative
    // single check still holds (min over ALL explicit policy triggers), and
    // 0.35 < 0.5 passes here.
    const e = engine({ thresholdRatio: 0.8, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.5, retainRatio: 0.1 }] })
    reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionRetainRatio: 0.35 })
    assert.deepEqual(e.config, { thresholdRatio: 0.8, retainRatio: 0.35, modelPolicies: [{ provider: 'p', model: 'b', thresholdRatio: 0.5, retainRatio: 0.1 }] })
  })

  test('hostile or malformed modelPolicies are ignored by the cross-check', () => {
    for (const policies of [
      'nope',
      42,
      [null, 7, 'x'],
      [{ thresholdRatio: 'high' }, { thresholdRatio: Number.NaN }, null],
      [{ get thresholdRatio(): never { throw new Error('boom') } }],
    ]) {
      const e = engine({ thresholdRatio: 0.8, modelPolicies: policies })
      assert.doesNotThrow(
        () => reconcileCompaction(storeCtx([{ name: 'compaction', value: e }]), { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.1 }),
      )
      const tuned = e.config as { thresholdRatio?: unknown; retainRatio?: unknown }
      assert.equal(tuned.thresholdRatio, 0.5)
      assert.equal(tuned.retainRatio, 0.1)
    }
  })
})

describe('reconcileCompaction guards', () => {
  test('unfamiliar engine shapes are skipped, not crashed on', () => {
    const shapes: unknown[] = [
      null,
      42,
      {},
      { config: null },
      { config: 42 },
      { config: [0.8] },
      { config: {} },
      { config: { thresholdRatio: '0.8' } },
      { config: { thresholdRatio: Number.NaN } },
    ]
    for (const value of shapes) {
      assert.doesNotThrow(
        () => reconcileCompaction(storeCtx([{ name: 'compaction', value }]), { compactionThresholdRatio: 0.5 }),
      )
    }
  })

  test('a hostile engine (throws on property access) is skipped; siblings still tune', () => {
    const hostile: Record<string, never> = {}
    Object.defineProperty(hostile, 'config', { get() { throw new Error('boom') } })
    const healthy = engine({ thresholdRatio: 0.8 })
    reconcileCompaction(
      storeCtx([{ name: 'compaction', value: hostile }, { name: 'compaction', value: healthy }]),
      { compactionThresholdRatio: 0.5 },
    )
    assert.deepEqual(healthy.config, { thresholdRatio: 0.5, retainRatio: 0.16, modelPolicies: [] })
  })

  test('hostile or empty store records are skipped whole', () => {
    const healthy = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([
      { hostile: true },
      { nullImpl: true },
      { name: 'compaction' },
      { name: 'compaction', value: null },
      { name: 'tokenMeter', value: engine({ thresholdRatio: 0.8 }) },
      { name: 'compaction', value: healthy },
    ])
    assert.doesNotThrow(() => reconcileCompaction(ctx, { compactionThresholdRatio: 0.5 }))
    assert.deepEqual(healthy.config, { thresholdRatio: 0.5, retainRatio: 0.16, modelPolicies: [] })
  })

  test('a missing or malformed reflect store degrades to no engines', () => {
    const want = { compactionThresholdRatio: 0.5 }
    assert.doesNotThrow(() => reconcileCompaction({} as unknown as Ctx, want))
    assert.doesNotThrow(() => reconcileCompaction({ reflect: {} } as unknown as Ctx, want))
    assert.doesNotThrow(() => reconcileCompaction({ reflect: { store: 42 } } as unknown as Ctx, want))
    // A hostile reflect face (throws on the store read itself) too.
    assert.doesNotThrow(() => reconcileCompaction({ get reflect(): never { throw new Error('boom') } } as unknown as Ctx, want))
  })

  test('out-of-range settings re-proof: every unusable ratio degrades to "keep the engine"', () => {
    const e = engine({ thresholdRatio: 0.8 })
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    const original = e.config
    for (const bad of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      reconcileCompaction(ctx, { compactionThresholdRatio: bad as number })
    }
    assert.equal(e.config, original)
    // 1.0 IS a legal threshold (pressure effectively off; overflow still recovers).
    reconcileCompaction(ctx, { compactionThresholdRatio: 1 })
    assert.deepEqual(e.config, { thresholdRatio: 1, retainRatio: 0.16, modelPolicies: [] })
  })
})

describe('installCompactionTune wiring', () => {
  test('tunes once at install and sweeps before forwarding every pre-step', async () => {
    const e = engine({ thresholdRatio: 0.8 })
    const listeners: Array<(input: object, next: () => Promise<unknown>) => Promise<unknown>> = []
    const reads: Array<Partial<PluginSettings> | undefined> = [undefined, { compactionThresholdRatio: 0.4 }, undefined]
    let readCount = 0
    const ctx = storeCtx([{ name: 'compaction', value: e }])
    ;(ctx as { on?: unknown }).on = (event: string, listener: (input: object, next: () => Promise<unknown>) => Promise<unknown>) => {
      assert.equal(event, 'agent/pre-step')
      listeners.push(listener)
    }
    installCompactionTune(ctx, { read: () => reads[readCount++] })
    // The install-time pass consumed the first read (unset → untouched).
    assert.equal(readCount, 1)
    assert.deepEqual(e.config, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] })

    assert.equal(listeners.length, 1)
    let forwarded = false
    const decision = await listeners[0]({}, async () => { forwarded = true; return { kind: 'enter' } })
    assert.equal(forwarded, true, 'the sweep never replaces the step decision')
    assert.deepEqual(decision, { kind: 'enter' })
    assert.deepEqual(e.config, { thresholdRatio: 0.4, retainRatio: 0.16, modelPolicies: [] })

    // The next step sees the cleared setting and restores.
    await listeners[0]({}, async () => ({ kind: 'enter' }))
    assert.deepEqual(e.config, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] })
  })

  test('a throwing settings read or engine never breaks the turn', async () => {
    const hostile: Record<string, never> = {}
    Object.defineProperty(hostile, 'config', { get() { throw new Error('boom') } })
    const listeners: Array<(input: object, next: () => Promise<unknown>) => Promise<unknown>> = []
    const ctx = storeCtx([{ name: 'compaction', value: hostile }])
    ;(ctx as { on?: unknown }).on = (_event: string, listener: (input: object, next: () => Promise<unknown>) => Promise<unknown>) => { listeners.push(listener) }
    installCompactionTune(ctx, { read: () => { throw new Error('settings down') } })
    // The install-time pass already swallowed the throw; the step pass does too.
    let forwarded = false
    await listeners[0]({}, async () => { forwarded = true; return 'ok' })
    assert.equal(forwarded, true)
  })
})

describe('reconcileCompaction on a real cordis context', () => {
  test('one pass tunes the CLI host-plane row and every web per-preset realm', () => {
    const ctx = new Context()
    const hostRow = engine({ thresholdRatio: 0.8 })
    ctx.reflect.provide('compaction', hostRow)
    // Two preset realms: isolated child scopes, each with its own engine.
    const realmA = ctx.isolate('compaction')
    const engineA = engine({ thresholdRatio: 0.8 })
    realmA.reflect.provide('compaction', engineA)
    const realmB = ctx.isolate('compaction')
    const engineB = engine({ thresholdRatio: 0.8, retainRatio: 0.2 })
    realmB.reflect.provide('compaction', engineB)

    assert.equal(ctx.get('compaction'), hostRow, 'the root scope resolves the host row')
    assert.equal(realmA.get('compaction'), engineA, 'each realm resolves its own engine')

    reconcileCompaction(ctx, { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.1 })
    assert.deepEqual(hostRow.config, { thresholdRatio: 0.5, retainRatio: 0.1, modelPolicies: [] })
    assert.deepEqual(engineA.config, { thresholdRatio: 0.5, retainRatio: 0.1, modelPolicies: [] })
    assert.deepEqual(engineB.config, { thresholdRatio: 0.5, retainRatio: 0.1, modelPolicies: [] })

    reconcileCompaction(ctx, undefined)
    assert.deepEqual(hostRow.config, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] })
    assert.deepEqual(engineA.config, { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] })
    assert.deepEqual(engineB.config, { thresholdRatio: 0.8, retainRatio: 0.2, modelPolicies: [] })
  })
})

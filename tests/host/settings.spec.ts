// Integration tests for the plugin settings namespace (src/host/settings.ts)
// against the REAL cordis context and the REAL dsh-settings provider base —
// the dsh-canonical harness pattern: an in-memory SettingsProvider subclass,
// mounted as a plugin, with installSettings layering the namespace on top.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { installSettings, prefsOf, SETTINGS_NAMESPACE } from '../../src/host/settings'
import type { PluginSettings } from '../../src/host/settings'

/** A provider implementing only the two storage primitives; the Service Definition owns the rest. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[String(ns)] = structuredClone(section)
    return Promise.resolve()
  }
}

// The raw string is what the dsh settings `register` accepts at runtime; the
// branded cast satisfies the SettingsNamespace type face (see
// src/host/settings.ts).
const ns = SETTINGS_NAMESPACE as SettingsNamespace

/** Poll until the inject callback inside installSettings has registered the namespace. */
async function untilRegistered(ctx: Context): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ctx.settings.get(ns) !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('the dsh-context settings namespace was never registered')
}

async function boot(doc?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
  installSettings(ctx)
  await untilRegistered(ctx)
  return { ctx, provider: ctx.get('settings') as MemorySettings }
}

describe('installSettings', () => {
  test('the namespace is the plugin short name', () => {
    assert.equal(SETTINGS_NAMESPACE, 'dsh-context')
  })

  test('registers the dsh-context namespace with schema defaults', async () => {
    const { ctx } = await boot()
    const descriptors = ctx.settings.describe()
    assert.ok(descriptors.some(d => String(d.ns) === 'dsh-context'), 'the namespace is registered')
    assert.deepEqual(ctx.settings.get(ns), {
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultFileSort: 'count',
    }, 'schema defaults resolve')
  })

  test('updates flow through the real scope; invalid values reject', async () => {
    const { ctx, provider } = await boot()
    await ctx.settings.update(ns, { defaultGranularity: 'turn' })
    assert.deepEqual(ctx.settings.get(ns), {
      defaultGranularity: 'turn',
      defaultTrendMode: 'total',
      defaultFileSort: 'count',
    }, 'the update resolves over the schema defaults')
    assert.deepEqual(provider.doc['dsh-context'], { defaultGranularity: 'turn' }, 'the provider persisted the section')

    await ctx.settings.update(ns, { defaultTrendMode: 'delta', defaultFileSort: 'path' })
    assert.deepEqual(ctx.settings.get(ns), {
      defaultGranularity: 'turn',
      defaultTrendMode: 'delta',
      defaultFileSort: 'path',
    }, 'every preference field resolves independently')

    await assert.rejects(
      ctx.settings.update(ns, { defaultGranularity: 'week' }),
      'an unknown granularity fails validation before anything persists',
    )
    // The loose fields degrade instead of rejecting: a stale file sort resolves to the default.
    await ctx.settings.update(ns, { defaultFileSort: 'net' })
    assert.deepEqual(ctx.settings.get(ns), {
      defaultGranularity: 'turn',
      defaultTrendMode: 'delta',
      defaultFileSort: 'count',
    }, 'a stale file sort degrades to the schema default')
    assert.deepEqual(provider.doc['dsh-context'], { defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'net' }, 'the stale value stays raw in storage and degrades at read')
  })

  test('a stale persisted preference degrades to the default (loose)', async () => {
    const { ctx } = await boot({ 'dsh-context': { defaultTrendMode: 'net', defaultFileSort: 'alpha' } })
    const value = ctx.settings.get(ns) as PluginSettings
    assert.equal(value.defaultTrendMode, 'total', 'the stale value falls back instead of breaking the section')
    assert.equal(value.defaultFileSort, 'count', 'the stale file sort falls back instead of breaking the section')
    assert.equal(value.defaultGranularity, 'step')
  })

  test('without a settings provider the install is inert', () => {
    const ctx = new Context()
    assert.doesNotThrow(() => installSettings(ctx))
    assert.equal(ctx.get('settings'), undefined, 'no provider composed, nothing registered')
    // The read face yields undefined before any provider composes: the tuning
    // pass treats that as "keep the engines' own configuration".
    const face = installSettings(new Context())
    assert.equal(face.read(), undefined)
  })

  test('the read face serves the re-proved section once the provider composes', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, { doc: { 'dsh-context': { compactionThresholdRatio: 0.5, compactionRetainRatio: 0.2 } } })
    const face = installSettings(ctx)
    // The inject resolves async even over an available provider; until then
    // the face reads undefined (and the tuning pass keeps engine configs).
    assert.equal(face.read(), undefined)
    for (let i = 0; i < 200 && face.read() === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.deepEqual(face.read(), {
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultFileSort: 'count',
      compactionThresholdRatio: 0.5,
      compactionRetainRatio: 0.2,
    })
  })

  test('a hostile section read degrades the face to undefined', () => {
    // A fake inject that resolves a provider whose register hands back a
    // section throwing on read.
    const ctx = {
      inject(_names: string[], cb: (sctx: unknown) => void): void {
        cb({ settings: { register: () => ({ get() { throw new Error('boom') } }) } })
      },
    }
    const face = installSettings(ctx as never)
    assert.equal(face.read(), undefined)
  })
})

describe('prefsOf', () => {
  test('rejects non-object sections whole', () => {
    for (const bad of [undefined, null, 42, 'section', () => {}]) {
      assert.equal(prefsOf(bad as never), undefined)
    }
  })

  test('keeps valid ratios and fills display defaults', () => {
    assert.deepEqual(prefsOf({ compactionThresholdRatio: 0.5, compactionRetainRatio: 0.2 }), {
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultFileSort: 'count',
      compactionThresholdRatio: 0.5,
      compactionRetainRatio: 0.2,
    })
  })

  test('degrades unusable ratios to absent fields', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      const section = prefsOf({ compactionThresholdRatio: bad, compactionRetainRatio: bad })
      assert.equal('compactionThresholdRatio' in (section as object), false, String(bad))
      assert.equal('compactionRetainRatio' in (section as object), false, String(bad))
    }
    // The boundary is inclusive at 1 for both (the engine's own assertRatio).
    assert.deepEqual(prefsOf({ compactionThresholdRatio: 1 })?.compactionThresholdRatio, 1)
  })

  test('degrades unknown display values to schema defaults', () => {
    assert.deepEqual(prefsOf({ defaultGranularity: 'week', defaultTrendMode: 7, defaultFileSort: true }), {
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultFileSort: 'count',
    })
  })
})

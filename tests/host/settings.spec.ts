// Integration tests for the plugin settings namespace (src/host/settings.ts)
// against the REAL cordis context and the REAL dsh-settings provider base —
// the dsh-canonical harness pattern: an in-memory SettingsProvider subclass,
// mounted as a plugin, with installSettings layering the namespace on top.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { installSettings, SETTINGS_NAMESPACE } from '../../src/host/settings'
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

const ns = settingsNamespace(SETTINGS_NAMESPACE)

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
  })
})

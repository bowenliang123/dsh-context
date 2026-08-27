// Unit tests for the runtime register() attribution hook (src/host/attribution.ts)
// against a REAL cordis Context: plugin fibers read `ctx.tools` (firing the
// internal/get waterfall) and call `register()` on a fake tools service.

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../../src/shared/types'
import { callerPackageFrom, createToolAttribution, packageNameFrom, type ToolAttribution } from '../../src/host/attribution'

/** Render an absolute fs path as a `file://` URL for synthetic stack frames. */
const fileUrl = (file: string) => 'file:///' + file.replace(/\\/g, '/')

/** Absolute path of this spec file (a file inside the dsh-context package). */
const specFile = path.normalize(fileURLToPath(import.meta.url))

describe('createToolAttribution', () => {
  test('falls back to the static chain when nothing was registered at runtime', () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    assert.equal(attribution.ownerOf('read'), '@deepseek-ai/dsh-tool-fs')
    assert.equal(attribution.ownerOf('mcp__github__get_issue'), 'mcp:github')
    assert.equal(attribution.ownerOf('unknown_tool'), undefined)
  })

  test('attributes tools to the plugin that read ctx.tools and registered them', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    const fake = { register() { return () => {} } }
    app.provide('tools', fake)
    let release: () => void = () => {}
    await app.plugin({
      name: 'provider-a',
      apply(sub) {
        const tools = (sub as any).tools
        assert.equal((sub as any).tools, fake, 'a wrapped instance is returned as-is')
        release = tools.register({ name: 'alpha' })
        tools.register({ name: 'beta' })
      },
    })
    assert.equal(attribution.ownerOf('alpha'), 'provider-a')
    assert.equal(attribution.ownerOf('beta'), 'provider-a')
    release()
    assert.equal(attribution.ownerOf('alpha'), undefined, 'the disposer forgets the tool')
    assert.equal(attribution.ownerOf('beta'), 'provider-a')
  })

  test('falls back to the caller stack when no tools read happened', async () => {
    const app = new Context()
    const fake = { register() { return () => {} } }
    app.provide('tools', fake)
    const attribution = createToolAttribution(app)
    const { registerBlind } = await import('./fixtures/anon-plugin/index.js')
    const tools = app.get('tools', false) as { register(def?: unknown): () => void }
    const release = registerBlind(tools)
    assert.equal(attribution.ownerOf('blind_tool'), 'anon-plugin', 'no reader → the caller stack wins')
    release()
    assert.equal(attribution.ownerOf('blind_tool'), undefined, 'the disposer forgets the tool')
  })

  test('root and self reader slots fall back to the caller stack', async () => {
    const app = new Context()
    const fake = { register() { return () => {} } }
    app.provide('tools', fake)
    const { registerBlind } = await import('./fixtures/anon-plugin/index.js')
    let attribution!: ToolAttribution
    await app.plugin({
      name: 'dsh-context',
      inject: ['tools'],
      apply(sub) {
        attribution = createToolAttribution(sub)
        registerBlind((sub as any).tools)
      },
    })
    await app.plugin({
      apply(sub) {
        registerBlind((sub as any).tools)
      },
    })
    assert.equal(attribution.ownerOf('blind_tool'), 'anon-plugin', 'self/root slots are never taken as-is')
  })

  test('ignores non-tools reads and keeps the static chain intact', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    app.provide('bench', { value: 1 })
    await app.plugin({
      name: 'probe',
      apply(sub) {
        void (sub as any).bench.value
        void (sub as any).bench.value
      },
    })
    assert.equal(attribution.ownerOf('grep'), '@deepseek-ai/dsh-tool-fs-search')
  })

  test('tolerates falsy and non-object tools values', async () => {
    for (const value of [undefined, 42]) {
      const app = new Context()
      const attribution = createToolAttribution(app)
      app.provide('tools', value)
      await app.plugin({
        name: 'probe',
        apply(sub) {
          void (sub as any).tools
        },
      })
      assert.equal(attribution.ownerOf('x'), undefined)
    }
  })

  test('leaves instances without a callable register untouched', async () => {
    for (const tools of [{ register: 42 }, {}]) {
      const app = new Context()
      const attribution = createToolAttribution(app)
      app.provide('tools', tools)
      await app.plugin({
        name: 'probe',
        apply(sub) {
          void (sub as any).tools
        },
      })
      assert.equal(attribution.ownerOf('whatever'), undefined)
    }
  })

  test('ignores registrations without a string tool name or a disposer', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    app.provide('tools', { register() { return undefined } })
    await app.plugin({
      name: 'weird',
      apply(sub) {
        const tools = (sub as any).tools
        tools.register()
        tools.register({ name: 42 })
        tools.register({ name: 'sticky' })
      },
    })
    assert.equal(attribution.ownerOf('sticky'), 'weird', 'records even without a disposer')
    assert.equal(attribution.ownerOf('42'), undefined, 'non-string tool names are not recorded')
  })

  test('keeps the static chain authoritative over live records', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    const fake = { register() { return () => {} } }
    app.provide('tools', fake)
    await app.plugin({
      name: 'third-party',
      apply(sub) {
        const tools = (sub as any).tools
        tools.register({ name: 'bash' })
        tools.register({ name: 'mcp__github__x' })
        tools.register({ name: 'brand_new_tool' })
      },
    })
    assert.equal(attribution.ownerOf('bash'), '@deepseek-ai/dsh-tool-bash', 'pinned map wins over the live record')
    assert.equal(attribution.ownerOf('mcp__github__x'), 'mcp:github', 'MCP naming wins over the live record')
    assert.equal(attribution.ownerOf('brand_new_tool'), 'third-party', 'live record fills the gap')
  })

  test('tags boot-time tools whose providers predate the hook as unknown', () => {
    const app = new Context()
    const fake = {
      register() { return () => {} },
      layers: { global: { tools: { entries: () => [
        ['claim_files', {}],
        ['pending_write', {}],
        ['read', {}],
      ] } } },
    }
    app.provide('tools', fake)
    const attribution = createToolAttribution(app)
    assert.equal(attribution.ownerOf('claim_files'), UNKNOWN_TOOL_SOURCE, 'boot-only tools carry the unknown sentinel')
    assert.equal(attribution.ownerOf('pending_write'), UNKNOWN_TOOL_SOURCE)
    assert.equal(attribution.ownerOf('read'), '@deepseek-ai/dsh-tool-fs', 'the static chain wins over the unknown tag')
    assert.equal(attribution.ownerOf('nope'), undefined, 'names outside the boot snapshot stay untagged')
  })

  test('a later runtime registration overrides the boot-time unknown tag', async () => {
    const app = new Context()
    const fake = {
      register() { return () => {} },
      layers: { global: { tools: { entries: () => [['claim_files', {}]] } } },
    }
    app.provide('tools', fake)
    const attribution = createToolAttribution(app)
    await app.plugin({
      name: 'claim-like',
      apply(sub) {
        ;((sub as any).tools as { register(def?: unknown): () => void }).register({ name: 'claim_files' })
      },
    })
    assert.equal(attribution.ownerOf('claim_files'), 'claim-like', 'a later live record beats the boot unknown tag')
  })

  test('tolerates tools values without an enumerable boot layer', () => {
    for (const tools of [
      undefined,
      { register() { return () => {} } },
      { register() { return () => {} }, layers: {} },
      { register() { return () => {} }, layers: { global: {} } },
      { register() { return () => {} }, layers: { global: { tools: {} } } },
      // A host tool service whose enumeration throws must not take the
      // caller's startup down — the boot snapshot just stays empty.
      {
        register() { return () => {} },
        layers: { global: { tools: { entries() { throw new Error('boom') } } } },
      },
    ]) {
      const app = new Context()
      if (tools !== undefined) app.provide('tools', tools)
      const attribution = createToolAttribution(app)
      assert.equal(attribution.ownerOf('whatever'), undefined, 'no boot entries → no unknown tag')
    }
  })

  test('resolves root-named local-link plugins through the register call stack', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    const fake = { register() { return () => {} } }
    app.provide('tools', fake)
    const { registerTool } = await import('./fixtures/local-plugin/index.js')
    await app.plugin({
      apply(sub) {
        registerTool((sub as any).tools)
      },
    })
    assert.equal(attribution.ownerOf('local_tool'), 'local-plugin')
  })

  test('callerPackageFrom resolves the registering package from a stack', () => {
    const anon = path.normalize(fileURLToPath(new URL('./fixtures/anon-plugin/index.js', import.meta.url)))
    const local = path.normalize(fileURLToPath(new URL('./fixtures/local-plugin/index.js', import.meta.url)))
    assert.equal(callerPackageFrom(undefined), undefined)
    assert.equal(callerPackageFrom('no frames here'), undefined)
    // non-frame lines are skipped
    assert.equal(callerPackageFrom(`Error\n  note\n  at ${local}:1:2`), 'local-plugin')
    // frames without a :line:col position are skipped, unresolvable targets yield undefined
    assert.equal(callerPackageFrom('Error\n    at x (file:///D:/no-position.js)\n    at y (file:///D:/has-position.js:1:2)'), undefined)
    // bare absolute path frames (transpiled modules) resolve
    assert.equal(callerPackageFrom(`Error\n    at ${local}:1:2\n    at ${specFile}:3:4`), 'local-plugin')
    // file:// URL frames with fn (...) wrappers resolve
    assert.equal(callerPackageFrom(`Error\n    at registerBlind (${fileUrl(anon)}:1:2)\n    at run (${fileUrl(specFile)}:3:4)`), 'anon-plugin')
    // frames resolving to this package are skipped, the next package wins
    assert.equal(callerPackageFrom(`Error\n    at ${specFile}:1:2\n    at ${local}:3:4`), 'local-plugin')
    // this module's own frames are skipped too
    const attributionFile = path.normalize(fileURLToPath(new URL('../../src/host/attribution.ts', import.meta.url)))
    assert.equal(callerPackageFrom(`Error\n    at ${attributionFile}:1:2\n    at ${local}:3:4`), 'local-plugin')
    // unparseable file URLs are skipped
    assert.equal(callerPackageFrom(`Error\n    at x (file:///D:/bad%zz.js:1:2)\n    at y (${fileUrl(local)}:3:4)`), 'local-plugin')
    // non-absolute targets (e.g. node: internal frames) are skipped
    assert.equal(callerPackageFrom(`Error\n    at ModuleJob.run (node:internal/modules/esm/module_job.js:346:20)\n    at y (${fileUrl(local)}:3:4)`), 'local-plugin')
    // async wrappers are tolerated
    assert.equal(callerPackageFrom(`Error\n    at async fn (${fileUrl(anon)}:1:2)`), 'anon-plugin')
  })

  test('packageNameFrom walks up to the nearest readable package.json', () => {
    const local = fileURLToPath(new URL('./fixtures/local-plugin/index.js', import.meta.url))
    assert.equal(packageNameFrom(local), 'local-plugin')
    assert.equal(packageNameFrom(local), 'local-plugin', 'results are cached per directory')
    const malformed = fileURLToPath(new URL('./fixtures/bad-pkg/index.js', import.meta.url))
    assert.equal(packageNameFrom(malformed), 'dsh-context', 'a malformed package.json is skipped, the walk continues upward')
    const rootless = path.join(path.parse(process.cwd()).root, '__dsh_context_nonexistent__', 'file.js')
    assert.equal(packageNameFrom(rootless), undefined, 'no readable boundary up to the filesystem root')
    const deep = path.join(path.parse(process.cwd()).root, ...Array.from({ length: 13 }, (_, i) => `__dsh_ctx_l${i}__`), 'file.js')
    assert.equal(packageNameFrom(deep), undefined, 'the walk-depth cap returns undefined before reaching the root')
  })
})
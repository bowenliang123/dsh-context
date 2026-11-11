import assert from 'node:assert/strict'
import { describe, test, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { basename, join } from 'node:path'
import { ATTACHMENT_ROUTE, makePreviewSweeper, PREVIEWS_MAX_DIRS, PREVIEWS_TTL_MS, referencedAttachmentOf, imagePreviewNameOf, watchAttachmentChannel } from '../../src/host/attachment'
import { type ColdReadGate } from '../../src/host/coldRead'
import { connectionOf, fakeCtx, observing, OPEN_GATE, postJson, SKIP_GATE, type FakeCtx, type FakeRoute } from './helpers/ctx'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../../src/shared/types'
import { callerPackageFrom, createToolAttribution, packageNameFrom, type ToolAttribution } from '../../src/host/attribution'

describe('attachment', () => {

function armed(spec: Record<string, unknown> = {}, gate: ColdReadGate = OPEN_GATE): FakeCtx {
  const fake = fakeCtx({ connection: connectionOf(), ...spec })
  watchAttachmentChannel(fake.ctx, gate)
  return fake
}

const call = (captured: FakeRoute, body: unknown): Promise<Record<string, unknown>> => postJson(captured, ATTACHMENT_ROUTE, body)

const BARE_IMAGE_EVENT = {
  type: 'user/message',
  seq: 10,
  time: 2,
  data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:i2' } }] },
}

const USER_EVENT = {
  type: 'user/message',
  seq: 9,
  time: 1,
  data: {
    content: [
      { type: 'file', attachment: { attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 } },
      { type: 'file', attachment: { attachmentId: 'sha256:f2', name: 'report.docx', bytes: 778285 } },
      { type: 'image', attachment: { attachmentId: 'sha256:i1', name: 'result-image.jpg', mediaType: 'image/jpeg', bytes: 146227, width: 1568, height: 1350 } },
      { type: 'text', text: 'how many files?' },
    ],
  },
}

const ALIAS = '/home/me/.dsh/attachments/v1/files/a3/a3f0/report.md'

describe('referencedAttachmentOf', () => {
  test('finds the block citing the id at every real citation site', () => {
    assert.deepEqual(
      referencedAttachmentOf([USER_EVENT], 'sha256:f1'),
      { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 },
    )
    assert.deepEqual(
      referencedAttachmentOf([
        { type: 'tool/result', seq: 2, time: 2, data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:i9', width: 1, height: 1 } }] } } },
      ], 'sha256:i9'),
      { kind: 'image', attachmentId: 'sha256:i9', width: 1, height: 1 },
    )
    assert.deepEqual(
      referencedAttachmentOf([
        {
          type: 'tool/result',
          seq: 3,
          time: 3,
          data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'shot' }, { type: 'image', attachment: { attachmentId: 'sha256:i10', width: 2, height: 2 } }] }] } },
        },
      ], 'sha256:i10'),
      { kind: 'image', attachmentId: 'sha256:i10', width: 2, height: 2 },
    )
    assert.deepEqual(
      referencedAttachmentOf([
        { type: 'agent/inbox/spliced', seq: 4, time: 4, data: { target: 'next-turn', inserted: [{ content: [{ type: 'file', attachment: { attachmentId: 'sha256:f9', name: 'delivered.md', bytes: 7 } }] }] } },
      ], 'sha256:f9'),
      { kind: 'file', attachmentId: 'sha256:f9', name: 'delivered.md', bytes: 7 },
    )
  })

  test('the walk is bounded and total over a hostile log; an id the log never cites resolves null', () => {
    let deep: Record<string, unknown> = { type: 'file', attachment: { attachmentId: 'sha256:deep', name: 'x.md', bytes: 1 } }
    for (let i = 0; i < 10; i++) deep = { nest: deep }
    assert.equal(referencedAttachmentOf([{ type: 'user/message', data: deep }], 'sha256:deep'), null)
    const hostile = new Proxy({}, { ownKeys() { throw new Error('hostile payload') } })
    assert.equal(referencedAttachmentOf([{ type: 'x', data: hostile }], 'sha256:f1'), null)
    assert.deepEqual(
      referencedAttachmentOf([{ type: 'x', data: hostile }, USER_EVENT], 'sha256:f1'),
      { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 },
    )
    assert.equal(referencedAttachmentOf([USER_EVENT], 'sha256:other'), null)
    assert.equal(referencedAttachmentOf([], 'sha256:f1'), null)
    assert.equal(
      referencedAttachmentOf([
        null,
        42,
        { type: 'x' },
        { type: 'x', data: null },
        { type: 'x', data: { content: 'not-an-array' } },
        { type: 'x', data: { content: [null, 'plain', { type: 'file' }] } },
        { type: 'x', data: { message: null } },
      ], 'sha256:f1'),
      null,
    )
  })
})

describe('watchAttachmentChannel gating', () => {
  test('no route without the connection service or its fetch registry, and a rejecting registry stays up without one', () => {
    for (const spec of [{}, { connection: {} }, { connection: { fetch: {} } }]) {
      const { ctx, captured } = fakeCtx(spec)
      watchAttachmentChannel(ctx, OPEN_GATE)
      assert.equal(captured.path, undefined, JSON.stringify(spec))
    }
    assert.equal(armed().captured.path, ATTACHMENT_ROUTE)
    const rejecting = fakeCtx({ connection: { fetch: { register: () => { throw new Error('registration rejected') } } } })
    assert.doesNotThrow(() => { watchAttachmentChannel(rejecting.ctx, OPEN_GATE) })
    assert.equal(rejecting.captured.path, undefined)
  })

  test('bad bodies, a missing session, and a missing attachment are typed failures', async () => {
    const { captured } = armed()
    const badJson = await captured.fetch!(new Request(`http://dsh.test${ATTACHMENT_ROUTE}`, { method: 'POST', body: '{' }))
    assert.equal((await badJson.json() as { ok: boolean }).ok, false)
    for (const body of [undefined, null, {}, { sessionId: 42 }, { sessionId: '' }, { sessionId: 's1' }, { sessionId: 's1', attachmentId: 7 }, { sessionId: 's1', attachmentId: '' }]) {
      const r = await call(captured, body)
      assert.equal(r.ok, false, JSON.stringify(body))
    }
  })

  test('no sessionQuery, a verbless query, or a skipped read answers a typed null', async () => {
    assert.deepEqual(await call(armed().captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: {} }).captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: observing(null) }).captured, { sessionId: 's1', attachmentId: 'a' }), { ok: true, value: null })
    const skipped = armed({ sessionQuery: observing([USER_EVENT]) }, SKIP_GATE)
    assert.deepEqual(await call(skipped.captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: null })
  })

  test('an id the session never cited resolves null (the authorization rule)', async () => {
    const query = observing([USER_EVENT])
    const { captured } = armed({ sessionQuery: query })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:invented' }), { ok: true, value: null })
    assert.equal(query.wasDisposed(), true)
  })

  test('a throwing observation surfaces as an internal failure', async () => {
    const { captured } = armed({ sessionQuery: { observeSession: () => Promise.reject(new Error('log unreadable')) } })
    const r = await call(captured, { sessionId: 's1', attachmentId: 'a' })
    assert.equal(r.ok, false)
    assert.equal((r.error as { message: string }).message, 'log unreadable')
    const nonError = armed({ sessionQuery: { observeSession: () => Promise.reject('nope') } })
    assert.equal(((await call(nonError.captured, { sessionId: 's1', attachmentId: 'a' })).error as { message: string }).message, 'nope')
  })
})

describe('watchAttachmentChannel resolution', () => {
  test('a cited file resolves its named host path and the observation disposes', async () => {
    const query = observing([USER_EVENT])
    const seen: unknown[] = []
    const { captured } = armed({
      sessionQuery: query,
      attachments: {
        fileHostPath: (ref: unknown) => {
          seen.push(ref)
          return ALIAS
        },
      },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: { path: ALIAS } })
    assert.deepEqual(seen, [{ attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 }])
    assert.equal(query.wasDisposed(), true)
  })

  test('every unlocatable file shape resolves a typed null', async () => {
    const cases: { attachments: unknown; id: string }[] = [
      { attachments: undefined, id: 'sha256:f1' },
      { attachments: {}, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => undefined }, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => '' }, id: 'sha256:f1' },
      { attachments: { fileHostPath: () => 42 }, id: 'sha256:f1' },
      {
        attachments: {
          fileHostPath: () => {
            throw new Error('invalid attachment ref')
          },
        },
        id: 'sha256:f1',
      },
    ]
    for (const c of cases) {
      const { captured } = armed({ sessionQuery: observing([USER_EVENT, BARE_IMAGE_EVENT]), attachments: c.attachments })
      assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: c.id }), { ok: true, value: null }, JSON.stringify(c))
    }
  })

  test('an observation without a dispose method and a nameless file reference still serve', async () => {
    const { captured } = armed({
      sessionQuery: { observeSession: () => Promise.resolve({ events: [USER_EVENT] }) },
      attachments: { fileHostPath: () => ALIAS },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: 'sha256:f1' }), { ok: true, value: { path: ALIAS } })
    const nameless = armed({
      sessionQuery: observing([{ type: 'user/message', seq: 1, data: { content: [{ type: 'file', attachment: { attachmentId: 'sha256:f3' } }] } }]),
      attachments: { fileHostPath: (ref: unknown) => `${ALIAS}:${JSON.stringify(ref)}` },
    })
    const r = await call(nameless.captured, { sessionId: 's1', attachmentId: 'sha256:f3' })
    assert.deepEqual(r.value, { path: `${ALIAS}:${JSON.stringify({ attachmentId: 'sha256:f3', name: '', bytes: 0 })}` })
  })
})

describe('image preview names', () => {
  test('a viewable leaf suffix wins; otherwise the verified media type names the preview', () => {
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'photo.PNG', mediaType: 'image/jpeg' }), 'photo.PNG')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: '../../evil.svg' }), 'evil.svg')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'C:\\tmp\\x.webp' }), 'x.webp')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'clipboard', mediaType: 'image/jpeg' }), 'attachment.jpg')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', name: 'scan.tiff', mediaType: 'image/png' }), 'attachment.png')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', mediaType: 'image/gif' }), 'attachment.gif')
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a', mediaType: 'image/tiff' }), null)
    assert.equal(imagePreviewNameOf({ kind: 'image', attachmentId: 'a' }), null)
  })
})

describe('watchAttachmentChannel image aliases', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function storeOf(bytes: string): { home: string; objectPath: string; store: { imageHostPath: () => string } } {
    const home = mkdtempSync(join(tmpdir(), 'dsh-context-att-'))
    homes.push(home)
    const digest = 'ab'.repeat(32)
    const objectPath = join(home, 'attachments', 'v1', 'objects', 'ab', digest)
    mkdirSync(join(home, 'attachments', 'v1', 'objects', 'ab'), { recursive: true })
    writeFileSync(objectPath, bytes)
    return { home, objectPath, store: { imageHostPath: () => objectPath } }
  }

  test('a cited image answers a named hard link under the plugin preview cache', async () => {
    const { home, objectPath, store } = storeOf('image-bytes')
    const { captured } = armed({ sessionQuery: observing([USER_EVENT]), attachments: store })
    const r = await call(captured, { sessionId: 's1', attachmentId: 'sha256:i1' })
    const path = (r.value as { path: string }).path
    assert.equal(path, join(home, 'cache', 'dsh-context', 'previews', 'ab', basename(objectPath), 'result-image.jpg'))
    assert.equal(readFileSync(path, 'utf8'), 'image-bytes', 'the link shares the stored bytes')
    const again = await call(captured, { sessionId: 's1', attachmentId: 'sha256:i1' })
    assert.deepEqual(again.value, { path })
  })

  test('an unfamiliar layout, an unlocatable object, and a hostile or empty image reference all answer a typed null', async () => {
    const flat = armed({
      sessionQuery: observing([USER_EVENT]),
      attachments: { imageHostPath: () => join(tmpdir(), 'objects', 'ab', 'digest') },
    })
    assert.deepEqual(await call(flat.captured, { sessionId: 's1', attachmentId: 'sha256:i1' }), { ok: true, value: null })

    const { home } = storeOf('image-bytes')
    const missing = armed({
      sessionQuery: observing([USER_EVENT]),
      attachments: { imageHostPath: () => join(home, 'attachments', 'v1', 'objects', 'ab', 'gone') },
    })
    assert.deepEqual(await call(missing.captured, { sessionId: 's1', attachmentId: 'sha256:i1' }), { ok: true, value: null })

    const cases: { store: unknown; id: string }[] = [
      { store: {}, id: 'sha256:i1' },
      {
        store: {
          imageHostPath: () => {
            throw new Error('invalid attachment ref')
          },
        },
        id: 'sha256:i1',
      },
      { store: { imageHostPath: () => '' }, id: 'sha256:i1' },
      { store: { imageHostPath: () => 42 }, id: 'sha256:i1' },
      { store: { imageHostPath: () => '/x/attachments/v1/objects/ab/digest' }, id: 'sha256:i2' },
    ]
    for (const c of cases) {
      const { captured } = armed({ sessionQuery: observing([USER_EVENT, BARE_IMAGE_EVENT]), attachments: c.store })
      assert.deepEqual(await call(captured, { sessionId: 's1', attachmentId: c.id }), { ok: true, value: null }, JSON.stringify(c.id))
    }
  })
})


const sweepHomes: string[] = []

function sweeperStoreOf(): { home: string; previews: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-context-att-sweep-'))
  sweepHomes.push(home)
  mkdirSync(join(home, 'cache', 'dsh-context'), { recursive: true })
  return { home, previews: join(home, 'cache', 'dsh-context', 'previews') }
}

describe('attachment previews sweeper', () => {
  afterEach(() => {
    for (const home of sweepHomes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  test('an expired preview directory is swept; a fresh one survives; the cap trims the oldest', async () => {
    const { home, previews } = sweeperStoreOf()
    const clock = PREVIEWS_TTL_MS * 4
    const sweeper = makePreviewSweeper(() => clock, 0)
    try {
      const staleDir = join(previews, 'stale')
      const freshDir = join(previews, 'fresh')
      mkdirSync(staleDir, { recursive: true })
      mkdirSync(freshDir, { recursive: true })
      writeFileSync(join(staleDir, 'a.jpg'), 'x')
      writeFileSync(join(freshDir, 'b.jpg'), 'x')
      writeFileSync(join(previews, 'loose.txt'), 'not a directory')
      const staleTime = new Date(clock - PREVIEWS_TTL_MS - 60_000)
      const freshTime = new Date(clock)
      utimesSync(staleDir, staleTime, staleTime)
      utimesSync(freshDir, freshTime, freshTime)
      await sweeper.sweepNow(previews)
      assert.ok(!existsSync(staleDir), 'the expired directory is removed')
      assert.ok(existsSync(freshDir), 'the fresh directory survives')

      for (let i = 0; i < PREVIEWS_MAX_DIRS + 40; i++) {
        const dir = join(previews, 'cap-' + String(i).padStart(4, '0'))
        mkdirSync(dir, { recursive: true })
        const at = new Date(clock - i * 1_000)
        utimesSync(dir, at, at)
      }
      await sweeper.sweepNow(previews)
      const all = readdirSync(previews)
      assert.ok(all.filter(name => name !== 'loose.txt').length <= PREVIEWS_MAX_DIRS, 'the cap bounds every directory under the previews root')
      assert.ok(all.includes('loose.txt'), 'a loose file at the root is ignored, not swept')
      const left = all.filter(name => name.startsWith('cap-'))
      assert.ok(left.length <= PREVIEWS_MAX_DIRS - 1, 'the cap trims down to the budget alongside the surviving fresh directory')
      assert.ok(left.every(name => name <= 'cap-0510'), 'the kept set is the newest slice of the created directories')
    } finally {
      sweeper.dispose()
      void home
    }
  })

  test('a scheduled sweep runs once per debounce window and the disposer cancels it', async () => {
    const { previews } = sweeperStoreOf()
    const sweeper = makePreviewSweeper(() => Date.now(), 5)
    try {
      sweeper.schedule(previews)
      sweeper.schedule(previews)
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.ok(true, 'a debounced sweep neither throws nor double-runs')
      sweeper.dispose()
      sweeper.schedule(previews)
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(!existsSync(join(previews, 'nothing')), 'a disposed sweeper never fires')
    } finally {
      sweeper.dispose()
    }
  })
})
})

describe('attribution', () => {

const fileUrl = (file: string) => 'file:///' + file.replace(/\\/g, '/')

const specFile = path.normalize(fileURLToPath(import.meta.url))

const CORDIS_ORIGINAL = Symbol.for('cordis.original')

class TrackedTools extends Service {
  layers = { global: { tools: new Map() } }
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(_definition?: { name?: unknown }) {
    return () => {}
  }
}

describe('createToolAttribution', () => {
  test('falls back to the static chain when nothing was registered at runtime, ignoring non-tools reads', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    assert.equal(attribution.ownerOf('read'), '@deepseek-ai/dsh-tool-fs')
    assert.equal(attribution.ownerOf('bash'), '@deepseek-ai/dsh-tool-bash', 'the pinned map serves boot-time first-party tools')
    assert.equal(attribution.ownerOf('mcp__github__get_issue'), 'mcp:github')
    assert.equal(attribution.ownerOf('unknown_tool'), undefined)
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

  test('the static chain follows the detected line for the moved schedule tools', () => {
    assert.equal(createToolAttribution(new Context(), '0.2.0-rc.2').ownerOf('schedule_create'), '@deepseek-ai/dsh-schedule')
    const current = createToolAttribution(new Context(), '0.2.2-rc.1')
    assert.equal(current.ownerOf('schedule_create'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(current.ownerOf('schedule_view'), '@deepseek-ai/dsh-tool-schedule')
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

  test('forwards registration options and keeps the disposer attribution', async () => {
    const app = new Context()
    const seen: unknown[][] = []
    let receiver: unknown
    const fake = {
      register(this: unknown, ...args: unknown[]) {
        receiver = this
        seen.push(args)
        return () => {}
      },
    }
    app.provide('tools', fake)
    const attribution = createToolAttribution(app)
    const when = () => true
    let release: (() => void) | undefined
    await app.plugin({
      name: 'gated-provider',
      apply(sub) {
        release = (sub as any).tools.register({ name: 'gated' }, { when })
      },
    })
    assert.deepEqual(seen, [[{ name: 'gated' }, { when }]], 'the definition and its registration options both reach the original')
    assert.equal(receiver, fake, 'the original register keeps its receiver')
    assert.equal(attribution.ownerOf('gated'), 'gated-provider')
    release?.()
    assert.equal(attribution.ownerOf('gated'), undefined, 'the forwarded call still returns the wrapped disposer')
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

  test('tolerates falsy, non-object, and register-less tools values', async () => {
    for (const value of [undefined, 42, { register: 42 }, {}]) {
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

  test('a foreign wrapper carrying a garbage attribution marker is left untouched', async () => {
    const app = new Context()
    const attribution = createToolAttribution(app)
    const foreign = Object.assign(() => 'not-a-disposer', { attributedOriginal: 42 })
    const fake = { register: foreign }
    app.provide('tools', fake)
    await app.plugin({
      name: 'probe',
      apply(sub) {
        void (sub as any).tools
      },
    })
    assert.equal((app.get('tools', false) as typeof fake).register, foreign, 'the instance was not re-wrapped')
    assert.equal(attribution.ownerOf('whatever'), undefined)
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

  test('the live record outranks the pinned map; name-derived MCP labels outrank the live record', async () => {
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
    assert.equal(attribution.ownerOf('bash'), 'third-party', 'a post-boot registration is the truth, even under a first-party name')
    assert.equal(attribution.ownerOf('mcp__github__x'), 'mcp:github', 'the name-derived MCP label names the actual provider')
    assert.equal(attribution.ownerOf('brand_new_tool'), 'third-party', 'live record fills the gap')
  })

  test('re-installing or re-applying the hook re-wraps without stacking wrappers', async () => {
    const app = new Context()
    let calls = 0
    app.provide('tools', { register() { calls++; return () => {} } })
    createToolAttribution(app)
    const second = createToolAttribution(app)
    await app.plugin({
      name: 'provider-b',
      apply(sub) {
        ;((sub as any).tools as { register(def?: unknown): () => void }).register({ name: 'reload_tool' })
      },
    })
    assert.equal(calls, 1, 'the original register ran once, through one wrapper only')
    assert.equal(second.ownerOf('reload_tool'), 'provider-b', 'the fresh hook records the registration')

    const reapplied = new Context()
    let reCalls = 0
    reapplied.provide('tools', { register() { reCalls++; return () => {} } })
    let attribution!: ToolAttribution
    const plugged = reapplied.plugin({ name: 'dsh-context', apply(sub) { createToolAttribution(sub) } })
    await plugged
    await plugged.dispose()
    const replugged = reapplied.plugin({
      name: 'dsh-context',
      apply(sub) {
        attribution = createToolAttribution(sub)
      },
    })
    await replugged
    await reapplied.plugin({
      name: 'provider-d',
      apply(sub) {
        ;((sub as any).tools as { register(def?: unknown): () => void }).register({ name: 'reloaded_tool' })
      },
    })
    assert.equal(reCalls, 1, 'the original register ran once, through one wrapper only')
    assert.equal(attribution.ownerOf('reloaded_tool'), 'provider-d', 'the re-applied hook records the registration')
  })

  test('unload restores the original register; an older incarnation unload leaves a newer wrapper installed', async () => {
    const app = new Context()
    const fake = { register(_definition?: unknown) { return () => {} } }
    app.provide('tools', fake)
    const original = fake.register
    let attribution!: ToolAttribution
    const fiber = app.plugin({
      name: 'dsh-context',
      apply(sub) {
        attribution = createToolAttribution(sub)
      },
    })
    await fiber
    assert.notEqual(fake.register, original, 'the hook wrapped the instance at apply')
    await fiber.dispose()
    assert.equal(fake.register, original, 'unload put the original register back on the instance')
    fake.register({ name: 'orphan_tool' })
    assert.equal(attribution.ownerOf('orphan_tool'), undefined, 'no dead-hook recording after unload')

    const stacked = new Context()
    const stackedFake = { register() { return () => {} } }
    stacked.provide('tools', stackedFake)
    const stackedOriginal = stackedFake.register
    let second!: ToolAttribution
    const older = stacked.plugin({ name: 'older-hook', apply(sub) { createToolAttribution(sub) } })
    await older
    assert.notEqual(stackedFake.register, stackedOriginal, 'the first hook wrapped the instance')
    const newer = stacked.plugin({ name: 'newer-hook', apply(sub) { second = createToolAttribution(sub) } })
    await newer
    assert.notEqual(stackedFake.register, stackedOriginal, 'the newer incarnation re-wrapped the instance')
    await older.dispose()
    assert.notEqual(stackedFake.register, stackedOriginal, 'the older disposer did not strip the newer wrapper')
    await stacked.plugin({
      name: 'provider-c',
      apply(sub) {
        ;((sub as any).tools as { register(def?: unknown): () => void }).register({ name: 'late_tool' })
      },
    })
    assert.equal(second.ownerOf('late_tool'), 'provider-c', 'the surviving hook still records')
    await newer.dispose()
    assert.equal(stackedFake.register, stackedOriginal, 'the newer disposer restores the true original')
  })

  test('a tracked service is wrapped once on its stable identity and restored on unload', async () => {
    const app = new Context()
    const tools = new TrackedTools(app)
    const original = tools.register
    let attribution!: ToolAttribution
    const fiber = app.plugin({
      name: 'dsh-context',
      apply(sub) {
        attribution = createToolAttribution(sub)
      },
    })
    await fiber
    assert.notEqual(tools.register, original, 'the hook wrapped the tracked instance at apply')
    const wrappedOnce = tools.register
    await app.plugin({
      name: 'agent-scope',
      apply(sub) {
        const first = (sub as unknown as { tools: TrackedTools & Record<symbol, unknown> }).tools
        const second = (sub as unknown as { tools: TrackedTools & Record<symbol, unknown> }).tools
        assert.notEqual(first, second, 'cordis hands out a fresh traced proxy per read')
        assert.equal(first[CORDIS_ORIGINAL], tools, 'the proxy peels to the underlying service')
        assert.equal(second[CORDIS_ORIGINAL], tools)
        assert.equal(tools.register, wrappedOnce, 'repeated reads never re-wrap the stable instance')
        first.register({ name: 'scoped_tool' })
      },
    })
    assert.equal(attribution.ownerOf('scoped_tool'), 'agent-scope', 'the hook still attributes scoped registrations')
    await fiber.dispose()
    assert.equal(tools.register, original, 'unload restored the prototype register of the tracked service')
    const orphan = tools.register({ name: 'orphan_tool' })
    assert.equal(attribution.ownerOf('orphan_tool'), undefined, 'no dead-hook recording after unload')
    orphan()
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
    assert.equal(attribution.ownerOf('read'), '@deepseek-ai/dsh-tool-fs', 'the pinned map wins over the unknown tag')
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
    assert.equal(callerPackageFrom(`Error\n  note\n  at ${local}:1:2`), 'local-plugin')
    assert.equal(callerPackageFrom('Error\n    at x (file:///D:/no-position.js)\n    at y (file:///D:/has-position.js:1:2)'), undefined)
    assert.equal(callerPackageFrom(`Error\n    at ${local}:1:2\n    at ${specFile}:3:4`), 'local-plugin')
    assert.equal(callerPackageFrom(`Error\n    at registerBlind (${fileUrl(anon)}:1:2)\n    at run (${fileUrl(specFile)}:3:4)`), 'anon-plugin')
    assert.equal(callerPackageFrom(`Error\n    at ${specFile}:1:2\n    at ${local}:3:4`), 'local-plugin')
    const attributionFile = path.normalize(fileURLToPath(new URL('../../src/host/attribution.ts', import.meta.url)))
    assert.equal(callerPackageFrom(`Error\n    at ${attributionFile}:1:2\n    at ${local}:3:4`), 'local-plugin')
    assert.equal(callerPackageFrom(`Error\n    at x (file:///D:/bad%zz.js:1:2)\n    at y (${fileUrl(local)}:3:4)`), 'local-plugin')
    assert.equal(callerPackageFrom(`Error\n    at ModuleJob.run (node:internal/modules/esm/module_job.js:346:20)\n    at y (${fileUrl(local)}:3:4)`), 'local-plugin')
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
})

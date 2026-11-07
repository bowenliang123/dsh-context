import assert from 'node:assert/strict'
import { describe, test, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ATTACHMENT_ROUTE, referencedAttachmentOf, imagePreviewNameOf, watchAttachmentChannel } from '../../src/host/attachment'
import type { ColdReadGate } from '../../src/host/coldRead'
import { connectionOf, fakeCtx, observing, OPEN_GATE, postJson, SKIP_GATE } from './helpers/ctx'
import type { FakeCtx, FakeRoute } from './helpers/ctx'

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

import { act, createElement as h, useState, useSyncExternalStore } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeContextModal } from '../../../src/client/components/contextModal'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { modalStoreOf, setPendingConsume, takePendingConsume } from '../../../src/client/modalStore'
import { watchHistoryFaces } from '../../../src/client/historyPage'
import { createContextSettings } from '../../../src/client/settings'
import { type ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestSessions, asClientCtx } from '../helpers/harness'
import { click, flush, hover, keydown, makeKit, mount, query, queryAll, text, unhover, until } from '../helpers/kit'
import { makeRecomCard, resetRecomCache } from '../../../src/client/components/recomCard'
import { DEFAULT_RECOM, type Recom } from '../../../src/shared/recoms'

describe('contextModal', () => {

const kit = makeKit()
const settings = createContextSettings()


function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 21 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

function boundModalHook(sessionId: string) {
  const store = modalStoreOf(sessionId)
  return (sel: (open: boolean) => boolean): boolean =>
    useSyncExternalStore(store.subscribe, () => sel(store.getSnapshot()))
}

const OPEN = (): boolean => true

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

describe('ContextModal', () => {
  test('renders null without a useContextModal hook or while closed, and shows the loading view when opened without a projection', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)

    const m1 = await mount(h(ContextModal, { sessionId: 'sm-none', useProjection: () => timeline() }))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const closedProjection = vi.fn(() => timeline())
    const m2 = await mount(h(ContextModal, { sessionId: 'sm-closed', useContextModal: () => false, useProjection: closedProjection, }))
    assert.equal(m2.container.childElementCount, 0)
    assert.equal(closedProjection.mock.calls.length, 0, 'a closed modal never mounts the detail reader')

    const openProjection = vi.fn(() => timeline())
    await m2.update(h(ContextModal, {
      sessionId: 'sm-closed',
      useContextModal: OPEN,
      useProjection: openProjection,
    }))
    assert.ok(openProjection.mock.calls.length > 0, 'opening mounts the detail reader')
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)
    await m2.unmount()

    for (const [sid, useProjection] of [
      ['sm-load1', undefined],
      ['sm-load2', () => undefined],
    ] as const) {
      const loading = await mount(h(ContextModal, { sessionId: sid, useContextModal: OPEN, ...(useProjection !== undefined ? { useProjection } : {}), }))
      assert.ok(text(document.body).includes(DICT_EN['overview.title']), 'no projection hook (or an empty one) keeps the zero layout')
      assert.ok(text(document.body).includes(DICT_EN['browser.title']))
      assert.ok(document.body.querySelector('.lc-modal-card') !== null)
      assert.ok(document.body.querySelector('.lc-modal-fill') !== null, 'the modal block keeps its final size class')
      assert.equal(document.body.querySelectorAll('.lc-modal-skeleton').length, 0)
      await loading.unmount()
    }
  })

  test('an open modal without a session id still paints its skeleton', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m = await mount(h(ContextModal, {
      sessionId: '',
      useContextModal: OPEN,
      useProjection: () => timeline(),
    }))
    try {
      assert.ok(document.body.querySelector('.lc-modal-fill') !== null)
      assert.ok(document.body.querySelector('.lc-br') !== null, 'the browser keeps its card shape without a session id')
    } finally {
      await m.unmount()
    }
  })

  test('a projection seat that appears or disappears after mount keeps the gate rendering without shifting its hooks', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    function useTimelineSeat(): ContextTimeline {
      useState(0)
      return timeline()
    }
    const base = { sessionId: 'sm-flip', useContextModal: OPEN, warm: true }
    const m = await mount(h(ContextModal, base))
    await m.update(h(ContextModal, { ...base, useProjection: useTimelineSeat }))
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)
    await m.update(h(ContextModal, base))
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)
    await m.unmount()
  })

  test('a cold read that settles without data surfaces the retryable failure, not a stall', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500, json: async () => null } as Response))
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m = await mount(h(ContextModal, { sessionId: 'sm-cold-fail', useContextModal: OPEN, useProjection: () => undefined, }))
    await until(() => text(document.body).includes(DICT_EN['detail.loadFailed']), 'the failure note never surfaced')
    assert.ok(document.body.querySelector('.lc-modal-card') !== null, 'the modal keeps its frame once failed')
    await act(async () => {
      const hit = queryAll(document.body, 'button').find(b => text(b) === DICT_EN['detail.loadFailed'])
      if (hit === undefined) throw new Error('retry button not found')
      hit.click()
    })
    await m.unmount()
  })

  test('a corrupt timeline projection is sanitized and still renders the composition', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-garbage',
      useContextModal: OPEN,
      useProjection: (key: string) =>
        key === 'contextTimeline' ? { current: 'junk', requests: 'nope', nodes: 7, archive: null } : undefined,
    }))
    assert.ok(text(document.body).includes(DICT_EN['overview.title']))
    assert.ok(document.body.querySelector('.lc-br-cats') !== null)
    await m.unmount()
  })

  test('full render: subtitle variants and hover link through the composed browser', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const projections: Record<string, unknown> = {
      contextTimeline: timeline({
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        reasoningEffort: 'high',
      }),
      contextPressure: { projectedTokens: 100, contextWindow: 128000 },
      contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 18 },
      contextHeaders: {
        headers: [{ seq: 1, time: 0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }],
      },
    }
    const m = await mount(h(ContextModal, { sessionId: 'sm-full', useContextModal: OPEN, useProjection: (key: string) => projections[key], }))
    assert.ok(text(document.body).includes('deepseek · deepseek-v4-flash (high)'))

    const compCard = query(document.body, '.lc-modal-card .lc-card')
    const seg = query(compCard, '.lc-stacked-seg')
    await hover(seg)
    assert.ok(query(compCard, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.ok(queryAll(compCard, '.lc-chip').some(c => c.className.includes('lc-chip-on')))
    await unhover(query(compCard, '.lc-stacked'))
    assert.ok(!query(compCard, '.lc-stacked').className.includes('lc-stacked-dim'))
    await m.unmount()

    const onlyModel = await mount(h(ContextModal, {
      sessionId: 'sm-sub1',
      useContextModal: OPEN,
      useProjection: (key: string) => key === 'contextTimeline' ? timeline({ model: 'only-model' }) : undefined,
    }))
    assert.ok(text(document.body).includes('only-model'))
    assert.ok(!text(document.body).includes('only-model ·'))
    await onlyModel.unmount()

    const noModel = await mount(h(ContextModal, { sessionId: 'sm-sub2', useContextModal: OPEN, useProjection: (key: string) => key === 'contextTimeline' ? timeline() : undefined, }))
    assert.equal(query(document.body, '.lc-modal-card .lc-card').querySelector('.lc-card-sub'), null)
    await noModel.unmount()
  })

  test('a backdrop click without a sessionId and a card click both leave the modal open', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m1 = await mount(h(ContextModal, { useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(document.body, '.lc-modal-backdrop'))
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)
    assert.equal(sessions.bails.length, 0)
    await m1.unmount()

    const m2 = await mount(h(ContextModal, { sessionId: 'sm-card', useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(document.body, '.lc-modal-card'))
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)
    assert.equal(sessions.bails.length, 0)
    await m2.unmount()
  })

  test('close flips the store and bails a pending consume through the session scope; unguarded, serviceless, and unscoped closes stay quiet', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const sid = 'sm-close'
    modalStoreOf(sid).set(true)
    setPendingConsume(sid, { kind: 'bare-token', token: '/context' })
    const m = await mount(h(ContextModal, { sessionId: sid, useContextModal: boundModalHook(sid), useProjection: () => undefined, }))
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)

    await click(query(document.body, '.lc-modal-close'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(document.body.querySelector('.lc-modal-backdrop'), null)
    assert.equal(sessions.bails.length, 1)
    assert.equal(sessions.bails[0].event, 'slash/input-consume-token')
    assert.deepEqual(sessions.bails[0].payload, { guard: { kind: 'bare-token', token: '/context' } })
    assert.equal(takePendingConsume(sid), undefined)
    await m.unmount()

    const scoped: string[] = []
    const bails = sessions.bails.length
    const cases: { sid: string; ctx: TestClientCtx; guard?: Parameters<typeof setPendingConsume>[1] }[] = [
      { sid: 'sm-noguard', ctx: new TestClientCtx({ services: { sessions } }) },
      { sid: 'sm-nosvc', ctx: new TestClientCtx(), guard: { kind: 'bare-token', token: '/context' } },
      {
        sid: 'sm-noscope',
        ctx: new TestClientCtx({ services: { sessions: { scope: (id: string) => { scoped.push(id); return undefined } } } }),
        guard: { kind: 'span', span: { start: 0, end: 8, draftRev: 3 } },
      },
    ]
    for (const { sid: quietSid, ctx, guard } of cases) {
      const QuietModal = makeContextModal(asClientCtx(ctx), kit, settings)
      modalStoreOf(quietSid).set(true)
      if (guard !== undefined) setPendingConsume(quietSid, guard)
      const quiet = await mount(h(QuietModal, { sessionId: quietSid, useContextModal: boundModalHook(quietSid), useProjection: () => undefined, }))
      await click(query(document.body, '.lc-modal-backdrop'))
      assert.equal(modalStoreOf(quietSid).getSnapshot(), false)
      assert.equal(document.body.querySelector('.lc-modal-backdrop'), null)
      await quiet.unmount()
    }
    assert.equal(sessions.bails.length, bails, 'a close with no bail path closes quietly')
    assert.deepEqual(scoped, ['sm-noscope'], 'the scope beats the service check')
  })

  test('the mask docks between the frame sidebars, follows template rewrites, and disconnects on close', async () => {
    vi.stubGlobal('innerWidth', 1280)
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const sid = 'sm-dock'
    const frame = document.createElement('div')
    frame.style.gridTemplateColumns = '280px minmax(400px, 1fr) minmax(0px, 360px)'
    const seat = document.createElement('div')
    frame.appendChild(seat)
    document.body.appendChild(frame)

    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const m = await mount(h(ContextModal, { sessionId: sid, useContextModal: boundModalHook(sid), useProjection: () => undefined, }))
    seat.appendChild(m.container)
    await act(async () => {
      modalStoreOf(sid).set(true)
    })
    const backdrop = query(document.body, '.lc-modal-backdrop')
    assert.equal(backdrop.style.left, '280px')
    assert.equal(backdrop.style.right, '360px')

    await act(async () => {
      frame.style.gridTemplateColumns = '56px minmax(0px, 1fr) minmax(0px, 0px)'
    })
    await flush()
    const rewritten = query(document.body, '.lc-modal-backdrop')
    assert.equal(rewritten.style.left, '56px')
    assert.equal(rewritten.style.right, '0px')

    disconnectSpy.mockClear()
    await click(query(document.body, '.lc-modal-backdrop'))
    assert.equal(document.body.querySelector('.lc-modal-backdrop'), null)
    assert.equal(disconnectSpy.mock.calls.length, 1)
    frame.remove()
    await m.unmount()

    const noFrame = await mount(h(ContextModal, { sessionId: 'sm-noframe', useContextModal: OPEN, useProjection: () => undefined, }))
    const noFrameBackdrop = query(document.body, '.lc-modal-backdrop')
    assert.equal(noFrameBackdrop.style.left, '0px', 'without a frame ancestor the mask stays full-viewport')
    assert.equal(noFrameBackdrop.style.right, '0px')
    await noFrame.unmount()
  })

  test('Escape closes; other keys do not; the listener is removed on close', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const sid = 'sm-esc'
    modalStoreOf(sid).set(true)
    const m = await mount(h(ContextModal, { sessionId: sid, useContextModal: boundModalHook(sid), useProjection: () => undefined, }))
    await keydown('a')
    assert.ok(document.body.querySelector('.lc-modal-backdrop') !== null)

    await keydown('Escape')
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(document.body.querySelector('.lc-modal-backdrop'), null)

    setPendingConsume(sid, { kind: 'bare-token', token: '/context' })
    await keydown('Escape')
    assert.equal(sessions.bails.length, 0)
    assert.notEqual(takePendingConsume(sid), undefined)
    await m.unmount()
  })

  test('closing restores focus when it can, and skips the restore when the previous element is gone or nothing was focused', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)

    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    assert.equal(document.activeElement, btn)
    const m1 = await mount(h(ContextModal, { sessionId: 'sm-focus', useContextModal: boundModalHook('sm-focus'), useProjection: () => undefined, }))
    await act(async () => { modalStoreOf('sm-focus').set(true) })
    const closeBtn = query(document.body, '.lc-modal-close')
    closeBtn.focus()
    assert.equal(document.activeElement, closeBtn)
    await click(closeBtn)
    assert.equal(document.activeElement, btn, 'the previous element takes focus back')
    btn.remove()
    await m1.unmount()

    const gone = document.createElement('button')
    document.body.appendChild(gone)
    gone.focus()
    const m2 = await mount(h(ContextModal, { sessionId: 'sm-focus-gone', useContextModal: boundModalHook('sm-focus-gone'), useProjection: () => undefined, }))
    await act(async () => { modalStoreOf('sm-focus-gone').set(true) })
    gone.remove()
    await click(query(document.body, '.lc-modal-close'))
    assert.equal(modalStoreOf('sm-focus-gone').getSnapshot(), false)
    assert.ok(!document.contains(gone))
    await m2.unmount()

    modalStoreOf('sm-focus-null').set(true)
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
    const m3 = await mount(h(ContextModal, { sessionId: 'sm-focus-null', useContextModal: boundModalHook('sm-focus-null'), useProjection: () => undefined, }))
    vi.restoreAllMocks()
    await click(query(document.body, '.lc-modal-close'))
    assert.equal(modalStoreOf('sm-focus-null').getSnapshot(), false)
    assert.equal(document.activeElement, document.body)
    await m3.unmount()
  })
})

describe('ContextModal — the split generation', () => {
  test('the modal shares the detail route: the browser lands the collections on open; a subagent body reads under its parent address', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          rev: 1,
          requests: [{ seq: 1, turn: 1, step: 1, time: 1, system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6, total: 21 }],
          events: [],
          nodes: [{ seq: 1, cat: 'assistant', tokens: 5, text: 'modal reply' }],
          droppedNodes: 0,
          archive: [],
        },
      }),
    }
    let release!: () => void
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads++
      if (reads === 1) return new Promise(res => { release = () => res(response) })
      return Promise.resolve(response)
    })
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const head = timeline({
      counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 },
      last: { seq: 1, total: 21, prompt: 20 },
      detailRev: 1,
    })
    const m = await mount(h(ContextModal, { sessionId: 'sm-slim', useContextModal: OPEN, useProjection: (key: string) => (key === 'contextTimeline' ? head : undefined), }))
    assert.ok(text(document.body).includes(DICT_EN['overview.title']))
    assert.ok(document.body.querySelector('.lc-br-note .lc-skel-note') !== null, 'the browser reserves its loading bar')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => document.body.querySelector('.lc-br-note .lc-skel-note') === null, 'the modal detail never landed')
    assert.equal(queryAll(document.body, '.lc-br-pick option').length, 2, 'live + the one served step')
    assert.ok(text(document.body).includes('1 Item'), 'the assistant section counts the served node')
    await m.unmount()

    const calls: unknown[] = []
    const subCtx = new TestClientCtx({
      services: {
        sessions: { subagentAddress: () => ({ parentSessionId: 'sm-parent', childSessionId: 'sm-body', mode: 'continuable' }) },
      },
    })
    subCtx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    subCtx.setService('remote', {
      session: {
        page: (request: unknown) => {
          calls.push(request)
          return Promise.resolve({
            ok: true,
            value: {
              records: [{
                type: 'event',
                event: { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'OLD FULL BODY' }] } },
              }],
            },
          })
        },
      },
    })
    watchHistoryFaces(asClientCtx(subCtx))
    const SubModal = makeContextModal(asClientCtx(subCtx), kit, settings)
    const subMount = await mount(h(SubModal, {
      sessionId: 'sm-body',
      useContextModal: OPEN,
      useProjection: (key: string) => (key === 'contextTimeline'
        ? timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })
        : undefined),
    }))
    const userRow = queryAll(document.body, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(userRow !== undefined)
    await click(userRow)
    await flush()
    assert.deepEqual(calls, [{
      address: { kind: 'subagent', parentSessionId: 'sm-parent', childSessionId: 'sm-body', mode: 'continuable' },
      throughSeq: 1,
      beforeSeq: 2,
    }])
    assert.ok(text(document.body).includes('OLD FULL BODY'), 'the fetched body renders')
    await subMount.unmount()
    subCtx.dispose()
  })

  test('a mount that raced the declared inject heals when the face lands mid-open', async () => {
    const calls: { sessionId: string; throughSeq: number; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    watchHistoryFaces(asClientCtx(ctx))
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const projections: Record<string, unknown> = {
      contextTimeline: timeline(),
      contextHeaders: { headers: [{ seq: 1, time: 0, systemTokens: 5, tools: [] }] },
    }
    const m = await mount(h(ContextModal, { sessionId: 'sm-race', useContextModal: OPEN, useProjection: (key: string) => projections[key], }))
    const sysRow = queryAll(document.body, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.system']))
    assert.ok(sysRow !== undefined)
    await click(sysRow)
    assert.ok(text(document.body).includes(DICT_EN['browser.headerMetaOnly']), 'the faceless mount shows the static note')

    await act(async () => {
      ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
      ctx.setService('remote', {
        session: {
          page: (request: { address: { sessionId: string }; throughSeq: number; beforeSeq: number }) => {
            calls.push({ sessionId: request.address.sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq })
            return Promise.resolve({
              ok: true,
              value: {
                records: [{ type: 'event', event: { type: 'system/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'HEALED SYSTEM PROMPT' }] } } } }],
              },
            })
          },
        },
      })
    })
    await until(() => text(document.body).includes('HEALED SYSTEM PROMPT'), 'the open epoch never healed after the face landed')
    assert.ok(!text(document.body).includes(DICT_EN['browser.headerMetaOnly']))
    assert.deepEqual(calls, [{ sessionId: 'sm-race', throughSeq: 1, beforeSeq: 2 }])
    await m.unmount()
    ctx.dispose()
  })
})

describe('ContextModal — opt-in session warm-up', () => {
  test('the registration opt-in warms the split head once per session, not the closed dialog body', async () => {
    vi.useFakeTimers()
    const reads: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      reads.push(JSON.parse(init?.body ?? '{}').sessionId as string)
      return { ok: true, status: 200, json: async () => ({ ok: true, value: {
        rev: 2, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
        head: timeline({ detailRev: 2 }),
      } }) }
    })
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-warm', warm: true, useContextModal: () => false,
      useProjection: () => timeline({ detailRev: 2 }),
    }))
    assert.equal(m.container.childElementCount, 0)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    assert.deepEqual(reads, ['sm-warm'])
    await m.unmount()
    vi.useRealTimers()
  })
})
})

describe('recomCard', () => {

function remoteRecom(): Recom {
  return {
    ...DEFAULT_RECOM,
    id: 'remote',
    name: 'Remote Model',
    slogan: { en: 'Remote slogan', zh: '远端标语' },
    promotion: { en: 'Remote promotion', zh: '远端推广' },
    tooltip: { en: 'Remote tooltip', zh: '远端说明' },
  }
}

function secondRecom(): Recom {
  return { ...remoteRecom(), id: 'second', name: 'Second Model' }
}

function reply(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function pendingRequest(): { calls: number; release(value: Response): void } {
  let release!: (value: Response) => void
  const request = { calls: 0, release: (value: Response) => { release(value) } }
  vi.stubGlobal('fetch', () => {
    request.calls++
    return new Promise<Response>((resolve) => { release = resolve })
  })
  return request
}

function card(locale: 'en' | 'zh'): () => ReturnType<ReturnType<typeof makeRecomCard>> {
  const ctx = new TestClientCtx({ locale })
  return makeRecomCard(makeKit(locale), asClientCtx(ctx))
}

afterEach(() => {
  resetRecomCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RecomCard', () => {
  test('the default paints immediately, then the validated remote pool replaces it', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return pending
    })
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    assert.ok(m.container.querySelector('.lc-card-title') === null)
    assert.ok(m.container.querySelector('.lc-recom-link > .lc-recom-arrow') !== null)
    assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.en))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    release(reply({ ok: true, value: [remoteRecom()], degraded: false }))
    await flush()
    assert.ok(text(m.container).includes('Remote Model'))
    assert.ok(text(m.container).includes('Remote slogan'))
    assert.ok(text(m.container).includes('Remote promotion'))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    const tooltip = query(m.container, '[role="tooltip"]')
    assert.equal(tooltip.textContent, 'Remote tooltip')
    const link = query<HTMLAnchorElement>(m.container, 'a')
    assert.equal(link.href, DEFAULT_RECOM.url)
    assert.equal(link.target, '_blank')
    assert.equal(link.rel, 'noreferrer')
    assert.equal(link.getAttribute('aria-describedby'), query(m.container, '[role="tooltip"]').id)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'api/dsh-context/recom')
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.equal(calls[0]?.init?.body, '{}')
    assert.equal(query<HTMLImageElement>(m.container, 'img').src, DEFAULT_RECOM.icon)
    await m.unmount()
  })

  test('Chinese content renders locally and HTTP or payload failures preserve the default', async () => {
    const responses = [
      reply({}, false),
      reply({ ok: true, value: { bad: true } }),
      { ok: true, json: () => Promise.reject(new Error('bad json')) } as unknown as Response,
    ]
    for (const response of responses) {
      vi.stubGlobal('fetch', async () => response)
      const RecomCard = card('zh')
      const m = await mount(h(RecomCard))
      await flush()
      assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.zh))
      assert.equal(query(m.container, '[role="tooltip"]').textContent, DEFAULT_RECOM.tooltip.zh)
      assert.ok(m.container.querySelector('.lc-recom-degraded') !== null)
      await m.unmount()
    }
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const RecomCard = card('zh')
    const m = await mount(h(RecomCard))
    await flush()
    assert.ok(text(m.container).includes(DEFAULT_RECOM.promotion.zh))
    await m.unmount()
  })

  test('the brand initial covers icon states and a settled pool survives unmount', async () => {
    const request = pendingRequest()
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    const mark = query(m.container, '.lc-recom-mark')
    assert.equal(mark.querySelector('.lc-recom-fallback')?.textContent, 'D')
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('load'))
    })
    assert.ok(mark.classList.contains('lc-recom-mark-loaded'))
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('error'))
    })
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    assert.ok(mark.querySelector('img') === null)
    await m.unmount()
    request.release(reply({ ok: true, value: [remoteRecom()] }))
    await flush()
    assert.equal(m.container.isConnected, false)
    const second = await mount(h(RecomCard))
    assert.ok(text(second.container).includes('Remote Model'))
    assert.equal(request.calls, 1)
    await second.unmount()
  })

  test('the first pool picks randomly and later mounts rotate immediately with one fetch', async () => {
    const request = pendingRequest()
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    assert.ok(text(first.container).includes(DEFAULT_RECOM.name))
    request.release(reply({ ok: true, value: [remoteRecom(), secondRecom()], degraded: false }))
    await flush()
    assert.ok(text(first.container).includes('Second Model'))
    await first.unmount()
    const second = await mount(h(RecomCard))
    assert.ok(text(second.container).includes('Remote Model'), 'the next entry paints synchronously')
    await second.unmount()
    const third = await mount(h(RecomCard))
    assert.ok(text(third.container).includes('Second Model'), 'rotation wraps within the cached pool')
    await third.unmount()
    assert.equal(request.calls, 1)
  })

  test('concurrent first mounts share the same pool request', async () => {
    const request = pendingRequest()
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    const second = await mount(h(RecomCard))
    request.release(reply({ ok: true, value: [remoteRecom()] }))
    await flush()
    assert.ok(text(first.container).includes('Remote Model'))
    assert.ok(text(second.container).includes('Remote Model'))
    assert.equal(request.calls, 1)
    await first.unmount()
    await second.unmount()
  })

  test('reset during a pending read keeps a later request shared and independent', async () => {
    const releases: ((value: Response) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { releases.push(resolve) }))
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    resetRecomCache()
    const second = await mount(h(RecomCard))
    assert.equal(releases.length, 2)
    releases[0](reply({}, false))
    await flush()
    const third = await mount(h(RecomCard))
    assert.equal(releases.length, 2, 'the stale cleanup leaves the newer request in flight')
    releases[1](reply({ ok: true, value: [secondRecom()] }))
    await flush()
    assert.ok(text(second.container).includes('Second Model'))
    assert.ok(text(third.container).includes('Second Model'))
    await first.unmount()
    await second.unmount()
    await third.unmount()
  })

  test('an identical initial selection leaves the painted card untouched', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: [DEFAULT_RECOM] }))
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    await flush()
    assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.en))
    assert.ok(text(m.container).includes(DEFAULT_RECOM.promotion.en))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    await m.unmount()
  })

  test('a degraded pool paints its mark at once and a later mount retries', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: [DEFAULT_RECOM], degraded: true }))
    const RecomCard = card('zh')
    const first = await mount(h(RecomCard))
    await flush()
    assert.equal(query(first.container, '.lc-recom-brand').textContent, 'DeepSeek')
    assert.ok(first.container.querySelector('.lc-recom-degraded') !== null)
    await first.unmount()
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { release = resolve }))
    const second = await mount(h(RecomCard))
    assert.ok(second.container.querySelector('.lc-recom-degraded') !== null, 'the cached degrade paints at once')
    release(reply({ ok: true, value: [remoteRecom()], degraded: false }))
    await flush()
    assert.ok(text(second.container).includes('Remote Model'))
    assert.ok(second.container.querySelector('.lc-recom-degraded') === null)
    await second.unmount()
  })
})


describe('RecomCard cache ttl', () => {
  test('a degraded read is not served from cache on the next mount', async () => {
    const RecomCard = card('en')
    resetRecomCache()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ value: [remoteRecom()], degraded: false }) }
    })
    try {
      const first = await mount(h(RecomCard, {}))
      await flush()
      assert.equal(calls, 1)
      await first.unmount()
      const second = await mount(h(RecomCard, {}))
      await flush()
      assert.equal(calls, 2, 'a degraded read revalidates immediately')
      await second.unmount()
    } finally {
      vi.unstubAllGlobals()
      resetRecomCache()
    }
  })

  test('a mount inside the TTL window keeps the pool; past the TTL it refetches', async () => {
    const RecomCard = card('en')
    resetRecomCache()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return { ok: true, json: async () => ({ value: [{ ...remoteRecom(), id: 'x' + String(calls) }], degraded: false }) }
    })
    try {
      const first = await mount(h(RecomCard, {}))
      await flush()
      assert.equal(calls, 1)
      const second = await mount(h(RecomCard, {}))
      await flush()
      assert.equal(calls, 1, 'a fresh cache answers the next mount without a network read')
      await first.unmount()
      await second.unmount()
      const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
      const third = await mount(h(RecomCard, {}))
      await flush()
      assert.ok(calls >= 2, 'a mount past the TTL refetches')
      spy.mockRestore()
      await third.unmount()
    } finally {
      vi.unstubAllGlobals()
      resetRecomCache()
    }
  })
})
})

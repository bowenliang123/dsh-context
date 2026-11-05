import { act, createElement as h, useState, useSyncExternalStore } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeContextModal } from '../../../src/client/components/contextModal'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { modalStoreOf, setPendingConsume, takePendingConsume } from '../../../src/client/modalStore'
import { watchHistoryFaces } from '../../../src/client/historyPage'
import { createContextSettings } from '../../../src/client/settings'
import type { ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestSessions, asClientCtx } from '../helpers/harness'
import { click, flush, hover, keydown, makeKit, mount, query, queryAll, text, unhover, until } from '../helpers/kit'

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
    assert.ok(m2.container.querySelector('.lc-modal-backdrop') !== null)
    await m2.unmount()

    for (const [sid, useProjection] of [
      ['sm-load1', undefined],
      ['sm-load2', () => undefined],
    ] as const) {
      const loading = await mount(h(ContextModal, { sessionId: sid, useContextModal: OPEN, ...(useProjection !== undefined ? { useProjection } : {}), }))
      assert.ok(text(loading.container).includes(DICT_EN.loading), 'no projection hook (or an empty one) shows the loading view')
      assert.ok(loading.container.querySelector('.lc-modal-card') !== null)
      await loading.unmount()
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
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await m.update(h(ContextModal, base))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await m.unmount()
  })

  test('a cold read that settles without data surfaces the retryable failure, not a stall', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500, json: async () => null } as Response))
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m = await mount(h(ContextModal, { sessionId: 'sm-cold-fail', useContextModal: OPEN, useProjection: () => undefined, }))
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure note never surfaced')
    assert.ok(!text(m.container).includes(DICT_EN.loading), 'no spinner remains once failed')
    await act(async () => {
      const hit = queryAll(m.container, 'button').find(b => text(b) === DICT_EN['detail.loadFailed'])
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
    assert.ok(!text(m.container).includes(DICT_EN.loading))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(m.container.querySelector('.lc-br-cats') !== null)
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
    assert.ok(text(m.container).includes('deepseek · deepseek-v4-flash (high)'))

    const compCard = query(m.container, '.lc-modal-card .lc-card')
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
    assert.ok(text(onlyModel.container).includes('only-model'))
    assert.ok(!text(onlyModel.container).includes('only-model ·'))
    await onlyModel.unmount()

    const noModel = await mount(h(ContextModal, { sessionId: 'sm-sub2', useContextModal: OPEN, useProjection: (key: string) => key === 'contextTimeline' ? timeline() : undefined, }))
    assert.equal(query(noModel.container, '.lc-modal-card .lc-card').querySelector('.lc-card-sub'), null)
    await noModel.unmount()
  })

  test('a backdrop click without a sessionId and a card click both leave the modal open', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit, settings)
    const m1 = await mount(h(ContextModal, { useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(m1.container, '.lc-modal-backdrop'))
    assert.ok(m1.container.querySelector('.lc-modal-backdrop') !== null)
    assert.equal(sessions.bails.length, 0)
    await m1.unmount()

    const m2 = await mount(h(ContextModal, { sessionId: 'sm-card', useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(m2.container, '.lc-modal-card'))
    assert.ok(m2.container.querySelector('.lc-modal-backdrop') !== null)
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
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)

    await click(query(m.container, '.lc-modal-close'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
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
      await click(query(quiet.container, '.lc-modal-backdrop'))
      assert.equal(modalStoreOf(quietSid).getSnapshot(), false)
      assert.equal(quiet.container.querySelector('.lc-modal-backdrop'), null)
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
    const backdrop = query(m.container, '.lc-modal-backdrop')
    assert.equal(backdrop.style.left, '280px')
    assert.equal(backdrop.style.right, '360px')

    await act(async () => {
      frame.style.gridTemplateColumns = '56px minmax(0px, 1fr) minmax(0px, 0px)'
    })
    await flush()
    const rewritten = query(m.container, '.lc-modal-backdrop')
    assert.equal(rewritten.style.left, '56px')
    assert.equal(rewritten.style.right, '0px')

    disconnectSpy.mockClear()
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.equal(disconnectSpy.mock.calls.length, 1)
    frame.remove()
    await m.unmount()

    const noFrame = await mount(h(ContextModal, { sessionId: 'sm-noframe', useContextModal: OPEN, useProjection: () => undefined, }))
    const noFrameBackdrop = query(noFrame.container, '.lc-modal-backdrop')
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
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)

    await keydown('Escape')
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)

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
    const closeBtn = query(m1.container, '.lc-modal-close')
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
    await click(query(m2.container, '.lc-modal-close'))
    assert.equal(modalStoreOf('sm-focus-gone').getSnapshot(), false)
    assert.ok(!document.contains(gone))
    await m2.unmount()

    modalStoreOf('sm-focus-null').set(true)
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
    const m3 = await mount(h(ContextModal, { sessionId: 'sm-focus-null', useContextModal: boundModalHook('sm-focus-null'), useProjection: () => undefined, }))
    vi.restoreAllMocks()
    await click(query(m3.container, '.lc-modal-close'))
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
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['detail.loading']))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => !text(m.container).includes(DICT_EN['detail.loading']), 'the modal detail never landed')
    assert.equal(queryAll(m.container, '.lc-br-pick option').length, 2, 'live + the one served step')
    assert.ok(text(m.container).includes('1 Item'), 'the assistant section counts the served node')
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
    const userRow = queryAll(subMount.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(userRow !== undefined)
    await click(userRow)
    await flush()
    assert.deepEqual(calls, [{
      address: { kind: 'subagent', parentSessionId: 'sm-parent', childSessionId: 'sm-body', mode: 'continuable' },
      throughSeq: 1,
      beforeSeq: 2,
    }])
    assert.ok(text(subMount.container).includes('OLD FULL BODY'), 'the fetched body renders')
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
    const sysRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.system']))
    assert.ok(sysRow !== undefined)
    await click(sysRow)
    assert.ok(text(m.container).includes(DICT_EN['browser.headerMetaOnly']), 'the faceless mount shows the static note')

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
    await until(() => text(m.container).includes('HEALED SYSTEM PROMPT'), 'the open epoch never healed after the face landed')
    assert.ok(!text(m.container).includes(DICT_EN['browser.headerMetaOnly']))
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

// ContextModal (src/client/components/contextModal.tsx) — the /context
// dialog rendered through the REGISTERED composition (makeContextModal over
// a TestClientCtx), with the per-session modal store driving open/close,
// real sessions faces for the consume-token bail, and real projections.

import { act, createElement as h, useSyncExternalStore } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeContextModal } from '../../../src/client/components/contextModal'
import { modalStoreOf, setPendingConsume, takePendingConsume } from '../../../src/client/modalStore'
import { watchHistoryFaces } from '../../../src/client/historyPage'
import type { ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestSessions, asClientCtx } from '../helpers/harness'
import { click, flush, hover, keydown, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()


function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6, total: 21 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

/** A useContextModal hook really bound to the per-session store. */
function boundModalHook(sessionId: string) {
  const store = modalStoreOf(sessionId)
  return (sel: (open: boolean) => boolean): boolean =>
    useSyncExternalStore(store.subscribe, () => sel(store.getSnapshot()))
}

const OPEN = (): boolean => true

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ContextModal', () => {
  test('renders null without a useContextModal hook or while closed', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)

    const m1 = await mount(h(ContextModal, { sessionId: 'sm-none', useProjection: () => timeline() }))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(ContextModal, {
      sessionId: 'sm-closed',
      useContextModal: () => false,
      useProjection: () => timeline(),
    }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('open with no projection hook (or an empty one) shows the loading view', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)

    const m1 = await mount(h(ContextModal, { sessionId: 'sm-load1', useContextModal: OPEN }))
    assert.ok(text(m1.container).includes(DICT_EN.loading))
    assert.ok(m1.container.querySelector('.lc-modal-card') !== null)
    await m1.unmount()

    const m2 = await mount(h(ContextModal, {
      sessionId: 'sm-load2',
      useContextModal: OPEN,
      useProjection: () => undefined,
    }))
    assert.ok(text(m2.container).includes(DICT_EN.loading))
    await m2.unmount()
  })

  test('a corrupt timeline projection is sanitized and still renders the composition', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
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
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const projections: Record<string, unknown> = {
      contextTimeline: timeline({
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
      }),
      contextPressure: { projectedTokens: 100, contextWindow: 128000 },
      contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 18 },
      contextHeaders: {
        headers: [{ seq: 1, time: 0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }],
      },
    }
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-full',
      useContextModal: OPEN,
      useProjection: (key: string) => projections[key],
    }))
    assert.ok(text(m.container).includes('deepseek-v4-flash · deepseek'))

    // Hovering a composition segment flows into hoverCat (dim + legend chip).
    const compCard = query(m.container, '.lc-modal-card .lc-card')
    const seg = query(compCard, '.lc-stacked-seg')
    await hover(seg)
    assert.ok(query(compCard, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.ok(queryAll(compCard, '.lc-chip').some(c => c.className.includes('lc-chip-on')))
    await unhover(query(compCard, '.lc-stacked'))
    assert.ok(!query(compCard, '.lc-stacked').className.includes('lc-stacked-dim'))
    await m.unmount()
  })

  test('subtitle degrades to the model alone, then to nothing', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)

    const m1 = await mount(h(ContextModal, {
      sessionId: 'sm-sub1',
      useContextModal: OPEN,
      useProjection: (key: string) => key === 'contextTimeline' ? timeline({ model: 'only-model' }) : undefined,
    }))
    assert.ok(text(m1.container).includes('only-model'))
    assert.ok(!text(m1.container).includes('only-model ·'))
    await m1.unmount()

    const m2 = await mount(h(ContextModal, {
      sessionId: 'sm-sub2',
      useContextModal: OPEN,
      useProjection: (key: string) => key === 'contextTimeline' ? timeline() : undefined,
    }))
    const card = query(m2.container, '.lc-modal-card .lc-card')
    assert.equal(card.querySelector('.lc-card-sub'), null)
    await m2.unmount()
  })

  test('backdrop click without a sessionId is a no-op', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const m = await mount(h(ContextModal, { useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    assert.equal(sessions.bails.length, 0)
    await m.unmount()
  })

  test('clicking the card itself does not close (stopPropagation)', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const m = await mount(h(ContextModal, { sessionId: 'sm-card', useContextModal: OPEN, useProjection: () => undefined }))
    await click(query(m.container, '.lc-modal-card'))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    assert.equal(sessions.bails.length, 0)
    await m.unmount()
  })

  test('close flips the store and bails a pending consume through the session scope', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-close'
    modalStoreOf(sid).set(true)
    setPendingConsume(sid, { kind: 'bare-token', token: '/context' })
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)

    await click(query(m.container, '.lc-modal-close'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.equal(sessions.bails.length, 1)
    assert.equal(sessions.bails[0].event, 'slash/input-consume-token')
    assert.deepEqual(sessions.bails[0].payload, { guard: { kind: 'bare-token', token: '/context' } })
    // The guard was taken, not left behind.
    assert.equal(takePendingConsume(sid), undefined)
    await m.unmount()
  })

  test('close without a pending consume sets the store but bails nothing', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-noguard'
    modalStoreOf(sid).set(true)
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(sessions.bails.length, 0)
    await m.unmount()
  })

  test('a pending consume without the sessions service closes quietly', async () => {
    const ctx = new TestClientCtx()
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-nosvc'
    modalStoreOf(sid).set(true)
    setPendingConsume(sid, { kind: 'bare-token', token: '/context' })
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('a pending consume whose scope is gone closes quietly', async () => {
    const scoped: string[] = []
    const sessions = {
      scope: (id: string) => {
        scoped.push(id)
        return undefined
      },
    }
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-noscope'
    modalStoreOf(sid).set(true)
    setPendingConsume(sid, { kind: 'span', span: { start: 0, end: 8, draftRev: 3 } })
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.deepEqual(scoped, [sid])
    await m.unmount()
  })

  test('the mask docks beside the frame ancestor, follows template rewrites, and disconnects on close', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-dock'
    // The shell frame: the plugin matches its INLINE grid template, the one
    // host anchor carried by every supported baseline (dockMeasure.ts).
    const frame = document.createElement('div')
    frame.style.gridTemplateColumns = '280px minmax(0, 1fr) 360px'
    const seat = document.createElement('div')
    frame.appendChild(seat)
    document.body.appendChild(frame)

    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    // Relocate the mount container under the frame before opening, so the
    // measure walks the real ancestor chain.
    seat.appendChild(m.container)
    await act(async () => {
      modalStoreOf(sid).set(true)
    })
    assert.equal(query(m.container, '.lc-modal-backdrop').style.left, '280px')

    // A sidebar collapse rewrite while open is followed through the observer.
    await act(async () => {
      frame.style.gridTemplateColumns = '56px minmax(0, 1fr) 360px'
    })
    await flush()
    assert.equal(query(m.container, '.lc-modal-backdrop').style.left, '56px')

    disconnectSpy.mockClear()
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.equal(disconnectSpy.mock.calls.length, 1)
    frame.remove()
    await m.unmount()
  })

  test('without a frame ancestor the mask stays full-viewport', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-noframe',
      useContextModal: OPEN,
      useProjection: () => undefined,
    }))
    assert.equal(query(m.container, '.lc-modal-backdrop').style.left, '0px')
    await m.unmount()
  })

  test('Escape closes; other keys do not; the listener is removed on close', async () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-esc'
    modalStoreOf(sid).set(true)
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await keydown('a')
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)

    await keydown('Escape')
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)

    // Listener removed on close: another Escape must not run close() again —
    // with a pending consume armed, a live listener would bail.
    setPendingConsume(sid, { kind: 'bare-token', token: '/context' })
    await keydown('Escape')
    assert.equal(sessions.bails.length, 0)
    assert.notEqual(takePendingConsume(sid), undefined)
    await m.unmount()
  })

  test('closing restores focus to the previously focused element', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-focus'
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    assert.equal(document.activeElement, btn)

    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await act(async () => {
      modalStoreOf(sid).set(true)
    })
    const closeBtn = query(m.container, '.lc-modal-close')
    closeBtn.focus()
    assert.equal(document.activeElement, closeBtn)

    await click(closeBtn)
    assert.equal(document.activeElement, btn)
    btn.remove()
    await m.unmount()
  })

  test('closing skips the focus restore when the previous element left the document', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-focus-gone'
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()

    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    await act(async () => {
      modalStoreOf(sid).set(true)
    })
    btn.remove()
    await click(query(m.container, '.lc-modal-close'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.ok(!document.contains(btn))
    await m.unmount()
  })

  test('no focus bookkeeping when nothing was focused (activeElement not an element)', async () => {
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const sid = 'sm-focus-null'
    modalStoreOf(sid).set(true)
    // Environment control (not a plugin fake): jsdom always reports body;
    // the harness browser can report null before the body exists.
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null)
    const m = await mount(h(ContextModal, {
      sessionId: sid,
      useContextModal: boundModalHook(sid),
      useProjection: () => undefined,
    }))
    vi.restoreAllMocks()
    await click(query(m.container, '.lc-modal-close'))
    assert.equal(modalStoreOf(sid).getSnapshot(), false)
    assert.equal(document.activeElement, document.body)
    await m.unmount()
  })
})

describe('ContextModal — the split generation', () => {
  /** Poll until the predicate holds (the detail store's debounce rides real timers). */
  async function until(fn: () => boolean, message: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (fn()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail(message)
  }

  test('the modal shares the detail channel: the browser lands the collections on open', async () => {
    const ctx = new TestClientCtx({
      services: {
        sessions: new TestSessions(),
        connection: {
          rpc: {
            call: async () => ({
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
          },
        },
      },
    })
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const head = timeline({
      counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 },
      last: { seq: 1, total: 21, prompt: 20 },
      detailRev: 1,
    })
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-slim',
      useContextModal: OPEN,
      useProjection: (key: string) => (key === 'contextTimeline' ? head : undefined),
    }))
    // The composition card paints off the head while the browser's detail note shows.
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['detail.loading']))
    // The detail lands: the browser serves the step picker + the sections.
    await until(() => !text(m.container).includes(DICT_EN['detail.loading']), 'the modal detail never landed')
    assert.equal(queryAll(m.container, '.lc-br-pick option').length, 2, 'live + the one served step')
    assert.ok(text(m.container).includes('1 Item'), 'the assistant section counts the served node')
    await m.unmount()
  })

  test('a mount that raced the declared inject heals when the face lands mid-open', async () => {
    // The race: the modal mounts (and its fetchers snapshot the face) BEFORE
    // `remote` composes — the degraded note shows — then the inject fires and
    // the OPEN system section must auto-fetch without any user action.
    const calls: { sessionId: string; throughSeq: number; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    // Armed before either service exists: the inject stays pending, the race.
    watchHistoryFaces(asClientCtx(ctx))
    const ContextModal = makeContextModal(asClientCtx(ctx), kit)
    const projections: Record<string, unknown> = {
      contextTimeline: timeline(),
      contextHeaders: { headers: [{ seq: 1, time: 0, systemTokens: 5, tools: [] }] },
    }
    const m = await mount(h(ContextModal, {
      sessionId: 'sm-race',
      useContextModal: OPEN,
      useProjection: (key: string) => projections[key],
    }))
    const sysRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.system']))
    assert.ok(sysRow !== undefined)
    await click(sysRow)
    assert.ok(text(m.container).includes(DICT_EN['browser.headerMetaOnly']), 'the faceless mount shows the static note')

    // The face lands mid-open (cordis replays the pending inject): the modal
    // re-renders, the fetcher builds, and the open epoch fetches by itself.
    // The face rides INSIDE the `remote` facade; the `remote.session` service
    // key stays hostile, as on the real host.
    await act(async () => {
      ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
      ctx.setService('remote', {
        session: {
          page: (request: { address: { sessionId: string }; throughSeq: number; beforeSeq: number }) => {
            calls.push({ sessionId: request.address.sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq })
            return Promise.resolve({
              ok: true,
              value: {
                records: [{ type: 'event', event: { type: 'request/header', seq: 1, time: 1, data: { header: { system: 'HEALED SYSTEM PROMPT', tools: [] } } } }],
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
    // Unload the declared slot so no face stales into the next test.
    ctx.dispose()
  })
})

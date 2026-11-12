import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { makeContextBrowser, stepStampOf } from '../../../src/client/components/browser'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import { type ContextHeaders, type RequestRecord, type HeaderEpochContent, type SurfaceNode } from '../../../src/shared/types'
import { createContextSettings } from '../../../src/client/settings'
import { click, flush, hover, mount, query, queryAll, surfaceNode, text, unhover, type Mounted } from '../helpers/kit'
import { Browser, ROW, catRow, elemRows, kit, pickStep, pickValue, pickLabels, props, req, tl, withEpochContent, silenceFetchWarn } from './browserHarness'
import { headersOf, type ConversationNodeLike } from '../../../src/client/services'

describe('browserLiveSurface', () => {

async function clickDeltaBase(m: Mounted, label: 'prev step' | 'prev turn'): Promise<void> {
  const btn = queryAll(m.container, '.lc-card-title .lc-gran-btn').find(b => text(b) === label)
  assert.ok(btn !== undefined, `toggle button ${label} exists`)
  await click(btn)
}

describe('ContextBrowser live surface', () => {
  test('the settings card default wins as the baseline toggle mount state', async () => {
    const prefs = createContextSettings()
    prefs.set('defaultDeltaBase', 'turn')
    const PrefBrowser = makeContextBrowser(kit, makeStackedBar(kit), prefs)
    const m = await mount(h(PrefBrowser, props({ data: tl({}) })))
    const baseBtns = queryAll(m.container, '.lc-card-title .lc-gran-btn')
    const turnBtn = baseBtns.find(b => text(b) === 'prev turn')
    assert.ok(turnBtn !== undefined && turnBtn.className.includes('lc-gran-on'), 'the persisted baseline is active at mount')
    const stepBtn = baseBtns.find(b => text(b) === 'prev step')
    assert.ok(stepBtn !== undefined && !stepBtn.className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('title, picker, live meta, category rows; empty categories stay shut', async () => {
    const data = tl({
      current: { system: 100, tools: 200, user: 50, inject: 0, skill: 0, assistant: 0, tool: 0, total: 350 },
      requests: [
        req({ seq: 10, turn: 1, step: 0 }),
        req({ seq: 20, turn: 1, step: 1, prompt: 800 }),
        req({ seq: 7, time: 500, turn: undefined, step: undefined }),
      ],
      nodes: [surfaceNode({ seq: 1, tokens: 50, text: 'hello' })],
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(query(m.container, '.lc-card-title-text')).includes('Context Browser'))
    const baseBtns = queryAll(m.container, '.lc-card-title .lc-gran-btn')
    const stepBtn = baseBtns.find(b => text(b) === 'prev step')
    assert.ok(stepBtn !== undefined && stepBtn.className.includes('lc-gran-on'), 'step baseline is the default')
    assert.ok(baseBtns.some(b => text(b) === 'prev turn' && !b.className.includes('lc-gran-on')))
    assert.equal(pickValue(m), 'live')
    const options = await pickLabels(m)
    assert.equal(options.length, 4, 'live + one option per request')
    assert.equal(options[0], 'Live')
    assert.equal(options[3], 'T1 · S0', 'options carry the compact step label without a time suffix')
    assert.ok(options.some(o => o.includes('T0 · S0')), 'requests without turn/step degrade to zeroes')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Live · Next Request'))
    assert.ok(meta.includes('Estimated ≈ 350'))
    assert.ok(meta.includes('Actual 800'), 'live pairs the estimate with the freshest actual')
    await clickDeltaBase(m, 'prev turn')
    const liveUserCat = queryAll(m.container, '.lc-br-cat')[ROW.user]
    assert.equal(text(query(liveUserCat, '.lc-br-delta')), '+1')
    assert.equal(text(query(liveUserCat, '.lc-br-tdelta')), '+50')
    await clickDeltaBase(m, 'prev step')
    assert.equal(queryAll(m.container, '.lc-br-cat-row').length, 7)
    assert.ok(text(catRow(m, 'user')).includes('1 Items'))
    assert.ok(queryAll(m.container, '.lc-br-cat')[ROW.inject].className.includes('lc-br-cat-empty'), 'empty category is marked')
    await pickStep(m, '7')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 0 · Step 0'))
    assert.ok(!meta2.includes('Actual'), 'this freshest request reported no usage')
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0, 'the seq-7 view and its seq-20 baseline hold the same single node')
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(m.container, '.lc-br-delta')), '+1')
    await pickStep(m, 'live')
    await click(catRow(m, 'inject'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    assert.ok(queryAll(m.container, '.lc-br-pct').some(el => text(el).endsWith('%')))
    await m.unmount()

    const zero = await mount(h(Browser, props({ data: tl({}) })))
    assert.ok(queryAll(zero.container, '.lc-br-pct').every(el => text(el) === ''))
    assert.equal(queryAll(zero.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(zero.container, '.lc-br-tdelta').length, 0)
    await clickDeltaBase(zero, 'prev turn')
    assert.equal(queryAll(zero.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(zero.container, '.lc-br-tdelta').length, 0)
    const zeroMeta = text(query(zero.container, '.lc-br-meta'))
    assert.ok(zeroMeta.includes('Estimated ≈ 0'))
    assert.ok(!zeroMeta.includes('Actual'), 'no requests, no actual figure')
    await zero.unmount()
  })

  test('dropped live nodes raise the missing-window note, live and on later steps only', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 3, turn: 1, step: 0 }), req({ seq: 10, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 6, text: 'served' })],
      droppedNodes: 2,
      surfaceFloor: 5,
      archiveFloor: 8,
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'), 'live flags the dropped tail')
    await pickStep(m, '3')
    assert.ok(!text(m.container).includes('earlier messages are also part'))
    assert.ok(text(m.container).includes('approximate'), 'seq below the archive floor is approximate')
    await pickStep(m, '10')
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'))
    assert.ok(text(m.container).includes('approximate'), 'a diff baseline below the archive floor stays approximate')
    await m.unmount()
  })

  test('step picking switches the assembled view; back-to-live restores the surface', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 30, inject: 0, skill: 0, assistant: 10, tool: 0, total: 40 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 25 }), req({ seq: 20, turn: 1, step: 1, user: 30, assistant: 10, prompt: 800 })],
      nodes: [surfaceNode({ seq: 1, text: 'first question' }), surfaceNode({ seq: 11, cat: 'assistant', tokens: 10, text: 'first answer' })],
      archive: [surfaceNode({ seq: 0, tokens: 5, text: 'archived hello', gone: 15 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '10')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(!meta.includes('Actual'), 'this step reported no usage')
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 2, 'archived + live nodes reconstructed')
    assert.ok(text(m.container).includes('archived hello'))
    await pickStep(m, '20')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 1 · Step 1'))
    assert.ok(meta2.includes('Actual 800'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'picking a step collapses the accordion')
    await pickStep(m, 'live')
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1, 'live excludes removed nodes')
    assert.ok(!text(m.container).includes('archived hello'))
    await m.unmount()
  })

  test('delta pills follow the picked baseline; a predecessor-less step diffs against zero', async () => {
    const data = tl({
      current: { system: 1, tools: 2, user: 60, inject: 0, skill: 0, assistant: 0, tool: 0, total: 63 },
      requests: [
        req({ seq: 1, turn: 1, step: 0, system: 1, tools: 2, user: 10, total: 13 }),
        req({ seq: 2, turn: 1, step: 1, system: 1, tools: 2, user: 20, total: 23 }),
        req({ seq: 3, turn: 2, step: 0, system: 1, tools: 2, user: 30, total: 33 }),
        req({ seq: 4, turn: 2, step: 1, system: 1, tools: 2, user: 40, total: 43 }),
        req({ seq: 5, turn: 3, step: 0, system: 1, tools: 2, user: 50, total: 53 }),
      ],
      nodes: [0, 1, 2, 3, 4, 5].map(seq => surfaceNode({ seq, tokens: 10 })),
      systems: [{ seq: 0, time: 1, tokens: 1 }],
    })
    const headers: ContextHeaders = {
      headers: [{ seq: 0, time: 1, systemTokens: 1, tools: [{ name: 'bash', tokens: 2 }] }],
    }
    const m = await mount(h(Browser, props({ data, headers })))
    const userRow = (): HTMLElement => queryAll(m.container, '.lc-br-cat')[ROW.user]
    await pickStep(m, '4')
    const countPills = queryAll(userRow(), '.lc-br-delta')
    assert.equal(countPills.length, 1, 'only the user count changed')
    assert.equal(text(countPills[0]), '+1')
    assert.ok(countPills[0].className.includes('lc-br-delta-up'))
    const tokenPills = queryAll(userRow(), '.lc-br-tdelta')
    assert.equal(tokenPills.length, 1)
    assert.equal(text(tokenPills[0]), '+10')
    await pickStep(m, '1')
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 3)
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    await pickStep(m, '4')
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+2')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+20')
    await pickStep(m, '1')
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 3)
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    await pickStep(m, 'live')
    await clickDeltaBase(m, 'prev step')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    await clickDeltaBase(m, 'prev turn')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+2')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+20')
    await clickDeltaBase(m, 'prev step')
    assert.equal(text(query(userRow(), '.lc-br-delta')), '+1')
    assert.equal(text(query(userRow(), '.lc-br-tdelta')), '+10')
    await m.unmount()
  })

  test('shrinking categories render downward pills', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [
        req({ seq: 2, turn: 1, step: 1, user: 25, total: 25 }),
        req({ seq: 3, turn: 2, step: 0, user: 10, total: 10 }),
      ],
      nodes: [surfaceNode({ seq: 1, tokens: 10, text: 'kept' })],
      archive: [surfaceNode({ seq: 0, tokens: 15, text: 'pruned away', gone: 3 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '3')
    const countPill = query(m.container, '.lc-br-delta')
    assert.equal(text(countPill), '-1', 'the archived node left the step’s surface')
    assert.ok(countPill.className.includes('lc-br-delta-down'))
    const tokenPill = query(m.container, '.lc-br-tdelta')
    assert.equal(text(tokenPill), '-15')
    assert.ok(tokenPill.className.includes('lc-br-tdelta-down'))
    await m.unmount()
  })

  test('hover linkage: category rows report hovers and mirror the shared key while live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10 })],
      nodes: [surfaceNode({ seq: 1, text: 'hi' })],
    })
    const hovers: (string | null)[] = []
    const el = h(Browser, props({ data, hoverKey: null, onHoverKey: (k) => { hovers.push(k) } }))
    const m = await mount(el)
    await hover(catRow(m, 'user'))
    await unhover(catRow(m, 'user'))
    assert.deepEqual(hovers, ['user', null])
    await m.update(h(Browser, props({ data, hoverKey: 'user', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.update(h(Browser, props({ data, hoverKey: 'free', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    await pickStep(m, '10')
    const before = hovers.length
    await hover(catRow(m, 'user'))
    assert.equal(hovers.length, before, 'no hover reporting while a step is shown')
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.unmount()

    const m2 = await mount(h(Browser, props({ data })))
    await hover(catRow(m2, 'user'))
    await m2.unmount()
  })

  test('previewSeq transiently shows a step; unknown preview/pin seqs fall back to live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10, prompt: 700 })],
      nodes: [surfaceNode({ seq: 1, text: 'hi' })],
    })
    const m = await mount(h(Browser, props({ data, previewSeq: 10 })))
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(meta.includes('Actual 700'))
    await m.update(h(Browser, props({ data, previewSeq: 999 })))
    const liveMeta = text(query(m.container, '.lc-br-meta'))
    assert.ok(liveMeta.includes('Live · Next Request'))
    assert.ok(liveMeta.includes('Actual 700'))
    await m.update(h(Browser, props({ data, previewSeq: null, pinSeq: 999 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    assert.equal(pickValue(m), 'live')
    await m.unmount()
  })

  test('element rows carry the introducing step stamp merged with the time (T{t} S{s} · clock); the live tail carries none', async () => {
    const data = tl({
      current: { system: 10, tools: 10, user: 10, inject: 10, skill: 10, assistant: 10, tool: 10, total: 70 },
      requests: [
        req({ seq: 20, turn: 1, step: 1 }),
        req({ seq: 30, turn: 1, step: 2 }),
        req({ seq: 40, turn: 2, step: 1 }),
      ],
      systems: [{ seq: 22, time: 100, tokens: 10 }],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'inject', tokens: 1, form: 'snapshot', text: 'state', time: 60_000 }),
        surfaceNode({ seq: 35, cat: 'assistant', tokens: 1 }),
        surfaceNode({ seq: 36, cat: 'skill', tokens: 1, skill: 's' }),
        surfaceNode({ seq: 45, cat: 'tool', tokens: 1, tool: 'bash' }),
      ],
    })
    const headers: ContextHeaders = { headers: [{ seq: 22, time: 100, systemTokens: 10, tools: [{ name: 't1', tokens: 5 }] }] }
    const epoch = withEpochContent(headers, { 22: { system: 'SYS', tools: [{ name: 't1', schema: {} }] } })
    const m = await mount(h(Browser, props({ data, headers: epoch.headers, fetchHeader: epoch.fetchHeader })))
    const stampOfCat = async (cat: keyof typeof ROW): Promise<string[]> => {
      await click(catRow(m, cat))
      await flush()
      const body = query(queryAll(m.container, '.lc-br-cat')[ROW[cat]], '.lc-br-body')
      return queryAll(body, '.lc-br-time').map(el => text(el))
    }
    assert.deepEqual(await stampOfCat('user'), ['T1 S1'], 'a stamp without a clock stands alone')
    const [injectStamp] = await stampOfCat('inject')
    assert.match(injectStamp, /^T1 S2 · \d{2}:\d{2}:\d{2}$/, 'the stamp merges with the clock into one run')
    assert.deepEqual(await stampOfCat('assistant'), ['T2 S1'])
    assert.deepEqual(await stampOfCat('skill'), ['T2 S1'])
    await click(catRow(m, 'tool'))
    await flush()
    const toolBody = query(queryAll(m.container, '.lc-br-cat')[ROW.tool], '.lc-br-body')
    const pendingMeta = query(toolBody, '.lc-br-time')
    assert.equal(text(pendingMeta), 'T2 S2')
    assert.ok(pendingMeta.className.includes('lc-br-time-pending'), 'the pending estimate wears the dotted underline')
    assert.equal(pendingMeta.title, 'Expected in the Turn 2 · Step 2 request (not yet sent)')
    assert.equal(queryAll(toolBody, '.lc-br-elem-row').length, 1, 'the row still renders with the pending stamp')
    assert.deepEqual(await stampOfCat('system'), ['T1 S2'])
    assert.deepEqual(await stampOfCat('tools'), ['T1 S2'])
    const tip = query(queryAll(m.container, '.lc-br-cat')[ROW.tools], '.lc-br-time').title
    assert.equal(tip, 'First carried by the Turn 1 · Step 2 request')
    await m.unmount()
  })

  test('pending tail stamps: a waiting user message opens the next turn, a final reply ends it, pending calls continue it', async () => {
    const waiting = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 10, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'tool', tokens: 1, tool: 'bash' }),
        surfaceNode({ seq: 30, cat: 'user', tokens: 1 }),
      ],
    })
    const m = await mount(h(Browser, props({ data: waiting })))
    await click(catRow(m, 'tool'))
    await flush()
    const toolBody = query(queryAll(m.container, '.lc-br-cat')[ROW.tool], '.lc-br-body')
    assert.equal(text(query(toolBody, '.lc-br-time')), 'T2 S1', 'a waiting user message opens the next turn')
    await m.unmount()

    const ended = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'assistant', tokens: 1, text: 'final answer' }),
      ],
    })
    const m1 = await mount(h(Browser, props({ data: ended })))
    await click(catRow(m1, 'assistant'))
    await flush()
    assert.equal(text(query(query(queryAll(m1.container, '.lc-br-cat')[ROW.assistant], '.lc-br-body'), '.lc-br-time')), 'T2 S1')
    await m1.unmount()
    const continuing = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0, total: 20 },
      requests: [req({ seq: 20, turn: 1, step: 1 })],
      nodes: [
        surfaceNode({ seq: 5, cat: 'user', tokens: 1 }),
        surfaceNode({ seq: 25, cat: 'assistant', tokens: 1, calls: ['bash'] }),
      ],
    })
    const m2 = await mount(h(Browser, props({ data: continuing })))
    await click(catRow(m2, 'assistant'))
    await flush()
    assert.equal(text(query(query(queryAll(m2.container, '.lc-br-cat')[ROW.assistant], '.lc-br-body'), '.lc-br-time')), 'T1 S2')
    await m2.unmount()
  })
})

describe('stepStampOf', () => {
  const r = (seq: number, turn?: number, step?: number): RequestRecord => req({ seq, turn, step })

  test('an item stamps to the FIRST request logged after it, whatever the wire order; the live tail and turn-less introducers stamp null', () => {
    const input = [r(30, 2, 1), r(10, 1, 1), r(20, 1, 2)]
    const stamp = stepStampOf(input)
    assert.deepEqual(stamp(5), { turn: 1, step: 1 })
    assert.deepEqual(stamp(10), { turn: 1, step: 2 }, 'an item AT a request seq is carried by the NEXT request')
    assert.deepEqual(stamp(25), { turn: 2, step: 1 })
    assert.equal(input[0].seq, 30, 'the caller array is not reordered')

    const tail = stepStampOf([r(10, undefined, undefined), r(20, 1, 1)])
    assert.equal(tail(5), null, 'the introducing request carries no turn/step numbers')
    assert.deepEqual(tail(15), { turn: 1, step: 1 })
    assert.equal(tail(25), null, 'no request follows the item yet')
  })
})
})

describe('browserHeaderEpochs', () => {

describe('ContextBrowser header epochs', () => {
  const HEADERS: ContextHeaders = {
    headers: [
      { seq: 15, time: 1500, systemTokens: 8, tools: [{ name: 'old', tokens: 1 }] },
      { seq: 35, time: 3500, systemTokens: 12, tools: [{ name: 'fresh', tokens: 9 }] },
    ],
  }
  const CONTENTS: Record<number, HeaderEpochContent> = {
    15: { system: 'SYS A', tools: [{ name: 'old', schema: {} }] },
    35: { system: 'SYS B\nsecond line', tools: [{ name: 'fresh', description: 'fresh tool', schema: {} }] },
  }
  const lazy = withEpochContent(HEADERS, CONTENTS)

  test('system category opens its prompt row directly; rich switch toggles raw/markdown', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await click(catRow(m, 'system'))
    await flush()
    const body = query(m.container, '.lc-br-body')
    assert.ok(text(body).includes('SYS B'), 'the newest epoch’s prompt shows on the live surface')
    assert.ok(text(body).includes('2 lines'), 'line count rides the section head')
    assert.ok(catRow(m, 'system').className.includes('lc-br-cat-open'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1)
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown view by default')
    const rawBtn = queryAll(body, '.lc-gran-btn')[0]
    assert.equal(text(rawBtn), 'Raw')
    await click(rawBtn)
    const lines = queryAll(m.container, '.lc-ts-line').map(line => line.textContent)
    assert.deepEqual(lines, ['SYS B', 'second line'])
    await click(queryAll(body, '.lc-gran-btn')[1])
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown restored')
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    assert.ok(!catRow(m, 'system').className.includes('lc-br-cat-open'))
    await m.unmount()
  })

  test('an epoch fetches once and the content stays cached across steps, each step reading the epoch in force at its seq', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    let calls = 0
    const counting = { ...lazy, fetchHeader: (seq: number) => { calls += 1; return lazy.fetchHeader(seq) } }
    const m = await mount(h(Browser, props({ data, ...counting })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'))
    assert.equal(calls, 1)
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    assert.equal(calls, 2)
    await pickStep(m, 'live')
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'))
    assert.equal(calls, 2)
    await m.unmount()
  })

  test('a failed epoch fetch auto-retries and the retried read renders', async () => {
    silenceFetchWarn()
    vi.useFakeTimers()
    try {
      const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
      const pendings: Array<{ resolve: (v: HeaderEpochContent | null) => void; reject: (e: unknown) => void }> = []
      const deferred: () => Promise<HeaderEpochContent | null> = () =>
        new Promise((resolve, reject) => { pendings.push({ resolve, reject }) })
      const m = await mount(h(Browser, props({ data, headers: HEADERS, fetchHeader: deferred })))
      await click(catRow(m, 'system'))
      await flush()
      assert.ok(text(query(m.container, '.lc-br-body')).includes('Loading'), 'the fetch is in flight')
      await act(async () => { pendings[0]!.reject(new Error('down')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
      await flush()
      assert.equal(pendings.length, 2, 'the bounded retry refetches without user action')
      await act(async () => { pendings[1]!.resolve(CONTENTS[35]!) })
      await flush()
      assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS B'), 'the retried read renders')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a stale epoch fetch resolves and rejects ignored once another epoch takes over', async () => {
    silenceFetchWarn()
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    const pendings: Array<{ resolve: (v: HeaderEpochContent | null) => void; reject: (e: unknown) => void }> = []
    const deferred = (): Promise<HeaderEpochContent | null> =>
      new Promise((resolve, reject) => { pendings.push({ resolve, reject }) })
    const m = await mount(h(Browser, props({ data, headers: HEADERS, fetchHeader: deferred })))
    await click(catRow(m, 'system'))
    await flush()
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 2)
    await act(async () => { pendings[0]!.reject(new Error('stale')) })
    await flush()
    assert.ok(!text(m.container).includes('Load failed'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('Loading'))
    await act(async () => { pendings[1]!.resolve(CONTENTS[15]!) })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    await pickStep(m, 'live')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 3)
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    await flush()
    assert.equal(pendings.length, 3, 'epoch 15 is cached')
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'))
    await act(async () => { pendings[2]!.resolve(CONTENTS[35]!) })
    await flush()
    assert.ok(!text(m.container).includes('SYS B'), 'the stale content is ignored')
    await m.unmount()
  })

  test('an epoch missing from the durable log degrades to the not-in-log note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({
      data, headers: HEADERS, fetchHeader: () => Promise.resolve(null),
    })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('not in the session log'))
    await click(catRow(m, 'tools'))
    await flush()
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('not in the session log'))
    await m.unmount()
  })

  test('a host without the history face, or an absent headers projection, degrades to the metadata-only note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, headers: HEADERS })))
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('token estimates only'))
    await click(catRow(m, 'tools'))
    assert.equal(elemRows(m).length, 1, 'metadata rows still render')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('token estimates only'))
    await m.unmount()

    const absent = await mount(h(Browser, props({ data, headers: null })))
    await click(catRow(absent, 'system'))
    assert.ok(text(query(absent.container, '.lc-br-body')).includes('older plugin build'))
    await click(catRow(absent, 'tools'))
    assert.ok(text(queryAll(absent.container, '.lc-br-body')[0]).includes('older plugin build'))
    await absent.unmount()
  })

  test('an epoch outside retention degrades to the no-epoch note', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 10, turn: 1, step: 0 })],
    })
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await pickStep(m, '10')
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('outside retention'))
    await click(catRow(m, 'tools'))
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('outside retention'))
    await m.unmount()
  })

  test('an epoch without a system prompt keeps the system category shut, including a step before the system node', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, tools: [{ name: 'x', tokens: 1 }] }] }
    const data = tl({ current: { system: 0, tools: 1, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } })
    const m = await mount(h(Browser, props({ data, ...withEpochContent(headers, { 1: { tools: [] } }) })))
    assert.ok(text(catRow(m, 'system')).includes('0 Items'))
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'no prompt, no body')
    await m.unmount()

    const scopedHeaders: ContextHeaders = { headers: [{ seq: 3, time: 300, tools: [] }] }
    const scoped = tl({
      current: { system: 30, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 30 },
      requests: [req({ seq: 5, turn: 1, step: 0, system: 0, tools: 0, user: 5, total: 5 })],
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const before = await mount(h(Browser, props({ data: scoped, headers: scopedHeaders })))
    await pickStep(before, '5')
    assert.ok(text(catRow(before, 'system')).includes('0 Items'))
    await click(catRow(before, 'system'))
    assert.equal(queryAll(before.container, '.lc-br-body').length, 0, 'no prompt yet at this step')
    await before.unmount()
  })

  test('a legacy content-bearing epoch (pre-#37 wire) still counts the system prompt', async () => {
    const legacy = {
      headers: [{
        seq: 12,
        time: 1_000,
        system: 'You are an AI agent.\n',
        tools: [{ name: 'bash', tokens: 815, description: 'run', schema: { type: 'object' } }],
      }],
    } as unknown as ContextHeaders
    const data = tl({ current: { system: 9, tools: 815, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 824 } })
    const m = await mount(h(Browser, props({ data, headers: headersOf(legacy) })))
    assert.ok(text(catRow(m, 'system')).includes(kit.t('browser.items', { n: 1 })))
    await m.unmount()
  })

  test('a fetched epoch or resolved prompt event without system text explains its absence', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 3, time: 3, systemTokens: 0, tools: [] }] }
    const data = tl({ current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 } })
    const m = await mount(h(Browser, props({
      data, headers, fetchHeader: () => Promise.resolve({ tools: [] }),
    })))
    await click(catRow(m, 'system'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-body')).includes('carried no system prompt'))
    await m.unmount()

    const systems = tl({
      current: { system: 30, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 30 },
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const blank = await mount(h(Browser, props({ data: systems, fetchHeader: () => Promise.resolve({ tools: [] }) })))
    await click(catRow(blank, 'system'))
    await flush()
    assert.ok(text(query(blank.container, '.lc-br-body')).includes('carried no system prompt'))
    await blank.unmount()
  })

  test('a system prompt rides the timeline systems list, fetched from its own event seq', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 15, time: 1500, tools: [{ name: 'x', tokens: 1 }] }] }
    const data = tl({
      current: { system: 30, tools: 1, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 31 },
      systems: [{ seq: 7, time: 700, tokens: 30 }],
    })
    const asked: number[] = []
    const fetchHeader = (seq: number): Promise<HeaderEpochContent> => {
      asked.push(seq)
      return Promise.resolve(seq === 7 ? { system: 'THE PROMPT', tools: [] } : { tools: [] })
    }
    const m = await mount(h(Browser, props({ data, headers, fetchHeader })))
    assert.ok(text(catRow(m, 'system')).includes(kit.t('browser.items', { n: 1 })))
    await click(catRow(m, 'system'))
    await flush()
    assert.deepEqual(asked, [7], 'the prompt is fetched from the system node, not the header epoch')
    assert.ok(text(query(m.container, '.lc-br-body')).includes('THE PROMPT'))
    await m.unmount()
  })
})
})

describe('browserContentFetch', () => {

describe('ContextBrowser tool results', () => {
  const cases: { seq: number; tail: string; err: boolean; label: string }[] = [
    { seq: 80, tail: 'boom\n[exit code: 3]', err: true, label: 'Failed · exit 3' },
    { seq: 81, tail: '[killed by signal: SIGKILL]', err: true, label: 'Failed' },
    { seq: 82, tail: '[shell killed by signal: SIGTERM]', err: true, label: 'Failed' },
    { seq: 83, tail: '[shell exited: code 2]', err: true, label: 'Failed · exit 2' },
    { seq: 84, tail: '[shell exited: code 0]', err: false, label: 'OK' },
    { seq: 85, tail: '[shell exited]', err: false, label: 'OK' },
    { seq: 86, tail: 'oops [exit code: 7]\n[shell killed by signal: SIGTERM]', err: true, label: 'Failed · exit 7' },
    { seq: 87, tail: '[status: killed]', err: true, label: 'Failed' },
    { seq: 88, tail: '[status: failed, boom]', err: true, label: 'Failed' },
    { seq: 89, tail: 'all good', err: false, label: 'OK' },
    { seq: 90, tail: 'a quoted [exit code: 9] marker mid-text\nmore output', err: false, label: 'OK' },
  ]
  const convNodes: ConversationNodeLike[] = cases.map(c => ({
    kind: 'tool-result', seq: c.seq,
    call: { name: 'bash', argsRaw: '{"description":"run it"}' },
    content: [{ type: 'image', attachment: { attachmentId: 'x' + String(c.seq) } }, null, { type: 'text', text: c.tail }],
  }))
  convNodes.push(
    { kind: 'tool-result', seq: 91, call: { name: 'read', argsRaw: '{}' }, content: [{ type: 'text', text: 'denied' }], isError: true },
    { kind: 'tool-result', seq: 92, call: null, content: [{ type: 'text', text: 'orphan' }] },
    { kind: 'tool-result', seq: 93, call: { name: 'bash', argsRaw: '' }, content: 'raw-text' as never },
  )
  const nodes: SurfaceNode[] = [
    ...cases.map(c => surfaceNode({ seq: c.seq, cat: 'tool', tokens: 9, tool: 'bash' })),
    surfaceNode({ seq: 91, cat: 'tool', tokens: 9, tool: 'read' }),
    surfaceNode({ seq: 92, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 93, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 94, cat: 'tool', tokens: 9, tool: 'write', err: true }),
    surfaceNode({ seq: 95, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 96, cat: 'tool', tokens: 9 }),
    surfaceNode({ seq: 97, cat: 'tool', tokens: 9, tool: 'bash' }),
  ]
  convNodes.push({ kind: 'tool-result', seq: 97, call: { name: 'bash', argsRaw: '{}' }, content: [{ type: 'text', text: 'skill body' }] })

  const data = tl({
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 162, total: 162 },
    nodes,
  })

  test('tail-status matrix drives the error dot; tags and previews render on collapsed rows', async () => {
    const m = await mount(h(Browser, props({ data, convNodes })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    assert.equal(rows.length, nodes.length)
    const dots = queryAll(m.container, '.lc-br-err-dot')
    assert.equal(dots.length, 9, 'one red dot per failing result')
    assert.ok(text(rows[0]).includes('bash'))
    assert.ok(text(rows[1]).includes('?'), 'missing tool name tags as ?')
    assert.ok(text(rows[1]).includes('Tool Result'), 'no join → placeholder preview')
    assert.ok(text(rows[2]).includes('Tool Result'))
    assert.ok(text(rows[3]).includes('write'))
    const byIdx = Object.fromEntries([97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80].map((s, i) => [s, i]))
    for (const c of cases) {
      const hasDot = rows[byIdx[c.seq]].querySelector('.lc-br-err-dot') !== null
      assert.equal(hasDot, c.err, `seq ${c.seq}: dot ${c.err ? 'shown' : 'hidden'} for tail ${JSON.stringify(c.tail)}`)
    }
    assert.ok(rows[byIdx[91]].querySelector('.lc-br-err-dot') !== null, 'isError stamps the dot')
    assert.ok(rows[byIdx[94]].querySelector('.lc-br-err-dot') !== null, 'the fold err flag stamps the dot')
    assert.ok(rows[byIdx[93]].querySelector('.lc-br-err-dot') === null, 'non-array content has no markers')
    await click(rows[0])
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('OK'))
    assert.ok(text(content).includes('skill body'))
    await m.unmount()
  })

  test('clean results render the OK state; orphan results render no call card', async () => {
    const m = await mount(h(Browser, props({ data, convNodes })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    const byIdx = Object.fromEntries([97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80].map((s, i) => [s, i]))
    const expand = async (seq: number) => {
      await click(rows[byIdx[seq]])
      return query(m.container, '.lc-br-content')
    }
    let content = await expand(89)
    assert.ok(text(content).includes('OK'))
    assert.ok(!queryAll(content, '.lc-br-err-dot').length)
    await click(elemRows(m)[byIdx[89]])
    content = await expand(80)
    assert.ok(text(content).includes('Failed · exit 3'))
    await click(elemRows(m)[byIdx[80]])
    content = await expand(81)
    assert.ok(text(content).includes('Failed'))
    assert.ok(!text(content).includes('exit'))
    await click(elemRows(m)[byIdx[81]])
    content = await expand(86)
    assert.ok(text(content).includes('Failed · exit 7'))
    await click(elemRows(m)[byIdx[86]])
    content = await expand(92)
    assert.ok(!text(content).includes('→'), 'no call card without a call record')
    assert.ok(text(content).includes('orphan'))
    await click(elemRows(m)[byIdx[92]])
    content = await expand(93)
    assert.ok(text(content).includes('OK'))
    assert.ok(!text(content).includes('raw-text'))
    await m.unmount()
  })
})

describe('ContextBrowser targeted content fetch', () => {
  const data = tl({
    current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
    nodes: [surfaceNode({ seq: 5, tokens: 5, text: 'pageable' }), surfaceNode({ seq: 6, tokens: 5, text: 'also pageable' })],
  })

  const openFirstRow = async (m: Mounted) => {
    await click(catRow(m, 'user'))
    await click(elemRows(m)[1])
  }

  test('a missed join fetches the seq once, and the fetched body renders', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const fetchContent = async (seq: number) => {
      calls += 1
      return new Promise<void>((resolve) => { release = resolve })
        .then(() => ({ kind: 'user', seq, content: [{ type: 'text', text: 'FULL BODY' }] }) as ConversationNodeLike)
    }
    const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
    await openFirstRow(m)
    assert.equal(calls, 1, 'one targeted read')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('Loading full content from older session history'), 'in-flight note')
    await act(async () => { release?.() })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('FULL BODY'))
    await click(elemRows(m)[1])
    await click(elemRows(m)[1])
    assert.ok(text(query(m.container, '.lc-br-content')).includes('FULL BODY'))
    assert.equal(calls, 1, 'no second fetch for a merged seq')
    await m.unmount()
  })

  test('a page without the seq reports it as absent from the session log', async () => {
    let calls = 0
    const fetchContent = async () => {
      calls += 1
      return null
    }
    const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
    await openFirstRow(m)
    await flush()
    assert.equal(calls, 1)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('not in the session log anymore'))
    await m.unmount()
  })

  test('a failed read arms the retry button; retrying succeeds', async () => {
    silenceFetchWarn()
    vi.useFakeTimers()
    try {
      let calls = 0
      let failing = true
      const fetchContent = async (seq: number) => {
        calls += 1
        if (failing) throw new Error('transport down')
        return { kind: 'user', seq, content: [{ type: 'text', text: 'RETRY BODY' }] } as ConversationNodeLike
      }
      const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
      await openFirstRow(m)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      const failed = query(m.container, '.lc-br-content')
      assert.ok(text(failed).includes('Load failed'))
      assert.equal(calls, 4, 'the bounded auto-retry exhausts before arming the manual retry')
      failing = false
      await click(query(failed, '.lc-br-retry'))
      await act(async () => { await Promise.resolve() })
      assert.ok(text(query(m.container, '.lc-br-content')).includes('RETRY BODY'))
      assert.equal(calls, 5)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a session scope change refetches instead of reusing another session value', async () => {
    const fetched: string[] = []
    let session = 'A'
    const fetchContent = async (seq: number) => {
      fetched.push(session + ':' + String(seq))
      return { kind: 'user', seq, content: [{ type: 'text', text: session + ' BODY' }] } as ConversationNodeLike
    }
    const mountWith = (value: string) => props({ data, convNodes: [], fetchContent, session: value })
    const m = await mount(h(Browser, mountWith('A')))
    await openFirstRow(m)
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('A BODY'))
    session = 'B'
    await m.update(h(Browser, mountWith('B')))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('B BODY'))
    assert.deepEqual(fetched, ['A:5', 'B:5'])
    await m.unmount()
  })

  test('a late fetch for an abandoned row never lands; the next row fetches its own seq', async () => {
    silenceFetchWarn()
    const deferreds: { resolve: (node: ConversationNodeLike | null) => void; reject: (reason: Error) => void }[] = []
    const fetchedFor: number[] = []
    const fetchContent = (seq: number): Promise<ConversationNodeLike | null> => {
      fetchedFor.push(seq)
      if (seq === 5) return new Promise((resolve, reject) => { deferreds.push({ resolve, reject }) })
      return Promise.resolve({ kind: 'user', seq, content: [{ type: 'text', text: 'BODY ' + String(seq) }] } as ConversationNodeLike)
    }
    let snap: { nodes?: readonly ConversationNodeLike[] } = { nodes: [] }
    const el = () => h(Browser, props({ data, convNodes: snap.nodes, fetchContent }))
    const m = await mount(el())
    await openFirstRow(m)
    assert.equal(deferreds.length, 1)
    await click(elemRows(m)[0])
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'))
    await act(async () => {
      deferreds[0]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'STALE BODY' }] })
    })
    assert.ok(!text(m.container).includes('STALE BODY'), 'stale result ignored')
    await click(elemRows(m)[1])
    await click(elemRows(m)[0])
    await flush()
    await act(async () => {
      deferreds[1]?.reject(new Error('gone'))
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'), 'stale rejection ignored')
    await click(elemRows(m)[1])
    await act(async () => {
      deferreds[2]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'BODY 5' }] })
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 5'))
    assert.deepEqual(fetchedFor, [5, 6, 5, 5], 'one call per miss (seq 6 stays cached)')
    snap = { nodes: [{ kind: 'user', seq: 5, content: [{ type: 'text', text: 'WINDOW BODY' }] }] }
    await m.update(el())
    assert.ok(text(query(m.container, '.lc-br-content')).includes('WINDOW BODY'))
    assert.ok(!text(m.container).includes('BODY 5'), 'the join takes precedence over the fetch cache')
    await m.unmount()
  })
})
})

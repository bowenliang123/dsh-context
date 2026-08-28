// ContextBrowser (src/client/components/browser.tsx) rendered with real
// React in jsdom: picker, category accordion, header content (schema
// narrowing matrix), conversation join (block cascade, tail-status matrix),
// targeted content fetch, hover linkage, and the focus bridges.

import assert from 'node:assert/strict'
import { act } from 'react'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeContextBrowser, type ContextBrowserProps } from '../../../src/client/components/browser'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import { UNKNOWN_TOOL_SOURCE, type ContextHeaders, type ContextTimeline, type RequestRecord, type SurfaceNode } from '../../../src/shared/types'
import type { ConversationNodeLike, ImageLoader, UseSessionLike } from '../../../src/client/services'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover, type Mounted } from '../helpers/kit'

const kit = makeKit()
const Browser = makeContextBrowser(kit, makeStackedBar(kit))

// Category row order is CATS: system, tools, user, inject, assistant, tool.
const ROW = { system: 0, tools: 1, user: 2, inject: 3, assistant: 4, tool: 5 } as const

function tl(over: Partial<ContextTimeline>): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 },
    requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    ...over,
  }
}

function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    time: 1_000, seq: 1, turn: 1, step: 0,
    system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...over,
  }
}

function node(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

/** A REAL tiny selector over an in-memory snapshot — the documented UseSessionLike contract. */
function sess(snap: { nodes?: readonly ConversationNodeLike[] }): UseSessionLike {
  return (sel) => sel(snap)
}

interface Snap { nodes?: readonly ConversationNodeLike[] }

/** Same contract, but re-reads the snapshot on every render (join tests mutate it). */
function liveSess(get: () => Snap): UseSessionLike {
  return (sel) => sel(get())
}

function catRow(m: Mounted, cat: keyof typeof ROW): HTMLElement {
  return queryAll(m.container, '.lc-br-cat-row')[ROW[cat]]
}

function elemRows(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-br-elem-row')
}

/** Type into the tool-schema search box like a real user (native setter + input event). */
async function typeToolSearch(m: Mounted, value: string): Promise<void> {
  await act(async () => {
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pickStep(m: Mounted, value: string): Promise<void> {
  const sel = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
  await act(async () => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function props(over: Partial<ContextBrowserProps>): ContextBrowserProps {
  return { data: tl({}), headers: null, ...over }
}

describe('ContextBrowser live surface', () => {
  test('title, picker, live meta, category rows; empty categories stay shut', async () => {
    const data = tl({
      current: { system: 100, tools: 200, user: 50, inject: 0, assistant: 0, tool: 0, total: 350 },
      requests: [
        req({ seq: 10, turn: 1, step: 0 }),
        req({ seq: 20, turn: 1, step: 1, prompt: 800 }),
        req({ seq: 7, time: 500, turn: undefined, step: undefined }),
      ],
      nodes: [node({ seq: 1, text: 'hello' })],
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(query(m.container, '.lc-card-title-text')).includes('Context Browser'))
    assert.ok(text(query(m.container, '.lc-br-hint')).includes('vs previous turn'))
    const sel = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(sel.value, 'live')
    const options = queryAll(sel, 'option').map(o => text(o))
    assert.equal(options.length, 4, 'live + one option per request')
    assert.equal(options[0], 'Live (Next Request)')
    assert.ok(options.some(o => o.includes('Turn 0 · Step 0')), 'requests without turn/step degrade to zeroes')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Live · Next Request'))
    assert.ok(meta.includes('Estimated ≈ 350'))
    assert.ok(!meta.includes('Actual Prompt'), 'no actual figure on the live surface')
    assert.equal(queryAll(m.container, '.lc-br-cat-row').length, 6)
    assert.ok(text(catRow(m, 'user')).includes('1 Items'))
    assert.ok(queryAll(m.container, '.lc-br-cat')[ROW.inject].className.includes('lc-br-cat-empty'), 'empty category is marked')
    // Picking the stamp-less request: meta degrades to zeroes, no baseline exists.
    await pickStep(m, '7')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 0 · Step 0'))
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0, 'no previous turn to compare against')
    await pickStep(m, 'live')
    await click(catRow(m, 'inject'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    assert.ok(queryAll(m.container, '.lc-br-pct').some(el => text(el).endsWith('%')))
    await m.unmount()
  })

  test('zero-total surface renders no percentages; no requests means no delta pills', async () => {
    const m = await mount(h(Browser, props({ data: tl({}) })))
    assert.ok(queryAll(m.container, '.lc-br-pct').every(el => text(el) === ''))
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 0)
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Estimated ≈ 0'))
    await m.unmount()
  })

  test('dropped live nodes raise the missing-window note, live and on later steps only', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 3, turn: 1, step: 0 }), req({ seq: 10, turn: 1, step: 1 })],
      nodes: [node({ seq: 6, text: 'served' })],
      droppedNodes: 2,
      surfaceFloor: 5,
      archiveFloor: 8,
    })
    const m = await mount(h(Browser, props({ data })))
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'), 'live flags the dropped tail')
    // Step before the floor: the dropped slice is not attributable → no note.
    await pickStep(m, '3')
    assert.ok(!text(m.container).includes('earlier messages are also part'))
    assert.ok(text(m.container).includes('approximate'), 'seq below the archive floor is approximate')
    // Step after the floor: the dropped slice is inside the context.
    await pickStep(m, '10')
    assert.ok(text(m.container).includes('2 earlier messages are also part of the context'))
    assert.ok(!text(m.container).includes('approximate'), 'seq at/after the archive floor is exact')
    await m.unmount()
  })

  test('step picking switches the assembled view; back-to-live restores the surface', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 30, inject: 0, assistant: 10, tool: 0, total: 40 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 25 }), req({ seq: 20, turn: 1, step: 1, user: 30, assistant: 10, prompt: 800 })],
      nodes: [node({ seq: 1, text: 'first question' }), node({ seq: 11, cat: 'assistant', tokens: 10, text: 'first answer' })],
      archive: [node({ seq: 0, tokens: 5, text: 'archived hello', gone: 15 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '10')
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(!meta.includes('Actual Prompt'), 'this step reported no usage')
    // The step's surface: archived node (gone 15 > 10) + seq 1; seq 11 is the response.
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 2, 'archived + live nodes reconstructed')
    assert.ok(text(m.container).includes('archived hello'))
    await pickStep(m, '20')
    const meta2 = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta2.includes('Turn 1 · Step 1'))
    assert.ok(meta2.includes('Actual Prompt 800'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'picking a step collapses the accordion')
    await pickStep(m, 'live')
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1, 'live excludes removed nodes')
    assert.ok(!text(m.container).includes('archived hello'))
    await m.unmount()
  })

  test('delta pills read against the previous turn’s last step; live reads the last request', async () => {
    const data = tl({
      current: { system: 1, tools: 2, user: 99, inject: 0, assistant: 0, tool: 0, total: 102 },
      requests: [
        req({ seq: 1, turn: 1, step: 0, system: 1, tools: 2, user: 10, total: 13 }),
        req({ seq: 2, turn: 1, step: 1, system: 1, tools: 2, user: 20, total: 23 }),
        req({ seq: 3, turn: 2, step: 0, system: 1, tools: 2, user: 30, total: 33 }),
        req({ seq: 4, turn: 2, step: 1, system: 1, tools: 2, user: 40, total: 43 }),
        req({ seq: 5, turn: 3, step: 0, system: 1, tools: 2, user: 50, total: 53 }),
      ],
      nodes: [1, 2, 3, 4, 5].map(seq => node({ seq, tokens: seq })),
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '4')
    const countPills = queryAll(m.container, '.lc-br-delta')
    assert.equal(countPills.length, 1, 'only the user count changed')
    assert.equal(text(countPills[0]), '+2')
    assert.ok(countPills[0].className.includes('lc-br-delta-up'))
    const tokenPills = queryAll(m.container, '.lc-br-tdelta')
    assert.equal(tokenPills.length, 1)
    assert.equal(text(tokenPills[0]), '+20')
    // First turn: no previous-turn baseline → no pills at all.
    await pickStep(m, '1')
    assert.equal(queryAll(m.container, '.lc-br-delta').length, 0)
    assert.equal(queryAll(m.container, '.lc-br-tdelta').length, 0)
    // Live: baseline is the most recent request.
    await pickStep(m, 'live')
    assert.equal(text(query(m.container, '.lc-br-delta')), '+1')
    assert.equal(text(query(m.container, '.lc-br-tdelta')), '+49')
    await m.unmount()
  })

  test('shrinking categories render downward pills', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 15, inject: 0, assistant: 0, tool: 0, total: 15 },
      requests: [
        req({ seq: 2, turn: 1, step: 1, user: 25, total: 25 }),
        req({ seq: 3, turn: 2, step: 0, user: 15, total: 15 }),
      ],
      nodes: [node({ seq: 1, tokens: 10, text: 'kept' })],
      archive: [node({ seq: 0, tokens: 15, text: 'pruned away', gone: 3 })],
    })
    const m = await mount(h(Browser, props({ data })))
    await pickStep(m, '3')
    const countPill = query(m.container, '.lc-br-delta')
    assert.equal(text(countPill), '-1', 'the archived node left the step’s surface')
    assert.ok(countPill.className.includes('lc-br-delta-down'))
    const tokenPill = query(m.container, '.lc-br-tdelta')
    assert.equal(text(tokenPill), '-10')
    assert.ok(tokenPill.className.includes('lc-br-tdelta-down'))
    await m.unmount()
  })

  test('hover linkage: category rows report hovers and mirror the shared key while live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10 })],
      nodes: [node({ seq: 1, text: 'hi' })],
    })
    const hovers: (string | null)[] = []
    const el = h(Browser, props({ data, hoverKey: null, onHoverKey: (k) => { hovers.push(k) } }))
    const m = await mount(el)
    await hover(catRow(m, 'user'))
    await unhover(catRow(m, 'user'))
    assert.deepEqual(hovers, ['user', null])
    // Mirrored hover lights the row; the 'free' key has no category row.
    await m.update(h(Browser, props({ data, hoverKey: 'user', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.update(h(Browser, props({ data, hoverKey: 'free', onHoverKey: (k) => { hovers.push(k) } })))
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    // A picked step has a different composition: the linkage drops.
    await pickStep(m, '10')
    const before = hovers.length
    await hover(catRow(m, 'user'))
    assert.equal(hovers.length, before, 'no hover reporting while a step is shown')
    assert.ok(!catRow(m, 'user').className.includes('lc-br-cat-on'))
    await m.unmount()

    // No hoverKey wiring at all: hovering is a no-op.
    const m2 = await mount(h(Browser, props({ data })))
    await hover(catRow(m2, 'user'))
    await m2.unmount()
  })

  test('previewSeq transiently shows a step; unknown preview/pin seqs fall back to live', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, assistant: 0, tool: 0, total: 10 },
      requests: [req({ seq: 10, turn: 1, step: 0, user: 10, total: 10, prompt: 700 })],
      nodes: [node({ seq: 1, text: 'hi' })],
    })
    const m = await mount(h(Browser, props({ data, previewSeq: 10 })))
    const meta = text(query(m.container, '.lc-br-meta'))
    assert.ok(meta.includes('Turn 1 · Step 0'))
    assert.ok(meta.includes('Preview'))
    assert.ok(meta.includes('Actual Prompt 700'))
    // Unknown preview seq: no request matches → live surface.
    await m.update(h(Browser, props({ data, previewSeq: 999 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    // A pinned step trimmed out of retention falls back to live too.
    await m.update(h(Browser, props({ data, previewSeq: null, pinSeq: 999 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    await m.unmount()
  })
})

describe('ContextBrowser header epochs', () => {
  const HEADERS: ContextHeaders = {
    headers: [
      { seq: 15, time: 1500, system: 'SYS A', tools: [{ name: 'old', tokens: 1 }] },
      { seq: 35, time: 3500, system: 'SYS B\nsecond line', tools: [{ name: 'fresh', tokens: 9, description: 'fresh tool' }] },
    ],
  }

  test('system category opens its prompt row directly; rich switch toggles raw/markdown', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, headers: HEADERS })))
    await click(catRow(m, 'system'))
    const body = query(m.container, '.lc-br-body')
    assert.ok(text(body).includes('SYS B'), 'the newest epoch’s prompt shows on the live surface')
    assert.ok(text(body).includes('2 lines'), 'line count rides the section head')
    // The single system row is already expanded.
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1)
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown view by default')
    const rawBtn = queryAll(m.container, '.lc-rich-seg-btn')[0]
    assert.equal(text(rawBtn), 'Raw')
    await click(rawBtn)
    const lines = queryAll(m.container, '.lc-ts-line').map(line => line.textContent)
    assert.deepEqual(lines, ['SYS B', 'second line'])
    await click(queryAll(m.container, '.lc-rich-seg-btn')[1])
    assert.ok(queryAll(m.container, '.lc-ts-desc-md').length >= 1, 'markdown restored')
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0)
    await m.unmount()
  })

  test('a past step reads the epoch in force at its seq', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 20, turn: 1, step: 0 }), req({ seq: 40, turn: 1, step: 1 })],
    })
    const m = await mount(h(Browser, props({ data, headers: HEADERS })))
    await pickStep(m, '20')
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('SYS A'), 'epoch before the request applies')
    await m.unmount()
  })

  test('absent headers projection degrades to the tokens-only note', async () => {
    const data = tl({ current: { system: 30, tools: 9, user: 0, inject: 0, assistant: 0, tool: 0, total: 39 } })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('older plugin build'))
    await click(catRow(m, 'tools'))
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('older plugin build'))
    await m.unmount()
  })

  test('an epoch outside retention degrades to the no-epoch note', async () => {
    const data = tl({
      current: { system: 30, tools: 9, user: 0, inject: 0, assistant: 0, tool: 0, total: 39 },
      requests: [req({ seq: 10, turn: 1, step: 0 })],
    })
    const m = await mount(h(Browser, props({ data, headers: HEADERS })))
    await pickStep(m, '10')
    await click(catRow(m, 'system'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('outside retention'))
    await click(catRow(m, 'tools'))
    assert.ok(text(queryAll(m.container, '.lc-br-body')[0]).includes('outside retention'))
    await m.unmount()
  })

  test('an epoch without a system prompt keeps the system category shut', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, tools: [{ name: 'x', tokens: 1 }] }] }
    const data = tl({ current: { system: 0, tools: 1, user: 0, inject: 0, assistant: 0, tool: 0, total: 1 } })
    const m = await mount(h(Browser, props({ data, headers })))
    assert.ok(text(catRow(m, 'system')).includes('0 Items'))
    await click(catRow(m, 'system'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'no prompt, no body')
    await m.unmount()
  })
})

describe('ContextBrowser tool schemas', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, system: 'SYS',
      tools: [
        // Producer order is NOT meaningful: rows re-rank by token price.
        { name: 'omega', tokens: 5, plugin: 'mcp:github' },
        { name: 'rho', tokens: 6, schema: 'nope' },
        { name: 'theta', tokens: 8, schema: { type: 'object', properties: null } },
        { name: 'zeta', tokens: 10, schema: { type: 'object' } },
        { name: 'epsilon', tokens: 20, schema: { type: 'object', properties: { z: { type: 'integer' } } } },
        { name: 'delta', tokens: 30, schema: { parameters: 'junk', input_schema: { properties: { y: { type: 'integer' } } } } },
        { name: 'gamma', tokens: 40, schema: { inputSchema: { properties: 'nope' } } },
        { name: 'beta', tokens: 50, schema: { input_schema: { properties: { x: { type: 'string' } } } } },
        {
          name: 'mega', tokens: 100, description: 'does everything',
          schema: {
            name: 'mega',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'string', description: 'the a param' },
                b: { type: 'object', properties: { x: {}, y: {} } },
                c: { type: 'array', items: { type: 'number' } },
                d: { type: 'array' },
                d2: { type: 'array', items: null },
                e: { type: 'string', enum: ['x', 'y'] },
                e2: { type: 'string', enum: [] },
                f: { enum: [1, 2] },
                g: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                h: { oneOf: [{ type: 'boolean' }] },
                i: { anyOf: [null, { type: 'string' }] },
                j: { anyOf: [] },
                k: { anyOf: [42, null] },
                l: { type: 'object', properties: {} },
                m: { type: 'object', properties: null },
                n: { type: 'object', properties: 42 },
                o: 'not-an-object',
                p: { description: 42 },
                q: { description: '' },
              },
              required: ['a', 42],
            },
          },
        },
      ],
    }],
  }
  const data = tl({ current: { system: 10, tools: 248, user: 0, inject: 0, assistant: 0, tool: 0, total: 258 } })

  test('rows rank by token price; the schema narrowing matrix renders', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    assert.equal(rows.length, 9)
    assert.deepEqual(rows.map(r => text(query(r, '.lc-br-preview'))),
      ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])

    // mega: the full parameter matrix.
    await click(rows[0])
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('does everything'), 'description section renders')
    const paramRows = queryAll(content, '.lc-ts-param-row')
    assert.equal(paramRows.length, 18, 'one row per object-valued property')
    const byName = (n: string) => paramRows.find(r => text(query(r, '.lc-ts-param-name')) === n)
    const typeOf = (n: string) => text(query(byName(n) as HTMLElement, '.lc-ts-param-type'))
    assert.equal(typeOf('a'), 'string')
    assert.equal(typeOf('b'), 'object{2}')
    assert.equal(typeOf('c'), 'array<number>')
    assert.equal(typeOf('d'), 'array')
    assert.equal(typeOf('d2'), 'array')
    assert.equal(typeOf('e'), 'string (enum)')
    assert.equal(typeOf('e2'), 'string')
    assert.equal(typeOf('f'), '(enum)')
    assert.equal(typeOf('g'), 'string | number')
    assert.equal(typeOf('h'), 'boolean')
    assert.equal(typeOf('i'), 'string')
    assert.equal(typeOf('j'), 'unknown')
    assert.equal(typeOf('k'), 'unknown')
    assert.equal(typeOf('l'), 'object')
    assert.equal(typeOf('m'), 'object')
    assert.equal(typeOf('n'), 'object')
    assert.equal(typeOf('p'), 'unknown')
    assert.equal(text(query(byName('a') as HTMLElement, '.lc-ts-param-req')), '✓')
    assert.equal(text(query(byName('b') as HTMLElement, '.lc-ts-param-req-off')), '·')
    assert.ok(text(byName('a') as HTMLElement).includes('the a param'))
    assert.equal(queryAll(byName('p') as HTMLElement, '.lc-ts-param-desc').length, 0, 'non-string description hidden')
    assert.equal(queryAll(byName('q') as HTMLElement, '.lc-ts-param-desc').length, 0, 'empty description hidden')
    assert.ok(text(content).includes('Parameters'))

    const toggle = query(content, '.lc-ts-json-toggle')
    assert.ok(text(toggle).includes('View Raw JSON'))
    await click(toggle)
    assert.ok(text(query(content, '.lc-ts-desc-body')).includes('"parameters"'))
    assert.ok(text(query(content, '.lc-ts-json-toggle')).includes('Collapse'))
    await click(query(content, '.lc-ts-json-toggle'))
    assert.equal(queryAll(content, 'pre').length, 0)
    await click(elemRows(m)[0])
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0)
    await m.unmount()
  })

  test('a text filter and the size/name sort narrow and re-rank the rows', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'tools'))
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by name, description, or parameters…')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.equal(sortBtns.length, 2)
    assert.ok(sortBtns[0].className.includes('lc-gran-on'), 'size is the default sort')
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))

    await typeToolSearch(m, 'gamma')
    assert.deepEqual(names(), ['gamma'])
    // The producer description matches: mega's 'does everything'.
    await typeToolSearch(m, 'everything')
    assert.deepEqual(names(), ['mega'])
    // The parameter JSON matches: 'the a param' lives in mega's schema.
    await typeToolSearch(m, 'the a param')
    assert.deepEqual(names(), ['mega'])
    // The plugin chip matches: omega carries mcp:github.
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    // No match degrades to a note; clearing restores every row.
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 9)

    // Name sort re-ranks alphabetically; size restores the token-price ranking.
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[0])
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])
    await m.unmount()
  })

  test('a hostile schema degrades the text filter, not the rows', async () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['self'] = cyclic
    const hostile: ContextHeaders = { headers: [{ seq: 1, time: 1, system: 'SYS', tools: [
      { name: 'loop', tokens: 3, schema: cyclic },
      { name: 'plain', tokens: 2 },
    ] }] }
    const m = await mount(h(Browser, props({ data, headers: hostile })))
    await click(catRow(m, 'tools'))
    assert.equal(elemRows(m).length, 2)
    // The name still matches; the unstringifiable schema contributes no text.
    await typeToolSearch(m, 'loop')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['loop'])
    // Searching schema-only text finds nothing here and shows the note.
    await typeToolSearch(m, 'properties')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await m.unmount()
  })

  test('schema nesting variants and the empty/degenerate arms', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    const open = async (name: string) => {
      const row = rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement
      await click(row)
      return query(m.container, '.lc-br-content')
    }
    // beta: input_schema nesting, no description.
    let body = await open('beta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    assert.ok(!text(body).includes('Description'), 'no description section without one')
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'beta') as HTMLElement)

    // gamma: inputSchema nesting with non-object properties → params empty.
    body = await open('gamma')
    assert.ok(text(body).includes('(no parameters)'))
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'gamma') as HTMLElement)

    // delta: a non-object `parameters` falls through to input_schema.
    body = await open('delta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'delta') as HTMLElement)

    // epsilon: bare-root object schema is itself the parameter object.
    body = await open('epsilon')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 1)
    assert.ok(text(body).includes('integer'))
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'epsilon') as HTMLElement)

    // zeta: object type without properties → no params section at all.
    body = await open('zeta')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 0)
    assert.ok(!text(body).includes('(no parameters)'))
    assert.ok(queryAll(body, '.lc-ts-json-toggle').length === 1, 'raw JSON still available')
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'zeta') as HTMLElement)

    // theta: null properties counts as a (bare) params object with no rows.
    body = await open('theta')
    assert.ok(text(body).includes('(no parameters)'))
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'theta') as HTMLElement)

    // rho: non-object schema → no params, JSON toggle shows the literal.
    body = await open('rho')
    assert.equal(queryAll(body, '.lc-ts-param-row').length, 0)
    await click(query(body, '.lc-ts-json-toggle'))
    assert.ok(text(query(body, 'pre')).includes('"nope"'))
    await click(elemRows(m).find(r => text(query(r, '.lc-br-preview')) === 'rho') as HTMLElement)

    // omega: no schema and no description → nothing behind the row.
    body = await open('omega')
    assert.equal(queryAll(body, '.lc-ts-json-toggle').length, 0)
    assert.equal(text(body), '')
    await m.unmount()
  })

  test('tool rows tag the registering plugin when attribution exists', async () => {
    const attributed: ContextHeaders = {
      headers: [{ seq: 1, time: 1, system: 'SYS', tools: [
        { name: 'write', tokens: 5, plugin: '@deepseek-ai/dsh-tool-fs' },
        { name: 'mcp__github__get_issue', tokens: 3, plugin: 'mcp:github' },
        { name: 'agent_teams_add_member', tokens: 2 }, // no attribution → no chip
        // Boot-predating tools arrive with the unknown sentinel → localized tag.
        { name: 'claim_files', tokens: 2, plugin: UNKNOWN_TOOL_SOURCE },
      ] }],
    }
    const data = tl({ current: { system: 0, tools: 10, user: 0, inject: 0, assistant: 0, tool: 0, total: 10 } })
    const m = await mount(h(Browser, props({ data, headers: attributed })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    assert.equal(rows.length, 4)
    const chips = queryAll(m.container, '.lc-br-tool-plugin')
    assert.equal(chips.length, 3, 'only attributed tools chip')
    assert.ok(text(chips[0]).includes('@deepseek-ai/dsh-tool-fs'))
    assert.ok(text(chips[1]).includes('mcp:github'))
    assert.ok((chips[0] as HTMLElement).title.includes('The registering plugin of this tool'), 'the chip carries the i18n tooltip')
    assert.ok(!text(rows[2]).includes('@'), 'unattributed tools stay untagged')
    // The unknown-source sentinel renders the localized tag with the
    // boot-timing explanation, never the raw sentinel string.
    assert.equal(chips[2].textContent, 'Unknown plugin')
    assert.ok((chips[2] as HTMLElement).title.includes('registered before the context plugin loaded'), 'unknown chips explain the boot gap')
    // Layout: the tool name leads the row, the plugin chip trails it directly
    // — one frame only, so `lc-br-tag` must not nest another `lc-br-tag`.
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'write', 'tool name leads')
    const chip = chips[0] as HTMLElement
    assert.equal(chip.previousElementSibling, query(rows[0], '.lc-br-preview'), 'plugin chip sits right after the tool name')
    assert.equal(chip.parentElement!.className, 'lc-br-elem-row', 'plugin chip is a single frame, a direct row child')
    assert.equal(queryAll(chip, '.lc-br-tag').length, 0, 'no nested tag wrapper')
    await m.unmount()
  })
})

describe('ContextBrowser message categories', () => {
  // One rich live surface exercising every NodeContent/BlocksBody branch.
  const convNodes: ConversationNodeLike[] = [
    // user with two images then text (image group flush mid-loop + trailing)
    { kind: 'user', seq: 1, content: [
      { type: 'image', attachment: { attachmentId: 'a1', name: 'one.png', bytes: 2048, width: 100, height: 50 } },
      { type: 'image', attachment: { attachmentId: 'a2' } },
      { type: 'text', text: 'with images' },
    ] },
    // user with text then one image
    { kind: 'user', seq: 2, content: [
      { type: 'text', text: 'one pic' },
      { kind: 'image', attachment: { attachmentId: 'a3' } },
    ] },
    // user without a content array → hint fallback
    { kind: 'user', seq: 5 },
    // assistant full block cascade
    { kind: 'assistant', seq: 68, blocks: [
      { kind: 'text', text: 'final answer' },
      { type: 'reasoning', text: 'thinking hard' },
      { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls","timeout":30,"opts":{"a":1}}' },
      { kind: 'tool-call', name: 'broken', argsRaw: 'not json' },
      { type: 'tool-call', arguments: '{"file_path":"x.ts"}' },
      { kind: 'tool-call', name: 'noargs' },
      { type: 'tool-result', content: [
        { type: 'text', text: 'inner result' },
        { type: 'image', attachment: { attachmentId: 'b1' } },
      ] },
      { type: 'tool-result', content: 'not-an-array' },
      { kind: 'image', attachment: { attachmentId: 'b2', name: 'pic.png', bytes: 4096, width: 640, height: 480 } },
      { type: 'mystery', foo: 1 },
      { type: 'text', text: 42 },
      'plain string block',
      { foo: 'bar' },
    ] },
    // assistant without blocks but with content (legacy shape)
    { kind: 'assistant', seq: 67, content: [{ type: 'text', text: 'legacy body' }] },
    // assistant summary sources
    { kind: 'assistant', seq: 62, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
    { kind: 'assistant', seq: 63, blocks: [{ kind: 'tool-call', name: 'read', argsRaw: '{}' }] },
    { kind: 'assistant', seq: 64, blocks: [{ kind: 'tool-call', name: 'edit', argsRaw: '{"path":"b.ts"}' }] },
    // compaction nodes
    { kind: 'compaction', seq: 70, summary: 'SUMMARY BODY' },
    { kind: 'compaction', seq: 71, summary: null },
    { kind: 'compaction', seq: 72, summary: '' },
    // inject join
    { kind: 'user', seq: 54, content: [{ type: 'text', text: 'relay body full' }] },
  ]

  const data = tl({
    current: { system: 0, tools: 0, user: 40, inject: 20, assistant: 60, tool: 30, total: 150 },
    nodes: [
      node({ seq: 1, tokens: 10, text: 'with images', time: 100 }),
      node({ seq: 2, tokens: 9, text: 'one pic', time: 200 }),
      node({ seq: 3, tokens: 5, text: 'fallback text', time: 300 }),
      node({ seq: 4, tokens: 4, text: '', time: 400 }),
      node({ seq: 5, tokens: 4, text: 'no content array', time: 500 }),
      node({ seq: 50, cat: 'inject', tokens: 5, form: 'snapshot', text: 'state' }),
      node({ seq: 51, cat: 'inject', tokens: 5, form: 'notice', text: 'heads up' }),
      node({ seq: 52, cat: 'inject', tokens: 5, skill: 'code-review', text: 'skill body' }),
      node({ seq: 53, cat: 'inject', tokens: 5, form: 'catalog' }),
      node({ seq: 55, cat: 'inject', tokens: 5, form: 'notice', text: '' }),
      node({ seq: 56, cat: 'inject', tokens: 5, text: 'no form' }),
      node({ seq: 54, cat: 'inject', tokens: 5, form: 'relay', text: 'relay body' }),
      node({ seq: 61, cat: 'assistant', tokens: 8, calls: ['bash', 'write'], text: 'done all' }),
      node({ seq: 62, cat: 'assistant', tokens: 8, calls: ['write'] }),
      node({ seq: 63, cat: 'assistant', tokens: 8, calls: ['read'] }),
      node({ seq: 64, cat: 'assistant', tokens: 8 }),
      node({ seq: 65, cat: 'assistant', tokens: 8 }),
      node({ seq: 66, cat: 'assistant', tokens: 8, calls: [], text: 'plain text' }),
      node({ seq: 67, cat: 'assistant', tokens: 8, text: 'legacy' }),
      node({ seq: 68, cat: 'assistant', tokens: 20, text: 'full cascade' }),
      node({ seq: 70, tokens: 6, text: 'summary node' }),
      node({ seq: 71, tokens: 6, text: '' }),
      node({ seq: 72, tokens: 6, text: 'empty summary' }),
    ],
  })

  const loadImage: ImageLoader = async (att) => {
    if (att.attachmentId === 'a3' || att.attachmentId === 'b1') throw new Error('denied')
    return 'blob:' + att.attachmentId
  }

  const mountBrowser = async (over: Partial<ContextBrowserProps> = {}) =>
    mount(h(Browser, props({ data, useSession: sess({ nodes: convNodes }), loadImage, ...over })))

  test('user rows: image chips on collapsed rows, join content, fallbacks', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    assert.equal(rows.length, 8, 'user + compaction nodes, newest first')
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'empty summary')
    // Image chips ride the collapsed row (seq 1 ×2, seq 2 ×1).
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    assert.ok(text(rowOf('with images')).includes('Image ×2'))
    assert.ok(text(rowOf('one pic')).includes('Image'))
    assert.ok(!text(rowOf('one pic')).includes('×'))
    // Open seq 1: the chip makes way for the grid; loader resolves two cards.
    await click(rowOf('with images'))
    await flush()
    let content = query(m.container, '.lc-br-content')
    assert.ok(!text(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement).includes('Image ×2'),
      'expanded row drops the chip')
    assert.ok(text(content).includes('Images'))
    const imgs = queryAll<HTMLImageElement>(content, '.lc-att-thumb img')
    assert.equal(imgs.length, 2, 'both loads resolved')
    assert.ok(imgs[0].src.includes('blob:a1'))
    assert.ok(text(content).includes('one.png'))
    assert.ok(text(content).includes('100×50'))
    await click(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement)

    // Open seq 2: single image, load REJECTS → error placeholder.
    await click(rowOf('one pic'))
    await flush()
    content = query(m.container, '.lc-br-content')
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.ok(text(query(content, '.lc-att-err')).includes('⚠'))
    await click(elemRows(m).find(r => text(r).includes('one pic')) as HTMLElement)

    // Join missed with preview text: content section + the window note.
    await click(rowOf('fallback text'))
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('fallback text'))
    assert.ok(text(content).includes('outside the loaded message window'))
    await click(elemRows(m).find(r => text(r).includes('fallback text')) as HTMLElement)

    // Join missed without text (seq 4, rows newest-first: 72,71,70,5,4,…): the note alone.
    assert.ok(text(rows[4]).includes('(non-text message)'))
    await click(rows[4])
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    assert.ok(!text(content).includes('Content'))
    await m.unmount()
  })

  test('user node whose conversation entry carries no content array shows the note', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    await click(elemRows(m).find(r => text(r).includes('no content array')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    await m.unmount()
  })

  test('message rows filter by tag and preview text; another category opens unfiltered', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by message text…')
    const previews = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    await typeToolSearch(m, 'summary')
    assert.deepEqual(previews(), ['empty summary', 'summary node'])
    // No match keeps the toolbar mounted so the filter can be cleared.
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(m.container).includes('No rows match the current filter'))
    assert.equal(queryAll(m.container, '.lc-br-tool-search').length, 1)
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 8)

    // The call-breadcrumb tag matches too (an assistant row's 'bash › write').
    await click(catRow(m, 'assistant'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '', 'another category opens unfiltered')
    await typeToolSearch(m, 'bash')
    assert.deepEqual(previews(), ['done all'])
    await m.unmount()
  })

  test('user images render a placeholder when no loader is wired', async () => {
    const m = await mountBrowser({ loadImage: undefined })
    await click(catRow(m, 'user'))
    await click(elemRows(m).find(r => text(r).includes('one pic')) as HTMLElement)
    assert.equal(queryAll(m.container, '.lc-att-ph').length, 1)
    await m.unmount()
  })

  test('assistant rows: preview cascade and the full block vocabulary', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const rows = elemRows(m)
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    assert.ok(text(rowOf('done all')).includes('bash › write'), 'call breadcrumb tag')
    assert.ok(text(rowOf('a.ts')).includes('write'), 'block summary previews a textless turn')
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      const preview = text(query(r, '.lc-br-preview'))
      return `${tag === null ? '∅' : text(tag)}|${preview}`
    })
    assert.ok(tags.includes('read|(empty reply)'), 'no self-summarizing call → empty marker')
    assert.ok(tags.includes('∅|b.ts'), 'textless turn previews the joined call summary')
    assert.ok(tags.includes('∅|(empty reply)'), 'no join, no calls → empty marker')
    assert.ok(tags.includes('∅|Calls '), 'empty call list previews as a bare Calls label (nodeText)')

    await click(rowOf('full cascade'))
    const content = query(m.container, '.lc-br-content')
    const heads = queryAll(content, '.lc-ts-card-head').map(el => text(el))
    assert.ok(heads.some(s => s.includes('Response')))
    assert.ok(heads.some(s => s.includes('Reasoning')))
    assert.ok(heads.some(s => s.includes('→ bash')))
    assert.ok(heads.some(s => s.includes('→ broken')))
    assert.ok(heads.some(s => s.includes('→ ?')), 'nameless call card')
    assert.ok(heads.some(s => s.includes('→ noargs')))
    assert.ok(heads.some(s => s.includes('Result')), 'nested tool-result text section')
    assert.ok(heads.filter(s => s.includes('Other content')).length === 5, 'unknown blocks render raw JSON')
    assert.ok(heads.some(s => s.includes('Images')))
    // Call arg rows: string, number and object values.
    const argVals = queryAll(content, '.lc-ts-arg-row').map(el => text(el))
    assert.ok(argVals.some(s => s.includes('command') && s.includes('ls')))
    assert.ok(argVals.some(s => s.includes('timeout') && s.includes('30')))
    assert.ok(argVals.some(s => s.includes('opts') && s.includes('{"a":1}')))
    // Unparseable args show raw; absent args show nothing.
    assert.ok(text(content).includes('not json'))
    assert.ok(text(content).includes('inner result'))
    await flush()
    // b1 rejects (error), b2 resolves.
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.equal(queryAll(content, '.lc-att-thumb img').length, 1)
    await m.unmount()
  })

  test('assistant with a legacy content array renders the generic content section', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    await click(elemRows(m).find(r => text(r).includes('legacy')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('Content'))
    assert.ok(text(content).includes('legacy body'))
    await m.unmount()
  })

  test('assistant without a join shows only the window note', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const row = elemRows(m).find(r => text(r).includes('(empty reply)') && !text(r).includes('read')) as HTMLElement
    await click(row)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    await m.unmount()
  })

  test('compaction nodes: summary text, null and empty summaries', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    // Newest first: 72 (empty summary), 71 (null summary), 70 (summary node).
    await click(rows[2])
    let content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('Summary'))
    assert.ok(text(content).includes('SUMMARY BODY'))
    // Null summary → empty body.
    await click(rows[1])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    // Empty-string summary → empty body.
    await click(rows[0])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    await m.unmount()
  })

  test('inject rows: form tags, snapshot prefix, skill injects', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'inject'))
    const rows = elemRows(m)
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('State Snapshot|Snapshot: state'))
    assert.ok(tags.includes('Notice|heads up'))
    assert.ok(tags.includes('∅|Skill: code-review'), 'skill injects keep the node-text label')
    assert.ok(tags.includes('Catalog Update|Catalog Update'), 'textless inject previews its form')
    assert.ok(tags.includes('Notice|Notice'), 'empty-string text keeps the form label')
    assert.ok(tags.includes('Context Injection|no form'), 'formless inject defaults to the context label')
    assert.ok(tags.includes('Agent Relay|relay body'))
    // Expanded inject joins the conversation content.
    await click(rows.find(r => text(r).includes('relay body')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('relay body full'))
    await m.unmount()
  })
})

describe('ContextBrowser tool results', () => {
  // The tail-status matrix: dsh settles failing commands as completed calls,
  // so trailing markers are the failure signal.
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
    // Fold-stamped failure without any marker.
    { kind: 'tool-result', seq: 91, call: { name: 'read', argsRaw: '{}' }, content: [{ type: 'text', text: 'denied' }], isError: true },
    // No call record → no call card.
    { kind: 'tool-result', seq: 92, call: null, content: [{ type: 'text', text: 'orphan' }] },
    // Content that is not an array → no body sections.
    { kind: 'tool-result', seq: 93, call: { name: 'bash', argsRaw: '' }, content: 'raw-text' as never },
  )
  const nodes: SurfaceNode[] = [
    ...cases.map(c => node({ seq: c.seq, cat: 'tool', tokens: 9, tool: 'bash' })),
    node({ seq: 91, cat: 'tool', tokens: 9, tool: 'read' }),
    node({ seq: 92, cat: 'tool', tokens: 9, tool: 'bash' }),
    node({ seq: 93, cat: 'tool', tokens: 9, tool: 'bash' }),
    // Fold-stamped err flag, no join.
    node({ seq: 94, cat: 'tool', tokens: 9, tool: 'write', err: true }),
    // No join at all → placeholder preview; missing tool name → '?'.
    node({ seq: 95, cat: 'tool', tokens: 9, tool: 'bash' }),
    node({ seq: 96, cat: 'tool', tokens: 9 }),
    // A skill result is labeled by skill name.
    node({ seq: 97, cat: 'tool', tokens: 9, tool: 'skill', skill: 'grilling' }),
  ]
  convNodes.push({ kind: 'tool-result', seq: 97, call: { name: 'skill', argsRaw: '{"description":"grill the plan"}' }, content: [{ type: 'text', text: 'skill body' }] })

  const data = tl({
    current: { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 162, total: 162 },
    nodes,
  })

  test('tail-status matrix drives the error dot; tags and previews render on collapsed rows', async () => {
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: convNodes }) })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    assert.equal(rows.length, nodes.length)
    // Dot presence per case (collapsed rows): every marker failure + the two
    // fold-stamped failures (isError, err flag) — nothing else.
    const dots = queryAll(m.container, '.lc-br-err-dot')
    assert.equal(dots.length, 9, 'one red dot per failing result')
    // Newest-first order: rows[0] is seq 97 (skill), then 96, 95, 94, 93, ...
    assert.ok(text(rows[0]).includes('Skill · grilling'), 'skill results label by name')
    assert.ok(text(rows[0]).includes('grill the plan'), 'call summary previews')
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
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: convNodes }) })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    // Newest first: index map by seq (97, 96, 95, 94, 93, 92, 91, 90..80).
    const byIdx = Object.fromEntries([97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80].map((s, i) => [s, i]))
    const expand = async (seq: number) => {
      await click(rows[byIdx[seq]])
      return query(m.container, '.lc-br-content')
    }
    let content = await expand(89)
    assert.ok(text(content).includes('OK'))
    assert.ok(!queryAll(content, '.lc-br-err-dot').length)
    await click(elemRows(m)[byIdx[89]])
    // Exit-code failure with the pill.
    content = await expand(80)
    assert.ok(text(content).includes('Failed · exit 3'))
    await click(elemRows(m)[byIdx[80]])
    // Killed by signal: failure without an exit code.
    content = await expand(81)
    assert.ok(text(content).includes('Failed'))
    assert.ok(!text(content).includes('exit'))
    await click(elemRows(m)[byIdx[81]])
    // Shell killed after a failing command: the command's code wins.
    content = await expand(86)
    assert.ok(text(content).includes('Failed · exit 7'))
    await click(elemRows(m)[byIdx[86]])
    // Orphan result: no call card, but the result body renders.
    content = await expand(92)
    assert.ok(!text(content).includes('→'), 'no call card without a call record')
    assert.ok(text(content).includes('orphan'))
    await click(elemRows(m)[byIdx[92]])
    // Non-array content: call card only.
    content = await expand(93)
    assert.ok(text(content).includes('OK'))
    assert.ok(!text(content).includes('raw-text'))
    await m.unmount()
  })
})

describe('ContextBrowser targeted content fetch', () => {
  const data = tl({
    current: { system: 0, tools: 0, user: 10, inject: 0, assistant: 0, tool: 0, total: 10 },
    nodes: [node({ seq: 5, tokens: 5, text: 'pageable' }), node({ seq: 6, tokens: 5, text: 'also pageable' })],
  })

  const openFirstRow = async (m: Mounted) => {
    await click(catRow(m, 'user'))
    await click(elemRows(m)[1]) // seq 5 (newest first: 6, 5)
  }

  test('a missed join fetches the seq once, and the fetched body renders', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const fetchContent = async (seq: number) => {
      calls += 1
      return new Promise<void>((resolve) => { release = resolve })
        .then(() => ({ kind: 'user', seq, content: [{ type: 'text', text: 'FULL BODY' }] }) as ConversationNodeLike)
    }
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: [] }), fetchContent })))
    await openFirstRow(m)
    assert.equal(calls, 1, 'one targeted read')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('Loading full content from older session history'), 'in-flight note')
    await act(async () => { release?.() })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('FULL BODY'))
    // Close and reopen the same row: the fetched node is merged state — no re-read.
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
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: [] }), fetchContent })))
    await openFirstRow(m)
    await flush()
    assert.equal(calls, 1)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('not in the session log anymore'))
    await m.unmount()
  })

  test('a failed read arms the retry button; retrying succeeds', async () => {
    let calls = 0
    const fetchContent = async (seq: number) => {
      calls += 1
      if (calls === 1) throw new Error('transport down')
      return { kind: 'user', seq, content: [{ type: 'text', text: 'RETRY BODY' }] } as ConversationNodeLike
    }
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: [] }), fetchContent })))
    await openFirstRow(m)
    await flush()
    const failed = query(m.container, '.lc-br-content')
    assert.ok(text(failed).includes('Load failed'))
    await click(query(failed, '.lc-br-retry'))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('RETRY BODY'))
    assert.equal(calls, 2)
    await m.unmount()
  })

  test('without a fetcher (older host) an un-joined row keeps the static note', async () => {
    const m = await mount(h(Browser, props({ data, useSession: sess({ nodes: [] }) })))
    await openFirstRow(m)
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('outside the loaded message window'))
    await m.unmount()
  })

  test('a late fetch for an abandoned row never lands; the next row fetches its own seq', async () => {
    const deferreds: { resolve: (node: ConversationNodeLike | null) => void; reject: (reason: Error) => void }[] = []
    const fetchedFor: number[] = []
    const fetchContent = (seq: number): Promise<ConversationNodeLike | null> => {
      fetchedFor.push(seq)
      if (seq === 5) return new Promise((resolve, reject) => { deferreds.push({ resolve, reject }) })
      return Promise.resolve({ kind: 'user', seq, content: [{ type: 'text', text: 'BODY ' + String(seq) }] } as ConversationNodeLike)
    }
    let snap: Snap = { nodes: [] }
    const el = () => h(Browser, props({ data, useSession: liveSess(() => snap), fetchContent }))
    const m = await mount(el())
    await openFirstRow(m) // seq 5 hangs in flight
    assert.equal(deferreds.length, 1)
    await click(elemRows(m)[0]) // switch to seq 6 while seq 5 is pending
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'))
    // The abandoned promise settles after the row was left — both outcomes are ignored.
    await act(async () => {
      deferreds[0]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'STALE BODY' }] })
    })
    assert.ok(!text(m.container).includes('STALE BODY'), 'stale result ignored')
    await click(elemRows(m)[1]) // seq 5 again: another deferred hangs
    await click(elemRows(m)[0])
    await flush()
    await act(async () => {
      deferreds[1]?.reject(new Error('gone'))
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'), 'stale rejection ignored')
    // Reopening seq 5 renders once its own fetch settles.
    await click(elemRows(m)[1])
    await act(async () => {
      deferreds[2]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'BODY 5' }] })
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 5'))
    assert.deepEqual(fetchedFor, [5, 6, 5, 5], 'one call per miss (seq 6 stays cached)')
    // The conversation window catching up later wins over fetched state.
    snap = { nodes: [{ kind: 'user', seq: 5, content: [{ type: 'text', text: 'WINDOW BODY' }] }] }
    await m.update(el())
    assert.ok(text(query(m.container, '.lc-br-content')).includes('WINDOW BODY'))
    assert.ok(!text(m.container).includes('BODY 5'), 'the join takes precedence over the fetch cache')
    await m.unmount()
  })
})

describe('ContextBrowser focus bridges', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, system: 'SYS',
      tools: [
        { name: 'beta', tokens: 50, description: 'the beta tool', schema: { input_schema: { properties: { x: { type: 'string' } } } } },
        { name: 'alpha', tokens: 10, description: 'the alpha tool' },
      ],
    }],
  }
  const data = tl({
    current: { system: 10, tools: 60, user: 10, inject: 0, assistant: 0, tool: 0, total: 80 },
    requests: [req({ seq: 10, turn: 1, step: 0, total: 80 }), req({ seq: 20, turn: 1, step: 1, total: 80 })],
    nodes: [node({ seq: 1, tokens: 5, text: 'focusable' }), node({ seq: 11, cat: 'assistant', tokens: 5, text: 'answer' })],
  })
  const convNodes: ConversationNodeLike[] = [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'focusable' }] }]

  test('nodeFocus selects the step, opens the node, scrolls it into view, and clears', async () => {
    const scrolls: unknown[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolls.push(arg) } as never
    try {
      let handled = 0
      const m = await mount(h(Browser, props({ data, headers, useSession: sess({ nodes: convNodes }) })))
      await m.update(h(Browser, props({
        data, headers, useSession: sess({ nodes: convNodes }),
        nodeFocus: { step: 'live', seq: 1, cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.equal(handled, 1)
      const onRows = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(onRows.length, 1)
      assert.ok(text(onRows[0]).includes('focusable'))
      assert.deepEqual(scrolls, [{ block: 'nearest' }], 'the open row scrolled into view')
      // A step focus switches the assembled view.
      await m.update(h(Browser, props({
        data, headers, useSession: sess({ nodes: convNodes }),
        nodeFocus: { step: 20, seq: 1, cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 1'))
      assert.equal(handled, 2)
      // A node outside the assembled surface leaves nothing to scroll to.
      await m.update(h(Browser, props({
        data, headers, useSession: sess({ nodes: convNodes }),
        nodeFocus: { step: 'live', seq: 999, cat: 'user' },
      })))
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0)
      await m.unmount()
    } finally {
      Element.prototype.scrollIntoView = orig
    }
  })

  test('pinSeq selects the pinned step and unpinning returns to live (accordion resets)', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'user'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 1)
    await m.update(h(Browser, props({ data, headers, pinSeq: 10 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 0'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'pinning resets the accordion')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '10')
    await m.update(h(Browser, props({ data, headers, pinSeq: null })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    await m.unmount()
  })
})

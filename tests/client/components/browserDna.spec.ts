import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextBrowserProps } from '../../../src/client/components/browser'
import type { ContextHeaders } from '../../../src/shared/types'
import { click, flush, hover, mount, query, queryAll, surfaceNode, text, tipRows, unhover, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, kit, props, req, tl, typeToolSearch, withEpochContent } from './browserHarness'

describe('ContextBrowser DNA mode and the open-category bar pin', () => {
  const dnaHeaders: ContextHeaders = {
    headers: [{
      seq: 1, time: 1000, systemTokens: 100,
      tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 25 }],
    }],
  }
  const dnaData = tl({
    current: { system: 100, tools: 75, user: 20, inject: 10, skill: 0, assistant: 40, tool: 30, total: 275 },
    requests: [req({ seq: 20, turn: 1, step: 0, system: 100, tools: 75, user: 20, inject: 0, assistant: 40, tool: 30, total: 265 })],
    nodes: [
      surfaceNode({ seq: 2, tokens: 20, time: 2000, text: 'hi' }),
      surfaceNode({ seq: 3, cat: 'tool', tokens: 30, time: 3000, tool: 'bash' }),
      surfaceNode({ seq: 4, cat: 'assistant', tokens: 40 }),
      surfaceNode({ seq: 5, cat: 'inject', tokens: 10, form: 'notice' }),
    ],
  })

  function dnaButton(m: Mounted): HTMLElement {
    return query(m.container, '.lc-br-dna-ctl .lc-gran-btn')
  }

  function bands(m: Mounted): HTMLElement[] {
    return queryAll(m.container, '.lc-stacked-seg')
  }

  test('the DNA toggle is parent-linked when both props arrive; a lone prop is ignored', async () => {
    // Linked on: the bar redraws and the button reflects the parent's state without a click.
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders, dna: true, onDnaChange: () => {} })))
    assert.equal(bands(m).length, 7)
    assert.ok(dnaButton(m).className.includes('lc-gran-on'))
    // A lone `dna` prop without the handler does NOT link: the mount-local toggle still rules.
    await m.update(h(Browser, props({ data: dnaData, headers: dnaHeaders, dna: true })))
    assert.equal(bands(m).length, 6, 'unlinked: the local toggle is off')
    // The click reports to the parent instead of flipping local state; the bar follows the prop.
    const calls: boolean[] = []
    await m.update(h(Browser, props({
      data: dnaData, headers: dnaHeaders, dna: true,
      onDnaChange: (on) => { calls.push(on) },
    })))
    await click(dnaButton(m))
    assert.deepEqual(calls, [false])
    assert.equal(bands(m).length, 7, 'still on until the parent re-renders the prop')
    await m.unmount()
  })

  test('the toggle redraws the composition bar as one band per item, in prompt order', async () => {    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    // Category mode: one segment per category in CATS order, pick cursor off, tooltip slot unmounted.
    assert.equal(bands(m).length, 6)
    const normal = bands(m).map(seg => seg.style.width)
    assert.deepEqual(normal, [100, 75, 20, 10, 40, 30].map(v => `${v / 275 * 100}%`))
    assert.ok(!bands(m)[0].className.includes('lc-stacked-seg-pick'))
    assert.ok(!query(m.container, '.lc-br-bar').className.includes('lc-br-bar-dna'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0)

    const btn = dnaButton(m)
    assert.equal(text(btn), 'DNA Mode')
    assert.equal(query(m.container, '.lc-br-dna-ctl').getAttribute('title'), kit.t('browser.dnaTip'))
    await click(btn)
    // Prompt order: the system prompt, the two tool schemas in producer order, then the message flow by seq —
    // NOT the fold's category order and NOT the header event's bookkeeping seq (see dna.ts).
    const segs = bands(m)
    assert.equal(segs.length, 7)
    assert.deepEqual(segs.map(seg => seg.style.width), [100, 50, 25, 20, 30, 40, 10].map(v => `${v / 275 * 100}%`))
    assert.ok(segs.every(seg => seg.className.includes('lc-stacked-seg-pick')))
    assert.ok(query(m.container, '.lc-br-bar').className.includes('lc-br-bar-dna'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 1, 'the per-item tooltip slot mounts')
    assert.ok(btn.className.includes('lc-gran-on'))

    await click(btn)
    assert.equal(bands(m).length, 6, 'toggling off restores the category composition')
    assert.ok(!btn.className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('band hover floats the per-item tooltip locally; a mirrored category key lights that category\'s bands', async () => {
    const hovers: (string | null)[] = []
    const wired = (hoverKey: string | null) => h(Browser, props({ data: dnaData, headers: dnaHeaders, hoverKey, onHoverKey: (k) => { hovers.push(k) } }))
    const m = await mount(wired(null))
    await click(dnaButton(m))

    // A band hover is LOCAL: the tooltip names the item (category label + join time); nothing reports upward.
    await hover(bands(m)[3])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), [`User Messages · ${kit.fmtTime(2000)}`, '≈20 · 7% of used context', null])
    assert.deepEqual(hovers, [], 'DNA hovers stay on the bar — the overview keeps showing the live category composition')
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    // A node without a logged time shows the bare label.
    await hover(bands(m)[5])
    assert.deepEqual(tipRows(tip), ['Assistant Messages', '≈40 · 15% of used context', null])
    await unhover(query(m.container, '.lc-stacked'))
    assert.ok(!tip.className.includes('lc-bar-tip-on'))

    // The incoming category mirror still works: the open category's bands light as a group (no tooltip for a mirrored hover).
    await m.update(wired('tool'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false, false])
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    await m.update(wired('free'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')), "the overview's free key lights nothing here")
    await m.unmount()
  })

  test('band labels: skill tag, nameless tool result, formless injection; a header-less surface shows message bands only', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 40, skill: 0, assistant: 0, tool: 20, total: 60 },
      nodes: [
        surfaceNode({ seq: 1, cat: 'inject', tokens: 10, skill: 'code' }),
        surfaceNode({ seq: 2, cat: 'tool', tokens: 20 }),
        surfaceNode({ seq: 3, cat: 'inject', tokens: 30 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(dnaButton(m))
    assert.equal(bands(m).length, 3)
    const tip = query(m.container, '.lc-bar-tip')
    await hover(bands(m)[0])
    assert.deepEqual(tipRows(tip), ['Skill · code', '≈10 · 17% of used context', null])
    await hover(bands(m)[1])
    assert.deepEqual(tipRows(tip), ['?', '≈20 · 33% of used context', null])
    await hover(bands(m)[2])
    assert.deepEqual(tipRows(tip), ['Context Injection', '≈30 · 50% of used context', null])
    await m.unmount()
  })

  test('the DNA list reads the newest message first, the prompt prefix keeping its seat; the filter scans what the rows show', async () => {
    const lazy = withEpochContent(dnaHeaders, {
      1: { system: 'You are a helpful assistant.', tools: [{ name: 'bash', description: 'run a shell command', schema: {} }, { name: 'write', schema: {} }] },
    })
    const m = await mount(h(Browser, props({ data: dnaData, ...lazy })))
    await click(dnaButton(m))
    await flush()
    const list = query(m.container, '.lc-br-dna-list')
    // The epoch's tool schemas arrive folded into one group, so only the system prompt and the messages are rows.
    assert.equal(elemRows(m).length, 5)
    const fold = query(list, '.lc-br-fold')
    assert.ok(text(fold).includes(kit.catLabel('tools')), 'the group carries the tool-schemas type tag')
    assert.ok(text(fold).includes(kit.t('browser.items', { n: 2 })), 'the folded group counts its schemas')
    assert.ok(!text(fold).includes('bash'), 'no schema row renders while folded')
    // Unfolded: one row per band — the system prompt and the two tool schemas in producer order, then the message
    // flow NEWEST first (the category view's own order) — NOT the fold's category order.
    await click(fold)
    assert.equal(elemRows(m).length, 7)
    const previews = elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.ok(previews[0].includes('helpful assistant'))
    assert.deepEqual(previews.slice(1, 3), ['bash', 'write'])
    assert.ok(text(elemRows(m)[6]).includes('hi'), 'the oldest message closes the list')
    assert.ok(text(elemRows(m)[5]).includes('bash'), 'the tool result keeps its tool tag')
    // Every row annotates itself with its type — the category view's dot+label.
    const types = elemRows(m).map(r => text(query(r, '.lc-br-type')))
    assert.deepEqual(types, [
      kit.catLabel('system'), kit.catLabel('tools'), kit.catLabel('tools'),
      kit.catLabel('inject'), kit.catLabel('assistant'), kit.catLabel('tool'), kit.catLabel('user'),
    ])
    assert.ok(elemRows(m).every(r => queryAll(r, '.lc-br-type i').length === 1), 'each type tag carries its category dot')
    // Independent prompt-position counters: tool schemas 1..N, messages 1..M; the system prompt unnumbered. The
    // counters keep the PROMPT's numbering, so they descend down the reversed list.
    const nos = queryAll(list, '.lc-br-idx').map(el => text(el))
    assert.deepEqual(nos, ['#1', '#2', '#4', '#3', '#2', '#1'])
    const chips = queryAll(list, '.lc-br-idx')
    assert.equal(chips[0].getAttribute('title'), kit.t('browser.toolNoTip'))
    assert.equal(chips[2].getAttribute('title'), kit.t('browser.msgNoTip'))

    // The filter scans exactly what the rows show: prompt text, tool name and schema text, tag and preview.
    await typeToolSearch(m, 'helpful')
    assert.equal(elemRows(m).length, 1, 'the system prompt matches on its text')
    await typeToolSearch(m, 'shell command')
    assert.equal(elemRows(m).length, 1, 'the tool schema matches on its description')
    assert.equal(queryAll(m.container, '.lc-br-fold').length, 0, 'a filtered list is flat — a folded group cannot hide a hit')
    await typeToolSearch(m, 'write')
    assert.equal(elemRows(m).length, 1)
    await typeToolSearch(m, 'zzz')
    assert.ok(text(query(m.container, '.lc-br-dna-list')).includes('No rows match'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 7)
    await m.unmount()
  })

  test('the tool schemas fold into one group; a band pick unfolds it, and folding back closes the row it held', async () => {
    const lazy = withEpochContent(dnaHeaders, { 1: { system: 'sys', tools: [{ name: 'bash', schema: {} }, { name: 'write', schema: {} }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...lazy })))
    await click(dnaButton(m))
    await flush()
    const rows = () => elemRows(m).length
    assert.equal(rows(), 5, 'folded by default: the two schema rows are hidden')
    // A band pick must reveal the schema it points at, then open that row.
    await click(bands(m)[2])
    assert.equal(rows(), 7, 'the picked band unfolded the group')
    const on = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(on.length, 1)
    assert.ok(text(on[0]).includes('write'), 'the picked schema row is the open one')
    // Folding the group takes the open row with it, so no band stays lit for a hidden row.
    await click(query(m.container, '.lc-br-fold'))
    assert.equal(rows(), 5)
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0)
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    // Re-opening by hand keeps the group unfolded for the next pick.
    await click(query(m.container, '.lc-br-fold'))
    assert.equal(rows(), 7)
    await m.unmount()
  })

  test('the system prompt and the tool schemas are fetched from their OWN events, whatever the open category', async () => {
    // The live system node carries the `system/message` event's seq (9); the schemas ride the `request/header`
    // epoch (1). One fetched value caches under the requested seq alone, so a single fetch cannot serve both rows.
    const lazy = withEpochContent(dnaHeaders, {
      1: { system: 'SYS', tools: [{ name: 'bash', description: 'run a shell command', schema: {} }, { name: 'write', schema: {} }] },
      9: { system: 'SYS', tools: [] },
    })
    const data = tl({
      current: { system: 100, tools: 75, user: 20, inject: 0, skill: 0, assistant: 0, tool: 0, total: 195 },
      systems: [{ seq: 9, time: 1200, tokens: 100 }],
      nodes: [surfaceNode({ seq: 2, tokens: 20, time: 2000, text: 'hi' })],
    })
    const fresh = await mount(h(Browser, props({ data, ...lazy })))
    await click(dnaButton(fresh))
    await flush()
    await click(query(fresh.container, '.lc-br-fold'))
    await click(elemRows(fresh)[1])
    await flush()
    assert.ok(text(query(fresh.container, '.lc-br-content')).includes('run a shell command'), 'the schema row reads the header epoch, not the system node')
    await typeToolSearch(fresh, 'shell command')
    assert.equal(elemRows(fresh).length, 1, 'the filter reads the fetched schema')
    await fresh.unmount()

    // Switched with the tools accordion still open: the schema epoch was the open category's key, and the system
    // prompt must keep reading its own event.
    const m = await mount(h(Browser, props({ data, ...lazy })))
    await click(catRow(m, 'tools'))
    await flush()
    await click(dnaButton(m))
    await flush()
    await click(query(m.container, '.lc-br-fold'))
    await click(elemRows(m)[0])
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('SYS'), 'the system row reads the system/message event')
    await m.unmount()
  })

  test('a compacted summary keeps its prompt seat — the DNA list reads messages newest-first by that seat', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 35, inject: 0, skill: 0, assistant: 25, tool: 0, total: 60 },
      nodes: [
        surfaceNode({ seq: 3, tokens: 10, text: 'older question' }),
        surfaceNode({ seq: 40, cat: 'assistant', tokens: 25, text: 'later answer' }),
        // The fold splices the replacement at the replaced range's seat: newest seq, oldest prompt position.
        surfaceNode({ seq: 60, tokens: 25, text: 'compacted summary', seat: 1 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(dnaButton(m))
    const rows = queryAll(m.container, '.lc-br-elem-row').map(el => text(el))
    assert.ok(rows[0].includes('later answer'), 'the newest prompt position leads the list')
    assert.ok(rows[1].includes('older question'))
    assert.ok(rows[2].includes('compacted summary'), 'the summary keeps the seat of the range it replaced')
    assert.deepEqual(queryAll(m.container, '.lc-br-idx').map(el => text(el)), ['#3', '#2', '#1'])
    await m.unmount()
  })

  test('an empty context renders no DNA list rows', async () => {
    const m = await mount(h(Browser, props({ data: tl({}), headers: null })))
    await click(dnaButton(m))
    assert.equal(query(m.container, '.lc-br-dna-list').textContent, '')
    await m.unmount()
  })

  test('clicking a band opens its row in the DNA list and scrolls it into view; a stale row filter is cleared', async () => {
    const scrolls: unknown[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolls.push(arg) } as never
    try {
      const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
      await click(dnaButton(m))
      // Band n3 (index 4) opens its own row — the list mirrors the strip one-to-one, no category accordion.
      await click(bands(m)[4])
      assert.equal(queryAll(m.container, '.lc-br-cat').length, 0)
      const onRows = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(onRows.length, 1)
      assert.ok(text(onRows[0]).includes('bash'))
      assert.deepEqual(scrolls, [{ block: 'nearest' }])

      // A stale row filter cannot hide the clicked band's row.
      await typeToolSearch(m, 'zzz')
      assert.ok(text(query(m.container, '.lc-br-dna-list')).includes('No rows match'))
      await click(bands(m)[3])
      assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '')
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 1)
      assert.ok(text(query(m.container, '.lc-br-dna-list')).includes('hi'))

      // The system band opens the system section (metadata-only note without a header fetcher).
      await click(bands(m)[0])
      assert.ok(text(query(m.container, '.lc-br-dna-list')).includes('token estimates only'))
      await m.unmount()
    } finally {
      Element.prototype.scrollIntoView = orig
    }
  })

  test('a tiny item stays a hoverable filament (the minBand floor) while the tooltip reports the true share', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 2, inject: 0, skill: 0, assistant: 998, tool: 0, total: 1000 },
      nodes: [surfaceNode({ seq: 1, tokens: 2, text: 'ok' }), surfaceNode({ seq: 2, cat: 'assistant', tokens: 998 })],
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(dnaButton(m))
    const segs = bands(m)
    assert.equal(segs.length, 2)
    // 2/1000 ≈ 0.2% would render sub-pixel: the band pins to the 0.35% floor, the big band rescales.
    assert.equal(segs[0].style.width, '0.35%')
    assert.ok(Math.abs(parseFloat(segs[1].style.width) - 99.65) < 0.001)
    await hover(segs[0])
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['User Messages', '≈2 · 0% of used context', null])
    // Category mode keeps exact widths (no floor outside DNA mode).
    await click(dnaButton(m))
    assert.deepEqual(bands(m).map(seg => seg.style.width), ['0.2%', '99.8%'])
    await m.unmount()
  })

  test('category mode: the open category stays lit; a pointer hover overrides the pin and the pin resumes on leave', async () => {
    // A parent really holding the shared hover key, so hovers round-trip like the overview link.
    const Harness = (p2: Omit<ContextBrowserProps, 'hoverKey' | 'onHoverKey'>) => {
      const [hoverKey, setHoverKey] = useState<string | null>(null)
      return h(Browser, props({ ...p2, hoverKey, onHoverKey: setHoverKey }))
    }
    const m = await mount(h(Harness, { data: dnaData, headers: dnaHeaders }))
    const stack = query(m.container, '.lc-stacked')
    assert.ok(!stack.className.includes('lc-stacked-dim'), 'nothing pinned while no category is open')
    // Opening a category pins its segment lit (category order: system, tools, user, inject, assistant, tool).
    await click(catRow(m, 'assistant'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    assert.ok(stack.className.includes('lc-stacked-dim'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0, 'category mode mounts no tooltip slot — the pin floats nothing')
    await hover(bands(m)[0])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [true, false, false, false, false, false])
    await unhover(stack)
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    await click(catRow(m, 'assistant'))
    assert.ok(!stack.className.includes('lc-stacked-dim'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    await m.unmount()
  })

  test('DNA mode: an open row lights its own band (no floating tooltip); a band hover overrides, the row resumes', async () => {
    // No shared-hover wiring (the /context modal path): the row's light works standalone. The epoch content
    // rides along so every band — the system prompt included — renders as an openable row.
    const lazy = withEpochContent(dnaHeaders, { 1: { system: 'You are a helpful assistant.', tools: [{ name: 'bash', schema: {} }, { name: 'write', schema: {} }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...lazy })))
    await click(dnaButton(m))
    await flush()
    // Unfold the tool schemas so the row list is the whole prompt: sys, bash, write, then n5..n2 (newest first).
    await click(query(m.container, '.lc-br-fold'))
    // Opening the assistant row (n4, band 5) lights exactly that band — the list indexes the bar back.
    await click(elemRows(m)[4])
    const stack = query(m.container, '.lc-stacked')
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, false, true, false])
    assert.ok(stack.className.includes('lc-stacked-dim'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0, 'a browsed row lights its band without floating a tooltip')
    // A pointer hover on the bar overrides the row's light and floats its tooltip again.
    await hover(bands(m)[1])
    assert.ok(query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, true, false, false, false, false, false])
    await unhover(stack)
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, false, true, false])
    await click(elemRows(m)[4])
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!stack.className.includes('lc-stacked-dim'))
    await m.unmount()
  })

  test('a DNA row hover lights its own band, the pointer floating its tooltip; leaving the row releases it', async () => {
    const lazy = withEpochContent(dnaHeaders, { 1: { system: 'You are a helpful assistant.', tools: [{ name: 'bash', schema: {} }, { name: 'write', schema: {} }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...lazy })))
    await click(dnaButton(m))
    await flush()
    await click(query(m.container, '.lc-br-fold'))
    // The rows read newest-first while the bar keeps prompt order, so a lit band follows the row's KEY, never its
    // list index: row 6 is n2 (band 3), row 0 the system prompt (band 0).
    const rows = elemRows(m)
    await hover(rows[6])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, true, false, false, false])
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), [`User Messages · ${kit.fmtTime(2000)}`, '≈20 · 7% of used context', null])
    await unhover(rows[6])
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    // The system prompt and a tool schema are bands in their own right.
    await hover(rows[0])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [true, false, false, false, false, false, false])
    await unhover(rows[0])
    await hover(rows[1])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, true, false, false, false, false, false])
    await unhover(rows[1])
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    await m.unmount()
  })

  test('a push dropping the hovered band does not dim the bar with nothing lit; the open row resumes underneath', async () => {
    const lazy = withEpochContent(dnaHeaders, { 1: { system: 'You are a helpful assistant.', tools: [{ name: 'bash', schema: {} }, { name: 'write', schema: {} }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...lazy })))
    await click(dnaButton(m))
    await flush()
    // Unfold the tool schemas so the row list is the whole prompt: sys, bash, write, n2..n5.
    await click(query(m.container, '.lc-br-fold'))
    await hover(bands(m)[3])
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    // The hovered node is compacted out of the live surface while the pointer rests on its band — a removed element
    // fires no mouseleave, so the stale key must be dropped instead of dimming the whole bar with nothing lit.
    const pushed = tl({
      current: { ...dnaData.current, user: 0, total: 255 },
      requests: dnaData.requests,
      nodes: dnaData.nodes.filter(n => n.seq !== 2),
    })
    await m.update(h(Browser, props({ data: pushed, ...lazy })))
    assert.ok(!query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'), 'the dead key floats no tooltip either')
    // Band order is now sys, bash, write, n3, n4, n5: the open row's band still lights under the stale hover.
    await click(elemRows(m)[4])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    await hover(bands(m)[3])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, true, false, false])
    await m.unmount()
  })

  test('the pin drops while the previewed step holds nothing for the open category', async () => {
    const wired = (previewSeq: number | null) => h(Browser, props({ data: dnaData, headers: dnaHeaders, previewSeq, onHoverKey: () => {} }))
    const m = await mount(wired(null))
    await click(catRow(m, 'inject'))
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'), 'inject pins lit on the live surface')
    // The retained step carries no injections: the pin drops instead of dimming a bar with nothing lit.
    await m.update(wired(20))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    await m.update(wired(null))
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'), 'back on the live surface the pin returns')
    await m.unmount()
  })
})


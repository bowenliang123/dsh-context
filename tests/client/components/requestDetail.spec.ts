// RequestDetail (src/client/components/requestDetail.tsx) rendered with real
// React in jsdom: header chips, delta mode, per-category rows, and the step
// brief (chipParts/nodeLine cascades, locate linkage).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeRequestDetail } from '../../../src/client/components/requestDetail'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import type { RequestRecord, ContextEventRecord, SurfaceNode } from '../../../src/shared/types'
import type { ConversationNodeLike } from '../../../src/client/services'
import type { StepBrief } from '../../../src/client/brief'
import { makeKit, mount, click, queryAll, query, text } from '../helpers/kit'

const kit = makeKit()
const RequestDetail = makeRequestDetail(kit, makeStackedBar(kit))

function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    time: 1_700_000_000_000, seq: 10, turn: 1, step: 1,
    system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 250, total: 1300,
    ...over,
  }
}

function node(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

/** Full-category fixture so every row renders a non-zero figure. */
const FULL = { system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 250, total: 1300 }

describe('RequestDetail header', () => {
  test('null request renders nothing', async () => {
    const m = await mount(h(RequestDetail, { request: null }))
    assert.equal(m.container.innerHTML, '')
    await m.unmount()
  })

  test('step detail: title, time, usage chips, per-category rows', async () => {
    const m = await mount(h(RequestDetail, {
      request: req({ prompt: 1000, output: 120, cacheRead: 500 }),
    }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Turn 1 · Step 1'))
    assert.ok(!head.includes('Last Step'), 'single-step request carries no last-step tag')
    assert.ok(!head.includes('Delta'), 'cumulative mode carries no delta tag')
    assert.ok(head.includes('Actual Prompt 1.0k'))
    assert.ok(head.includes('Output 120'))
    assert.ok(head.includes('Cache 50.00%'), 'real cacheHitPercent: 500/1000 truncated to two decimals')
    const rows = queryAll(m.container, '.lc-detail-row')
    assert.equal(rows.length, 6)
    assert.ok(text(rows[0]).includes('System Prompt'))
    assert.ok(text(rows[0]).includes('≈100'))
    const pcts = queryAll(m.container, '.lc-detail-pct').map(el => text(el))
    assert.ok(pcts.some(p => p.endsWith('%')), 'percentages rendered when total > 0')
    const fills = queryAll<HTMLElement>(m.container, '.lc-bar-fill')
    assert.equal(fills.length, 6, 'one fill per row in cumulative mode')
    assert.ok(fills[0].style.width !== '0%', 'non-zero categories fill the track')
    await m.unmount()
  })

  test('usage chips drop out when the figures are absent; cache falls back to a dash when nothing was billed', async () => {
    const m = await mount(h(RequestDetail, { request: req({}) }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(!head.includes('Actual Prompt'))
    assert.ok(!head.includes('Output'))
    assert.ok(!head.includes('Cache'))
    await m.unmount()

    const m2 = await mount(h(RequestDetail, { request: req({ prompt: 0, cacheRead: 0 }) }))
    const head2 = text(query(m2.container, '.lc-detail-head'))
    assert.ok(head2.includes('Cache —%'), 'prompt 0 → cacheHitPercent null → dash')
    assert.ok(!head2.includes('Output'))
    await m2.unmount()
  })

  test('turn aggregate shows the step count and the last-step tag; stepCount 1 stays a step', async () => {
    const m = await mount(h(RequestDetail, { request: req({ turn: 2, stepCount: 3 }) }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Turn 2 · 3 steps'))
    assert.ok(head.includes('Last Step'))
    await m.unmount()

    const m2 = await mount(h(RequestDetail, { request: req({ turn: 2, step: 4, stepCount: 1 }) }))
    const head2 = text(query(m2.container, '.lc-detail-head'))
    assert.ok(head2.includes('Turn 2 · Step 4'))
    assert.ok(!head2.includes('Last Step'))
    await m2.unmount()

    // Requests without turn/step stamps degrade to zeroes.
    const bare: RequestRecord = {
      time: 1_700_000_000_000, seq: 3,
      system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0, total: 4,
    }
    const m3 = await mount(h(RequestDetail, { request: bare }))
    assert.ok(text(query(m3.container, '.lc-detail-head')).includes('Turn 0 · Step 0'))
    await m3.unmount()
    const m4 = await mount(h(RequestDetail, { request: { ...bare, stepCount: 2 } }))
    assert.ok(text(query(m4.container, '.lc-detail-head')).includes('Turn 0 · 2 steps'))
    await m4.unmount()
  })

  test('boundary marker shows where the event happened; in-flight markers hide', async () => {
    const marker: ContextEventRecord = {
      seq: 9, time: 1_699_999_999_000, kind: 'compaction', count: 3,
      fromTurn: 2, fromStep: 3, turn: 2, step: 4,
    }
    const m = await mount(h(RequestDetail, { request: req({}), marker }))
    const chip = query(m.container, '.lc-detail-marker')
    assert.ok(text(chip).includes('✂ Turn 2 · Step 3→4'))
    assert.equal(chip.getAttribute('title'), 'Context compacted (summary replaced 3 messages)')
    await m.unmount()

    // Cross-turn gap.
    const m2 = await mount(h(RequestDetail, {
      request: req({}),
      marker: { seq: 9, time: 1, kind: 'prune', fromTurn: 2, fromStep: 8, turn: 3, step: 1 },
    }))
    assert.ok(text(query(m2.container, '.lc-detail-marker')).includes('Turn 2 · Step 8 → Turn 3 · Step 1'))
    await m2.unmount()

    // Same-request boundary (no from-stamps).
    const m3 = await mount(h(RequestDetail, {
      request: req({}),
      marker: { seq: 9, time: 1, kind: 'compaction', count: 2, turn: 4, step: 2 },
    }))
    assert.ok(text(query(m3.container, '.lc-detail-marker')).includes('✂ Turn 4 · Step 2'))
    await m3.unmount()

    // No turn/step stamps (event in flight) → no marker chip.
    const m4 = await mount(h(RequestDetail, {
      request: req({}),
      marker: { seq: 9, time: 1, kind: 'prune' },
    }))
    assert.equal(queryAll(m4.container, '.lc-detail-marker').length, 0)
    await m4.unmount()

    const m5 = await mount(h(RequestDetail, { request: req({}), marker: null }))
    assert.equal(queryAll(m5.container, '.lc-detail-marker').length, 0)
    await m5.unmount()
  })
})

describe('RequestDetail delta mode', () => {
  test('signed deltas vs the previous record: net chip, diverging rows, no usage chips', async () => {
    const request = req({ system: 150, tools: 200, user: 250, inject: 0, assistant: 300, tool: 350, total: 1250, prompt: 900 })
    const prev = req({ ...FULL, inject: 0 })
    const m = await mount(h(RequestDetail, { request, prev }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Delta'), 'delta tag shown')
    assert.ok(!head.includes('Actual Prompt'), 'usage chips drop out in delta mode')
    const metric = query(m.container, '.lc-detail-metric')
    // +50 -50 -100 +100 → net 0 → neutral chip.
    assert.ok(text(metric).includes('Δ 0'))
    assert.ok(!metric.className.includes('lc-detail-metric-up'))
    assert.ok(!metric.className.includes('lc-detail-metric-down'))
    const zeros = queryAll(m.container, '.lc-bar-zero')
    assert.equal(zeros.length, 6, 'every delta row carries the zero line')
    const upFills = queryAll(m.container, '.lc-bar-fill-up')
    const downFills = queryAll(m.container, '.lc-bar-fill-down')
    assert.equal(upFills.length, 2, 'system +50, tool +100')
    assert.equal(downFills.length, 2, 'user -50, assistant -100')
    // maxAbs = 100 (assistant/tool): tool fills the full half-track, system half of it.
    assert.equal((upFills[1] as HTMLElement).style.width, '50%')
    assert.equal((upFills[0] as HTMLElement).style.width, '25%')
    const nums = queryAll(m.container, '.lc-detail-num')
    assert.ok(text(nums[0]).includes('+50'))
    assert.ok(nums[0].className.includes('lc-detail-num-up'))
    assert.ok(text(nums[2]).includes('-50'))
    assert.ok(nums[2].className.includes('lc-detail-num-down'))
    assert.ok(!nums[1].className.includes('lc-detail-num-up'), 'zero delta is neutral')
    assert.ok(queryAll(m.container, '.lc-detail-pct').every(el => text(el) === ''), 'no percentages in delta mode')
    await m.unmount()
  })

  test('delta with prev null reads against zeros (all up); shrink-only deltas go down', async () => {
    const m = await mount(h(RequestDetail, { request: req({}), prev: null }))
    const metric = query(m.container, '.lc-detail-metric')
    assert.ok(metric.className.includes('lc-detail-metric-up'))
    assert.ok(text(metric).includes('Δ +1.3k'))
    assert.equal(queryAll(m.container, '.lc-bar-fill-down').length, 0)
    await m.unmount()

    const m2 = await mount(h(RequestDetail, {
      request: req({ system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 }),
      prev: req({ ...FULL }),
    }))
    const metric2 = query(m2.container, '.lc-detail-metric')
    assert.ok(metric2.className.includes('lc-detail-metric-down'))
    assert.ok(text(metric2).includes('Δ -1.3k'))
    assert.equal(queryAll(m2.container, '.lc-bar-fill-up').length, 0)
    assert.equal(queryAll(m2.container, '.lc-bar-fill-down').length, 6)
    await m2.unmount()
  })

  test('cumulative rows with a zero total render zero-width fills and no percentages', async () => {
    const m = await mount(h(RequestDetail, {
      request: req({ system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 }),
    }))
    for (const fill of queryAll<HTMLElement>(m.container, '.lc-bar-fill')) {
      assert.equal(fill.style.width, '0%')
    }
    assert.ok(queryAll(m.container, '.lc-detail-pct').every(el => text(el) === ''))
    await m.unmount()
  })
})

describe('RequestDetail brief section', () => {
  const convOk: ConversationNodeLike = {
    kind: 'tool-result', seq: 21,
    call: { name: 'bash', argsRaw: '{"description":"list files"}' },
    content: [{ type: 'text', text: 'a.txt' }],
  }

  test('absent/empty briefs render no section', async () => {
    const m = await mount(h(RequestDetail, { request: req({}), brief: null }))
    assert.equal(queryAll(m.container, '.lc-brief').length, 0)
    await m.unmount()

    const empty: StepBrief = { inputs: [] }
    const m2 = await mount(h(RequestDetail, { request: req({}), brief: empty }))
    assert.equal(queryAll(m2.container, '.lc-brief').length, 0)
    await m2.unmount()
  })

  test('opener, inputs with overflow, and reply rows render with tags and previews', async () => {
    const brief: StepBrief = {
      opener: node({ seq: 1, cat: 'user', text: 'please refactor this' }),
      inputs: [
        node({ seq: 21, cat: 'tool', tool: 'bash' }),
        node({ seq: 22, cat: 'inject', form: 'snapshot', text: 'state v2' }),
        node({ seq: 23, cat: 'user', text: 'extra note', imgs: 3 }),
        node({ seq: 24, cat: 'inject', form: 'notice' }),
      ],
      response: node({ seq: 25, cat: 'assistant', calls: ['bash', 'write'], text: 'done' }),
    }
    const m = await mount(h(RequestDetail, {
      request: req({}), brief,
      convOf: (seq) => seq === 21 ? convOk : undefined,
    }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows.length, 3)
    assert.ok(text(rows[0]).includes('please refactor this'), 'opener row carries the user text')
    assert.ok(text(rows[0]).includes('User'), 'opener tagged as the turn opener')
    // Inputs: three chips + the overflow pill.
    const chips = queryAll(rows[1], '.lc-brief-chip')
    assert.equal(chips.length, 3, 'inputs capped at MAX_CHIPS')
    assert.ok(text(rows[1]).includes('+1'), 'overflow pill counts the hidden inputs')
    assert.ok(text(chips[0]).includes('bash') && text(chips[0]).includes('list files'), 'tool chip: name tag + call summary')
    assert.ok(text(chips[1]).includes('State Snapshot') && text(chips[1]).includes('Snapshot: state v2'))
    assert.ok(text(chips[2]).includes('Image ×3'), 'user chip counts attachments')
    // Rows are inert without onLocate.
    assert.equal(rows[0].tagName, 'DIV')
    assert.ok(!chips[0].className.includes('lc-brief-chip-link'))
    // Reply: one grown chip with the call breadcrumb.
    const replyChip = query(rows[2], '.lc-brief-chip')
    assert.ok(replyChip.className.includes('lc-brief-chip-grow'))
    assert.ok(text(replyChip).includes('bash › write'))
    assert.ok(text(replyChip).includes('done'))
    assert.equal(queryAll(m.container, '.lc-brief-tip').length, 3)
    assert.equal(chips[0].getAttribute('title'), 'bash · list files')
    await m.unmount()
  })

  test('locate linkage: row clicks locate their node; chip clicks locate their own node only', async () => {
    const calls: { seq: number; isResponse: boolean }[] = []
    const onLocate = (n: SurfaceNode, isResponse: boolean): void => {
      calls.push({ seq: n.seq, isResponse })
    }
    const brief: StepBrief = {
      opener: node({ seq: 1, cat: 'user', text: 'open' }),
      inputs: [
        node({ seq: 21, cat: 'tool', tool: 'bash', err: true }),
        node({ seq: 22, cat: 'inject', form: 'catalog', text: 'tools changed' }),
      ],
      response: node({ seq: 25, cat: 'assistant', text: 'reply text' }),
    }
    const m = await mount(h(RequestDetail, {
      request: req({}), brief, onLocate,
      convOf: (seq) => seq === 21 ? convOk : undefined,
    }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows[0].tagName, 'BUTTON', 'rows become buttons when locate is wired')
    // Error dot on the failed tool chip.
    assert.equal(queryAll(rows[1], '.lc-br-err-dot').length, 1)
    // Chip click: locates the chip's node, not the row's first input twice.
    const chip = queryAll(rows[1], '.lc-brief-chip')[1]
    assert.ok(chip.className.includes('lc-brief-chip-link'))
    await click(chip)
    assert.deepEqual(calls, [{ seq: 22, isResponse: false }], 'stopPropagation keeps the row handler out')
    await click(rows[1] as HTMLElement)
    assert.deepEqual(calls[1], { seq: 21, isResponse: false })
    await click(rows[2] as HTMLElement)
    assert.deepEqual(calls[2], { seq: 25, isResponse: true })
    const replyChip = query(rows[2], '.lc-brief-chip')
    assert.ok((replyChip.getAttribute('title') ?? '').includes('Reveal in Context Browser'))
    await click(rows[0] as HTMLElement)
    assert.deepEqual(calls[3], { seq: 1, isResponse: false })
    await m.unmount()
  })

  test('chipParts cascade: tool/assistant/inject/user kinds and the skill-inject fallback', async () => {
    const inputs: SurfaceNode[] = [
      // tool: skill tag wins; summary from the join.
      node({ seq: 30, cat: 'tool', skill: 'code-review', tool: 'bash' }),
      // tool: name tag, no join → no text.
      node({ seq: 31, cat: 'tool', tool: 'read' }),
      // tool: no name, no join → untagged Tool Result placeholder.
      node({ seq: 32, cat: 'tool' }),
      // assistant: text + call list breadcrumb.
      node({ seq: 33, cat: 'assistant', calls: ['bash'], text: 'looking' }),
      // assistant: textless, block summary through the join.
      node({ seq: 34, cat: 'assistant', calls: ['write'] }),
      // assistant: no own calls; the breadcrumb is recovered from the join.
      node({ seq: 35, cat: 'assistant' }),
      // assistant: truly empty reply.
      node({ seq: 36, cat: 'assistant', calls: [] }),
      // inject: plain form with text.
      node({ seq: 37, cat: 'inject', form: 'relay', text: 'from agent' }),
      // inject: form absent → Context Injection.
      node({ seq: 38, cat: 'inject', text: 'plain' }),
      // user: single image, no text.
      node({ seq: 39, cat: 'user', imgs: 1 }),
      // user: plain text.
      node({ seq: 40, cat: 'user', text: 'hi' }),
    ]
    const convs: Record<number, ConversationNodeLike> = {
      30: { kind: 'tool-result', seq: 30, call: { name: 'bash', argsRaw: '{"description":"load skill"}' } },
      34: { kind: 'assistant', seq: 34, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
      35: { kind: 'assistant', seq: 35, blocks: [{ kind: 'tool-call', name: 'read', argsRaw: '{}' }] },
      44: { kind: 'assistant', seq: 44, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
    }
    // One row per input would need 11 rows; instead render them as one inputs
    // list — chips are the unit under test (3 shown + overflow), so render
    // batches through separate mounts.
    const render = async (list: SurfaceNode[]) => {
      const m = await mount(h(RequestDetail, {
        request: req({}),
        brief: { inputs: list },
        convOf: (seq) => convs[seq],
      }))
      return m
    }
    const chipText = (m: Awaited<ReturnType<typeof render>>, i: number) =>
      text(queryAll(m.container, '.lc-brief-chip')[i])

    const m1 = await render(inputs.slice(0, 3))
    assert.ok(chipText(m1, 0).includes('Skill · code-review') && chipText(m1, 0).includes('load skill'))
    assert.equal(chipText(m1, 1), 'read', 'tool name tag without a join leaves no text')
    assert.equal(chipText(m1, 2), 'Tool Result', 'untagged tool falls back to the placeholder text')
    await m1.unmount()

    const m2 = await render(inputs.slice(3, 6))
    assert.ok(chipText(m2, 0).includes('bash') && chipText(m2, 0).includes('looking'))
    assert.ok(chipText(m2, 1).includes('write') && chipText(m2, 1).includes('a.ts'), 'block summary through the join')
    assert.equal(chipText(m2, 2), 'read', 'breadcrumb from the join, no preview text')
    await m2.unmount()

    const m3 = await render(inputs.slice(6, 9))
    assert.equal(chipText(m3, 0), '(empty reply)')
    assert.ok(chipText(m3, 1).includes('Agent Relay') && chipText(m3, 1).includes('from agent'))
    assert.ok(chipText(m3, 2).includes('Context Injection') && chipText(m3, 2).includes('plain'))
    await m3.unmount()

    const m4 = await render(inputs.slice(9))
    assert.equal(chipText(m4, 0), 'Image', 'single image: no count suffix')
    assert.equal(chipText(m4, 1), 'hi')
    await m4.unmount()

    // chipParts fallback (inject carrying a skill): nodeLine drives the text.
    const m5 = await render([node({ seq: 41, cat: 'inject', skill: 'ponytail' })])
    assert.equal(chipText(m5, 0), 'Skill · ponytail', 'skill inject falls back to nodeLine')
    await m5.unmount()
    const m6 = await render([node({ seq: 42, cat: 'inject', skill: 'ponytail', text: 'notes inside' })])
    assert.equal(chipText(m6, 0), 'notes inside', 'nodeLine prefers the node text over the skill label')
    await m6.unmount()

    // A category outside the fold's vocabulary (host drift) still renders:
    // nodeLine labels the calls breadcrumb, else the non-text placeholder.
    const m7 = await render([node({ seq: 43, cat: 'mystery' as never, calls: ['bash', 'read'] })])
    assert.equal(chipText(m7, 0), 'bash › read')
    await m7.unmount()
    const m8 = await render([node({ seq: 44, cat: 'mystery' as never, calls: ['write'] })])
    assert.equal(chipText(m8, 0), 'write · a.ts', 'block summary joins the breadcrumb')
    await m8.unmount()
    const m9 = await render([node({ seq: 45, cat: 'mystery' as never, calls: [] })])
    assert.equal(chipText(m9, 0), '(non-text message)')
    await m9.unmount()
    const m10 = await render([node({ seq: 46, cat: 'mystery' as never })])
    assert.equal(chipText(m10, 0), '(non-text message)', 'no calls list at all')
    await m10.unmount()

    // Skill-tagged tool without a join: tag only, no summary text.
    const m11 = await render([node({ seq: 47, cat: 'tool', skill: 'grilling' })])
    assert.equal(chipText(m11, 0), 'Skill · grilling')
    await m11.unmount()
    // Textless injection: the form tag carries the chip alone.
    const m12 = await render([node({ seq: 48, cat: 'inject', form: 'notice' })])
    assert.equal(chipText(m12, 0), 'Notice')
    await m12.unmount()
  })

  test('opener without tag or text renders a bare row; inputs-only brief has no opener row', async () => {
    const brief: StepBrief = {
      opener: node({ seq: 1, cat: 'user' }),
      inputs: [],
    }
    const m = await mount(h(RequestDetail, { request: req({}), brief }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows.length, 1, 'opener-only brief')
    assert.equal(queryAll(rows[0], '.lc-brief-fact').length, 0, 'no fact tag on a plain user opener')
    assert.equal(queryAll(rows[0], '.lc-brief-text').length, 0, 'no text span without preview')
    await m.unmount()

    const m2 = await mount(h(RequestDetail, {
      request: req({}),
      brief: { inputs: [node({ seq: 5, cat: 'user', text: 'just input' })] },
    }))
    const rows2 = queryAll(m2.container, '.lc-brief-row')
    assert.equal(rows2.length, 1)
    assert.ok(text(rows2[0]).includes('In'), 'the single row is the inputs row')
    assert.equal(queryAll(m2.container, '.lc-brief-more').length, 0, 'no overflow pill at the cap')
    await m2.unmount()

    // Opener carrying an image upload: the fact tag shows on the opener row.
    const m3 = await mount(h(RequestDetail, {
      request: req({}),
      brief: { opener: node({ seq: 7, cat: 'user', text: 'see attached', imgs: 2 }), inputs: [] },
    }))
    const fact = query(m3.container, '.lc-brief-fact')
    assert.equal(text(fact), 'Image ×2')
    assert.ok(text(query(m3.container, '.lc-brief-text')).includes('see attached'))
    await m3.unmount()
  })
})

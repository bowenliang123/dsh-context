// StatsContext (src/client/components/statsContext.tsx) rendered in both locales against an injected model-price book (the store never
// reaches the network). Connector geometry is pinned through measureFlow's unit tests (jsdom has no layout); the event rows live on the
// events card (contextView.spec.ts). `countsOfRecords` and `toolTallyOf` derive the tallies the split generation's slim head carries.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi, beforeEach } from 'vitest'
import { countsOfRecords, flowCurve, makeStatsContext, makeSubagentCost, measureFlow, toolTallyOf } from '../../../src/client/components/statsContext'
import type { SubagentStats } from '../../../src/client/components/statsContext'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const NO_SUB = (): SubagentStats => ({ usage: null, count: 0 })
const StatsContext = makeStatsContext(kit, NO_SUB)
const StatsContextZh = makeStatsContext(kitZh, NO_SUB)

/** A minimal real-shaped slice of the models.dev /api.json payload. */
const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}

const NO_FILES = { reads: 0, writes: 0, searches: 0, images: 0 }
const NO_COUNTS = { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 }

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

/** A skill-tagged inject event the way the host fold stamps it (fold.ts). */
function skillEv(name: string): ContextEventRecord {
  return { seq: 0, time: 0, kind: 'inject', form: 'instructions', sub: 'skill', name }
}

/** The five flow nodes in DOM order: inputs / events / session / tools / cost. */
function flowNodes(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-flow-node')
}

/** One node's VISIBLE pills as 'label+figure' strings. The tools node also carries an off-flow gauge (every pill at
 *  its natural width, for `ToolPills`' fit) — the gauge is never shown, so it is not part of what a reader sees. */
function pillsOf(node: HTMLElement): string[] {
  return queryAll(node, '.lc-flow-pill').filter(el => el.closest('.lc-flow-pill-gauge') === null)
    .map(el => (el.querySelector('.lc-flow-pill-label')?.textContent ?? '') + (el.querySelector('b')?.textContent ?? ''))
}

/** The team ledger's rows as 'label+pair' strings (tips excluded). */
function rowsOf(node: HTMLElement): string[] {
  return queryAll(node, '.lc-flow-row').map(el => (el.querySelector('.lc-flow-row-label')?.textContent ?? '') + (el.querySelector('.lc-flow-pair')?.textContent ?? ''))
}

function headsOf(container: HTMLElement): { labels: string[]; totals: string[] } {
  const heads = queryAll(container, '.lc-flow-head')
  return {
    labels: heads.map(el => el.querySelector('.lc-flow-label')?.textContent ?? ''),
    totals: heads.map(el => el.querySelector('.lc-flow-total')?.textContent ?? ''),
  }
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
})

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, the three priced event kinds, and the distinct loaded skills', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [
        ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode'),
        // Skill loads and a `/name` invocation count by DISTINCT name; the
        // available-skills catalog digest rides an untagged inject event and never lands in the tally.
        skillEv('grilling'), skillEv('grilling'), skillEv('ponytail'),
        { ...ev('inject'), name: 'available-skills' },
        // Hostile shapes skip: a nameless tag and a non-string name.
        { ...ev('inject'), sub: 'skill' },
        { ...ev('inject'), sub: 'skill', name: 5 } as unknown as ContextEventRecord,
      ],
    )
    // model/mode events do not appear (only the three priced kinds do); every
    // inject above rides kind 'inject', the catalog digest and hostile shapes
    // included — only the skills TALLY filters by the tag.
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 9, compactions: 2, prunes: 1, skills: 2 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
  })
})

describe('toolTallyOf (the live-surface per-tool tally)', () => {
  const node = (cat: SurfaceNode['cat'], tool?: string): SurfaceNode => ({ seq: 0, cat, tokens: 0, ...(tool !== undefined ? { tool } : {}) })

  test('folds the host predicate: tool results, plus skill nodes carrying a tool', () => {
    const tally = toolTallyOf([
      node('tool', 'read'), node('tool', 'read'), node('tool', 'bash'),
      node('skill', 'run_code'), // a skill node carrying a tool counts
      node('skill'), // a bare skill node does not
      node('user'), node('assistant'),
      node('tool'), // an unnamed result counts toward the head figure but rides no pill
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1], ['run_code', 1]])
  })

  test('sorts count-desc then name-asc, skipping hostile shapes', () => {
    const tally = toolTallyOf([
      node('tool', 'bash'), node('tool', 'read'), node('tool', 'read'),
      { seq: 0, cat: 'tool', tokens: 0, tool: 5 } as unknown as SurfaceNode,
      node('tool', ''),
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1]])
  })

  test('count ties break name-asc in either insertion order', () => {
    assert.deepEqual(toolTallyOf([node('tool', 'zed'), node('tool', 'apple')]), [['apple', 1], ['zed', 1]])
    assert.deepEqual(toolTallyOf([node('tool', 'apple'), node('tool', 'zed')]), [['apple', 1], ['zed', 1]])
  })
})

describe('measureFlow (the connector geometry)', () => {
  const boxes = {
    inputs: { x: 0, y: 0, w: 100, h: 40 },
    events: { x: 0, y: 60, w: 100, h: 80 },
    session: { x: 160, y: 30, w: 120, h: 80 },
    tools: { x: 340, y: 0, w: 100, h: 40 },
    cost: { x: 340, y: 60, w: 100, h: 80 },
  }

  test('horizontal mode flows left→right, fanning the session edge at ⅓ and ⅔, colored by element', () => {
    const links = measureFlow(boxes, true)
    assert.equal(links.length, 4)
    // inputs→session: inputs' right-center to the session's left edge at ⅓ (control distance 30 = half the 60px gap).
    assert.equal(links[0].d, `M 100 20 C 130 20 130 ${30 + 80 * (1 / 3)} 160 ${30 + 80 * (1 / 3)}`)
    // events→session: events' right-center to the session's left edge at ⅔.
    assert.equal(links[1].d, `M 100 100 C 130 100 130 ${30 + 80 * (2 / 3)} 160 ${30 + 80 * (2 / 3)}`)
    // session→tools: the session's right edge at ⅓ to tools' left-center.
    assert.equal(links[2].d, `M 280 ${30 + 80 * (1 / 3)} C 310 ${30 + 80 * (1 / 3)} 310 20 340 20`)
    // session→cost: the session's right edge at ⅔ to cost's left-center.
    assert.equal(links[3].d, `M 280 ${30 + 80 * (2 / 3)} C 310 ${30 + 80 * (2 / 3)} 310 100 340 100`)
    assert.deepEqual(links.map(l => l.color), [
      'var(--color-green-500)', 'var(--color-purple-500)', 'var(--color-teal-500)', 'var(--color-pink-500)',
    ])
  })

  test('vertical mode flows top→bottom with the same fan', () => {
    const links = measureFlow(boxes, false)
    assert.equal(links.length, 4)
    // inputs→session: inputs' bottom-center to the session's top edge at ⅓; the 10px gap floors the control distance at 18.
    assert.equal(links[0].d, `M 50 40 C 50 58 ${160 + 120 * (1 / 3)} 12 ${160 + 120 * (1 / 3)} 30`)
    // session→cost: the session's bottom edge at ⅔ to cost's top-center; control distance 25 = half the 50px gap.
    assert.equal(links[3].d, `M ${160 + 120 * (2 / 3)} 110 C ${160 + 120 * (2 / 3)} 135 390 35 390 60`)
  })

  test('flowCurve floors the control distance so near neighbors still bow', () => {
    assert.equal(
      flowCurve({ x: 0, y: 0, dx: 1, dy: 0 }, { x: 20, y: 0, dx: -1, dy: 0 }),
      'M 0 0 C 18 0 2 0 20 0',
    )
  })
})

describe('StatsContext', () => {
  /** jsdom has no layout, so `ToolPills` shows the whole tally. Stubbing widths lets the fit run for real: a pill is
   *  sized by its label's length, and the "+N" chip by its own. */
  function stubWidths(pillWidth: number, chipWidth: number, rowWidth: number): () => void {
    const real = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const chip = this.classList.contains('lc-flow-pill-dim')
      const inGauge = this.closest('.lc-flow-pill-gauge') !== null
      if (!this.classList.contains('lc-flow-pill') && !this.classList.contains('lc-flow-pills')) return real.call(this)
      if (this.classList.contains('lc-flow-pills-tools')) {
        return { width: rowWidth, height: 0, top: 0, left: 0, right: rowWidth, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      const w = chip ? chipWidth : pillWidth
      const left = inGauge && chip ? chipWidth : 0
      return { width: w, height: 0, top: 0, left, right: left + w, bottom: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect
    }
    return () => { Element.prototype.getBoundingClientRect = real }
  }

  test('the tools row folds the tail into the overflow pill at the width it is measured against', async () => {
    const restore = stubWidths(100, 40, 260)
    try {
      // 100px pills + a 40px chip + 4px gaps: 260 holds two pills and the chip (248), never three (352).
      const m = await mount(h(StatsContext, {
        counts: NO_COUNTS, files: NO_FILES, tools: [['read', 8], ['bash', 3], ['grep', 2]], locale: 'en',
      }))
      await flush()
      assert.deepEqual(pillsOf(flowNodes(m.container)[3]), ['read8', 'bash3', '+1 more'])
      await m.unmount()
    } finally {
      restore()
    }
  })

  test('a wide card spells out every tool, with the overflow pill at zero', async () => {
    const restore = stubWidths(100, 40, 900)
    try {
      const m = await mount(h(StatsContext, {
        counts: NO_COUNTS, files: NO_FILES, tools: [['read', 8], ['bash', 3], ['grep', 2]], locale: 'en',
      }))
      await flush()
      assert.deepEqual(pillsOf(flowNodes(m.container)[3]), ['read8', 'bash3', 'grep2', '+0 more'])
      await m.unmount()
    } finally {
      restore()
    }
  })

  test('folds the flow: source cards feed the session node, which drains into the effect cards', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1, skills: 2 },
      humanInputs: 7,
      answers: 3,
      toolCalls: 12,
      files: { reads: 9, writes: 2, searches: 4, images: 1 },
      tools: [['read', 8], ['bash', 3], ['grep', 2], ['edit', 1], ['glob', 1]],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(text(m.container).includes('Context Stats'))
    const nodes = flowNodes(m.container)
    const { labels, totals } = headsOf(m.container)
    assert.deepEqual(labels, ['Input / Output', 'Context Events', 'Tool Calls', 'Agent Network?'])
    // I/O totals the inputs plus every file op (7 + 9 + 2 + 4 + 1); the family's 1M
    // uncached input bills the doubled peak rate — the team's header pairs its tokens with it.
    assert.deepEqual(totals, ['23', '6', '12', '1.0M/$0.30'])
    assert.deepEqual(pillsOf(nodes[0]), ['Human Inputs?7', 'Read9', 'Written2', 'Searched4', 'Images1'])
    assert.deepEqual(pillsOf(nodes[1]), ['Inject3', 'Compact2', 'Prune1'])
    // Every tool the row can hold pills out in full (jsdom reports no width, so nothing is folded away here); the
    // overflow pill reads zero. The real fit is measured in the browser, where the card has a width.
    assert.deepEqual(pillsOf(nodes[3]), ['read8', 'bash3', 'grep2', 'edit1', 'glob1', '+0 more'])
    assert.deepEqual(rowsOf(nodes[4]), ['Current Agent1.0M/$0.30', 'Subagents × 0?0/—'])
    // The session node carries two figure rows under its label — turns/steps
    // above skill loads/answers (two skills, three answers above).
    assert.equal(nodes[2].querySelector('.lc-flow-label')?.textContent, 'Current Session')
    const selfRows = queryAll(nodes[2], '.lc-flow-self-stats')
    assert.deepEqual(selfRows.map(row => queryAll(row, '.lc-flow-kv b').map(el => el.textContent)), [['3', '4'], ['2', '3']])
    assert.deepEqual(selfRows.map(row => queryAll(row, '.lc-flow-kv i').map(el => el.textContent)), [['Turns', 'Steps'], ['Skill Loads', 'Answers']])
    // The event pills tint by the events card's own kind classes.
    assert.ok(nodes[1].querySelector('.lc-flow-pill.lc-kind-inject') !== null)
    assert.ok(nodes[1].querySelector('.lc-flow-pill.lc-kind-prune') !== null)
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 3, 'the inputs-pill, family, and sub-row tips')
    // The four connectors, two layers each (jsdom measures zeroed boxes — the geometry itself is measureFlow's pin).
    assert.equal(queryAll(m.container, '.lc-flow-ribbon').length, 4)
    assert.equal(queryAll(m.container, '.lc-flow-dash').length, 4)
    await m.unmount()
  })

  test('absent counters and cost degrade to zeros, dimmed pills, and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(headsOf(m.container).totals, ['0', '0', '0', '0/—'])
    const nodes = flowNodes(m.container)
    assert.deepEqual(pillsOf(nodes[0]), ['Human Inputs?0', 'Read0', 'Written0'], 'searches/images pill only when they happened')
    assert.deepEqual(pillsOf(nodes[3]), ['+0 more'], 'the overflow chip always renders, so the reserved row reads as a figure')
    assert.deepEqual(rowsOf(nodes[4]), ['Current Agent0/—', 'Subagents × 0?0/—'])
    assert.equal(queryAll(nodes[0], '.lc-flow-pill-dim').length, 3, 'every zero pill dims')
    assert.equal(queryAll(nodes[1], '.lc-flow-pill-dim').length, 3)
    await m.unmount()
  })

  test('the tools total falls back to the tally sum on hosts too old to carry it', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [['read', 8], ['bash', 3]],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[2], '11')
    const nodes = flowNodes(m.container)
    assert.deepEqual(pillsOf(nodes[3]), ['read8', 'bash3', '+0 more'], 'two tools pill out, the overflow chip reads zero')
    await m.unmount()
  })

  test('the cost bubble lists the billed models with their billed rates', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.equal(tips.length, 3, 'the inputs-pill, family, and sub-row tips')
    assert.ok(tips[0].includes('question answerings'), 'the human-inputs tip explains its tally')
    const costTip = tips[1]
    assert.ok(costTip.includes('every descendant subagent session'), 'the cost tip names the family scope — all levels')
    assert.ok(costTip.includes('billed total'), 'the tip glosses the token face too')
    assert.ok(costTip.includes('Per-1M-token rates:'))
    assert.ok(costTip.includes('Priced as listed on models.dev for deepseek · deepseek-v4-flash.'), 'the listing line names the resolved registry face')
    // The table lists the book's own rates (the footnotes carry the peak scheme).
    assert.ok(costTip.includes('Cache input $0.00'))
    assert.ok(costTip.includes('Uncached input $0.15'))
    assert.ok(costTip.includes('Cache write $0.15'))
    assert.ok(costTip.includes('Output $0.60'))
    assert.ok(costTip.includes('peak windows'), 'a DeepSeek session explains the peak/off-peak scheme')
    assert.ok(!costTip.includes('|'), 'no peak|off pairs — the footnotes carry the scheme')
    await m.unmount()
  })

  test('a non-DeepSeek session never sees DeepSeek-specific notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('Priced as listed on models.dev for zhipuai · glm-5.3-flash.'))
    assert.ok(!costTip.includes('DeepSeek'), 'the DeepSeek scheme note stays out of other providers’ bubbles')
    // glm-5.3-flash lists cache_write at 0 — the zero band drops from the table.
    assert.ok(costTip.includes('Uncached input $0.07'))
    assert.ok(!costTip.includes('Cache write'))
    await m.unmount()
  })

  test('the cost header links to the models.dev provider listing when one provider priced the scope', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    const links = queryAll(m.container, 'a.lc-flow-head')
    assert.equal(links.length, 1, 'the cost header is the only link')
    assert.equal(links[0].getAttribute('href'), 'https://models.dev/providers/deepseek/')
    assert.equal(links[0].getAttribute('target'), '_blank')
    assert.ok(links[0].textContent.includes('$0.30'), 'the link keeps the header body')
    assert.ok(queryAll(m.container, '.lc-flow-head').length > links.length, 'the sibling headers stay plain')
    await m.unmount()
  })

  test('a multi-provider scope keeps the cost header unlinked', async () => {
    const two: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: two,
      locale: 'en',
    }))
    await flush()
    assert.equal(queryAll(m.container, 'a.lc-flow-head').length, 0, 'two providers name their faces in the tooltip instead')
    await m.unmount()
  })

  test('a multi-provider session names the resolved registry face on each listing line', async () => {
    const two: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: two,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('for deepseek · deepseek-v4-flash.'))
    assert.ok(costTip.includes('for zhipuai · glm-5.3-flash.'))
    // 1M × $0.15 × 2 (the DeepSeek peak) + 2M × $0.075 = $0.45; the tokens total too.
    assert.ok(headsOf(m.container).totals[3] === '3.0M/$0.45')
    await m.unmount()
  })

  test('the zh locale localizes the cards and prices the cost in CNY at 1 CNY = 0.15 USD', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0, skills: 5 },
      answers: 4,
      files: { reads: 2, writes: 1, searches: 0, images: 0 },
      tools: [['read', 2]],
      cost: COST,
      locale: 'zh',
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文统计'))
    const nodes = flowNodes(m.container)
    const { labels, totals } = headsOf(m.container)
    assert.deepEqual(labels, ['输入输出', '上下文事件', '工具调用', 'Agent 网络?'])
    // $0.30 / 0.15 = ¥2; the rates convert through the same fixed rate.
    assert.deepEqual(totals, ['3', '1', '2', '1.0M/¥2.00'])
    assert.deepEqual(pillsOf(nodes[0]), ['用户输入?0', '读取2', '写入1'])
    assert.deepEqual(pillsOf(nodes[1]), ['注入0', '压缩1', '剪枝0'])
    assert.deepEqual(pillsOf(nodes[3]), ['read2', '其他 +0'])
    assert.deepEqual(rowsOf(nodes[4]), ['当前 Agent1.0M/¥2.00', '子 Agent × 0?0/—'])
    assert.equal(nodes[2].querySelector('.lc-flow-label')?.textContent, '当前会话')
    const selfRowsZh = queryAll(nodes[2], '.lc-flow-self-stats')
    assert.deepEqual(selfRowsZh.map(row => queryAll(row, '.lc-flow-kv i').map(el => el.textContent)), [['轮次', '步数'], ['技能加载', '模型回复']])
    assert.deepEqual(selfRowsZh.map(row => queryAll(row, '.lc-flow-kv b').map(el => el.textContent)), [['1', '1'], ['5', '4']])
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('含当前智能体及所有层级的子智能体'), 'the cost tip names the family scope too — all levels')
    assert.ok(costTip.includes('每百万 Token 价格'))
    assert.ok(costTip.includes('按 deepseek · deepseek-v4-flash 在 models.dev 的刊登价格如上。'))
    assert.ok(costTip.includes('人民币按 1 元 = 0.15 美元换算。'), 'the CNY display carries the conversion footnote')
    assert.ok(costTip.includes('缓存输入 ¥0.02'))
    assert.ok(costTip.includes('未缓存输入 ¥1.00'))
    assert.ok(costTip.includes('缓存写入 ¥1.00'))
    assert.ok(costTip.includes('输出 ¥4.00'))
    await m.unmount()
  })

  test('a book that has not landed yet keeps the cost figure dashed (the tokens still read)', async () => {
    setModelPricesLoader(() => new Promise(() => {}))
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '1.0M/—')
    assert.ok(!text(m.container).includes('unavailable'), 'a pending fetch is not a failure')
    await m.unmount()
  })

  test('a failed price fetch dashes the figure and notes the outage in the tip', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '1.0M/—')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('unavailable'))
    assert.ok(!costTip.includes('Per-1M-token rates'))
    await m.unmount()
  })

  test('a DeepSeek off bucket prices at book and the footnotes carry the peak scheme', async () => {
    const split: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    }
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: split,
      locale: 'en',
    }))
    await flush()
    // 1M at the doubled $0.3 peak miss rate + 2M at the $0.15 off-peak (book) rate.
    assert.ok(headsOf(m.container).totals[3] === '3.0M/$0.60')
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('Cache input $0.00'), 'the table lists the book rates once, whatever the billed buckets')
    assert.ok(costTip.includes('Uncached input $0.15'))
    assert.ok(costTip.includes('peak windows'), 'the peak-window footnote explains the bucket split')
    assert.ok(!costTip.includes('|'))
    await m.unmount()
  })

  test('a session whose models the book cannot price notes the outage too', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'future-provider': { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '1/—')
    assert.ok(text(queryAll(m.container, '.lc-stat-tip')[1]).includes('unavailable'))
    await m.unmount()
  })

  test('a hostile cost branch is skipped by the tooltip rows, not fatal', async () => {
    const hostile = {
      junk: 5,
      'zai-coding-cn': {
        'glm-5.3-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    } as unknown as SessionCostUsage
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: hostile,
      locale: 'en',
    }))
    await flush()
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('junk'))
    // No row may show the peak|off-peak pair — that is DeepSeek's alone.
    const rows = queryAll(m.container, '.lc-stat-tip-row').map(el => text(el))
    assert.ok(rows.every(r => !r.includes('|')))
    // Both buckets bill at list price: 2M × $0.075 — no half-price off-peak.
    assert.ok(headsOf(m.container).totals[3] === '2.0M/$0.15')
    await m.unmount()
  })

  test('clicking the team card switches to the Fleet tab; the price link stays out of it', async () => {
    // The card this cell tallies lives on the Fleet tab now: the click activates that tab's own chrome.
    const bar = document.createElement('div')
    const fleet = document.createElement('button')
    fleet.setAttribute('role', 'tab')
    fleet.setAttribute('aria-selected', 'false')
    fleet.textContent = 'Fleet'
    let fleetClicks = 0
    fleet.addEventListener('click', () => { fleetClicks++ })
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.setAttribute('aria-selected', 'true')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.append(context, fleet)
    document.body.appendChild(bar)
    try {
      const m = await mount(h('div', { className: 'lc-root' },
        h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, locale: 'en' }),
      ))
      await flush()
      const team = query(m.container, '.lc-flow-team')
      await click(team)
      assert.equal(fleetClicks, 1, 'the click activates the Fleet tab')
      assert.equal(contextClicks, 0)
      // The price link inside the same cell is a navigation, never a tab switch.
      await click(query(m.container, 'a.lc-flow-head'))
      assert.equal(fleetClicks, 1)
      // Keyboard parity: Enter/Space activate, anything else stays quiet.
      team.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      assert.equal(fleetClicks, 2)
      team.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
      assert.equal(fleetClicks, 2)
      await m.unmount()
    } finally {
      bar.remove()
    }
  })

  test('without a Fleet tab on screen a click is a quiet no-op', async () => {
    // No tab bar at all.
    const bare = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, locale: 'en' }))
    await click(query(bare.container, '.lc-flow-team'))
    await bare.unmount()
    // A tab bar without a Fleet entry (the placement preference that drops the conversation tabs).
    const bar = document.createElement('div')
    const chat = document.createElement('button')
    chat.setAttribute('role', 'tab')
    chat.textContent = 'Chat'
    bar.appendChild(chat)
    document.body.appendChild(bar)
    try {
      const m = await mount(h('div', { className: 'lc-root' },
        h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, locale: 'en' }),
      ))
      await click(query(m.container, '.lc-flow-team'))
      await m.unmount()
    } finally {
      bar.remove()
    }
  })

  test('the second-row figures fire onFigureClick on click and keyboard', async () => {
    const calls: string[] = []
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      answers: 1,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      onFigureClick: (f) => { calls.push(f) },
    }))
    await flush()
    const cells = queryAll(m.container, '.lc-flow-kv-btn')
    assert.equal(cells.length, 2)
    assert.equal(cells[0].getAttribute('role'), 'button')
    assert.ok(cells[0].getAttribute('title') !== null && cells[0].getAttribute('title') !== '', 'the jump tip rides')
    await click(cells[0])
    assert.deepEqual(calls, ['skills'])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['skills', 'answers'])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['skills', 'answers'])
    await m.unmount()
  })

  test('without onFigureClick the figure cells stay inert', async () => {
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, answers: 1, files: NO_FILES, tools: [], locale: 'en' }))
    await flush()
    const cells = queryAll(m.container, '.lc-flow-kv')
    assert.ok(cells.every(c => c.getAttribute('role') === null && !c.className.includes('lc-flow-kv-btn')))
    await m.unmount()
  })
})

describe('StatsContext — the subagent split (injected seat)', () => {
  const SUB: SessionCostUsage = {
    'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('the family figure merges the subagent usage in; the split pills price each share alone', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 2 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    // Family total: 1M × $0.30 (the doubled peak) + 2M × $0.075; own share $0.30, the subagents' $0.15.
    assert.equal(headsOf(m.container).totals[3], '3.0M/$0.45')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent1.0M/$0.30', 'Subagents × 2?2.0M/$0.15'])
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 2?'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[1].includes('for deepseek · deepseek-v4-flash.'))
    assert.ok(tips[1].includes('for zhipuai · glm-5.3-flash.'))
    assert.ok(tips[2].includes('every descendant subagent session'))
    assert.ok(tips[2].includes('all levels'), 'the sub tip spells out the subtree covers all levels')
    assert.ok(tips[2].includes('for zhipuai · glm-5.3-flash.'), 'the sub tip carries its own price table')
    await m.unmount()
  })

  test('subagent usage alone (no own cost) still prices the family and dashes the own pill', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 1 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '2.0M/$0.15')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 1?2.0M/$0.15'])
    await m.unmount()
  })

  test('a DeepSeek-billing subagent surfaces the peak/off-peak note under both tips', async () => {
    const deepseekSub: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const Stats = makeStatsContext(kit, () => ({ usage: deepseekSub, count: 1 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    // The off bucket bills at book: 1M × $0.15.
    assert.equal(headsOf(m.container).totals[3], '1.0M/$0.15')
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[1].includes('peak windows'))
    assert.ok(tips[2].includes('peak windows'), 'the sub tip explains the scheme its own figure rides')
    await m.unmount()
  })

  test('a sub usage the book cannot price dashes the sub pill and notes the outage in its tip', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: { future: { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, count: 1 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    // The family's own model still prices: $0.30 (the doubled peak). The
    // unpriceable sub branch merges in (pricing zero) but cannot lift the
    // total — the sub cost dashes; its single token still reads.
    assert.equal(headsOf(m.container).totals[3], '1.0M/$0.30')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent1.0M/$0.30', 'Subagents × 1?1/—'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[2].includes('unavailable'))
    await m.unmount()
  })

  test('a null seat keeps the figure dashed with the ledger zeroed and no outage notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '0/—')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 0?0/—'])
    assert.ok(!text(m.container).includes('unavailable'))
    await m.unmount()
  })
})

describe('StatsContext — the real subagent-cost seat (makeSubagentCost)', () => {
  /** A well-formed slim head with (or without) a cost usage. */
  function head(cost?: SessionCostUsage): ContextTimeline {
    return {
      ok: true,
      contextWindow: 1000,
      current: { system: 10, tools: 10, user: 80, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100 },
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
      ...(cost !== undefined ? { cost } : {}),
    }
  }

  /** A sessions face double with the list-feed contract (agentGraph.spec's shape). */
  class FakeSessions {
    private listeners = new Set<() => void>()
    state: unknown
    constructor(byId: Record<string, unknown>) {
      this.state = { byId }
    }
    readonly list = {
      getSnapshot: (): unknown => this.state,
      subscribe: (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
    setState(byId: Record<string, unknown>): void {
      this.state = { byId }
      for (const fn of this.listeners) fn()
    }
  }

  function makeSeat(byId: Record<string, unknown>): { seat: (sessionId: string | undefined) => SubagentStats; face: FakeSessions } {
    const face = new FakeSessions(byId)
    const ctx = new TestClientCtx({ services: { sessions: face } })
    return { seat: makeSubagentCost(asClientCtx(ctx), makeAgentHeads()), face }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('warm rows fold live; cold rows fetch once and land; snapshot ticks never refetch', async () => {
    const calls: string[] = []
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // Hold the read until the warm-only paint is asserted.
      return await new Promise((resolve) => { release = resolve })
    })
    const SUB_WARM: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
      cold: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    // The warm row's usage prices while the cold read is still in flight.
    assert.equal(headsOf(m.container).totals[3], '2.0M/$0.15')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 2?2.0M/$0.15'])
    assert.deepEqual(calls, ['cold'], 'only the timeline-less relative fetched')
    // Both descendants count in the ledger's subtree row, cold included.
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 2?'])
    // A snapshot tick while the read is in flight re-attaches the SAME
    // pending read; when it lands, the duplicate settle bails on identity.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
        cold: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    // The cold read lands: its $0.15 merges into the family and the sub share.
    await act(async () => {
      release?.({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 1,
            head: head({ 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }),
            requests: [],
            events: [],
            nodes: [],
            droppedNodes: 0,
            archive: [],
          },
        }),
      })
    })
    await flush()
    assert.equal(headsOf(m.container).totals[3], '4.0M/$0.30')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 2?4.0M/$0.30'])
    await m.unmount()
  })

  test('a failing cold fetch degrades the card without crashing or retrying', async () => {    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('transport down')
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      cold: { parentId: 'root', updatedAt: 2 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['cold'])
    assert.equal(headsOf(m.container).totals[3], '0/—')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 1?0/—'])
    // The cold descendant still counts in the ledger's subtree row — a subagent is one whether or not its usage priced.
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 1?'])
    // A later snapshot tick re-folds the subtree; the sticky failure never re-fetches.
    await act(async () => {
      face.setState({ root: { running: false, updatedAt: 1 }, cold: { parentId: 'root', updatedAt: 2 } })
    })
    await flush()
    assert.deepEqual(calls, ['cold'])
    await m.unmount()
  })

  test('a headless detail answer (or a null value) lands nothing and never retries', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // The head is optional on the payload; a null value answers absence.
      const headless = { rev: 1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: calls.length === 1 ? headless : null }),
      }
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      headless: { parentId: 'root', updatedAt: 2 },
      absent: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    // Neither read carried a head: nothing lands, the figures stay zeroed, no throw.
    assert.equal(headsOf(m.container).totals[3], '0/—')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 2?0/—'])
    // A later tick re-attaches to the settled nulls without re-fetching.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        headless: { parentId: 'root', updatedAt: 2 },
        absent: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    await m.unmount()
  })

  test('without the sessions face the seat prices nothing', async () => {
    const ctx = new TestClientCtx()
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads()))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '0/—')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 0?0/—'])
    await m.unmount()
  })

  test('an absent session id folds nothing (and fetches nothing)', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('must not fetch')
    })
    const face = new FakeSessions({ root: { running: false, updatedAt: 1 }, kid: { parentId: 'root', updatedAt: 2 } })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads()))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(calls, [])
    assert.equal(headsOf(m.container).totals[3], '0/—')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0/—', 'Subagents × 0?0/—'])
    await m.unmount()
  })
})


import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeStatsContext, makeSubagentCost } from '../../../src/client/components/statsContext'
import type { StatsEventKind, SubagentStats } from '../../../src/client/components/statsContext'
import { DICT_EN } from '../../../src/client/i18n'
import { nameColorOf } from '../../../src/client/nameColor'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { invalidate, resetInvalidations } from '../../../src/client/invalidation'
import type { ContextTimeline, CostPriceFace, SessionCostRead, SessionCostUsage } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const NO_SUB = (): SubagentStats => ({ usage: null, count: 0, costRead: null })
const StatsContext = makeStatsContext(kit, NO_SUB)
const StatsContextZh = makeStatsContext(kitZh, NO_SUB)

const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}

const FACE_FLASH: CostPriceFace = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  rate: { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 },
  via: 'direct',
  confidence: 'high',
}

const FACE_GLM: CostPriceFace = {
  provider: 'zhipuai',
  model: 'glm-5.3-flash',
  rate: { hit: 0.015, miss: 0.075, write: 0, out: 0.25 },
  via: 'direct',
  confidence: 'high',
}

const OWN_READ: SessionCostRead = { usd: 0.3, ready: true, faces: [FACE_FLASH] }

const SUB_READ: SessionCostRead = { usd: 0.15, ready: true, faces: [FACE_GLM] }

const NO_FILES = { reads: 0, writes: 0, searches: 0, images: 0 }
const NO_COUNTS = { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 }

function visibleChipsOf(row: HTMLElement): HTMLElement[] {
  return queryAll(row, '.lc-ledger-chip').filter(el => el.closest('.lc-ledger-gauge') === null)
}

function chipsOf(row: HTMLElement): string[] {
  return visibleChipsOf(row)
    .map(el => (el.querySelector('.lc-ledger-chip-label')?.textContent ?? '') + (el.querySelector('b')?.textContent ?? ''))
}

function costCellsOf(container: HTMLElement): string[] {
  return queryAll(container, '.lc-ledger-team .lc-strip-cell').map(el =>
    (el.querySelector('i')?.textContent ?? '') + (el.querySelector('.lc-strip-pair')?.textContent ?? ''),
  )
}

function costTipOf(container: HTMLElement, scope: 'team' | 'own' | 'sub'): string {
  const index = scope === 'team' ? 0 : scope === 'own' ? 1 : 2
  return text(queryAll(container, '.lc-ledger-team .lc-stat-tip')[index])
}

describe('StatsContext', () => {
  function stubWidths(chipWidth: number, moreWidth: number, rowWidth: number): () => void {
    const real = Element.prototype.getBoundingClientRect
    const rect = (w: number): DOMRect => ({ width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const isChip = this.classList.contains('lc-ledger-chip')
      const isRow = this.classList.contains('lc-ledger-chips')
      if (!isChip && !isRow) return real.call(this)
      if (isRow) return rect(rowWidth)
      return rect(this.classList.contains('lc-ledger-chip-more') ? moreWidth : chipWidth)
    }
    return () => { Element.prototype.getBoundingClientRect = real }
  }

  type StatsProps = Parameters<typeof StatsContext>[0]

  test('each lane folds its chip tail at the measured width and spells out every chip when wide', async () => {
    const lanes: { selector: string; props: Partial<StatsProps>; cases: (readonly [number, string[]])[] }[] = [
      {
        selector: '.lc-ledger-out-chips',
        props: { tools: [['read', 8], ['bash', 3], ['grep', 2]] },
        cases: [[260, ['read8', 'bash3', '+1 more']], [320, ['read8', 'bash3', 'grep2']], [900, ['read8', 'bash3', 'grep2']]],
      },
      {
        selector: '.lc-ledger-in-body2',
        props: { commands: { runs: 9, top: [['python3', 3], ['git', 2], ['grep', 2], ['node', 1], ['npm', 1]] } },
        cases: [[260, ['python33', 'git2', '+3 more']], [900, ['python33', 'git2', 'grep2', 'node1', 'npm1']]],
      },
    ]
    for (const lane of lanes) {
      for (const [rowWidth, expected] of lane.cases) {
        const restore = stubWidths(100, 40, rowWidth)
        try {
          const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', ...lane.props }))
          await flush()
          assert.deepEqual(chipsOf(query(m.container, lane.selector)), expected)
          await m.unmount()
        } finally {
          restore()
        }
      }
    }
  })

  test('a changed tally re-fits the row to the same run', async () => {
    const restore = stubWidths(100, 40, 260)
    try {
      const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, locale: 'en', tools: [['read', 8], ['bash', 3], ['grep', 2]] }))
      await flush()
      assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-out-chips')), ['read8', 'bash3', '+1 more'])
      await m.update(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, locale: 'en', tools: [['read', 8], ['edit', 3], ['glob', 2]] }))
      assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-out-chips')), ['read8', 'edit3', '+1 more'])
      await m.unmount()
    } finally {
      restore()
    }
  })

  test('the ledger paints the two lanes, the KPI row with its events tile, and the Team costs', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1, skills: 2 },
      humanInputs: 7,
      answers: 3,
      toolCalls: 12,
      files: { reads: 9, writes: 2, searches: 4, images: 1 },
      tools: [['read', 8], ['bash', 3], ['grep', 2], ['edit', 1], ['glob', 1]],
      commands: { runs: 626, top: [['python3', 212]] },
      cost: COST,
      costRead: OWN_READ,
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(queryAll(m.container, '.lc-ledger-total').map(el => el.textContent), ['23', '12', '626', '1.0M/$0.30'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-body2')), ['python3212'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-chips')), ['User?7', 'Read9', 'Write2', 'Search4', 'Image1'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-out-chips')), ['read8', 'bash3', 'grep2', 'edit1', 'glob1'])
    const inertCmdChip = query(m.container, '.lc-ledger-in-body2 .lc-ledger-chip')
    assert.equal(inertCmdChip.getAttribute('role'), null, 'the command chip stays inert without the relay')
    assert.equal(inertCmdChip.getAttribute('title'), 'python3', 'the name rides the native title')
    assert.equal(queryAll(m.container, '.lc-ledger-out-body2 > .lc-strip-cell').length, 2, 'Current Agent and Subagents each hold one cost row')
    assert.equal(queryAll(m.container, '.lc-ledger-out-body2 .lc-ledger-chip').length, 0, 'the cost rows replace the roster chips')
    const core = query(m.container, '.lc-core')
    assert.deepEqual(queryAll(core, '.lc-core-kv:not(.lc-core-kv-events)').map(el => (el.querySelector('b')?.textContent ?? '') + (el.querySelector('i')?.textContent ?? '')), ['3Turns', '4Steps', '2Skill Loads', '3Answers'])
    assert.equal(queryAll(m.container, '.lc-core-kv-events .lc-kind').length, 3)
    assert.equal(queryAll(m.container, '.lc-core-kv-events .lc-kind.lc-ledger-chip-dim').length, 0)
    assert.deepEqual(costCellsOf(m.container), ['Fleet?1.0M/$0.30', 'Current Agent?1.0M/$0.30', 'Subagents × 0?—/—'])
    const subCell = queryAll(m.container, '.lc-ledger-out-body2 > .lc-strip-cell')[1]
    assert.equal(queryAll(subCell, '.lc-strip-pair b').length, 0, 'a zero-count subagent row renders its placeholder pair as plain text')
    assert.equal(queryAll(m.container, '.lc-ledger-team-count').length, 0, 'a zero count stays plain label text')
    await m.unmount()
  })

  test('absent counters and cost degrade to zeros and dimmed chips', async () => {
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', }))
    await flush()
    assert.deepEqual(queryAll(m.container, '.lc-ledger-total').map(el => el.textContent), ['0', '0', '0', '0/—'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-chips')), ['User?0', 'Read0', 'Write0'], 'search/image chips only when they happened')
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-out-chips')), ['+0 more'], 'an empty tool lane keeps the zero chip, so the lane still reads as a figure')
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-body2')), [DICT_EN['stats.laneEmpty']], 'an empty command lane keeps its own empty chip')
    assert.equal(queryAll(m.container, '.lc-ledger-in-body2 .lc-ledger-chip-more').length, 0, 'no command overflow control appears without extra programs')
    assert.equal(queryAll(m.container, '.lc-ledger-in-chips .lc-ledger-chip-dim').length, 3, 'every zero chip dims')
    assert.deepEqual(costCellsOf(m.container), ['Fleet?0/—', 'Current Agent?0/—', 'Subagents × 0?—/—'])
    assert.equal(queryAll(m.container, '.lc-core-kv-events .lc-kind.lc-ledger-chip-dim').length, 3, 'the zero event kinds dim too')
    await m.unmount()

    const tallied = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [['read', 8], ['bash', 3]], locale: 'en', }))
    await flush()
    assert.deepEqual(queryAll(tallied.container, '.lc-ledger-total').map(el => el.textContent)[1], '11')
    assert.deepEqual(chipsOf(query(tallied.container, '.lc-ledger-out-chips')), ['read8', 'bash3'], 'two tools chip out, with no zero chip after them')
    await tallied.unmount()
  })

  test('the cost bubble lists the host price faces with their billed rates', async () => {
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: OWN_READ, locale: 'en', }))
    await flush()
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.equal(tips.length, 4, 'the user chip plus the three team-cost tips')
    assert.ok(tips.includes(DICT_EN['stats.userTip']), 'the user chip tip explains its tally')
    const costTip = costTipOf(m.container, 'team')
    for (const part of [
      'every descendant subagent session', 'billed total', 'Per-1M-token rates:',
      'Priced as listed on models.dev for deepseek · deepseek-v4-flash.',
      'Cache input $0.00', 'Uncached input $0.15', 'Cache write $0.15', 'Output $0.60',
      'peak windows', 'off-peak rates', 'twice the listed rate',
    ]) assert.ok(costTip.includes(part), `the team tip carries: ${part}`)
    assert.ok(!costTip.includes('|'), 'no peak|off pairs — the footnotes carry the scheme')
    const ownTip = costTipOf(m.container, 'own')
    assert.ok(ownTip.includes('current agent session alone'), 'the own tip scopes the figure to the session itself')
    assert.ok(ownTip.includes('Per-1M-token rates:'))
    assert.ok(ownTip.includes('for deepseek · deepseek-v4-flash.'))
    const links = queryAll(m.container, 'a.lc-strip-link')
    assert.equal(links.length, 1, 'the family figure is the only link')
    assert.equal(links[0].getAttribute('href'), 'https://models.dev/providers/deepseek/')
    assert.equal(links[0].getAttribute('target'), '_blank')
    assert.ok(links[0].textContent.includes('$0.30'), 'the link keeps the pair body')
    await m.unmount()

    const split: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    }
    const splitMount = await mount(h(StatsContext, {
      counts: NO_COUNTS, files: NO_FILES, tools: [], cost: split,
      costRead: { usd: 0.6, ready: true, faces: [FACE_FLASH] }, locale: 'en',
    }))
    await flush()
    assert.deepEqual(costCellsOf(splitMount.container)[0], 'Fleet?3.0M/$0.60')
    const splitTip = costTipOf(splitMount.container, 'team')
    assert.ok(splitTip.includes('Cache input $0.00'), 'the table lists the host rate once, whatever the billed buckets')
    assert.ok(splitTip.includes('Uncached input $0.15'))
    assert.ok(splitTip.includes('peak windows'), 'the peak-window footnote explains the bucket split')
    assert.ok(!splitTip.includes('|'))
    await splitMount.unmount()
  })

  test('a non-DeepSeek session never sees DeepSeek-specific notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      costRead: { usd: 0.15, ready: true, faces: [FACE_GLM] },
      locale: 'en',
    }))
    await flush()
    const costTip = costTipOf(m.container, 'team')
    assert.ok(costTip.includes('Priced as listed on models.dev for zhipuai · glm-5.3-flash.'))
    assert.ok(!costTip.includes('DeepSeek'), 'the DeepSeek scheme note stays out of other providers’ bubbles')
    assert.ok(costTip.includes('Uncached input $0.07'))
    assert.ok(!costTip.includes('Cache write'))
    await m.unmount()
  })

  test('a multi-provider scope keeps the family figure unlinked and names each resolved registry face', async () => {
    const two: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS, files: NO_FILES, tools: [], cost: two,
      costRead: { usd: 0.45, ready: true, faces: [FACE_FLASH, FACE_GLM] }, locale: 'en',
    }))
    await flush()
    assert.equal(queryAll(m.container, 'a.lc-strip-link').length, 0, 'two providers name their faces in the tooltip instead')
    const costTip = costTipOf(m.container, 'team')
    assert.ok(costTip.includes('for deepseek · deepseek-v4-flash.'))
    assert.ok(costTip.includes('for zhipuai · glm-5.3-flash.'))
    assert.deepEqual(costCellsOf(m.container)[0], 'Fleet?3.0M/$0.45')
    await m.unmount()
  })

  test('the zh locale localizes the card and prices the cost in CNY at 1 CNY = 0.15 USD', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0, skills: 5 },
      answers: 4,
      files: { reads: 2, writes: 1, searches: 0, images: 0 },
      tools: [['read', 2]],
      cost: COST,
      costRead: OWN_READ,
      locale: 'zh',
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文统计'))
    assert.deepEqual(queryAll(m.container, '.lc-ledger-label').map(el => el.textContent), ['输入输出', '工具调用', '命令执行', '编队'])
    assert.deepEqual(queryAll(m.container, '.lc-ledger-total').map(el => el.textContent), ['3', '2', '0', '1.0M/¥2.00'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-chips')), ['用户?0', '读取2', '写入1'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-out-chips')), ['read2'])
    const core = query(m.container, '.lc-core')
    assert.deepEqual(queryAll(core, '.lc-core-kv:not(.lc-core-kv-events)').map(el => (el.querySelector('b')?.textContent ?? '') + (el.querySelector('i')?.textContent ?? '')), ['1轮次', '1步数', '5技能加载', '4模型回复'])
    const costTip = costTipOf(m.container, 'team')
    for (const part of [
      '含当前智能体及所有层级的子智能体', '每百万 Token 价格', '挂牌价为谷时价', '2 倍计费',
      '按 deepseek · deepseek-v4-flash 在 models.dev 的刊登价格如上。',
      '人民币按 1 元 = 0.15 美元换算。', '缓存输入 ¥0.02', '未缓存输入 ¥1.00', '缓存写入 ¥1.00', '输出 ¥4.00',
    ]) assert.ok(costTip.includes(part), `the zh team tip carries: ${part}`)
    await m.unmount()
  })

  test('the lower lanes show commands, family costs, and jump command and tool chips', async () => {
    const SUB: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const picks: string[] = []
    const toolPicks: string[] = []
    const programs = [['python3', 212], ['git', 88], ['grep', 40], ['node', 20], ['npm', 10]] as const
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 5, costRead: SUB_READ }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [['read', 8]],
      commands: { runs: 626, top: programs },
      cost: COST,
      costRead: OWN_READ,
      locale: 'en',
      onToolPick: (tool) => { toolPicks.push(tool) },
      onCommandPick: (program) => { picks.push(program) },
    }))
    await flush()
    assert.deepEqual(queryAll(m.container, '.lc-ledger-total').map(el => el.textContent), ['0', '8', '626', '3.0M/$0.45'])
    assert.deepEqual(chipsOf(query(m.container, '.lc-ledger-in-body2')), programs.map(([name, n]) => name + String(n)), 'every program fits the unmeasured row')
    assert.equal(queryAll(m.container, '.lc-ledger-out-body2 .lc-ledger-chip').length, 0, 'no roster chips remain below Team')
    assert.deepEqual(costCellsOf(m.container), ['Fleet?3.0M/$0.45', 'Current Agent?1.0M/$0.30', 'Subagents × 5?2.0M/$0.15'])
    const subCell = queryAll(m.container, '.lc-ledger-out-body2 > .lc-strip-cell')[1]
    assert.deepEqual(queryAll(subCell, '.lc-strip-pair b').map(el => el.textContent), ['2.0M', '$0.15'], 'a counted subagent row bolds both figures')
    assert.equal(query(m.container, '.lc-ledger-team-count').textContent, '× 5', 'a positive count bolds as its own figure')
    const cmdChips = visibleChipsOf(query(m.container, '.lc-ledger-in-body2'))
    assert.equal(cmdChips[0].getAttribute('title'), DICT_EN['stats.commandJump'])
    assert.deepEqual(
      cmdChips.map(el => [el.querySelector('.lc-ledger-chip-label')?.textContent, el.querySelector('i')?.style.background]),
      programs.map(([name]) => [name, nameColorOf(name)]),
      'programs keep the shared name-hash color',
    )
    await click(cmdChips[2])
    cmdChips[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(picks, ['grep', 'git'])
    const toolChips = queryAll(m.container, '.lc-ledger-out-chips .lc-ledger-chip')
    assert.equal(toolChips[0].getAttribute('title'), DICT_EN['stats.toolJump'])
    await click(toolChips[0])
    toolChips[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    toolChips[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    assert.deepEqual(toolPicks, ['read', 'read'])
    await m.unmount()
  })

  test('a ready read without a usd figure dashes the cost without claiming an outage; a non-ready read notes the outage', async () => {
    const ready = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: { usd: null, ready: true }, locale: 'en' }))
    await flush()
    assert.deepEqual(costCellsOf(ready.container)[0], 'Fleet?1.0M/—')
    assert.ok(!text(ready.container).includes('unavailable'), 'a usd-less ready read is not an outage')
    await ready.unmount()

    const failed = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: { usd: null, ready: false }, locale: 'en' }))
    await flush()
    assert.deepEqual(costCellsOf(failed.container)[0], 'Fleet?1.0M/—')
    const costTip = costTipOf(failed.container, 'team')
    assert.ok(costTip.includes('unavailable'))
    assert.ok(!costTip.includes('Per-1M-token rates'))
    await failed.unmount()
  })

  test('an unpriced model names the miss; an inferred family price says it is a reference estimate', async () => {
    const unpriced = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'future-provider': { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      costRead: { usd: null, ready: true, misses: [{ provider: 'future-provider', model: 'mystery-model', reason: 'model-unknown' }] },
      locale: 'en',
    }))
    await flush()
    assert.ok(costCellsOf(unpriced.container)[0].startsWith('Fleet?1/—'))
    assert.ok(costTipOf(unpriced.container, 'team').includes('Not priced: future-provider / mystery-model'))
    assert.ok(!costTipOf(unpriced.container, 'team').includes('unavailable'), 'a ready catalog with one unknown model is not an outage')
    await unpriced.unmount()

    const inferred = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'future-provider': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      costRead: { usd: 0.0000015, ready: true, faces: [{ ...FACE_FLASH, via: 'family', confidence: 'medium' }] },
      locale: 'en',
    }))
    await flush()
    assert.ok(costCellsOf(inferred.container)[0].startsWith('Fleet?1/$'))
    assert.ok(costTipOf(inferred.container, 'team').includes('reference estimate'))
    await inferred.unmount()
  })

  test('an ambiguous host face names the disagreement instead of an outage', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { gateway: { x: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      costRead: { usd: null, ready: true, misses: [{ provider: 'gateway', model: 'x', reason: 'ambiguous', candidates: 2 }] },
      locale: 'en',
    }))
    await flush()
    const costTip = costTipOf(m.container, 'team')
    assert.ok(costTip.includes('has 2 models.dev entries with different rates'))
    assert.ok(!costTip.includes('unavailable'), 'an ambiguous catalog face is not an outage')
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
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: hostile, costRead: { usd: 0.15, ready: true, faces: [FACE_GLM] }, locale: 'en', }))
    await flush()
    const costTip = costTipOf(m.container, 'team')
    assert.ok(costTip.includes('glm-5.3-flash'))
    assert.ok(!costTip.includes('junk'))
    assert.ok(!costTip.includes('|'))
    assert.deepEqual(costCellsOf(m.container)[0], 'Fleet?2.0M/$0.15')
    await m.unmount()
  })

  test('the Fleet section hands its jump to the caller; the price link stays out of it', async () => {
    let opened = 0
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: OWN_READ, locale: 'en', onTeamClick: () => { opened += 1 }, }))
    await flush()
    const head = query(m.container, '.lc-ledger-team-head')
    assert.equal(head.getAttribute('role'), null, 'the header is not a button wrapping the provider link')
    const open = query(m.container, 'button.lc-ledger-team-open')
    await click(open)
    assert.equal(opened, 1)
    await click(head)
    assert.equal(opened, 2, 'the header body opens the view too')
    await click(query(m.container, 'a.lc-strip-link'))
    assert.equal(opened, 2, 'the provider link keeps its own activation')
    await click(open)
    assert.equal(opened, 3)
    const rows = queryAll(m.container, '.lc-ledger-out-body2 > .lc-strip-cell')
    assert.deepEqual(rows.map(el => el.tagName), ['BUTTON', 'BUTTON'], 'each split row is a Fleet jump')
    await click(rows[0])
    assert.equal(opened, 4)
    await click(rows[1])
    assert.equal(opened, 5)
    await m.unmount()
  })

  test('without the relay the Fleet section, hinge figures, and chips stay inert', async () => {
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, answers: 1, humanInputs: 1, files: NO_FILES, tools: [], cost: COST, locale: 'en' }))
    await flush()
    const cost = query(m.container, '.lc-ledger-team-head')
    assert.equal(cost.getAttribute('role'), null)
    assert.equal(cost.getAttribute('tabindex'), null)
    assert.equal(queryAll(m.container, '.lc-ledger-team-open').length, 0, 'no dead button without the view relay')
    assert.equal(queryAll(m.container, '.lc-ledger-out-body2 button').length, 0, 'the split rows stay figures too')
    await click(cost)
    const cells = queryAll(m.container, '.lc-core-kv')
    assert.ok(cells.every(c => c.getAttribute('role') === null && !c.className.includes('lc-core-kv-btn')))
    const events = queryAll(m.container, '.lc-core-kv-event')
    assert.ok(events.every(e => e.getAttribute('role') === null && !e.className.includes('lc-core-kv-event-btn')))
    const tile = query(m.container, '.lc-core-kv-events')
    assert.ok(!tile.className.includes('lc-core-kv-events-btn'), 'no hover affordance without the relay')
    assert.equal(tile.getAttribute('role'), null)
    assert.equal(query(tile, 'i').getAttribute('role'), null, 'the label carries no dead wire')
    const chips = queryAll(m.container, '.lc-ledger-chip')
    assert.ok(chips.every(c => c.getAttribute('role') === null && !c.className.includes('lc-ledger-chip-btn')))
    await m.unmount()
  })

  test('the events tile reveals the card as a whole, and each kind narrows it on click and keyboard', async () => {
    const opened: (StatsEventKind | null)[] = []
    const m = await mount(h(StatsContext, {
      counts: { turns: 1, steps: 2, injects: 3, compactions: 2, prunes: 1, skills: 0 },
      files: NO_FILES, tools: [], locale: 'en',
      onEventsClick: (kind) => { opened.push(kind) },
    }))
    await flush()
    const tile = query(m.container, '.lc-core-kv-events')
    assert.ok(tile.className.includes('lc-core-kv-events-btn'), 'the tile body reads as one jump')
    assert.equal(tile.getAttribute('role'), null, 'the tile keeps the pills’ semantics; the label carries the wire')
    const label = query(tile, '.lc-core-kv-events-open')
    assert.equal(label.getAttribute('role'), 'button')
    assert.equal(label.getAttribute('title'), DICT_EN['stats.eventsJump'])
    await click(tile)
    assert.deepEqual(opened, [null], 'the tile body reveals the card without narrowing its lens')
    await click(label)
    assert.deepEqual(opened, [null, null], 'the label fires once, not through the tile too')
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(opened, [null, null, null])

    const entries = queryAll(m.container, '.lc-core-kv-event-btn')
    assert.equal(queryAll(m.container, '.lc-core-kv-sep').length, 2, 'the slash separators hold the three kinds apart')
    assert.deepEqual(entries.map(el => el.getAttribute('data-kind')), ['inject', 'compaction', 'prune'])
    assert.equal(entries[0].getAttribute('title'), DICT_EN['stats.eventsKindJump'].replace('{kind}', 'Inject'))
    await click(entries[0])
    assert.deepEqual(opened, [null, null, null, 'inject'], 'a pill jump stays single')
    entries[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(opened, [null, null, null, 'inject', 'prune'])
    entries[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    assert.deepEqual(opened, [null, null, null, 'inject', 'prune', 'compaction'])
    entries[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    assert.deepEqual(opened, [null, null, null, 'inject', 'prune', 'compaction'])
    await m.unmount()
  })

  test('the hinge figures fire their jump on click and keyboard', async () => {
    const calls: string[] = []
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, answers: 1, files: NO_FILES, tools: [], locale: 'en', onJump: (j) => { calls.push(j) }, }))
    await flush()
    const cells = queryAll(m.container, '.lc-core-kv-btn')
    assert.equal(cells.length, 4)
    assert.equal(cells[0].getAttribute('role'), 'button')
    assert.equal(cells[0].getAttribute('title'), DICT_EN['stats.sessionJump'])
    assert.equal(cells[1].getAttribute('title'), DICT_EN['stats.sessionJump'])
    await click(cells[0])
    assert.deepEqual(calls, ['turns'])
    await click(cells[1])
    assert.deepEqual(calls, ['turns', 'steps'])
    assert.equal(cells[2].getAttribute('title'), DICT_EN['stats.skillsJump'])
    await click(cells[2])
    assert.deepEqual(calls, ['turns', 'steps', 'skills'])
    cells[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['turns', 'steps', 'skills', 'answers'])
    cells[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['turns', 'steps', 'skills', 'answers'])
    await m.unmount()
  })

  test('the I/O chips fire their jumps on click and keyboard, and the band wedges pick the same jump', async () => {
    const calls: string[] = []
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, humanInputs: 2, files: { reads: 18, writes: 13, searches: 4, images: 9 }, tools: [], locale: 'en', onJump: (j) => { calls.push(j) }, }))
    await flush()
    const chips = queryAll(m.container, '.lc-ledger-in-chips .lc-ledger-chip')
    assert.deepEqual(chips.map(el => el.getAttribute('title')),
      [null, DICT_EN['stats.filesJump'], DICT_EN['stats.filesJump'], DICT_EN['stats.filesJump'], DICT_EN['stats.filesJump']])
    assert.ok(text(chips[0]).includes(DICT_EN['stats.userTip']), 'the metric bubble stays')
    assert.ok(chips.every(el => el.getAttribute('role') === 'button'), 'every chip jumps')
    await click(chips[0])
    await click(chips[1])
    assert.deepEqual(calls, ['inputs', 'read'])
    chips[3].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['inputs', 'read', 'search'])
    chips[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['inputs', 'read', 'search', 'image'])
    chips[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    assert.deepEqual(calls, ['inputs', 'read', 'search', 'image'])
    await m.unmount()
  })

})

describe('StatsContext — the subagent split (injected seat)', () => {
  const SUB: SessionCostUsage = {
    'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('the family figure merges the subagent usage in; the split cells price each share alone', async () => {
    for (const own of [OWN_READ, undefined] as const) {
      const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 2, costRead: SUB_READ }))
      const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], ...(own !== undefined ? { cost: COST, costRead: own } : {}), locale: 'en' }))
      await flush()
      assert.deepEqual(costCellsOf(m.container), own !== undefined
        ? ['Fleet?3.0M/$0.45', 'Current Agent?1.0M/$0.30', 'Subagents × 2?2.0M/$0.15']
        : ['Fleet?2.0M/$0.15', 'Current Agent?0/—', 'Subagents × 2?2.0M/$0.15'])
      if (own !== undefined) {
        const teamTip = costTipOf(m.container, 'team')
        assert.ok(teamTip.includes('for deepseek · deepseek-v4-flash.'))
        assert.ok(teamTip.includes('for zhipuai · glm-5.3-flash.'))
        const ownTip = costTipOf(m.container, 'own')
        assert.ok(ownTip.includes('for deepseek · deepseek-v4-flash.'))
        assert.ok(!ownTip.includes('glm-5.3-flash'), 'the own tip never borrows a subagent face')
        const subTip = costTipOf(m.container, 'sub')
        for (const part of ['every descendant subagent session', 'all levels', 'for zhipuai · glm-5.3-flash.']) {
          assert.ok(subTip.includes(part), `the sub tip carries: ${part}`)
        }
      }
      await m.unmount()
    }
  })

  test('dedupes repeated faces and misses across the own and sub reads', async () => {
    const MISS = { provider: 'future', model: 'mystery', reason: 'model-unknown' as const }
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 1, costRead: { usd: 0.1, ready: true, faces: [FACE_FLASH, FACE_GLM], misses: [MISS] } }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      costRead: { usd: 0.3, ready: true, faces: [FACE_FLASH], misses: [MISS] },
      locale: 'en',
    }))
    await flush()
    const teamTip = costTipOf(m.container, 'team')
    assert.equal(teamTip.split('for deepseek · deepseek-v4-flash.').length - 1, 1, 'the shared face appears once')
    assert.equal(teamTip.split('Not priced: future / mystery').length - 1, 1, 'the shared miss appears once')
    assert.equal(queryAll(m.container, 'a.lc-strip-link').length, 0, 'two priced providers keep the figure unlinked')
    await m.unmount()
  })

  test('a non-ready sub read dashes the family figure and notes the outage under both tips', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 2, costRead: { usd: 0.15, ready: false } }))
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: OWN_READ, locale: 'en' }))
    await flush()
    assert.deepEqual(costCellsOf(m.container), ['Fleet?3.0M/—', 'Current Agent?1.0M/$0.30', 'Subagents × 2?2.0M/—'])
    assert.ok(costTipOf(m.container, 'team').includes('unavailable'))
    assert.ok(costTipOf(m.container, 'sub').includes('unavailable'))
    await m.unmount()
  })

  test('a DeepSeek-billing subagent surfaces the peak/off-peak note under both tips', async () => {
    const deepseekSub: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const Stats = makeStatsContext(kit, () => ({ usage: deepseekSub, count: 1, costRead: { usd: 0.15, ready: true, faces: [FACE_FLASH] } }))
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', }))
    await flush()
    assert.deepEqual(costCellsOf(m.container)[0], 'Fleet?1.0M/$0.15')
    assert.ok(costTipOf(m.container, 'team').includes('peak windows'))
    assert.ok(costTipOf(m.container, 'sub').includes('peak windows'), 'the sub tip explains the scheme its own figure rides')
    await m.unmount()
  })

  test('a sub read the host cannot price dashes the sub cell and names the miss in its tip', async () => {
    const Stats = makeStatsContext(kit, () => ({
      usage: { future: { 'mystery-model': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      count: 1,
      costRead: { usd: null, ready: true, misses: [{ provider: 'future', model: 'mystery-model', reason: 'model-unknown' }] },
    }))
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, costRead: OWN_READ, locale: 'en', }))
    await flush()
    assert.deepEqual(costCellsOf(m.container), ['Fleet?1.0M/$0.30', 'Current Agent?1.0M/$0.30', 'Subagents × 1?1/—'])
    assert.ok(costTipOf(m.container, 'sub').includes('Not priced: future / mystery-model'))
    await m.unmount()
  })
})

describe('StatsContext — the real subagent-cost seat (makeSubagentCost)', () => {
  function head(cost?: SessionCostUsage, costRead?: SessionCostRead): ContextTimeline {
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
      ...(costRead !== undefined ? { costRead } : {}),
    }
  }

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
      return await new Promise((resolve) => { release = resolve })
    })
    const SUB_WARM: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const WARM_READ: SessionCostRead = { usd: 0.15, ready: true }
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      warm: { parentId: 'root', origin: 'subagent', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM, WARM_READ) } },
      cold: { parentId: 'root', origin: 'subagent', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'root', }))
    await flush()
    assert.deepEqual(costCellsOf(m.container), ['Fleet?2.0M/—', 'Current Agent?0/—', 'Subagents × 2?2.0M/—'], 'a missing member read dashes the family figure')
    assert.deepEqual(calls, ['cold'], 'only the timeline-less relative fetched')
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        warm: { parentId: 'root', origin: 'subagent', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM, WARM_READ) } },
        cold: { parentId: 'root', origin: 'subagent', updatedAt: 3 },
      })
    })
    await flush()
    await act(async () => {
      release?.({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 1,
            head: head(
              { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
              { usd: 0.15, ready: true },
            ),
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
    assert.deepEqual(costCellsOf(m.container), ['Fleet?4.0M/$0.30', 'Current Agent?0/—', 'Subagents × 2?4.0M/$0.30'])
    await m.unmount()
  })

  test('a pricing invalidation re-reads landed child heads that still lack a price', async () => {
    let round = 0
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(JSON.parse(String(init.body)))
      round++
      const read = round === 1 ? { usd: null, ready: false } : { usd: 0.2, ready: true }
      const value = {
        a: { head: head({ 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, read) },
        b: { head: head({ 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, read) },
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      a: { parentId: 'root', origin: 'subagent', updatedAt: 2 },
      b: { parentId: 'root', origin: 'subagent', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'root' }))
    await flush()
    await flush()
    assert.deepEqual(costCellsOf(m.container), ['Fleet?4.0M/—', 'Current Agent?0/—', 'Subagents × 2?4.0M/—'])
    assert.equal(calls.length, 1)
    await act(async () => {
      invalidate('pricing')
    })
    await flush()
    await flush()
    assert.equal(calls.length, 2, 'the unpriced landed heads were re-read')
    assert.deepEqual(costCellsOf(m.container), ['Fleet?4.0M/$0.40', 'Current Agent?0/—', 'Subagents × 2?4.0M/$0.40'])
    await act(async () => {
      invalidate('heads')
    })
    await flush()
    assert.equal(calls.length, 2)
    await act(async () => {
      invalidate('pricing')
    })
    await flush()
    assert.equal(calls.length, 2, 'priced heads stay landed')
    await act(async () => {
      face.setState({ root: { running: false, updatedAt: 1 }, a: { parentId: 'root', origin: 'subagent', updatedAt: 2 }, b: { parentId: 'root', origin: 'subagent', updatedAt: 3 } })
    })
    await flush()
    await m.unmount()
    resetInvalidations()
  })

  test('a failing cold fetch degrades the card without crashing or retrying', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('transport down')
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      cold: { parentId: 'root', origin: 'subagent', updatedAt: 2 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'root', }))
    await flush()
    assert.deepEqual(calls, ['cold'])
    assert.deepEqual(costCellsOf(m.container), ['Fleet?0/—', 'Current Agent?0/—', 'Subagents × 1?0/—'])
    await act(async () => {
      face.setState({ root: { running: false, updatedAt: 1 }, cold: { parentId: 'root', origin: 'subagent', updatedAt: 2 } })
    })
    await flush()
    assert.deepEqual(calls, ['cold'])
    await m.unmount()
  })

  test('a headless detail answer (or a null value) lands nothing and never retries', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(JSON.parse(String(init?.body)))
      const headless = { rev: 1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { headless: { head: headless } } }),
      }
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      headless: { parentId: 'root', origin: 'subagent', updatedAt: 2 },
      absent: { parentId: 'root', origin: 'subagent', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'root', }))
    await flush()
    assert.deepEqual(calls, [{ ids: ['headless', 'absent'] }, { sessionId: 'absent', head: true }], 'both cold children ride one batch; the missing head falls back to one detail read')
    assert.deepEqual(costCellsOf(m.container), ['Fleet?0/—', 'Current Agent?0/—', 'Subagents × 2?0/—'])
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        headless: { parentId: 'root', origin: 'subagent', updatedAt: 2 },
        absent: { parentId: 'root', origin: 'subagent', updatedAt: 3 },
      })
    })
    await flush()
    assert.equal(calls.length, 2, 'a landed null head never retries past the one detail fallback')
    await m.unmount()
  })

  test('the Subagents row counts the DESCENDANT subtree only', async () => {
    const { seat } = makeSeat({
      root: { running: false, updatedAt: 1, projectionValues: { contextTimeline: head() } },
      kid: { parentId: 'root', origin: 'subagent', updatedAt: 2, projectionValues: { contextTimeline: head(), subagent: { mode: 'one-shot', label: 'kid-label' } } },
      sib: { parentId: 'root', origin: 'subagent', updatedAt: 3, projectionValues: { contextTimeline: head(), subagent: { mode: 'one-shot', label: 'sibling-label' } } },
      grand: { parentId: 'kid', origin: 'subagent', updatedAt: 4, projectionValues: { contextTimeline: head(), subagent: { mode: 'one-shot', label: 'grand-label' } } },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'kid', }))
    await flush()
    assert.deepEqual(queryAll(m.container, '.lc-ledger-team .lc-strip-cell').map(el => text(el))[2].startsWith('Subagents × 1'), true, 'the count folds the subtree below the current session, never the parent or a sibling')
    await m.unmount()
  })

  test('without a sessions face or a session id the seat prices nothing and fetches nothing', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('must not fetch')
    })
    const face = new FakeSessions({ root: { running: false, updatedAt: 1 }, kid: { parentId: 'root', origin: 'subagent', updatedAt: 2 } })
    for (const [ctx, sessionId] of [
      [new TestClientCtx(), 'root'],
      [new TestClientCtx({ services: { sessions: face } }), undefined],
    ] as const) {
      const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads()))
      const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', ...(sessionId !== undefined ? { sessionId } : {}) }))
      await flush()
      assert.deepEqual(calls, [])
      assert.deepEqual(costCellsOf(m.container), ['Fleet?0/—', 'Current Agent?0/—', 'Subagents × 0?—/—'])
      await m.unmount()
    }
  })
})


describe('makeSubagentCost — batch head channel', () => {
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
  }

  afterEach(() => { vi.unstubAllGlobals() })

  function coldChild(id: string): unknown {
    return { parentId: 'root', origin: 'subagent', updatedAt: 2, id }
  }

  test('batches the cold relative heads in one read and survives a failed batch', async () => {
    const face = new FakeSessions({ root: { running: true, updatedAt: 1 }, a: coldChild('a'), b: coldChild('b') })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const calls: string[][] = []
    const heads = {
      headOf: () => Promise.resolve(null),
      headOfMany: (ids: readonly string[]) => {
        calls.push([...ids])
        return Promise.reject(new Error('offline'))
      },
    }
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), heads))
    const m = await mount(h(Stats, { counts: NO_COUNTS, files: NO_FILES, tools: [], locale: 'en', sessionId: 'root' }))
    await flush()
    assert.deepEqual(calls[0]?.slice().sort(), ['a', 'b'], 'both cold children ride one batch')
    assert.ok(text(m.container).length > 0)
    await m.unmount()
  })
})


describe('StatsContext chip width cache', () => {
  class PipeRO {
    static all: { el: HTMLElement; fire: () => void }[] = []
    private readonly cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) { this.cb = cb }
    observe(el: Element): void {
      PipeRO.all.push({ el: el as HTMLElement, fire: () => { this.cb([], this as unknown as ResizeObserver) } })
    }

    unobserve(): void {}
    disconnect(): void {}
  }

  function stubLane(chipWidth: number, moreWidth: number, rowWidth: number): () => void {
    const real = Element.prototype.getBoundingClientRect
    const rect = (w: number): DOMRect => ({ width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const isChip = this.classList.contains('lc-ledger-chip')
      const isRow = this.classList.contains('lc-ledger-chips')
      if (!isChip && !isRow) return real.call(this)
      if (isRow) return rect(rowWidth)
      return rect(this.classList.contains('lc-ledger-chip-more') ? moreWidth : chipWidth)
    }
    return () => { Element.prototype.getBoundingClientRect = real }
  }

  test('the width table is reused across row resizes and re-measured when the first chip shifts', async () => {
    vi.stubGlobal('ResizeObserver', PipeRO)
    const restore = stubLane(100, 40, 260)
    try {
      const m = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, locale: 'en', tools: [['read', 8], ['bash', 3], ['grep', 2]] }))
      const row = query(m.container, '.lc-ledger-out-chips') as HTMLElement
      const entry = PipeRO.all.find(e => e.el === row)
      assert.ok(entry !== undefined, 'the row width observer never attached')
      Object.defineProperty(row, 'clientWidth', { value: 260, configurable: true })
      entry.fire()
      await flush()
      assert.deepEqual(chipsOf(row), ['read8', 'bash3', '+1 more'], 'the first measured fit folds')
      entry.fire()
      await flush()
      assert.deepEqual(chipsOf(row), ['read8', 'bash3', '+1 more'], 'an unchanged width keeps the fitted row')
      restore()
      const wider = stubLane(100, 40, 320)
      Object.defineProperty(row, 'clientWidth', { value: 320, configurable: true })
      try {
        entry.fire()
        await flush()
        assert.deepEqual(chipsOf(row), ['read8', 'bash3', 'grep2'], 'the cached width table serves the wider row')
      } finally {
        wider()
      }
      const shifted = stubLane(170, 40, 320)
      Object.defineProperty(row, 'clientWidth', { value: 321, configurable: true })
      try {
        entry.fire()
        await flush()
        assert.deepEqual(chipsOf(row), ['read8', '+2 more'], 'a shifted first chip re-measures the whole table')
      } finally {
        shifted()
      }
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

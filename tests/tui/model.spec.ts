import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { translatorOf } from '../../src/tui/i18n'
import { statGrid } from '../../src/tui/sceneTabs'
import { eventMeta } from '../../src/tui/view'
import {
  eventRows, fileRows, headlineText, legendItems, nodeLabel, occupancyBars, occupancyOf, panelLayout, truncateStart, type Occupancy,
} from '../../src/tui/model'
import { T0, timelineFixture } from './helpers'

const t = translatorOf('en')
const cells = (text: string): number => Array.from(text).length

describe('occupancy', () => {
  test('the host usage anchors the headline so it matches the host footer', () => {
    const o = occupancyOf(timelineFixture(), { occupancy: { usedTokens: 81_400, contextWindow: 131_072 } })
    assert.ok(o !== null)
    assert.equal(o.tokens, 81_400)
    assert.equal(o.window, 131_072)
    assert.equal(o.pct, 62.1)
    assert.equal(o.parts.length, 7)
    assert.equal(headlineText(o, t), 'Context 62.1% · 81.4k/131.1k')
  })

  test('without host usage the fold anchors on the newest request, with the official breakdown when served', () => {
    const o = occupancyOf(timelineFixture(), { breakdown: { systemTokens: 900, toolsTokens: 1900, messageTokens: 1300 } })
    assert.ok(o !== null)
    assert.equal(o.tokens, 4100 + (4160 - 4140))
    assert.equal(o.window, 200_000)
    assert.equal(o.parts[0].raw, 900)
    assert.ok(o.reserve !== undefined)
    const windowless = occupancyOf(timelineFixture(), { occupancy: { usedTokens: 1000 } })
    assert.deepEqual([windowless?.tokens, windowless?.window], [1000, 200_000], 'the fold window stands in for an unreported one')
  })

  test('host usage alone (no projection yet) still yields a headline; nothing at all yields null', () => {
    const o = occupancyOf(null, { occupancy: { usedTokens: 500, contextWindow: 1000 } })
    assert.deepEqual(o, { tokens: 500, pct: 50, parts: [], window: 1000 })
    const bare = occupancyOf(null, { occupancy: { usedTokens: 500 } })
    assert.deepEqual(bare, { tokens: 500, pct: null, parts: [] })
    assert.ok(bare !== null)
    assert.equal(headlineText(bare, t), 'Context · 500')
    assert.equal(occupancyOf(null, {}), null)
  })
})

function occupancy(over: Partial<Occupancy>): Occupancy {
  return {
    tokens: 0,
    pct: null,
    parts: ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'].map(key => ({ key, color: '', value: 0 })),
    ...over,
  }
}

describe('occupancyBars', () => {
  const parts = (values: number[]) => ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']
    .map((key, i) => ({ key, color: '', value: values[i] ?? 0 }))

  test('no window: one composition bar with category slots as colors', () => {
    const bars = occupancyBars(occupancy({ parts: parts([1, 2]) }), 20)
    assert.equal(bars.length, 1)
    assert.equal(bars[0].capacity, undefined)
    assert.deepEqual(bars[0].segments.slice(0, 2), [{ value: 1, color: 0 }, { value: 2, color: 1 }])
  })

  test('a window without a reserve is one occupancy bar', () => {
    const bars = occupancyBars(occupancy({ tokens: 10, window: 100, parts: parts([10]) }), 20)
    assert.deepEqual(bars.map(b => [b.width, b.capacity]), [[20, 100]])
  })

  test('the reserve hatches the true window tail and the used span draws against the masks edge', () => {
    const reserve = { threshold: 160_000, headroom: 65_536, output: 8192 }
    const bars = occupancyBars(occupancy({ tokens: 50_000, window: 200_000, parts: parts([50_000]), reserve }), 40)
    assert.equal(bars.length, 2)
    const start = 200_000 - 65_536 - 8192
    assert.deepEqual([bars[0].width, bars[0].capacity], [40 - 15, start])
    assert.equal(bars[0].segments[0].value, 50_000)
    assert.deepEqual(bars[1].segments, [
      { value: 0, color: 'warning' },
      { value: 65_536, color: 'warning', hatch: true },
      { value: 8192, color: 'inactive', hatch: true },
    ])
  })

  test('usage past the masks edge fills the main bar and eats into the masks', () => {
    const reserve = { threshold: 160_000, headroom: 65_536, output: 8192 }
    const start = 200_000 - 65_536 - 8192
    const used = start + 70_000
    const bars = occupancyBars(occupancy({ tokens: used, window: 200_000, parts: parts([used]), reserve }), 40)
    assert.ok(Math.abs(bars[0].segments[0].value - start) < 1e-6, 'scaled down to the masks edge')
    assert.deepEqual(bars[1].segments.map(s => s.value), [70_000, 0, 8192 - (70_000 - 65_536)])
  })

  test('a reserve too thin for one cell (or the whole bar) falls back to one occupancy bar', () => {
    const thin = { threshold: 900_000, headroom: 100, output: 100 }
    assert.equal(occupancyBars(occupancy({ window: 1_000_000, reserve: thin }), 20).length, 1)
    const whole = { threshold: 1, headroom: 999, output: 0 }
    assert.equal(occupancyBars(occupancy({ window: 1000, reserve: whole }), 20).length, 1)
  })

  test('the legend lists the non-zero categories with their heuristic counts', () => {
    const items = legendItems(occupancy({ parts: [{ key: 'system', color: '', value: 10, raw: 8 }, { key: 'tools', color: '', value: 0 }, { key: 'user', color: '', value: 5 }] }), t)
    assert.deepEqual(items, [
      { color: 0, label: 'System Prompt', value: '≈8' },
      { color: 2, label: 'User Messages', value: '≈5' },
    ])
  })
})

describe('eventRows', () => {
  test('newest first, with glyphs, signed token figures and the step label', () => {
    const rows = eventRows(timelineFixture().events, t)
    assert.deepEqual(rows.map(r => [r.seq, r.glyph, r.kindLabel, r.tokens, r.tone]), [
      [9, '⇆', 'Switch', null, 'warning'],
      [8, '✂', 'Compact', '−400', 'warning'],
      [2, '+', 'Inject', '+50', 'success'],
    ])
    assert.equal(rows[1].at, 'T1 S2 → T2 S1')
    assert.equal(rows[0].label, 'Model switched: a → b')
  })

  test('a kind filter keeps only that kind', () => {
    assert.deepEqual(eventRows(timelineFixture().events, t, 'inject').map(r => r.seq), [2])
  })
})

describe('event rows at a width', () => {
  const row = eventRows(timelineFixture().events, t)[1]

  test('the time goes first, then the turn, while the label would fall under 12 cells', () => {
    assert.equal(eventMeta(row, 44, '42s', cells), '−400 T1 S2 → T2 S1 42s')
    assert.equal(eventMeta(row, 34, '42s', cells), '−400 T1 S2 → T2 S1')
    assert.equal(eventMeta(row, 30, '42s', cells), '−400')
    assert.equal(eventMeta({ ...row, tokens: null }, 10, '42s', cells), 'T1 S2 → T2 S1', 'the first figure always stays')
    assert.equal(eventMeta({ ...row, tokens: null, at: null }, 10, '', cells), '')
  })
})

describe('stat grid', () => {
  test('as many sections per row as keep each 28 wide, the row and its gaps filling the width exactly', () => {
    assert.deepEqual(statGrid(3, 100), { perRow: 3, sectionWidth: 32 })
    assert.deepEqual(statGrid(3, 80), { perRow: 2, sectionWidth: 39 })
    assert.deepEqual(statGrid(3, 40), { perRow: 1, sectionWidth: 40 })
    assert.deepEqual(statGrid(2, 200), { perRow: 2, sectionWidth: 99 })
  })
})

describe('fileRows', () => {
  test('aggregates the op log, relativizes to the workspace and keeps the read window line', () => {
    const rows = fileRows(timelineFixture(), '/w', 'latest')
    assert.deepEqual(rows.map(r => r.display), ['TODO', 'src/b.ts', 'src/a.ts'])
    const b = rows[1]
    assert.deepEqual([b.abs, b.reads, b.writes, b.added, b.removed, b.line, b.time], ['/w/src/b.ts', 1, 1, 5, 2, undefined, T0 + 8000])
    assert.equal(rows[2].line, 10)
    assert.equal(rows[2].abs, '/w/src/a.ts')
    assert.equal(rows[0].abs, undefined, 'a search pattern is never a file to open')
  })

  test('sorts by count, path and name', () => {
    const timeline = timelineFixture()
    assert.equal(fileRows(timeline, '/w', 'count')[0].display, 'src/b.ts')
    assert.deepEqual(fileRows(timeline, '/w', 'path').map(r => r.display), ['src/a.ts', 'TODO', 'src/b.ts'], 'by raw path, like the web card')
    assert.deepEqual(fileRows(timeline, '/w', 'name').map(r => r.display), ['TODO', 'src/a.ts', 'src/b.ts'])
    const op = (seq: number, path: string, kind: 'read' | 'write', added = 0, removed = 0) => ({ seq, path, kind, tool: kind, err: false, added, removed })
    const churn = timelineFixture({ fileOps: [op(1, 'x.ts', 'write', 100, 20), op(2, 'y.ts', 'read'), op(3, 'y.ts', 'read'), op(4, 'z.ts', 'read')] })
    assert.deepEqual(fileRows(churn, '/w', 'count').map(r => r.display), ['y.ts', 'z.ts', 'x.ts'])
    assert.deepEqual(fileRows(churn, '/w', 'lines').map(r => r.display), ['x.ts', 'z.ts', 'y.ts'], 'line churn first, ties to the newest op')
  })

  test('no op log (older host, or nothing loaded) is no rows; a relative path without a workspace has no absolute form', () => {
    assert.deepEqual(fileRows(null, undefined, 'count'), [])
    assert.deepEqual(fileRows(timelineFixture({ fileOps: undefined }), '/w', 'count'), [])
    const op = { seq: 1, path: 'x.ts', kind: 'write' as const, tool: 'edit', err: false, added: 0, removed: 0 }
    assert.deepEqual(fileRows(timelineFixture({ fileOps: [op] }), undefined, 'count')[0], {
      path: 'x.ts', display: 'x.ts', reads: 0, writes: 1, searches: 0, added: 0, removed: 0,
    })
  })
})

describe('text helpers', () => {
  test('truncateStart keeps the file name of an overflowing path, measured in cells', () => {
    assert.equal(truncateStart('src/tui/model.ts', 20, cells), 'src/tui/model.ts')
    assert.equal(truncateStart('src/tui/model.ts', 9, cells), '…model.ts')
    assert.equal(truncateStart('目录/文件.ts', 6, s => Array.from(s).reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0)), '…件.ts')
    assert.equal(truncateStart('abc', 0, cells), '')
  })

  test('nodeLabel names each surface node by what it is', () => {
    assert.equal(nodeLabel({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash' }), 'bash')
    assert.equal(nodeLabel({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash', text: 'ok' }), 'bash: ok')
    assert.equal(nodeLabel({ seq: 1, cat: 'skill', tokens: 1, skill: 'tdd' }), 'tdd')
    assert.equal(nodeLabel({ seq: 1, cat: 'skill', tokens: 1, name: 'digest' }), 'digest')
    assert.equal(nodeLabel({ seq: 1, cat: 'inject', tokens: 1, name: 'AGENTS.md' }), 'AGENTS.md')
    assert.equal(nodeLabel({ seq: 1, cat: 'inject', tokens: 1, name: 'AGENTS.md', text: 'rules' }), 'AGENTS.md: rules')
    assert.equal(nodeLabel({ seq: 1, cat: 'assistant', tokens: 1, calls: ['read', 'bash'] }), '→ read, bash')
    assert.equal(nodeLabel({ seq: 1, cat: 'assistant', tokens: 1, calls: [] }), '#1')
    assert.equal(nodeLabel({ seq: 7, cat: 'user', tokens: 1 }), '#7')
    assert.equal(nodeLabel({ seq: 7, cat: 'user', tokens: 1, text: 'hi' }), 'hi')
  })
})

describe('panelLayout', () => {
  test('sections drop from the bottom as the panel shrinks', () => {
    assert.deepEqual(panelLayout(30, 8, 20), { legendRows: 2, events: 5, files: 19 })
    assert.deepEqual(panelLayout(8, 3, 4), { legendRows: 1, events: 3, files: 0 })
    assert.deepEqual(panelLayout(4, 3, 4), { legendRows: 0, events: 1, files: 0 })
    assert.deepEqual(panelLayout(3, 0, 4), { legendRows: 0, events: 0, files: 0 })
    assert.deepEqual(panelLayout(12, 0, 4), { legendRows: 2, events: 0, files: 4 })
  })
})

import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { aggregateByTurn, attachMarkers, jumpTargetOf, turnStepsOf } from '../../../src/client/components/trendModel'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { click, mount, query, queryAll } from '../helpers/kit'
import { TrendChart, bars, propsOf, req } from './trendChartHarness'

describe('aggregateByTurn', () => {
  test('same-turn steps collapse into the last record, turnless requests pool under 0, and an empty history aggregates to nothing', () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1, total: 500 }),
      req(3, { turn: 2, step: 0 }),
    ])
    assert.equal(agg.length, 2)
    assert.equal(agg[0].seq, 2, 'the turn bar is its LAST step')
    assert.equal(agg[0].stepCount, 2)
    assert.equal(agg[0].total, 500)
    assert.equal(agg[1].stepCount, 1)

    const turnless = aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: undefined })])
    assert.equal(turnless.length, 1)
    assert.equal(turnless[0].stepCount, 2)
    assert.equal(aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: 1 })]).length, 2, 'a turnless run breaks at the first stamped turn')
    assert.deepEqual(aggregateByTurn([]), [])

    const durationAgg = aggregateByTurn([
      req(1, { turn: 1, step: 0, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, activeMs: 2500 }),
      req(3, { turn: 2, step: 0, activeMs: 800 }),
    ])
    assert.equal(durationAgg[0].activeMs, 3500, 'the turn bar carries its steps\' summed active time')
    assert.equal(durationAgg[1].activeMs, 800, 'a single-step turn keeps its own figure')
    const partial = aggregateByTurn([req(1, { turn: 1, activeMs: 1000 }), req(2, { turn: 1 })])
    assert.equal(partial[0].activeMs, 1000)
    const none = aggregateByTurn([req(1, { turn: 1 }), req(2, { turn: 1 })])
    assert.ok(!('ms' in none[0]), 'no fabricated zero when no step reported')
  })
})

describe('turnStepsOf', () => {
  test('tallies per-turn step counts over the raw records; turnless pool under 0', () => {
    const stepsOf = turnStepsOf([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1 }),
      req(3, { turn: 2, step: 0 }),
      req(4, { turn: undefined, step: undefined }),
    ])
    assert.equal(stepsOf(1), 2)
    assert.equal(stepsOf(2), 1)
    assert.equal(stepsOf(undefined), 1, 'turnless records read the pooled 0 key')
    assert.equal(stepsOf(9), 1, 'a turn outside the list answers 1 instead of missing')
    assert.equal(turnStepsOf([])(1), 1)
  })
})

describe('jumpTargetOf', () => {
  test('matches the exact seq; an aged-out seq clamps to the oldest retained request', () => {
    const reqs = [req(50), req(60), req(70)]
    assert.equal(jumpTargetOf(reqs, 60)?.seq, 60)
    assert.equal(jumpTargetOf(reqs, 10)?.seq, 50, 'below the window → the oldest retained bar')
    assert.equal(jumpTargetOf([], 1), null)
  })
})

describe('TrendChart entrance rise', () => {
  const slot = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--lc-i')

  test('each bar carries its rise stagger slot, capped so a long log settles quickly', async () => {
    const reqs = Array.from({ length: 25 }, (_, i) => req(i + 1))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const stacks = queryAll(m.container, '.lc-bar-stack')
    assert.equal(stacks.length, 25)
    assert.equal(slot(stacks[0]), '0')
    assert.equal(slot(stacks[1]), '1')
    assert.equal(slot(stacks[19]), '19')
    assert.equal(slot(stacks[20]), '20')
    assert.equal(slot(stacks[24]), '20')
    await m.unmount()

    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 50, user: 60 })
    const delta = await mount(h(TrendChart, propsOf([r1, r2], { mode: 'delta' })))
    const ups = queryAll(delta.container, '.lc-bar-up')
    const downs = queryAll(delta.container, '.lc-bar-down')
    assert.deepEqual([slot(ups[0]), slot(ups[1]), slot(downs[1])], ['0', '1', '1'], 'delta arms share their bar rise stagger slot')
    assert.equal(queryAll(downs[0], 'div').length, 0)
    await delta.unmount()
  })

  test('switching granularity remounts every bar so the entrance rise replays', async () => {
    function GranularityHarness(props: { requests: RequestRecord[] }) {
      const [granularity, setGranularity] = useState<'step' | 'turn'>('turn')
      const display = granularity === 'turn' ? aggregateByTurn(props.requests) : props.requests
      return h('div', null,
        h('button', { onClick: () => { setGranularity('step') } }, 'to-step'),
        h(TrendChart, { ...propsOf(display), granularity }))
    }
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const m = await mount(h(GranularityHarness, { requests: reqs }))
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['2', '3'])
    const reusedSeq = query(m.container, '.lc-bar[data-seq="2"]')
    await click(query(m.container, 'button'))
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['1', '2', '3'])
    assert.notEqual(query(m.container, '.lc-bar[data-seq="2"]'), reusedSeq)
    await m.unmount()
  })
})

describe('attachMarkers', () => {
  test('each boundary event attaches to the first request logged after it; stray, non-boundary, or repeated events attach nowhere', () => {
    const reqs = [req(5), req(10)]
    const ev: ContextEventRecord = { seq: 7, time: 0, kind: 'compaction' }
    const markers = attachMarkers(reqs, [ev])
    assert.equal(markers.length, 2)
    assert.equal(markers[0], undefined)
    assert.equal(markers[1], ev)
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 99, time: 0, kind: 'prune' }])).length, 0)
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 1, time: 0, kind: 'inject' }])).length, 0)
    assert.equal(attachMarkers([], [{ seq: 1, time: 0, kind: 'compaction' }]).length, 0)
    const first: ContextEventRecord = { seq: 1, time: 0, kind: 'compaction' }
    const second: ContextEventRecord = { seq: 2, time: 0, kind: 'prune' }
    const repeated = attachMarkers(reqs, [first, second])
    assert.equal(repeated[0], first)
    assert.equal(repeated[1], undefined)
  })
})

import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import { resetSessionWarm, scheduleSessionWarm, useSessionDetailWarm } from '../../src/client/prefetch'
import { detailStoreOf, resetTimelineDetailStores } from '../../src/client/timelineSource'
import { mount } from './helpers/kit'

function detail(rev: number): unknown {
  return {
    rev,
    requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    head: {
      ok: true,
      current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
      detailRev: rev,
    },
  }
}

function stubDetail(rev = 1): { reads: string[] } {
  const reads: string[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    const id = JSON.parse(init?.body ?? '{}').sessionId as string
    reads.push(id)
    return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(rev) }) }
  })
  return { reads }
}

afterEach(() => {
  resetSessionWarm()
  resetTimelineDetailStores()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scheduleSessionWarm', () => {
  test('invalid ids and revisions arm nothing', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('', 1)
    scheduleSessionWarm(undefined, 1)
    scheduleSessionWarm('s1', null)
    scheduleSessionWarm('s1', -1)
    scheduleSessionWarm('s1', Number.NaN)
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, [])
  })

  test('a newer revision updates the pending target without moving the deadline; a replay is covered', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('s1', 1)
    await vi.advanceTimersByTimeAsync(500)
    scheduleSessionWarm('s1', 2)
    await vi.advanceTimersByTimeAsync(401)
    assert.deepEqual(reads, ['s1'], 'the original 900ms deadline fired with the newest revision')
    scheduleSessionWarm('s1', 1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, ['s1'], 'the landed revision covers a replay')
  })

  test('the fired window warms the newest scheduled revision, not the first', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail(5)
    detailStoreOf('s1').warm(5)
    await vi.advanceTimersByTimeAsync(0)
    assert.deepEqual(reads, ['s1'])
    scheduleSessionWarm('s1', 1)
    scheduleSessionWarm('s1', 6)
    await vi.advanceTimersByTimeAsync(900)
    assert.deepEqual(reads, ['s1', 's1'], 'the upgraded revision warmed the channel')
  })

  test('the pending map stays bounded under a burst of sessions', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    for (let i = 0; i < 33; i++) scheduleSessionWarm('s' + i, 1)
    await vi.advanceTimersByTimeAsync(900)
    assert.equal(reads.length, 32, 'the oldest pending warm-up was evicted')
    assert.equal(reads.includes('s0'), false)
    assert.equal(reads.includes('s32'), true)
  })
})

describe('useSessionDetailWarm', () => {
  test('the rendered session and its split head arm the warm-up; a head without a revision does not', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(props: { useProjection?: unknown }): null {
      useSessionDetailWarm('s1', props.useProjection)
      return null
    }
    const m = await mount(h(Probe, { useProjection: () => ({ detailRev: 4 }) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    assert.deepEqual(reads, ['s1'])
    await m.update(h(Probe, { useProjection: () => ({}) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    assert.deepEqual(reads, ['s1'], 'an inline head arms nothing')
    await m.unmount()
  })
})

describe('useSessionDetailWarm — teardown', () => {
  test('a mount without a projection seat arms nothing', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm('s1', undefined)
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
    await m.unmount()
  })

  test('a missing session id arms nothing and unmounts cleanly', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm(undefined, () => ({ detailRev: 2 }))
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
    await m.unmount()
  })

  test('unmounting before the window cancels the pending warm-up', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm('s1', () => ({ detailRev: 2 }))
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await m.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
  })
})

describe('scheduleSessionWarm — dedupe and reset', () => {
  test('a pending session ignores a lower or equal revision, and reset clears an armed timer', async () => {
    resetSessionWarm()
    resetTimelineDetailStores()
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('dedupe', 2)
    scheduleSessionWarm('dedupe', 1)
    scheduleSessionWarm('dedupe', 2)
    await vi.advanceTimersByTimeAsync(901)
    assert.deepEqual(reads, ['dedupe'])
    scheduleSessionWarm('dedupe-2', 1)
    resetSessionWarm()
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, ['dedupe'], 'reset cleared the armed timer')
  })
})

import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import { fetchMissNote, useFetchOnMiss } from '../../../src/client/components/fetchOnMiss'
import type { FetchOnMiss } from '../../../src/client/components/fetchOnMiss'
import { mount, until } from '../helpers/kit'

let current: FetchOnMiss<string> | null = null

function Probe(props: {
  missKey: number | null
  fetcher?: (key: number) => Promise<string | null>
  scope?: string
}): ReactElement {
  const miss = useFetchOnMiss<string>(props.missKey, props.fetcher, 'test warn', props.scope)
  current = miss
  return h('div', null, h('span', { 'data-k': 'values' }, JSON.stringify([...miss.values])))
}

const values = (): [number, string][] => current === null ? [] : [...current.values]

const t = (key: string): string => key

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  current = null
})

describe('useFetchOnMiss scope isolation', () => {
  test('a same-seq value from another session never leaks into the new session', async () => {
    const a = vi.fn(async () => 'A body')
    const b = vi.fn(async () => 'B body')
    const m = await mount(h(Probe, { missKey: 7, fetcher: a, scope: 'A' }))
    try {
      await until(() => current?.state !== 'loading' && current?.values.has(7) === true, 'A never loaded')
      assert.deepEqual(values(), [[7, 'A body']])
      await m.update(h(Probe, { missKey: 7, fetcher: b, scope: 'B' }))
      await until(() => current?.values.get(7) === 'B body', 'B never re-read the seq')
      assert.equal(b.mock.calls.length, 1, 'the new session fetched instead of replaying A')
      assert.deepEqual(values(), [[7, 'B body']], 'no stale A entry survives')
    } finally {
      await m.unmount()
    }
  })

  test('a scope change with the same fetcher resets the values and re-reads', async () => {
    const fetcher = vi.fn(async () => 'shared body')
    const m = await mount(h(Probe, { missKey: 3, fetcher, scope: 'A' }))
    try {
      await until(() => current?.values.has(3) === true, 'the first read never landed')
      await m.update(h(Probe, { missKey: 3, fetcher, scope: 'B' }))
      await until(() => fetcher.mock.calls.length === 2, 'the scope change never re-read')
      assert.deepEqual(values(), [[3, 'shared body']])
    } finally {
      await m.unmount()
    }
  })

  test('a response from the previous session never lands after the switch', async () => {
    let resolveOld!: (value: string | null) => void
    const oldFetcher = (): Promise<string | null> => new Promise((resolve) => { resolveOld = resolve })
    const newFetcher = vi.fn(async () => 'B body')
    const m = await mount(h(Probe, { missKey: 9, fetcher: oldFetcher, scope: 'A' }))
    try {
      await m.update(h(Probe, { missKey: 9, fetcher: newFetcher, scope: 'B' }))
      await until(() => current?.values.get(9) === 'B body', 'B never landed')
      await act(async () => { resolveOld('A body') })
      assert.deepEqual(values(), [[9, 'B body']], 'the stale A response was dropped')
    } finally {
      await m.unmount()
    }
  })
})

describe('useFetchOnMiss retry and bounds', () => {
  test('a rejection from the previous session never lands after the switch', async () => {
    let rejectOld!: (reason: unknown) => void
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldFetcher = (): Promise<string | null> => new Promise((_resolve, reject) => { rejectOld = reject })
    const newFetcher = async (): Promise<string | null> => 'B body'
    const m = await mount(h(Probe, { missKey: 9, fetcher: oldFetcher, scope: 'A' }))
    try {
      await m.update(h(Probe, { missKey: 9, fetcher: newFetcher, scope: 'B' }))
      await until(() => current?.values.get(9) === 'B body', 'B never landed')
      await act(async () => { rejectOld(new Error('late')) })
      assert.equal(current?.state, 'idle', 'the stale rejection changed nothing')
      assert.equal(warn.mock.calls.length, 0, 'the stale rejection was not even reported')
    } finally {
      await m.unmount()
    }
  })

  test('a failed read retries with bounded backoff and lands without user action', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      if (calls <= 2) throw new Error('offline')
      return 'landed'
    }
    const m = await mount(h(Probe, { missKey: 1, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      assert.equal(calls, 1)
      assert.equal(current?.state, 'loading', 'an armed retry keeps the placeholder in place')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      assert.equal(calls, 2)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      assert.equal(calls, 3)
      await until(() => current?.values.get(1) === 'landed', 'the retried read never landed')
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })

  test('the retry budget ends in a failed state that a manual retry revives', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      if (calls <= 4) throw new Error('offline')
      return 'revived'
    }
    const m = await mount(h(Probe, { missKey: 2, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      assert.equal(calls, 4)
      assert.equal(current?.state, 'failed')
      await act(async () => { current?.retry() })
      await until(() => current?.values.get(2) === 'revived', 'the manual retry never landed')
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })

  test('a null answer is absent and is not retried', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => null)
    const m = await mount(h(Probe, { missKey: 4, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      assert.equal(current?.state, 'absent')
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      assert.equal(fetcher.mock.calls.length, 1)
    } finally {
      await m.unmount()
    }
  })

  test('the value map stays bounded under heavy churn', async () => {
    const fetcher = async (key: number): Promise<string | null> => 'body ' + String(key)
    const m = await mount(h(Probe, { missKey: 0, fetcher, scope: 's' }))
    try {
      for (let key = 0; key < 40; key++) {
        await m.update(h(Probe, { missKey: key, fetcher, scope: 's' }))
        await until(() => current?.values.has(key) === true, 'key ' + String(key) + ' never landed')
      }
      assert.equal(current?.values.size, 32, 'the miss cache is bounded')
      assert.equal(current?.values.has(39), true)
      assert.equal(current?.values.has(0), false)
    } finally {
      await m.unmount()
    }
  })

  test('an unmount cancels an armed retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      throw new Error('offline')
    }
    const m = await mount(h(Probe, { missKey: 5, fetcher, scope: 's' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    assert.equal(calls, 1)
    await m.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    assert.equal(calls, 1, 'the detached hook retried nothing')
  })

  test('no fetcher and no key are inert', async () => {
    const m = await mount(h(Probe, { missKey: null }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
      assert.deepEqual(values(), [])
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })
})

describe('fetchMissNote', () => {
  test('renders the empty, absent, failed, and loading notes', () => {
    assert.equal(fetchMissNote(t, undefined, 'idle', () => {}, 'browser.noContent'), 'browser.noContent')
    assert.equal(fetchMissNote(t, () => {}, 'absent', () => {}, 'browser.noContent'), 'browser.notInLog')
    assert.equal(fetchMissNote(t, () => {}, 'loading', () => {}, 'browser.noContent'), 'browser.loading')
    let retries = 0
    const node = fetchMissNote(t, () => {}, 'failed', () => { retries++ }, 'browser.noContent')
    assert.ok(node !== null && typeof node === 'object')
    const button = node as { props: { onClick: () => void; children: string } }
    assert.equal(button.props.children, 'browser.loadFailed')
    button.props.onClick()
    assert.equal(retries, 1)
  })
})

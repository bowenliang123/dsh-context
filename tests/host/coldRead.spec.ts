import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { type HeapReading, makeColdReadGate } from '../../src/host/coldRead'

const v8Heap = vi.hoisted(() => ({ used: 100, limit: 1000, calls: 0 }))
vi.mock('node:v8', () => ({
  getHeapStatistics: () => {
    v8Heap.calls++
    return { used_heap_size: v8Heap.used, heap_size_limit: v8Heap.limit }
  },
}))

const LOW: HeapReading = { used: 100, limit: 1000 }
const HIGH: HeapReading = { used: 800, limit: 1000 }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('makeColdReadGate', () => {
  test('concurrent reads run one at a time, in queue order', async () => {
    const gate = makeColdReadGate(() => LOW)
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const task = (name: string, gate2?: Promise<string>): (() => Promise<string>) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push(`${name}:start`)
      const value = await (gate2 ?? Promise.resolve(name))
      order.push(`${name}:end`)
      active--
      return value
    }
    const blocker = deferred<string>()
    const first = gate.admit(task('a', blocker.promise))
    const second = gate.admit(task('b'))
    const third = gate.admit(task('c'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['a:start'], 'the queued reads wait for the front')
    blocker.resolve('A')
    assert.deepEqual(await Promise.all([first, second, third]), ['A', 'b', 'c'])
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
    assert.equal(maxActive, 1, 'never two reads in flight')
  })

  test('foreground reads overtake queued background work without overtaking the active read', async () => {
    const gate = makeColdReadGate(() => LOW)
    const order: string[] = []
    const blocker = deferred<string>()
    const task = (name: string, wait?: Promise<string>) => async () => {
      order.push(`${name}:start`)
      const value = await (wait ?? Promise.resolve(name))
      order.push(`${name}:end`)
      return value
    }
    const active = gate.admit(task('background-a', blocker.promise), { priority: 'background' })
    const queued = gate.admit(task('background-b'), { priority: 'background' })
    const foreground = gate.admit(task('foreground'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(order, ['background-a:start'])
    blocker.resolve('a')
    assert.deepEqual(await Promise.all([active, queued, foreground]), ['a', 'background-b', 'foreground'])
    assert.deepEqual(order, [
      'background-a:start', 'background-a:end',
      'foreground:start', 'foreground:end',
      'background-b:start', 'background-b:end',
    ])
  })

  test('the waiting queue rejects overflow without running the read', async () => {
    const gate = makeColdReadGate(() => LOW)
    const blocker = deferred<string>()
    const active = gate.admit(() => blocker.promise)
    const waiting = Array.from({ length: 64 }, () => gate.admit(async () => 'ok'))
    let overflowRan = false
    const overflow = gate.admit(async () => {
      overflowRan = true
      return 'overflow'
    })
    blocker.resolve('done')
    assert.equal(await active, 'done')
    assert.deepEqual(await Promise.all(waiting), Array.from({ length: 64 }, () => 'ok'))
    assert.equal(await overflow, undefined)
    assert.equal(overflowRan, false)
  })

  test('the headroom check runs at the front of the queue, and its two-thirds boundary is strict', async () => {
    let reading = LOW
    const gate = makeColdReadGate(() => reading)
    const blocker = deferred<string>()
    let started = false
    const first = gate.admit(async () => {
      started = true
      const value = await blocker.promise
      return value
    })
    let ran = 0
    const second = gate.admit(async () => {
      ran++
      return 'b'
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(started, 'the front read started under the low reading')
    reading = HIGH
    blocker.resolve('a')
    assert.equal(await first, 'a', 'the running read settles normally')
    assert.equal(await second, undefined, 'the queued read meets the hot heap at its turn')
    assert.equal(await gate.admit(async () => 'skipped'), undefined, 'a read requested under pressure never starts')
    assert.equal(ran, 0)
    reading = LOW
    assert.equal(await gate.admit(async () => 'c'), 'c')
    const at = makeColdReadGate(() => ({ used: 200, limit: 300 }))
    assert.equal(await at.admit(async () => 'x'), undefined)
    const below = makeColdReadGate(() => ({ used: 199, limit: 300 }))
    assert.equal(await below.admit(async () => 'x'), 'x')
  })

  test('a hostile or garbage probe fails open', async () => {
    const throwing = makeColdReadGate(() => {
      throw new Error('hostile meter')
    })
    assert.equal(await throwing.admit(async () => 'x'), 'x')
    for (const junk of [
      { used: Number.NaN, limit: 1000 },
      { used: 100, limit: Number.NaN },
      { used: 100, limit: 0 },
      { used: 100, limit: -1 },
    ]) {
      const gate = makeColdReadGate(() => junk)
      assert.equal(await gate.admit(async () => 'x'), 'x', `junk reading ${JSON.stringify(junk)} admits`)
    }
  })

  test('a rejecting read propagates and the queue survives it', async () => {
    const gate = makeColdReadGate(() => LOW)
    const failure = gate.admit(async (): Promise<string> => {
      throw new Error('fold exploded')
    })
    await assert.rejects(failure, /fold exploded/)
    assert.equal(await gate.admit(async () => 'after'), 'after', 'the next read still runs')
  })

  test('the default reading is the process’s own V8 heap', async () => {
    v8Heap.used = 100
    v8Heap.limit = 1000
    assert.equal(await makeColdReadGate().admit(async () => 'x'), 'x')
    assert.ok(v8Heap.calls > 0, 'the default probe reads node:v8 heap statistics')
    v8Heap.used = 800
    assert.equal(await makeColdReadGate().admit(async () => 'x'), undefined, 'the default probe applies the two-thirds ceiling')
  })
})

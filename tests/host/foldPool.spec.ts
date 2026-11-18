import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Worker } from 'node:worker_threads'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createFoldPool } from '../../src/host/foldWorker'

interface SentMessage {
  kind: string
  events?: SessionEvent[]
}

function workerRig(rejectTerminate = false, postError: unknown = '', postErrorAt = 0) {
  const handlers = new Map<string, ((value: unknown) => void)[]>()
  const sent: SentMessage[] = []
  let terminations = 0
  const worker = {
    on(event: string, handler: (value: unknown) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    postMessage(message: SentMessage) {
      if (postError !== '' && sent.length === postErrorAt) throw postError
      sent.push(message)
    },
    async terminate() {
      terminations++
      if (rejectTerminate) throw new Error('terminate failed')
      return 0
    },
  } as unknown as Worker
  const emit = (event: string, value: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(value)
  }
  const done = () => {
    emit('message', { kind: 'done', timeline: {}, activity: {}, lastPromptAt: 0, blank: true })
  }
  return { worker, sent, emit, done, terminations: () => terminations }
}

function events(length: number): SessionEvent[] {
  return Array.from({ length }, (_, seq) => ({ type: 'todo/write', seq, time: seq, data: {} })) as unknown as SessionEvent[]
}

const flush = () => new Promise(resolve => setImmediate(resolve))

describe('fold pool backpressure and bounded queue', () => {
  test('only one chunk is in flight and end follows the final acknowledgement', async () => {
    const rig = workerRig()
    const pool = createFoldPool(() => rig.worker)
    const pending = pool.fold({}, events(4_001))
    assert.deepEqual(rig.sent.map(message => message.kind), ['begin', 'chunk'])
    assert.equal(rig.sent[1].events?.length, 2_000)
    rig.emit('message', { kind: 'ack' })
    await flush()
    assert.deepEqual(rig.sent.map(message => message.kind), ['begin', 'chunk', 'chunk'])
    assert.equal(rig.sent[2].events?.length, 2_000)
    rig.emit('message', { kind: 'ack' })
    await flush()
    assert.equal(rig.sent[3].events?.length, 1)
    rig.emit('message', { kind: 'ack' })
    await flush()
    assert.deepEqual(rig.sent.map(message => message.kind), ['begin', 'chunk', 'chunk', 'chunk', 'end'])
    rig.done()
    await pending
    rig.done()
    pool.dispose()
  })

  test('the waiting queue has a hard bound and disposal rejects every job', async () => {
    const rig = workerRig()
    const pool = createFoldPool(() => rig.worker, { maxQueue: 1 })
    const active = pool.fold({}, events(1))
    const queued = pool.fold({}, events(1))
    await assert.rejects(pool.fold({}, events(1)), /queue is full/)
    pool.dispose()
    await assert.rejects(active, /disposed/)
    await assert.rejects(queued, /disposed/)
    await assert.rejects(pool.fold({}, events(1)), /disposed/)
    rig.emit('error', new Error('late worker error'))
  })

  test('a worker failure rejects its active job and restarts the queued job', async () => {
    const rig = workerRig(true)
    const pool = createFoldPool(() => rig.worker)
    const active = pool.fold({}, events(1))
    const queued = pool.fold({}, events(1))
    rig.emit('error', new Error('boom'))
    await assert.rejects(active, /boom/)
    await flush()
    assert.equal(rig.terminations(), 1)
    assert.deepEqual(rig.sent.map(message => message.kind), ['begin', 'chunk', 'begin', 'chunk'])
    rig.emit('message', { kind: 'ack' })
    await flush()
    rig.done()
    await queued
    pool.dispose()
  })

  test('synchronous spawn and post failures reject the active job without jamming the queue', async () => {
    const spawned = workerRig()
    let attempts = 0
    const pool = createFoldPool(() => {
      attempts++
      if (attempts === 1) throw 'spawn failed'
      return spawned.worker
    })
    const first = pool.fold({}, events(1))
    const second = pool.fold({}, events(1))
    await assert.rejects(first, /spawn failed/)
    spawned.emit('message', { kind: 'ack' })
    spawned.done()
    await second
    assert.deepEqual(spawned.sent.map(message => message.kind), ['begin', 'chunk', 'end'])
    pool.dispose()

    const broken = workerRig(false, new Error('post failed'))
    const replacement = workerRig()
    const workers = [broken, replacement]
    const posting = createFoldPool(() => workers.shift()?.worker as Worker)
    const rejected = posting.fold({}, events(1))
    const restarted = posting.fold({}, events(1))
    await assert.rejects(rejected, /post failed/)
    replacement.emit('message', { kind: 'ack' })
    replacement.done()
    await restarted
    assert.deepEqual(replacement.sent.map(message => message.kind), ['begin', 'chunk', 'end'])
    posting.dispose()

    const ackBroken = workerRig(false, 'post failed', 2)
    const ackReplacement = workerRig()
    const ackWorkers = [ackBroken, ackReplacement]
    const acknowledged = createFoldPool(() => ackWorkers.shift()?.worker as Worker)
    const afterAck = acknowledged.fold({}, events(1))
    const nextAfterAck = acknowledged.fold({}, events(1))
    ackBroken.emit('message', { kind: 'ack' })
    await assert.rejects(afterAck, /post failed/)
    ackReplacement.emit('message', { kind: 'ack' })
    ackReplacement.done()
    await nextAfterAck
    assert.deepEqual(ackReplacement.sent.map(message => message.kind), ['begin', 'chunk', 'end'])
    acknowledged.dispose()

    const errorBroken = workerRig(false, new Error('post failed'), 2)
    const errorReplacement = workerRig()
    const errorWorkers = [errorBroken, errorReplacement]
    const errors = createFoldPool(() => errorWorkers.shift()?.worker as Worker)
    const afterError = errors.fold({}, events(1))
    const nextAfterError = errors.fold({}, events(1))
    errorBroken.emit('message', { kind: 'ack' })
    await assert.rejects(afterError, /post failed/)
    errorReplacement.emit('message', { kind: 'ack' })
    errorReplacement.done()
    await nextAfterError
    assert.deepEqual(errorReplacement.sent.map(message => message.kind), ['begin', 'chunk', 'end'])
    errors.dispose()
  })

  test('idle recycling is cancelled by new work and a replacement ignores late events', async () => {
    vi.useFakeTimers()
    try {
      const first = workerRig(true)
      const second = workerRig()
      const rigs = [first, second]
      const pool = createFoldPool(() => rigs.shift()?.worker as Worker, { idleMs: 20 })
      const one = pool.fold({}, events(1))
      first.emit('message', { kind: 'ack' })
      first.done()
      await one
      await vi.advanceTimersByTimeAsync(19)
      assert.equal(first.terminations(), 0)
      const two = pool.fold({}, events(1))
      first.emit('message', { kind: 'ack' })
      first.done()
      await two
      await vi.advanceTimersByTimeAsync(20)
      assert.equal(first.terminations(), 1)
      const three = pool.fold({}, events(1))
      second.emit('message', { kind: 'ack' })
      second.done()
      await three
      first.emit('error', new Error('late worker error'))
      first.emit('exit', 1)
      assert.equal(second.terminations(), 0)
      pool.dispose()
      assert.equal(second.terminations(), 1)
      await vi.advanceTimersByTimeAsync(100)
      assert.equal(second.terminations(), 1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a negative idle timeout keeps the worker until disposal', async () => {
    const rig = workerRig()
    const pool = createFoldPool(() => rig.worker, { idleMs: -1 })
    const pending = pool.fold({}, events(1))
    rig.emit('message', { kind: 'ack' })
    rig.done()
    await pending
    assert.equal(rig.terminations(), 0)
    pool.dispose()
    assert.equal(rig.terminations(), 1)
  })
})

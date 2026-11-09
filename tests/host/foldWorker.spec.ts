import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { describe, test } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createFoldPool, startFoldWorkerChannel } from '../../src/host/foldWorker'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { createContextActivityDefinition } from '../../src/host/activity'
import { foldInProcess, inProcessPool } from './helpers/foldWorker'
import { assistantMessage, header, userMessage } from './helpers/events'

const META = { id: 'w1', version: 4, createdAt: 1, cwd: '/repo/w1', isSeeded: false } as unknown as SessionHeader

function messageEvents(): SessionEvent[] {
  const events: SessionEvent[] = [header(0, { model: 'deepseek-v4-flash', provider: 'deepseek' }) as unknown as SessionEvent]
  let seq = 1
  for (const [text, tokens] of [['first', 10] as const, ['second', 30] as const]) {
    events.push(userMessage(seq++, [{ type: 'text', text }], { kind: 'user' }) as unknown as SessionEvent)
    events.push(assistantMessage(seq++, { turn: seq, usage: { inputTokens: tokens, outputTokens: 5 } }) as unknown as SessionEvent)
  }
  return events
}

function referenceValues(config: Record<string, unknown>, events: readonly SessionEvent[]): Record<string, unknown> {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition(config as never, () => false) as never)
  registry.register(createContextActivityDefinition() as never)
  return registry.restore({}, events, 0 as never, META, 0 as never).snapshot.values as Record<string, unknown>
}

describe('dsh-context fold worker', () => {
  test('the channel folds chunked events into the same values a single-shot restore produces', async () => {
    const events = messageEvents()
    const folded = await foldInProcess({}, events)
    const reference = referenceValues({}, events)
    assert.deepEqual(folded.timeline, reference.contextTimeline)
    assert.deepEqual(folded.activity, reference.contextActivity)
    const lastPrompt = events
      .filter(event => event.type === 'user/message')
      .reduce((max, event) => Math.max(max, event.time), 0)
    assert.equal(folded.lastPromptAt, lastPrompt)
    assert.equal(folded.blank, false)
  })

  test('an empty or promptless session folds blank with no last prompt', async () => {
    const folded = await foldInProcess({}, [header(0) as unknown as SessionEvent])
    assert.equal(folded.blank, true)
    assert.equal(folded.lastPromptAt, 0)
    assert.deepEqual(folded.activity, { days: {} })
  })

  test('a fold that throws reports the failure through the pool', async () => {
    const pool = inProcessPool()
    try {
      const hostile = { get maxEvents(): number { throw new Error('boom') } }
      await assert.rejects(pool.fold(hostile as never, messageEvents()), /boom/)
    } finally {
      pool.dispose()
    }
  })

  test('a second concurrent fold is rejected as busy', async () => {
    const pool = inProcessPool()
    try {
      const first = pool.fold({}, messageEvents())
      await assert.rejects(pool.fold({}, messageEvents()), /busy/)
      await first
    } finally {
      pool.dispose()
    }
  })

  test('dispose rejects the pending fold; a later dispose is a no-op', async () => {
    const pool = inProcessPool()
    const pending = pool.fold({}, messageEvents())
    pool.dispose()
    await assert.rejects(pending, /disposed/)
    pool.dispose()
  })

  test('the channel without a port returns quietly', () => {
    startFoldWorkerChannel(null)
  })

  test('worker error events fail the pending fold with the emitted cause', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const first = pool.fold({}, messageEvents())
      worker.emit('error', 'boom-string')
      await assert.rejects(first, /boom-string/)
      const second = pool.fold({}, messageEvents())
      worker.emit('error', new Error('bang'))
      await assert.rejects(second, /bang/)
    } finally {
      pool.dispose()
    }
  })

  test('a worker exit fails a pending fold and the next fold runs again', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const pending = pool.fold({}, messageEvents())
      worker.emit('exit')
      await assert.rejects(pending, /exited/)
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded)
    } finally {
      pool.dispose()
    }
  })

  test('non-object worker messages are ignored', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const pending = pool.fold({}, messageEvents())
      worker.emit('message', 42)
      const folded = await pending
      assert.ok('timeline' in folded)
      const again = await pool.fold({}, messageEvents())
      assert.ok('timeline' in again)
    } finally {
      pool.dispose()
    }
  })

  test('the channel tolerates non-record traffic and a missing config', async () => {
    const pool = inProcessPool()
    try {
      pool.sendToWorker('junk')
      pool.sendToWorker({ kind: 'begin' })
      pool.sendToWorker({ kind: 'end' })
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded)
    } finally {
      pool.dispose()
    }
  })

  test('a chunk that throws a non-error reports the failure and the pool recovers', async () => {
    const pool = inProcessPool()
    try {
      pool.sendToWorker({ kind: 'begin', config: {} })
      pool.sendToWorker({ kind: 'chunk', events: [{ get type(): string { throw 'zap' } }] })
      await new Promise(resolve => setTimeout(resolve, 10))
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded, 'the pool re-spawns after an out-of-band failure')
    } finally {
      pool.dispose()
    }
  })

  test('a rejecting terminate stays fail-soft on dispose', async () => {
    const pool = inProcessPool({ terminate: async () => { throw new Error('no thread') } })
    await pool.fold({}, messageEvents())
    pool.dispose()
  })

  test('pool message edge cases stay fail-soft', async () => {
    const pool = inProcessPool()
    try {
      const failing = pool.fold({}, messageEvents())
      pool.worker.emit('message', { kind: 'failed', message: 42 })
      await assert.rejects(failing, /fold worker failed/)
      const pending = pool.fold({}, messageEvents())
      pool.worker.emit('message', { kind: 'done', timeline: {}, activity: {}, lastPromptAt: 'x', blank: true })
      const folded = await pending
      assert.equal(folded.lastPromptAt, 0)
      assert.equal(folded.blank, true)
    } finally {
      pool.dispose()
    }
  })

  test('the default eval worker fails to boot from source and the pool surfaces the error', async () => {
    const pool = createFoldPool()
    try {
      await assert.rejects(pool.fold({}, messageEvents()))
    } finally {
      pool.dispose()
    }
  })
})

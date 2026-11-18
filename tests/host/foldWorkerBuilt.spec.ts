import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createFoldPool } from '../../src/host/foldWorker'
import { assistantMessage, userMessage } from './helpers/events'

const BUILT_WORKER_BOOTSTRAP = `
const { pathToFileURL } = require('node:url')
const { parentPort, workerData } = require('node:worker_threads')
import(pathToFileURL(workerData.entry).href)
  .then(module => module.startFoldWorkerChannel())
  .catch(error => parentPort.postMessage({ kind: 'failed', message: String((error && error.message) || error) }))
`

test('the built host bundle completes a real worker fold', async () => {
  const entry = fileURLToPath(new URL('../../lib/index.js', import.meta.url))
  assert.ok(existsSync(entry), 'run pnpm run build before the built-worker test')
  const worker = new Worker(BUILT_WORKER_BOOTSTRAP, { eval: true, workerData: { entry } })
  const pool = createFoldPool(() => worker, { idleMs: -1 })
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent,
    userMessage(1, [{ type: 'text', text: 'prompt' }], { kind: 'user' }, { time: 2 }),
    userMessage(2, [{ type: 'text', text: 'earlier clock' }], { kind: 'user' }, { time: 1 }),
    assistantMessage(3, { turn: 1, step: 1, time: 3 }),
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } } as unknown as SessionEvent,
    { type: 'session/title', seq: 5, time: 5, data: { title: 'Built title' } } as unknown as SessionEvent,
  ]
  const folded = await pool.fold({}, events as unknown as SessionEvent[])
  const timeline = folded.timeline as { ok?: boolean; counts?: { turns?: number } }
  assert.equal(timeline.ok, true)
  assert.equal(timeline.counts?.turns, 1)
  assert.equal(folded.blank, false)
  assert.equal(folded.lastPromptAt, 1)
  assert.equal(folded.title, 'Built title')
  pool.dispose()
  await worker.terminate()
})

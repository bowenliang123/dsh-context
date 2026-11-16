import { openDatabase } from '../../../src/host/db/open'
import { createDb } from '../../../src/host/db/db'
import { admissionRows, admitRows } from '../../../src/host/db/admission'
import { foldSession } from '../../../src/host/db/ingest'
import { resolveBounds } from '../../../src/host/config'
import { fakeCtx } from './ctx'
import { assistantMessage, compaction, endSeed, header, planMode, stepEnd, stepStart, systemMessage, toolCall, toolResult, userMessage } from './events'

const text = (value: string) => [{ type: 'text', text: value }]
const BOUNDS = resolveBounds({})

export function rootLog() {
  return [
    header(0, { tools: [{ name: 'bash', description: 'run' }, { name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek', reason: 'initial' }),
    systemMessage(1),
    userMessage(2, text('hello root')),
    stepStart(3, { time: 1003 }),
    assistantMessage(4, { turn: 1, step: 1, time: 2000, usage: { inputTokens: 10, outputTokens: 5 }, stream: [{ type: 'chunk', time: 1500, chunk: { type: 'text-delta', text: 'x' } }] }),
    toolCall(5, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }), turn: 1, step: 1 }),
    toolResult(6, { callId: 'c1', content: text('ok'), meta: { cwd: '/repo' } }),
    stepEnd(7, { time: 4000 }),
    planMode(8, { active: true }),
    compaction(9, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [2] }),
    header(10, { tools: [{ name: 'bash' }], model: 'deepseek-v4-pro', provider: 'deepseek', reason: 'change' }),
    userMessage(11, text('second turn'), undefined, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
    stepStart(12, { time: 12000 }),
    assistantMessage(13, { turn: 2, step: 1, time: 13000, usage: { inputTokens: 3, outputTokens: 2 } }),
    stepEnd(14, { time: 14000 }),
  ]
}

export function childLog() {
  return [
    header(0, { tools: [{ name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('inherited prompt')),
    assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } }),
    endSeed(3, { inherited: true }),
    userMessage(4, text('child prompt')),
    stepStart(5, { time: 5000 }),
    assistantMessage(6, { turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 3 } }),
    stepEnd(7, { time: 6000 }),
  ]
}

export function forkLog() {
  return [
    header(0, { tools: [{ name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('fork prompt')),
    stepStart(2, { time: 2000 }),
    assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 2 } }),
    stepEnd(4, { time: 3000 }),
  ]
}

export function otherLog() {
  return [
    header(0, { tools: [], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('other prompt')),
  ]
}

export function makeCorpus() {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  const fake = fakeCtx({
    workspaceRegistry: {
      list: () => [{ title: 'workspace-one', sessionIds: ['root', 'child', 'fork'] }],
      archivedSessionIds: ['fork'],
    },
    sessionProjectionCache: {
      cachedSnapshot: (header: Record<string, unknown>) => ({
        values: {
          title: `title-${String(header.id)}`,
          sessionListMetadata: { blank: false, lastPromptAt: 500 },
        },
      }),
    },
    sessionProjections: {
      snapshot: () => ({ values: { title: 'live-title', sessionListMetadata: { blank: false, lastPromptAt: 700 } } }),
    },
    agents: { get: (id: string) => id === 'root' ? { status: 'running' } : undefined },
  }, { injectAll: true })
  const entries = [
    { id: 'root', header: { id: 'root', createdAt: 100, cwd: '/repo/root' }, live: false },
    { id: 'child', header: { id: 'child', createdAt: 200, cwd: '/repo/root', parentSession: 'root', origin: 'subagent', isSeeded: true, delegationDepth: 1 }, live: false },
    { id: 'fork', header: { id: 'fork', createdAt: 300, cwd: '/repo/fork', parentSession: 'root' }, live: false },
    { id: 'other', header: { id: 'other', createdAt: 400, cwd: '/repo/other' }, live: true, session: {} },
  ]
  admitRows(db, admissionRows(fake.ctx, entries))
  foldSession({ db, sessionId: 'root', title: 'title-root', cwd: '/repo/root', events: rootLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'child', title: 'title-child', cwd: '/repo/root', isSeeded: true, events: childLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'fork', title: 'title-fork', cwd: '/repo/fork', events: forkLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'other', title: 'title-other', cwd: '/repo/other', events: otherLog(), bounds: BOUNDS, incremental: false })
  return { opened, db, fake }
}

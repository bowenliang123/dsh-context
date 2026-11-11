// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { SLOW_MS, attentionOf, byLatest, bySlowest, commandsOf, durationOf, matchesFilter, matchesQuery, previewOf, programOf, programsOf, resultTextOf, surfaceSeqOf, viewsOf, tallyOfCommands, type Command } from '../../src/client/commands'
import { type SurfaceNode, type ContextTimeline, type RequestRecord, type ContextHeaders, type HeaderRecord } from '../../src/shared/types'
import { registerContextCommand } from '../../src/client/command'
import { DICT_EN } from '../../src/client/i18n'
import { ContextIcon } from '../../src/client/icon'
import { modalStoreOf, takePendingConsume } from '../../src/client/modalStore'
import { type InputTriggersFace } from '../../src/client/services'
import { asClientCtx, TestClientCtx } from './helpers/harness'
import { makeKit, surfaceNodeAt } from './helpers/kit'
import { grammarOfTool, highlightRuns } from '../../src/client/commandHighlight'
import { disposeRetention } from '../../src/client/retention'
import { type CodeHighlighter, type HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import { postRoute, postRouteEnvelope, postRouteQuietly, RouteError } from '../../src/client/route'
import { briefNodes, briefOf } from '../../src/client/brief'
import { ATTACHMENT_ROUTE, BACKFILL_ROUTE, BALANCE_ROUTE, COMMANDS_ROUTE, DETAIL_ROUTE, FLEET_ROUTE, SKILLS_ROUTE, VERSION_ROUTE } from '../../src/client/apiRoutes'
import { assemble, headerAt, systemAt } from '../../src/shared/assemble'

describe('commands', () => {

const T0 = 1_700_000_000_000

function cmd(seq: number, over: Partial<Command> = {}): Command {
  return {
    seq,
    time: T0 + seq * 1000,
    tool: 'bash',
    cmd: 'git status',
    start: T0 + seq * 1000,
    status: 'completed',
    err: false,
    ...over,
  }
}

describe('commandsOf — the gone join', () => {
  test('a removed result node stamps its record; live and nested records read their own keys', () => {
    const archive: SurfaceNode[] = [
      { seq: 50, cat: 'tool', tokens: 1, gone: 70 },
      { seq: 60, cat: 'tool', tokens: 1, gone: 71 },
      { seq: 62, cat: 'tool', tokens: 1 },
    ]
    const records = [
      cmd(1, { resultSeq: 50 }),
      cmd(2, { resultSeq: 55 }),
      cmd(3, { codeMode: true, parent: 60 }),
      cmd(4),
      cmd(5, { resultSeq: 50, gone: 99 }),
    ]
    const joined = commandsOf(records, archive)
    assert.equal(joined[0].gone, 70)
    assert.equal(joined[1].gone, undefined)
    assert.equal(joined[2].gone, 71, 'nested records join through their parent')
    assert.equal(joined[3].gone, undefined)
    assert.equal(joined[4].gone, 99)
  })
})

describe('surfaceSeqOf / durationOf', () => {
  test('the reveal target is the parent for nested runs, else the result node; a duration needs both endpoints and never goes negative', () => {
    assert.equal(surfaceSeqOf(cmd(1, { resultSeq: 9 })), 9)
    assert.equal(surfaceSeqOf(cmd(1, { resultSeq: 9, parent: 12 })), 12)
    assert.equal(surfaceSeqOf(cmd(1)), undefined)
    assert.equal(durationOf(cmd(1, { start: 100, end: 4200 })), 4100)
    assert.equal(durationOf(cmd(1, { start: 100 })), undefined)
    assert.equal(durationOf(cmd(1, { start: 100, end: 50 })), 0)
  })
})

describe('previewOf', () => {
  test('hides a leading workspace cd prefix and takes the first line', () => {
    assert.equal(previewOf(cmd(1, { cmd: 'cd /repo && git status' }), '/repo'), 'git status')
    assert.equal(previewOf(cmd(1, { cmd: 'cd /elsewhere && git status' }), '/repo'), 'cd /elsewhere && git status')
    assert.equal(previewOf(cmd(1, { cmd: 'cd /repo && python3 - <<\'PY\'\nbody\nPY' }), '/repo'), 'python3 - <<\'PY\'')
  })
})

describe('viewsOf — one derivation per record', () => {
  test('program lists cover run_code and non-command tools', () => {
    const views = viewsOf([cmd(1, { tool: 'run_code' }), cmd(2, { tool: 'edit' })], undefined)
    assert.deepEqual(views.map(view => view.programs), [['run_code'], ['edit']])
  })

  test('carries the program, the preview and the shape badges', () => {
    const views = viewsOf([
      cmd(1, { cmd: "cd /repo && python3 - <<'PY'\nprint(1)\nPY" }),
      cmd(2, { tool: 'run_code', cmd: 'await x()', status: 'running' }),
      cmd(3, { cmd: '   ' }),
      cmd(4, { tool: 'pwsh', cmd: '   ' }),
    ], '/repo')
    assert.deepEqual(views.map(v => v.program), ['python3', 'run_code', 'shell', 'pwsh'])
    assert.deepEqual(views.map(v => v.programs), [['python3'], ['run_code'], ['shell'], ['pwsh']])
    assert.equal(views[0].preview, "python3 - <<'PY'")
    assert.deepEqual(views[0].shape, { lines: 3, heredoc: true, inline: false })
    assert.deepEqual(views[1].shape, { lines: 1, heredoc: false, inline: false })
  })
})

describe('filters, search, and sort', () => {
  const records = [
    cmd(1, { cmd: 'git status', status: 'completed' }),
    cmd(2, { cmd: 'vitest run', status: 'failed', exit: 1, start: T0 + 2000, end: T0 + 22000, description: 'run the tests' }),
    cmd(3, { cmd: 'pnpm dev', status: 'running', background: true }),
    cmd(4, { cmd: 'tsc --noEmit', status: 'completed', start: T0 + 4000, end: T0 + 4400, cwd: '/repo/sub' }),
  ]

  test('the chips filter on status, slowness, and background', () => {
    const pick = (f: 'all' | 'failed' | 'slow' | 'background') => records.filter(r => matchesFilter(r, f)).map(r => r.seq)
    assert.deepEqual(pick('all'), [1, 2, 3, 4])
    assert.deepEqual(pick('failed'), [2])
    assert.deepEqual(pick('slow'), [2], `the ${SLOW_MS}ms bar`)
    assert.deepEqual(pick('background'), [3])
  })

  test('search reads the command, the description, the cwd, and the program identity', () => {
    const pick = (q: string) => records.filter(r => matchesQuery(r, q)).map(r => r.seq)
    assert.deepEqual(pick(''), [1, 2, 3, 4])
    assert.deepEqual(pick('vitest'), [2])
    assert.deepEqual(pick('TESTS'), [2])
    assert.deepEqual(pick('/repo/sub'), [4])
    assert.deepEqual(pick('absent'), [])
    assert.equal(matchesQuery(cmd(1, { cmd: 'for f in a; do echo $f; done' }), 'shell'), true)
    assert.equal(matchesQuery(cmd(2, { tool: 'run_code', cmd: 'await x()' }), 'run_code'), true)
    const rec = cmd(1, { cmd: 'git status' })
    assert.equal(matchesQuery(rec, 'my-program', 'my-program'), true, 'a supplied program is the one searched')
    assert.equal(matchesQuery(rec, 'my-program'), false)
    assert.equal(matchesQuery(cmd(1, { cmd: 'git status && my\\ cmd' }), 'my cmd', ['git', 'my cmd']), true, 'any contained program matches')
    assert.equal(matchesQuery(cmd(1, { cmd: 'git status' }), 'my cmd', ['git']), false)
  })

  test('latest is time-descending with a seq tie-break; slowest puts duration-less runs last', () => {
    assert.deepEqual(records.slice().sort(byLatest).map(r => r.seq), [4, 3, 2, 1])
    assert.deepEqual(records.slice().sort(bySlowest).map(r => r.seq), [2, 4, 3, 1])
    const tied = [cmd(1), { ...cmd(2), time: cmd(1).time }]
    assert.deepEqual(tied.slice().sort(byLatest).map(r => r.seq), [2, 1])
  })
})

describe('tallyOfCommands', () => {
  test('the list fallback tallies settled runs only', () => {
    const tally = tallyOfCommands([
      cmd(1, { status: 'completed', start: 0, end: 100 }),
      cmd(2, { status: 'failed', start: 0, end: 900 }),
      cmd(3, { status: 'killed', start: 0 }),
      cmd(4, { status: 'running', background: true }),
      cmd(5, { status: 'completed', background: true, start: 0, end: 50 }),
    ])
    assert.deepEqual(tally, { runs: 4, failed: 2, ms: 1050, bg: 2 })
  })
})

describe('the rail derivations', () => {
  test('programOf reads the shell head word and the code tool identity, falling back per dialect', () => {
    assert.equal(programOf(cmd(1, { cmd: 'cd /repo && git status' })), 'git')
    assert.equal(programOf(cmd(2, { tool: 'pwsh', cmd: 'Get-ChildItem' })), 'Get-ChildItem')
    assert.equal(programOf(cmd(3, { tool: 'run_code', cmd: 'await x()' })), 'run_code')
    assert.equal(programOf(cmd(4, { cmd: 'for f in a; do echo $f; done' })), 'shell')
    assert.equal(programOf(cmd(5, { cmd: '   ' })), 'shell', 'a blank command reads as shell too')
    assert.equal(programOf(cmd(6, { tool: 'pwsh', cmd: '   ' })), 'pwsh', 'a blank pwsh command reads as pwsh')
    assert.equal(programOf(cmd(7, { tool: 'read', cmd: '' })), 'read', 'a non-command tool names itself')
  })

  test('a record without cmd names its tool and still matches and tallies', () => {
    assert.equal(programOf(cmd(1, { cmd: undefined })), 'shell', 'a cmd-less shell record reads as shell')
    assert.equal(matchesQuery(cmd(2, { cmd: undefined, description: 'list files' }), 'files'), true)
    assert.equal(matchesQuery(cmd(3, { cmd: undefined }), 'zzz'), false)
    const attention = attentionOf(viewsOf([
      cmd(4, { cmd: undefined, status: 'failed', exit: 1 }),
      cmd(5, { cmd: undefined, start: 0, end: 90_000 }),
    ], undefined))
    assert.equal(attention.slowest?.cmd, '', 'the slowest card names the blank command')
    assert.deepEqual(attention.failing, { program: 'shell', count: 1 })
  })

  test('programsOf ranks every program by count with a stable name tie-break', () => {
    const records = [
      cmd(1, { cmd: 'git status' }),
      cmd(2, { cmd: 'git diff' }),
      cmd(3, { cmd: 'pnpm run build' }),
      cmd(4, { cmd: 'grep -rn x src' }),
      cmd(5, { tool: 'run_code', cmd: 'await 1' }),
      cmd(6, { cmd: 'git log' }),
    ]
    assert.deepEqual(programsOf(viewsOf(records, undefined)), [
      { name: 'git', n: 3, runs: 3 },
      { name: 'grep', n: 1, runs: 1 },
      { name: 'pnpm', n: 1, runs: 1 },
      { name: 'run_code', n: 1, runs: 1 },
    ])
  })

  test('programsOf counts every invocation and each containing run once', () => {
    const views = viewsOf([
      cmd(1, { cmd: 'grep foo a | grep -v bar && grep -c baz b' }),
      cmd(2, { cmd: 'echo hi && cat package.json' }),
      cmd(3, { cmd: 'cat README.md' }),
    ], undefined)
    assert.deepEqual(views.map(v => v.program), ['grep', 'echo', 'cat'])
    assert.deepEqual(programsOf(views), [
      { name: 'grep', n: 3, runs: 1 },
      { name: 'cat', n: 2, runs: 2 },
      { name: 'echo', n: 1, runs: 1 },
    ])
    assert.deepEqual(programsOf(viewsOf([
      cmd(1, { cmd: 'git status && git diff' }),
      cmd(2, { cmd: 'git log' }),
      cmd(3, { cmd: 'git status' }),
      cmd(4, { cmd: 'git branch' }),
    ], undefined)), [{ name: 'git', n: 5, runs: 4 }])
  })

  test('attentionOf counts each failed run once per contained program', () => {
    const attention = attentionOf(viewsOf([
      cmd(1, { cmd: 'git status && cat missing', status: 'failed' }),
      cmd(2, { cmd: 'cat one && cat two', status: 'failed' }),
    ], undefined))
    assert.deepEqual(attention.failing, { program: 'cat', count: 2 })
  })

  test('attentionOf ranks slowest, most-failed, repeats, and background; ties keep the first pick; nothing notable stays empty', () => {
    const attention = attentionOf(viewsOf([
      cmd(1, { cmd: 'git status', start: 0, end: 300 }),
      cmd(2, { cmd: 'pnpm build', start: 0, end: 90_000 }),
      cmd(3, { cmd: 'vitest run a', status: 'failed', exit: 1 }),
      cmd(4, { cmd: 'vitest run b', status: 'failed', exit: 1 }),
      cmd(5, { cmd: 'git status' }),
      cmd(6, { cmd: 'sleep 9', status: 'running', background: true }),
    ], undefined))
    assert.deepEqual(attention.slowest, { cmd: 'pnpm build', ms: 90_000 })
    assert.deepEqual(attention.failing, { program: 'vitest', count: 2 })
    assert.deepEqual(attention.repeats, { cmd: 'git status', count: 2 })
    assert.equal(attention.background, 1)

    const tied = attentionOf(viewsOf([
      cmd(1, { cmd: 'vitest a', status: 'failed', start: 0, end: 5000 }),
      cmd(2, { cmd: 'eslint b', status: 'failed', start: 0, end: 3000 }),
      cmd(3, { cmd: 'git status' }),
      cmd(4, { cmd: 'git diff' }),
      cmd(5, { cmd: 'git status' }),
      cmd(6, { cmd: 'git diff' }),
      cmd(7, { cmd: 'pnpm build', start: 0, end: 60_000 }),
      cmd(8, { cmd: 'pnpm test', start: 0, end: 30_000 }),
    ], undefined))
    assert.equal(tied.failing?.count, 1, 'each program failed once — first-seen holds the tie')
    assert.equal(tied.failing?.program, 'vitest')
    assert.equal(tied.repeats?.cmd, 'git status', 'first-seen holds the repeats tie')
    assert.deepEqual(tied.slowest, { cmd: 'pnpm build', ms: 60_000 })

    assert.deepEqual(attentionOf([]), {})
    assert.deepEqual(attentionOf(viewsOf([cmd(1, { start: 0, end: 50 })], undefined)), {})
    assert.equal(attentionOf(viewsOf([cmd(1, { start: 0, end: 500 })], undefined)).slowest, undefined)
  })
})

describe("resultTextOf — the detail result preview", () => {
  test('text blocks join; nested tool-result blocks flatten; the blocks field falls back; unreadable text reads null', () => {
    assert.equal(resultTextOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
    assert.equal(resultTextOf({ content: [{ type: 'tool-result', content: [{ kind: 'text', text: 'x' }] }, { type: 'text', text: 'y' }] }), 'x\ny')
    assert.equal(resultTextOf({ blocks: [{ kind: 'text', text: 'k' }] }), 'k')
    assert.equal(resultTextOf(null), null)
    assert.equal(resultTextOf(undefined), null)
    assert.equal(resultTextOf('junk'), null)
    assert.equal(resultTextOf({}), null)
    assert.equal(resultTextOf({ content: [] }), null)
    assert.equal(resultTextOf({ content: [null, 'str', { type: 'image' }, { type: 'text', text: '' }, { type: 'tool-result' }, { type: 42 }] }), null)
  })
})
})

describe('command', () => {

type Source = Parameters<InputTriggersFace['registerSource']>[0]

class TestInputTriggers {
  readonly sources: Source[] = []

  registerSource(src: Source): () => void {
    this.sources.push(src)
    return () => {
      const i = this.sources.indexOf(src)
      if (i >= 0) this.sources.splice(i, 1)
    }
  }
}

const SIGNAL = new AbortController().signal

function setup(): { ctx: TestClientCtx; inputTriggers: TestInputTriggers; source: Source } {
  const inputTriggers = new TestInputTriggers()
  const ctx = new TestClientCtx({ services: { inputTriggers } })
  registerContextCommand(asClientCtx(ctx), makeKit())
  assert.equal(inputTriggers.sources.length, 1)
  return { ctx, inputTriggers, source: inputTriggers.sources[0] }
}

describe('registerContextCommand', () => {
  test('without the input-triggers service nothing registers and disposal is safe', () => {
    const ctx = new TestClientCtx()
    registerContextCommand(asClientCtx(ctx), makeKit())
    ctx.dispose()
  })

  test('a service provided with a foreign shape registers nothing', () => {
    const ctx = new TestClientCtx({ services: { inputTriggers: { registerSource: 42 } } })
    registerContextCommand(asClientCtx(ctx), makeKit())
    ctx.dispose()
  })

  test('with the service it registers one "/" source named context at order 1', () => {
    const { ctx, inputTriggers, source } = setup()
    assert.equal(source.trigger, '/')
    assert.equal(source.name, 'context')
    assert.equal(source.order, 1)
    ctx.dispose()
    assert.equal(inputTriggers.sources.length, 0)
  })
})

describe('candidates', () => {
  test('a non-leading position yields no candidates', async () => {
    const { source } = setup()
    assert.deepEqual(await source.candidates({ sessionId: 'cmd-pos' }, { query: '', position: 'inline', signal: SIGNAL }), [])
  })

  test('an empty query yields the context candidate', async () => {
    const { source } = setup()
    const candidates = await source.candidates({ sessionId: 'cmd-empty' }, { query: '', position: 'leading', signal: SIGNAL })
    assert.deepEqual(candidates, [{
      name: 'context',
      label: DICT_EN['cmd.label'],
      icon: ContextIcon,
      section: DICT_EN['cmd.section'],
      description: DICT_EN['cmd.desc'],
    }])
  })

  test('a matching prefix yields the candidate; a mismatch or case/whitespace-normalized mismatch yields none', async () => {
    const { source } = setup()
    const session = { sessionId: 'cmd-prefix' }
    const hit = await source.candidates(session, { query: 'con', position: 'leading', signal: SIGNAL })
    assert.equal(hit.length, 1)
    assert.equal(hit[0].name, 'context')
    assert.deepEqual(await source.candidates(session, { query: 'xyz', position: 'leading', signal: SIGNAL }), [])
    assert.equal((await source.candidates(session, { query: ' CONTEXT ', position: 'leading', signal: SIGNAL })).length, 1)
  })
})

describe('onPick', () => {
  test('records the span guard, opens the modal, and answers handled', () => {
    const { source } = setup()
    const span = { start: 0, end: 8, draftRev: 3 }
    const outcome = source.onPick({
      candidate: { name: 'context' },
      session: { sessionId: 'cmd-pick' },
      position: 'leading',
      via: 'menu',
      span,
    })
    assert.equal(outcome, 'handled')
    assert.equal(modalStoreOf('cmd-pick').getSnapshot(), true)
    assert.deepEqual(takePendingConsume('cmd-pick'), { kind: 'span', span })
  })
})

describe('matchEnter', () => {
  test('the bare /context line arms the bare-token guard, opens the modal, and answers handled', async () => {
    const { source } = setup()
    assert.ok(source.matchEnter, 'the /context source registers matchEnter')
    const outcome = await source.matchEnter({ sessionId: 'cmd-enter' }, '/context', SIGNAL)
    assert.equal(outcome, 'handled')
    assert.equal(modalStoreOf('cmd-enter').getSnapshot(), true)
    assert.deepEqual(takePendingConsume('cmd-enter'), { kind: 'bare-token', token: '/context' })
  })

  test('a line other than the bare /context is not matched', async () => {
    const { source } = setup()
    assert.ok(source.matchEnter)
    assert.equal(await source.matchEnter({ sessionId: 'cmd-extra' }, '/context extra', SIGNAL), undefined)
    assert.equal(await source.matchEnter({ sessionId: 'cmd-other' }, 'hello', SIGNAL), undefined)
    assert.equal(takePendingConsume('cmd-extra'), undefined)
  })
})
})

describe('commandHighlight', () => {

const RUNS: HighlightSpan[][] = [[{ text: 'git', style: { color: 'var(--shiki-token-function)' } }]]

describe('grammarOfTool', () => {
  test('maps the shell dialects and leaves every other tool plain', () => {
    assert.equal(grammarOfTool('bash'), 'bash')
    assert.equal(grammarOfTool('pwsh'), 'powershell')
    assert.equal(grammarOfTool('run_code'), undefined)
    assert.equal(grammarOfTool('read_file'), undefined)
  })
})

describe('highlightRuns', () => {
  test('tokenizes once per grammar and text', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    const text = 'git status --short && ls'
    assert.equal(highlightRuns(highlight, 'bash', text), RUNS)
    assert.equal(highlightRuns(highlight, 'bash', text), RUNS)
    assert.equal(calls, 1)
    assert.equal(highlightRuns(highlight, 'powershell', text), RUNS)
    assert.equal(calls, 2)
  })

  test('re-attempts a text the loading grammar could not tokenize, and refuses an over-long line', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return undefined }
    assert.equal(highlightRuns(highlight, 'powershell', 'Get-ChildItem -Recurse'), undefined)
    assert.equal(highlightRuns(highlight, 'powershell', 'Get-ChildItem -Recurse'), undefined)
    assert.equal(calls, 2)
    const long = 'x'.repeat(1001)
    assert.equal(highlightRuns(highlight, 'bash', long), undefined)
    assert.equal(calls, 2)
    assert.equal(highlightRuns(highlight, 'bash', 'ls\n' + long), undefined)
    assert.equal(calls, 2)
  })

  test('a cached run expires after the retention ttl', () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
      highlightRuns(highlight, 'bash', 'expire me gently')
      vi.advanceTimersByTime(10 * 60_000)
      highlightRuns(highlight, 'bash', 'expire me gently')
      assert.equal(calls, 2, 'the expired highlight was recomputed')
    } finally {
      vi.useRealTimers()
    }
  })

  test('drops the least recently used text past the cap', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    const texts = Array.from({ length: 601 }, (_, i) => 'lru probe ' + i)
    for (const text of texts) highlightRuns(highlight, 'bash', text)
    assert.equal(calls, 601)
    highlightRuns(highlight, 'bash', texts[0])
    assert.equal(calls, 602)
  })
})

describe('highlight disposal', () => {
  test('dispose drops the run ledger so the plugin leaves nothing behind', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    highlightRuns(highlight, 'bash', 'dispose probe')
    assert.equal(calls, 1)
    disposeRetention()
    highlightRuns(highlight, 'bash', 'dispose probe')
    assert.equal(calls, 2, 'the disposed ledger no longer replays')
  })
})
})

describe('route', () => {

interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

interface Call {
  url: unknown
  init: FetchInit
}

function stubFetch(outcome: (call: Call) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: unknown, init: FetchInit) => {
    const call = { url, init }
    calls.push(call)
    return outcome(call)
  })
  return calls
}

function envelope(value: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status === 200, status, json: async () => ({ ok: true, value }) }
}

const decodeNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postRoute', () => {
  test('POSTs the JSON body to the route and resolves the decoded value', async () => {
    const calls = stubFetch(() => envelope(7))
    const decoded = await postRoute('api/route', { sessionId: 's1' }, decodeNumber)
    assert.equal(decoded, 7)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'api/route')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' })
    assert.equal(calls[0].init.body, JSON.stringify({ sessionId: 's1' }))
    assert.equal('signal' in calls[0].init, false, 'no signal is attached unless asked')
  })

  test('forwards the abort signal', async () => {
    const calls = stubFetch(() => envelope(1))
    const controller = new AbortController()
    await postRoute('api/route', {}, decodeNumber, { signal: controller.signal })
    assert.equal(calls[0].init.signal, controller.signal)
  })

  test('an absent envelope value resolves null without decoding', async () => {
    let decoded = 0
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const result = await postRoute('api/route', {}, (value: unknown) => {
      decoded++
      return decodeNumber(value)
    })
    assert.equal(result, null)
    assert.equal(decoded, 0, 'the decoder never runs for an absent value')
  })

  test('a non-ok HTTP status throws a RouteError naming the route and status', async () => {
    stubFetch(() => envelope(null, 404))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), (error: unknown) => {
      assert.ok(error instanceof RouteError)
      assert.match(error.message, /route HTTP 404/)
      assert.equal(error.status, 404)
      return true
    })
  })

  test('an unreadable or non-envelope body throws the read-failed error', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => 42 }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
  })

  test('a decoder rejection throws the read-malformed error', async () => {
    stubFetch(() => envelope('not-a-number'))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read malformed/)
  })

  test('a transport rejection propagates untouched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /offline/)
  })

  test('the label option names the failing read; the route stands in when absent', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: true, value: 1 }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail route HTTP 500/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail read failed/)
    stubFetch(() => envelope('junk'))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail read malformed/)
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /dsh-context: api\/route route HTTP 500/)
  })
})

describe('postRouteQuietly', () => {
  test('resolves the decoded value on success and null on absence', async () => {
    stubFetch(() => envelope(3))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), 3)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
  })

  test('degrades every defect, transport failure included, to null', async () => {
    stubFetch(() => envelope(null, 500))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    stubFetch(() => envelope('junk'))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber, { label: 'quiet' }), null)
  })
})

describe('postRouteEnvelope', () => {
  test('carries the revision and the decoded value of a changed reply', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: 4, revision: 'rev-1' }) }))
    const read = await postRouteEnvelope('api/route', { revision: null }, decodeNumber)
    assert.deepEqual(read, { value: 4, unchanged: false, revision: 'rev-1' })
  })

  test('an unchanged reply skips decoding and still reports the revision', async () => {
    let decoded = 0
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { stale: true }, revision: 'rev-2', unchanged: true }) }))
    const read = await postRouteEnvelope('api/route', {}, (value: unknown) => {
      decoded++
      return decodeNumber(value)
    })
    assert.deepEqual(read, { value: null, unchanged: true, revision: 'rev-2' })
    assert.equal(decoded, 0)
  })

  test('an unchanged reply without a revision and a value-less reply with one keep both shapes', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {}, unchanged: true }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: true })
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null, revision: 'rev-3' }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: false, revision: 'rev-3' })
  })

  test('an absent value or a hostile revision degrades to null and no revision', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null, revision: 7 }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: false })
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: 4, revision: '' }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: 4, unchanged: false })
  })

  test('a malformed decoded payload throws and transport defects reject', async () => {
    stubFetch(() => envelope('junk'))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber, { label: 'overview' }), /dsh-context: overview read malformed/)
    stubFetch(() => envelope(null, 502))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber), /route HTTP 502/)
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber), RouteError)
  })
})
})

describe('brief', () => {

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function timeline(nodes: SurfaceNode[], archive: SurfaceNode[]): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes,
    droppedNodes: 0,
    archive,
  }
}

describe('briefNodes', () => {
  test('merges live and archived nodes sorted by seq; an out-of-range index yields no brief', () => {
    const data = timeline([surfaceNodeAt(5), surfaceNodeAt(1)], [surfaceNodeAt(3, { gone: 9 }), surfaceNodeAt(2, { gone: 9 })])
    assert.deepEqual(briefNodes(data).map(n => n.seq), [1, 2, 3, 5])
    assert.equal(briefOf([], [req(1)], -1), null)
    assert.equal(briefOf([], [req(1)], 1), null)
  })
})

describe('briefOf response', () => {
  test('only an assistant node at the request seq is a response', () => {
    const nodes = [surfaceNodeAt(5, { cat: 'assistant', text: 'hi' })]
    assert.equal(briefOf(nodes, [req(5, { turn: 1 })], 0)?.response, nodes[0])
    assert.equal(briefOf([surfaceNodeAt(5)], [req(5, { turn: 1 })], 0)?.response, undefined, 'a non-assistant node is not a response')
    assert.equal(briefOf([surfaceNodeAt(4)], [req(5, { turn: 1 })], 0)?.response, undefined, 'no node at the seq means no response')
  })
})

describe('briefOf opener scan', () => {
  test('the opener is the newest user message before the turn starts, scoped to the turn window', () => {
    const nodes = [surfaceNodeAt(1), surfaceNodeAt(2), surfaceNodeAt(3, { cat: 'tool' }), surfaceNodeAt(5, { cat: 'assistant' })]
    assert.equal(briefOf(nodes, [req(5, { turn: 1 })], 0)?.opener, nodes[1])
    assert.equal(briefOf([surfaceNodeAt(3, { cat: 'tool' }), surfaceNodeAt(5, { cat: 'assistant' })], [req(5, { turn: 1 })], 0)?.opener, undefined, 'no user message in the window')
    const turnNodes = [surfaceNodeAt(1), surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(5, { cat: 'tool' }), surfaceNodeAt(7, { cat: 'assistant' })]
    const turnRequests = [req(3, { turn: 1 }), req(7, { turn: 2 })]
    assert.equal(briefOf(turnNodes, turnRequests, 1)?.opener, undefined, 'the scan stops at the previous turn’s last bar')
    const later = [surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(5), surfaceNodeAt(7, { cat: 'assistant' })]
    assert.equal(briefOf(later, turnRequests, 1)?.opener, later[1], 'a user message inside the later turn’s window is found')
  })
})

describe('briefOf inputs', () => {
  test('a mid-turn step collects the nodes since the previous bar, up to the request seq', () => {
    const nodes = [surfaceNodeAt(2), surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(5), surfaceNodeAt(7, { cat: 'assistant' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    assert.deepEqual(briefOf(nodes, requests, 1)?.inputs.map(n => n.seq), [4, 5])
    const tail = [surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(9, { cat: 'tool' })]
    const tailRequests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    assert.deepEqual(briefOf(tail, tailRequests, 1)?.inputs.map(n => n.seq), [4], 'the scan stops at the request seq even past the node tail')
  })

  test('a turn start and a missing previous turn field both yield no inputs row; requests without turn fields share the default turn', () => {
    assert.deepEqual(briefOf([surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(5)], [req(3, { turn: 1 }), req(7, { turn: 2 })], 1)?.inputs, [])
    assert.deepEqual(briefOf([], [req(3), req(7, { turn: 2 })], 1)?.inputs, [])
    assert.deepEqual(briefOf([surfaceNodeAt(4, { cat: 'tool' })], [req(3), req(7)], 1)?.inputs.map(n => n.seq), [4])
  })
})
})

describe('apiRoutes', () => {

describe('apiRoutes', () => {
  test('every fetch route stays browser-relative under the plugin namespace', () => {
    for (const route of [ATTACHMENT_ROUTE, BACKFILL_ROUTE, BALANCE_ROUTE, COMMANDS_ROUTE, DETAIL_ROUTE, FLEET_ROUTE, SKILLS_ROUTE, VERSION_ROUTE]) {
      assert.match(route, /^api\/dsh-context\/\w+$/, route)
    }
  })
})
})

describe('assemble', () => {

function epoch(seq: number): HeaderRecord {
  return { seq, time: 0, tools: [] }
}

function headers(...seqs: number[]): ContextHeaders {
  return { headers: seqs.map(epoch) }
}

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

describe('headerAt', () => {
  test('absent/empty headers or a seq at or before every epoch yield null; otherwise the newest epoch in force', () => {
    assert.equal(headerAt(null, 10), null)
    assert.equal(headerAt({ headers: [] }, 10), null)
    assert.equal(headerAt(headers(10, 20), 10), null)
    const h = headers(10, 20)
    assert.equal(headerAt(h, null), h.headers[1], 'a null seq picks the newest epoch')
    assert.equal(headerAt(h, 15), h.headers[0])
    assert.equal(headerAt(h, 25), h.headers[1])
  })
})

describe('assemble live view', () => {
  test('a null seq returns all live nodes for the next request, with the resolved system prompt; dropped nodes count as live', () => {
    const sys = { seq: 3, time: 300, tokens: 10 }
    const data = timeline({ nodes: [surfaceNodeAt(1), surfaceNodeAt(5)], systems: [sys] })
    const h = headers(10)
    const out = assemble(data, h, null)
    assert.equal(out.live, true)
    assert.deepEqual(out.nodes.map(n => n.seq), [1, 5])
    assert.notEqual(out.nodes, data.nodes)
    assert.equal(out.header, h.headers[0])
    assert.deepEqual(out.system, sys)
    assert.equal(out.missingLive, 0)
    assert.equal(out.approximate, false)
    const dropped = timeline({ nodes: [surfaceNodeAt(5)], droppedNodes: 3, surfaceFloor: 4 })
    assert.equal(assemble(dropped, null, null).missingLive, 3)
  })
})

describe('assemble past step', () => {
  test('the surface is live nodes before the step plus still-alive archive nodes in seq order, with the header in force', () => {
    const data = timeline({
      nodes: [surfaceNodeAt(1), surfaceNodeAt(3), surfaceNodeAt(8)],
      archive: [
        surfaceNodeAt(2, { gone: 10 }),
        surfaceNodeAt(4, { gone: 5 }),
        surfaceNodeAt(6),
        surfaceNodeAt(9, { gone: 12 }),
      ],
    })
    const h = headers(2, 10)
    const out = assemble(data, h, 7)
    assert.equal(out.live, false)
    assert.deepEqual(out.nodes.map(n => n.seq), [1, 2, 3])
    assert.equal(out.header, h.headers[0])
    assert.equal(assemble(timeline(), h, 1).header, null)
  })
})

describe('assemble missingLive for past steps', () => {
  test('a step after the surface floor contains every dropped live node; at/below it or without one flags nothing', () => {
    const data = timeline({ droppedNodes: 2, surfaceFloor: 5 })
    assert.equal(assemble(data, null, 6).missingLive, 2)
    assert.equal(assemble(data, null, 5).missingLive, 0)
    assert.equal(assemble(data, null, 3).missingLive, 0)
    assert.equal(assemble(timeline({ droppedNodes: 2 }), null, 6).missingLive, 0)
  })
})

describe('assemble approximate flag', () => {
  test('a step older than the archive floor is approximate; at/after it or without one is exact', () => {
    const data = timeline({ archiveFloor: 10 })
    assert.equal(assemble(data, null, 6).approximate, true)
    assert.equal(assemble(data, null, 10).approximate, false)
    assert.equal(assemble(timeline(), null, 6).approximate, false)
  })
})

describe('systemAt — the system prompt in force', () => {
  const sys = (seq: number, tokens: number, time = seq * 100) => ({ seq, time, tokens })

  test('the last nonempty live node wins; a step resolves the prompt logged before it; dormant-only lists yield none', () => {
    const data = timeline({ systems: [sys(3, 10), sys(8, 0), sys(12, 20)] })
    assert.deepEqual(systemAt(data, null, null), sys(12, 20))
    assert.deepEqual(systemAt(timeline({ systems: [sys(3, 10), sys(8, 0)] }), null, null), sys(3, 10))
    assert.deepEqual(systemAt(data, null, 12), sys(3, 10))
    assert.deepEqual(systemAt(data, null, 13), sys(12, 20))
    assert.equal(systemAt(data, null, 3), null, 'at the node itself the prompt is not yet in force')
    assert.equal(systemAt(timeline({ systems: [sys(3, 0)] }), null, null), null)

    const epoch: HeaderRecord = { seq: 15, time: 1500, systemTokens: 42, tools: [] }
    assert.deepEqual(systemAt(timeline(), epoch, null), { seq: 15, time: 1500, tokens: 42 })
    assert.deepEqual(systemAt(timeline({ systems: [] }), epoch, 20), { seq: 15, time: 1500, tokens: 42 })
    assert.equal(systemAt(timeline(), { seq: 15, time: 1500, tools: [] }, null), null, 'an epoch without a price yields none')
    assert.equal(systemAt(timeline(), null, null), null)
  })
})
})

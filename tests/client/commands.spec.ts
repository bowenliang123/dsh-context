import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  SLOW_MS,
  attentionOf,
  byLatest,
  bySlowest,
  commandsOf,
  durationOf,
  matchesFilter,
  matchesQuery,
  previewOf,
  programOf,
  programsOf,
  resultTextOf,
  surfaceSeqOf,
  viewsOf,
  tallyOfCommands,
} from '../../src/client/commands'
import type { Command } from '../../src/client/commands'
import type { SurfaceNode } from '../../src/shared/types'

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

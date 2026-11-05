import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { absPathOf, activityOf, activityOfOps, displayPathOf, formOf, glyphOf, locateStepOf, previewAddressOf } from '../../src/client/fileActivity'
import { kindOfCall, kindOfTool, linesOf, pathOfArgs } from '../../src/shared/fileOps'
import type { FileActivity, FileOp } from '../../src/client/fileActivity'
import type { ConversationNodeLike } from '../../src/client/services'
import type { RequestRecord, SurfaceNode } from '../../src/shared/types'

const T0 = 1700000000000

function op(
  seq: number,
  tool: string,
  args: Record<string, unknown> | null,
  extra: Partial<SurfaceNode> = {},
  convExtra: Partial<ConversationNodeLike> = {},
): { node: SurfaceNode; conv: ConversationNodeLike } {
  return {
    node: { seq, cat: 'tool', tokens: 5, tool, time: T0 + seq, ...extra },
    conv: {
      kind: 'tool',
      seq,
      call: args !== null ? { name: tool, argsRaw: JSON.stringify(args) } : null,
      ...convExtra,
    },
  }
}

function run(ops: { node: SurfaceNode; conv: ConversationNodeLike }[], before: number | null = null): FileActivity {
  const bySeq = new Map(ops.map(o => [o.node.seq, o.conv]))
  return activityOf(ops.map(o => o.node), seq => bySeq.get(seq), before)
}

describe('kindOfTool', () => {
  test('maps the known file tools to purposes; everything else is not a file op', () => {
    assert.equal(kindOfTool('read'), 'read')
    assert.equal(kindOfTool('read_image'), 'read')
    assert.equal(kindOfTool('write'), 'write')
    assert.equal(kindOfTool('edit'), 'write')
    assert.equal(kindOfTool('grep'), 'search')
    assert.equal(kindOfTool('glob'), 'search')
    assert.equal(kindOfTool('bash'), null)
    assert.equal(kindOfTool(undefined), null)
  })
})

describe('pathOfArgs', () => {
  test('null or target-less args yield no path; reads/writes take the first path-ish argument, searches prefer path then pattern', () => {
    assert.equal(pathOfArgs('read', null), null)
    assert.equal(pathOfArgs('read', {}), null)
    assert.equal(pathOfArgs('read', { file_path: '' }), null)
    assert.equal(pathOfArgs('read', { file_path: 42 }), null)
    assert.equal(pathOfArgs('read', { file_path: '/a.ts' }), '/a.ts')
    assert.equal(pathOfArgs('edit', { filePath: '/b.ts' }), '/b.ts')
    assert.equal(pathOfArgs('write', { path: '/c.ts' }), '/c.ts')
    assert.equal(pathOfArgs('grep', { pattern: 'foo', path: '/src' }), '/src')
    assert.equal(pathOfArgs('grep', { pattern: 'foo' }), 'foo')
    assert.equal(pathOfArgs('grep', { pattern: 'foo', path: '' }), 'foo')
    assert.equal(pathOfArgs('glob', { pattern: '**/*.ts' }), '**/*.ts')
    assert.equal(pathOfArgs('glob', {}), null)
  })
})

describe('linesOf', () => {
  test('counts rendered lines; a trailing newline closes its own line', () => {
    assert.equal(linesOf(''), 0)
    assert.equal(linesOf('a'), 1)
    assert.equal(linesOf('a\n'), 1)
    assert.equal(linesOf('a\nb'), 2)
  })
})

describe('formOf', () => {
  test('multimodal reads and image extensions scan apart; trailing slashes mark directories', () => {
    assert.equal(formOf('read_image', '/x.bin'), 'image')
    assert.equal(formOf('read', '/pic.PNG'), 'image')
    assert.equal(formOf('grep', '/src/'), 'dir')
    assert.equal(formOf('grep', 'C:\\repo\\src\\'), 'dir')
    assert.equal(formOf('read', '/a.ts'), 'text')
  })
})

describe('activityOf', () => {
  test('aggregates reads, writes, and searches per file with counts and line deltas', () => {
    const a = run([
      op(3, 'read', { file_path: '/src/a.ts' }),
      op(5, 'edit', { file_path: '/src/a.ts', old_string: 'x\ny\nz', new_string: 'x\nq' }),
      op(7, 'read', { file_path: '/src/a.ts' }),
      op(9, 'write', { file_path: '/src/b.ts', content: 'one\ntwo\n' }),
      op(11, 'grep', { pattern: 'needle', path: '/src' }),
      op(13, 'glob', { pattern: '**/*.md' }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['**/*.md', '/src', '/src/b.ts', '/src/a.ts'])

    const file = a.entries[3]
    assert.equal(file.reads, 2)
    assert.equal(file.writes, 1)
    assert.equal(file.searches, 0)
    assert.equal(file.added, 2)
    assert.equal(file.removed, 3)
    assert.deepEqual(file.ops.map(o => o.seq), [7, 5, 3])
    assert.equal(file.ops[0].kind, 'read')
    assert.equal(file.ops[0].time, T0 + 7)

    const written = a.entries[2]
    assert.equal(written.added, 2)
    assert.equal(written.removed, 0)

    const searched = a.entries[1]
    assert.equal(searched.searches, 1)
    assert.equal(searched.ops[0].detail, 'needle')
    assert.equal(a.entries[0].form, 'text')
    assert.equal(a.entries[0].ops[0].detail, undefined)

    assert.deepEqual(a.totals, {
      read: { files: 1, ops: 2 },
      write: { files: 2, ops: 2 },
      search: { files: 2, ops: 2 },
      image: { files: 0, ops: 0 },
      added: 4,
      removed: 3,
    })
  })

  test('flags multimodal reads and directory targets, and totals image ops', () => {
    const a = run([
      op(3, 'read_image', { file_path: '/shots/ui.png' }),
      op(5, 'read', { file_path: '/shots/logo.svg' }),
      op(7, 'grep', { pattern: 'x', path: '/src/' }),
    ])
    assert.equal(a.entries[2].form, 'image')
    assert.equal(a.entries[1].form, 'image')
    assert.equal(a.entries[0].form, 'dir')
    assert.deepEqual(a.totals.image, { files: 2, ops: 2 })
  })

  test('the before bound excludes later ops; null serves everything', () => {
    const ops = [op(3, 'read', { file_path: '/a.ts' }), op(9, 'read', { file_path: '/b.ts' })]
    assert.equal(run(ops, 9).entries.length, 1)
    assert.equal(run(ops, 9).entries[0].path, '/a.ts')
    assert.equal(run(ops, null).entries.length, 2)
  })

  test('the error flags and the archive removal stamp ride the op', () => {
    const a = run([
      op(3, 'read', { file_path: '/a.ts' }, { err: true }),
      op(5, 'read', { file_path: '/a.ts' }, {}, { isError: true }),
      op(7, 'read', { file_path: '/b.ts' }),
    ])
    assert.deepEqual(a.entries[1].ops.map(o => o.err), [true, true])
    assert.equal(a.entries[0].ops[0].err, false)
    const gone = run([op(3, 'read', { file_path: '/a.ts' }, { gone: 20 })])
    assert.equal(gone.entries[0].ops[0].gone, 20)
  })

  test('non-file tools and non-tool nodes never enter the fold', () => {
    const a = run([op(3, 'bash', { command: 'ls', description: 'List files' })])
    const withNoise = activityOf(
      [
        { seq: 1, cat: 'user', tokens: 5 },
        { seq: 2, cat: 'assistant', tokens: 5 },
        { seq: 3, cat: 'tool', tokens: 5 },
        { seq: 4, cat: 'tool', tokens: 5, tool: 'todo_write' },
      ],
      () => undefined,
      null,
    )
    assert.equal(a.entries.length, 0)
    assert.deepEqual(withNoise.entries, [])
    assert.equal(withNoise.totals.read.ops, 0)
  })

  test('file-kind ops without a resolvable path are skipped — never counted, never rowed', () => {
    const a = run([
      op(3, 'read', null),
      op(5, 'edit', {}),
      op(7, 'read', { file_path: '/a.ts' }),
    ])
    assert.equal(a.entries.length, 1)
    assert.deepEqual(a.entries[0].ops.map(o => o.seq), [7])
    assert.equal(a.totals.read.ops, 1)
    assert.equal(a.totals.write.ops, 0)
    assert.equal(a.totals.read.files, 1)
  })

  test('a lost or hostile join never takes the walk down', () => {
    const lost = activityOf(
      [
        { seq: 3, cat: 'tool', tokens: 5, tool: 'read', time: T0 },
        { seq: 5, cat: 'tool', tokens: 5, tool: 'run_code', time: T0 },
      ],
      () => undefined,
      null,
    )
    assert.deepEqual(lost.entries, [])

    const hostile: ConversationNodeLike = { kind: 'tool', seq: 7 }
    Object.defineProperty(hostile, 'call', { get(): never { throw new Error('boom') } })
    const healthy = op(9, 'read', { file_path: '/a.ts' })
    const bySeq = new Map<number, ConversationNodeLike>([[7, hostile], [9, healthy.conv]])
    const mixed = activityOf(
      [
        { seq: 7, cat: 'tool', tokens: 5, tool: 'read', time: T0 },
        healthy.node,
      ],
      seq => bySeq.get(seq),
      null,
    )
    assert.deepEqual(mixed.entries.map(e => e.path), ['/a.ts'])
    assert.equal(mixed.totals.read.ops, 1)
  })

  test('an edit with missing strings contributes no line delta', () => {
    const a = run([op(3, 'edit', { file_path: '/a.ts', new_string: 'only\nadded' })])
    assert.equal(a.entries[0].added, 2)
    assert.equal(a.entries[0].removed, 0)
    const b = run([op(3, 'edit', { file_path: '/a.ts', old_string: 'gone' })])
    assert.equal(b.entries[0].added, 0)
    assert.equal(b.entries[0].removed, 1)
    const c = run([op(3, 'write', { file_path: '/a.ts' })])
    assert.equal(c.entries[0].added, 0)
  })

  test('reads report the exact window off the result meta, else the limit estimate', () => {
    const window = Array.from({ length: 30 }, (_, i) => ({ number: 41 + i, text: 'x' }))
    const a = run([
      op(3, 'read', { file_path: '/a.ts', offset: 41, limit: 80 }, {}, {
        meta: { path: '/a.ts', offset: 41, totalLines: 500, lines: window },
      }),
      op(5, 'read', { file_path: '/b.ts', limit: 80 }),
      op(7, 'read', { file_path: '/c.ts' }),
      op(9, 'read', { file_path: '/d.ts', limit: 0 }),
      op(11, 'read', { file_path: '/e.ts', limit: 'many' }),
      op(13, 'read', { file_path: '/f.ts', limit: 80 }, {}, { meta: { shape: 'nope' } }),
      op(15, 'read', { file_path: '/g.ts', limit: 80 }, {}, { meta: { path: '/g.ts', offset: 1, lines: [] } }),
      op(17, 'read', { file_path: '/h.ts', limit: 80 }, {}, { meta: { path: '/h.ts', offset: 0, lines: window } }),
    ])
    assert.deepEqual(a.entries[7].ops[0].read, { start: 41, count: 30 })
    for (const i of [0, 1, 2, 6]) assert.deepEqual(a.entries[i].ops[0].read, { count: 80, est: true })
    for (const i of [3, 4, 5]) assert.equal(a.entries[i].ops[0].read, undefined)
    const nested = run([op(20, 'run_code', null, {}, { subCalls: [sub(15, 'read', { file_path: '/n.ts', limit: 50.9 })] })])
    assert.deepEqual(nested.entries[0].ops[0].read, { count: 50, est: true })
  })

  test('nodes without a timestamp carry ops without one; a search with a path but no pattern carries no detail', () => {
    const a = run([op(3, 'read', { file_path: '/a.ts' }, { time: undefined })])
    assert.equal(a.entries[0].ops[0].time, undefined)
    const searches = run([
      op(3, 'grep', { path: '/src' }),
      op(5, 'grep', { pattern: 'y', path: '' }),
    ])
    assert.equal(searches.entries[1].path, '/src')
    assert.equal(searches.entries[1].ops[0].detail, undefined)
    assert.equal(searches.entries[0].path, 'y')
    assert.equal(searches.entries[0].ops[0].detail, undefined, 'the pattern IS the row path')
  })
})

describe('locateStepOf', () => {
  const requests = [{ seq: 10 }, { seq: 20 }, { seq: 30 }] as RequestRecord[]

  test('the first request dispatched after the op — while alive — shows it; an unconsumed live node reveals on the live surface', () => {
    assert.equal(locateStepOf(requests, 5, undefined), 10)
    assert.equal(locateStepOf(requests, 15, 25), 20)
    assert.equal(locateStepOf(requests, 5, 10), null)
    assert.equal(locateStepOf(requests, 5, 8), null)
    assert.equal(locateStepOf([{ seq: 30 }, { seq: 10 }, { seq: 20 }] as RequestRecord[], 5, undefined), 10)
    assert.equal(locateStepOf(requests, 35, undefined), 'live')
    assert.equal(locateStepOf([], 1, undefined), 'live')
  })
})

function sub(seq: number, name: string, args: Record<string, unknown> | string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tool-result',
    seq,
    time: T0 + seq,
    call: { name, argsRaw: typeof args === 'string' ? args : JSON.stringify(args) },
    isError: false,
    subCalls: [],
    ...over,
  }
}

describe('kindOfCall', () => {
  test('str_replace_editor reads on view and writes otherwise; every other tool keeps its static kind', () => {
    assert.equal(kindOfCall('str_replace_editor', { command: 'view' }), 'read')
    assert.equal(kindOfCall('str_replace_editor', { command: 'create' }), 'write')
    assert.equal(kindOfCall('str_replace_editor', { command: 'str_replace' }), 'write')
    assert.equal(kindOfCall('str_replace_editor', { command: 'insert' }), 'write')
    assert.equal(kindOfCall('str_replace_editor', { command: 'explode' }), 'write')
    assert.equal(kindOfCall('str_replace_editor', null), 'write')
    assert.equal(kindOfCall('read', null), 'read')
    assert.equal(kindOfCall('bash', { command: 'ls' }), null)
  })
})

describe('activityOf — str_replace_editor', () => {
  test('view reads; create, str_replace, and insert write with their own line deltas', () => {
    const a = run([
      op(3, 'str_replace_editor', { command: 'view', path: '/a.py' }),
      op(5, 'str_replace_editor', { command: 'create', path: '/b.py', file_text: 'one\ntwo\n' }),
      op(7, 'str_replace_editor', { command: 'str_replace', path: '/b.py', old_str: 'one\ntwo', new_str: 'one' }),
      op(9, 'str_replace_editor', { command: 'insert', path: '/c.py', insert_line: 1, new_str: 'x\ny' }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['/c.py', '/b.py', '/a.py'])
    const b = a.entries[1]
    assert.equal(b.reads, 0)
    assert.equal(b.writes, 2)
    assert.equal(b.added, 3)
    assert.equal(b.removed, 2)
    assert.equal(a.entries[2].reads, 1)
    assert.equal(a.entries[0].added, 2)
    assert.deepEqual(a.totals.read, { files: 1, ops: 1 })
    assert.deepEqual(a.totals.write, { files: 2, ops: 3 })

    const stringless = run([
      op(13, 'str_replace_editor', { command: 'str_replace', path: '/a.py' }),
      op(15, 'str_replace_editor', { path: '/b.py' }),
    ])
    assert.ok(stringless.entries.every(e => e.writes === 1 && e.added === 0 && e.removed === 0), 'a stringless call rows as a zero-delta write')
  })
})

describe('activityOf — nested Code-Mode (PTC) calls', () => {
  test('a run_code result folds its settled sub-dispatches into ops attributed to the nested tools', () => {
    const a = run([
      op(30, 'run_code', { code: 'await tools.read(…)', description: 'Read failing test and its fixture' }, {}, {
        subCalls: [
          sub(20, 'read', { file_path: '/src/a.ts' }),
          sub(22, 'edit', { file_path: '/src/a.ts', old_string: 'x\ny', new_string: 'z' }),
          sub(24, 'write', { file_path: '/src/b.ts', content: 'one\ntwo\n' }),
          sub(26, 'grep', { pattern: 'needle', path: '/src' }),
          sub(28, 'bash', { command: 'ls' }),
          { kind: 'tool-result', seq: 27, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/src/a.ts' }) } },
        ],
      }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['/src/a.ts', '/src', '/src/b.ts'])
    const file = a.entries[0]
    assert.equal(file.reads, 2)
    assert.equal(file.writes, 1)
    const read = file.ops.find(o => o.seq === 20)
    assert.equal(read?.parent, 30)
    assert.equal(read?.program, 'Read failing test and its fixture')
    assert.equal(read?.time, T0 + 20)
    const minimal = file.ops.find(o => o.seq === 27)
    assert.equal(minimal?.time, undefined)
    assert.equal(minimal?.err, false)
    assert.deepEqual(a.totals, {
      read: { files: 1, ops: 2 },
      write: { files: 2, ops: 2 },
      search: { files: 1, ops: 1 },
      image: { files: 0, ops: 0 },
      added: 3,
      removed: 2,
    })

    const b = run([op(30, 'run_code', null, {}, { subCalls: [
      sub(20, 'grep', { pattern: 'needle', path: '/src' }),
      sub(21, 'glob', { pattern: '**/*.md' }),
      sub(22, 'read_image', { file_path: '/ui.png' }),
    ] })])
    assert.equal(b.entries[1].ops[0].detail, undefined)
    assert.equal(b.entries[2].ops[0].detail, 'needle')
    assert.equal(b.entries[0].form, 'image')
    assert.deepEqual(b.totals.image, { files: 1, ops: 1 })
    const bare = run([op(40, 'run_code', { code: 'x' }, {}, { subCalls: [sub(30, 'read', { file_path: '/a.ts' })] })])
    assert.equal(bare.entries[0].ops[0].program, undefined)
  })

  test('the sub-call error flag and the parent removal stamp ride the op', () => {
    const a = run([op(30, 'run_code', { code: 'x' }, { gone: 40 }, {
      subCalls: [
        sub(20, 'read', { file_path: '/a.ts' }, { isError: true }),
        sub(22, 'read', { file_path: '/b.ts' }),
      ],
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/b.ts', '/a.ts'])
    assert.equal(a.entries[1].ops[0].err, true)
    const ok = a.entries[0].ops[0]
    assert.equal(ok.err, false)
    assert.equal(ok.gone, 40)
    const parentOnly = run([op(30, 'run_code', { code: 'x' }, { err: true }, { isError: true, subCalls: [sub(20, 'read', { file_path: '/c.ts' })] })])
    assert.equal(parentOnly.entries[0].ops[0].err, false)
  })

  test('the parent seq gates nested ops at the before bound', () => {
    const runCode = op(30, 'run_code', { code: 'x' }, {}, { subCalls: [sub(20, 'read', { file_path: '/a.ts' })] })
    assert.equal(run([runCode], 30).entries.length, 0)
    assert.equal(run([runCode], 31).entries.length, 1)
  })

  test('running and malformed sub-call blocks drop out instead of throwing', () => {
    const a = run([op(30, 'run_code', null, {}, {
      subCalls: [
        'nope',
        null,
        42,
        { call: { name: 'read', argsRaw: '{}' }, seq: 21 },
        { kind: 'tool-result', seq: 22, call: null },
        { kind: 'tool-result', seq: 23, call: 'x' },
        { kind: 'tool-result', seq: 24, call: { name: 'read' } },
        { kind: 'tool-result', seq: 25, call: { name: 9, argsRaw: '{}' } },
        { kind: 'tool-result', call: { name: 'read', argsRaw: '{}' } },
        { kind: 'tool-result', seq: Number.NaN, call: { name: 'read', argsRaw: '{}' } },
        sub(26, 'read', 'not-json'),
        sub(27, 'read', {}),
        sub(28, 'read', { file_path: '/ok.ts' }),
      ],
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/ok.ts'])
    assert.equal(a.totals.read.ops, 1)
  })

  test('the depth cap and the cycle guard bound defensive trees', () => {
    let chain = sub(99, 'read', { file_path: '/deep.ts' })
    for (let s = 98; s >= 90; s--) chain = { ...sub(s, 'read', { file_path: '/deep.ts' }), subCalls: [chain] }
    const deep = run([op(100, 'run_code', null, {}, { subCalls: [chain] })])
    assert.equal(deep.entries[0].reads, 8)

    const x = sub(80, 'read', { file_path: '/cyc.ts' })
    const y = sub(81, 'read', { file_path: '/cyc.ts' })
    y.subCalls = [x]
    x.subCalls = [y]
    const cyclic = run([op(82, 'run_code', null, {}, { subCalls: [x] })])
    assert.equal(cyclic.entries[0].reads, 2)
  })

  test('a join without subCalls — aged out, or an older client — folds nothing extra', () => {
    const a = run([op(30, 'run_code', { code: 'x' })])
    assert.deepEqual(a.entries, [])
  })
})

describe('activityOf — search meta attribution', () => {
  test('a complete grep meta rows per matched file with hit counts and the pattern detail', () => {
    const a = run([
      op(10, 'grep', { pattern: 'needle', path: '/src' }, {}, {
        meta: { shape: 'matches', truncated: false, total: 3, files: [
          { path: '/src/a.ts', matches: [{ lineNumber: 1, line: 'needle' }, { lineNumber: 2, line: 'needle!' }] },
          { path: '/src/b.ts', matches: [{ lineNumber: 5, line: 'needle' }] },
        ] },
      }),
      op(12, 'grep', { pattern: 'broad' }, {}, {
        meta: { shape: 'matches', truncated: true, total: 500, files: [{ path: '/src/a.ts', matches: [{ lineNumber: 1, line: 'x' }] }] },
      }),
      op(14, 'grep', { pattern: 'old' }, { gone: 20, time: undefined }, {
        meta: { shape: 'paths', truncated: false, total: 1, paths: ['/old.ts'] },
      }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['old', '/old.ts', 'broad', '/src', '/src/a.ts', '/src/b.ts'])
    const byPath = new Map(a.entries.map(e => [e.path, e]))
    const srcA = byPath.get('/src/a.ts')!
    assert.equal(srcA.searches, 1)
    assert.equal(srcA.ops[0].hits, 2)
    assert.equal(srcA.ops[0].detail, 'needle')
    assert.equal(byPath.get('/src/b.ts')!.ops[0].hits, 1)
    assert.equal(byPath.get('/src')!.ops[0].detail, 'needle')
    assert.equal(byPath.get('/old.ts')!.ops[0].gone, 20)
    assert.equal(byPath.get('/old.ts')!.ops[0].time, undefined)
    assert.deepEqual(a.totals.search, { files: 6, ops: 6 })
  })

  test('an include filter joins the detail; glob metas row without hit counts', () => {
    const a = run([
      op(10, 'grep', { pattern: 'needle', include: '*.ts' }, {}, {
        meta: { shape: 'matches', truncated: false, total: 1, files: [{ path: '/a.ts', matches: [{ lineNumber: 1, line: 'x' }] }] },
      }),
      op(12, 'glob', { pattern: '**/*.md' }, {}, {
        meta: { shape: 'paths', truncated: false, total: 2, paths: ['/r.md', '/o.md'] },
      }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['**/*.md', '/r.md', '/o.md', 'needle', '/a.ts'])
    const byPath = new Map(a.entries.map(e => [e.path, e]))
    assert.equal(byPath.get('/a.ts')!.ops[0].detail, 'needle (*.ts)')
    assert.equal(byPath.get('/o.md')!.ops[0].hits, undefined)
    assert.equal(byPath.get('/o.md')!.ops[0].detail, '**/*.md')
    assert.equal(byPath.get('needle')!.ops[0].pattern, true, 'the pathless target is a pattern row')
  })

  test('malformed or empty metas fall back to the pattern row', () => {
    const metas: unknown[] = [
      'junk',
      42,
      { truncated: false, paths: ['/a.ts'] },
      { shape: 'other', truncated: false, paths: ['/a.ts'] },
      { shape: 'matches', truncated: false },
      { shape: 'matches', truncated: false, files: 'x' },
      { shape: 'matches', truncated: false, files: [] },
      { shape: 'matches', truncated: false, files: [null, 7, { path: '' }, { path: '/a.ts' }, { path: '/a.ts', matches: 'x' }] },
      { shape: 'paths', truncated: false },
      { shape: 'paths', truncated: false, paths: [] },
      { shape: 'paths', paths: ['/a.ts'] },
    ]
    for (const [i, meta] of metas.entries()) {
      const a = run([op(10, 'grep', { pattern: 'needle', path: '/src' }, {}, { meta })])
      assert.deepEqual(a.entries.map(e => e.path), ['/src'], `meta case ${i} must fall back`)
    }
    const partial = run([op(10, 'grep', { pattern: 'needle', path: '/src' }, {}, {
      meta: { shape: 'paths', truncated: false, total: 2, paths: ['/a.ts', ''] },
    })])
    assert.deepEqual(partial.entries.map(e => e.path), ['/src', '/a.ts'], 'one valid path among malformed siblings still attributes')
  })

  test('meta attribution survives an aged-out call head — no args, no pattern detail', () => {
    const a = run([op(10, 'grep', null, {}, {
      meta: { shape: 'paths', truncated: false, total: 1, paths: ['/only.md'] },
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/only.md'])
    assert.equal(a.entries[0].ops[0].detail, undefined)
  })
})

describe('glyphOf', () => {
  test('image form wins over everything the path says', () => {
    assert.deepEqual(glyphOf('/a/data.csv', 'image'), { glyph: '🖼', tip: 'files.form.image' })
  })

  test('directories match their last segment, case-insensitively', () => {
    const cases: [string, string, string][] = [
      ['/', '🏠', 'files.glyph.root'],
      ['.', '🏠', 'files.glyph.root'],
      ['/repo/tests/', '🧪', 'files.glyph.tests'],
      ['/repo/TESTS/', '🧪', 'files.glyph.tests'],
      ['/repo/packages/a/tests/', '🧪', 'files.glyph.tests'],
      ['/docs/', '📚', 'files.glyph.docs'],
      ['/repo/node_modules/', '📦', 'files.glyph.deps'],
      ['/repo/dist/', '🏗️', 'files.glyph.build'],
      ['/repo/scripts/', '🛠️', 'files.glyph.scripts'],
      ['/repo/config/', '⚙️', 'files.glyph.config'],
      ['/repo/assets/', '🎨', 'files.glyph.assets'],
      ['/repo/.github/', '🗄️', 'files.glyph.hidden'],
      ['/repo/src/', '📁', 'files.form.dir'],
      ['C:\\repo\\src\\', '📁', 'files.form.dir'],
    ]
    for (const [path, glyph, tip] of cases) assert.deepEqual(glyphOf(path, 'dir'), { glyph, tip }, path)
  })

  test('a Windows-style path keys on its backslash leaf too', () => {
    assert.deepEqual(glyphOf('C:\\repo\\.gitignore', 'text'), { glyph: '🚫', tip: 'files.glyph.ignore' })
  })

  test('files resolve special names before extensions, and buckets before the fallback', () => {
    const cases: [string, string, string][] = [
      ['pnpm-lock.yaml', '🔒', 'files.glyph.lock'],
      ['package-lock.json', '🔒', 'files.glyph.lock'],
      ['Cargo.lock', '🔒', 'files.glyph.lock'],
      ['a.test.ts', '🧪', 'files.glyph.tests'],
      ['foo_test.py', '🧪', 'files.glyph.tests'],
      ['test_foo.py', '🧪', 'files.glyph.tests'],
      ['Dockerfile', '🐳', 'files.glyph.docker'],
      ['Dockerfile.dev', '🐳', 'files.glyph.docker'],
      ['Makefile', '🛠️', 'files.glyph.scripts'],
      ['CMakeLists.txt', '🛠️', 'files.glyph.scripts'],
      ['.gitignore', '🚫', 'files.glyph.ignore'],
      ['LICENSE.md', '⚖️', 'files.glyph.license'],
      ['COPYING', '⚖️', 'files.glyph.license'],
      ['.env', '⚙️', 'files.glyph.config'],
      ['tsconfig.yaml', '⚙️', 'files.glyph.config'],
      ['config.env', '⚙️', 'files.glyph.config'],
      ['manifest.json', '🧾', 'files.glyph.data'],
      ['README.md', '📝', 'files.glyph.markdown'],
      ['README.MD', '📝', 'files.glyph.markdown'],
      ['server.log', '📜', 'files.glyph.log'],
      ['exports.csv', '📊', 'files.glyph.sheet'],
      ['report.xlsx', '📊', 'files.glyph.sheet'],
      ['manual.pdf', '📕', 'files.glyph.document'],
      ['bundle.tar.gz', '🗜️', 'files.glyph.archive'],
      ['inter.woff2', '🔤', 'files.glyph.font'],
      ['clip.mp4', '🎬', 'files.glyph.media'],
      ['README', '📄', 'files.form.text'],
      ['data.parquet', '📄', 'files.form.text'],
      ['.foo', '📄', 'files.form.text'],
    ]
    for (const [base, glyph, tip] of cases) assert.deepEqual(glyphOf('/x/' + base, 'text'), { glyph, tip }, base)
  })

  test('code files render letter badges over their language color, with readable text', () => {
    const cases: [string, string, string, string][] = [
      ['main.ts', 'TS', '#3178c6', 'files.glyph.lang.ts'],
      ['App.tsx', 'TSX', '#3178c6', 'files.glyph.lang.ts'],
      ['index.js', 'JS', '#f7df1e', 'files.glyph.lang.js'],
      ['a.spec.js', 'JS', '#f7df1e', 'files.glyph.lang.js'],
      ['app.py', 'PY', '#3572a5', 'files.glyph.python'],
      ['notebook.ipynb', 'NB', '#da5b0b', 'files.glyph.notebook'],
      ['main.go', 'GO', '#00add8', 'files.glyph.lang.go'],
      ['lib.rs', 'RS', '#dea584', 'files.glyph.lang.rust'],
      ['App.java', 'JV', '#b07219', 'files.glyph.lang.java'],
      ['Main.kt', 'KT', '#a97bff', 'files.glyph.lang.kotlin'],
      ['app.rb', 'RB', '#701516', 'files.glyph.lang.ruby'],
      ['db.php', 'PHP', '#4f5d95', 'files.glyph.lang.php'],
      ['mem.c', 'C', '#555555', 'files.glyph.lang.c'],
      ['util.h', 'C', '#555555', 'files.glyph.lang.c'],
      ['graph.cpp', 'C++', '#f34b7d', 'files.glyph.lang.cpp'],
      ['Repo.cs', 'C#', '#178600', 'files.glyph.lang.csharp'],
      ['Router.scala', 'SC', '#c22d40', 'files.glyph.lang.scala'],
      ['conf.lua', 'LUA', '#000080', 'files.glyph.lang.lua'],
      ['cli.dart', 'DA', '#00b4ab', 'files.glyph.lang.dart'],
      ['App.swift', 'SW', '#f05138', 'files.glyph.lang.swift'],
      ['App.vue', 'VUE', '#41b883', 'files.glyph.lang.vue'],
      ['view.svelte', 'SV', '#ff3e00', 'files.glyph.lang.svelte'],
      ['deploy.sh', 'SH', '#89e051', 'files.glyph.shell'],
      ['index.html', 'HT', '#e34c26', 'files.glyph.lang.html'],
      ['main.css', 'CSS', '#563d7c', 'files.glyph.style'],
      ['schema.sql', 'SQL', '#e38c00', 'files.glyph.database'],
    ]
    for (const [base, glyph, color, tip] of cases) {
      const g = glyphOf('/x/' + base, 'text')
      assert.equal(g.glyph, glyph, base)
      assert.equal(g.tip, tip, base)
      assert.equal(g.color, color, base)
      assert.ok(g.text !== undefined, `badge text color missing for ${base}`)
    }
    assert.equal(glyphOf('/x/index.js', 'text').text, '#1f2328')
    assert.equal(glyphOf('/x/deploy.sh', 'text').text, '#1f2328')
    assert.equal(glyphOf('/x/lib.rs', 'text').text, '#1f2328')
    assert.equal(glyphOf('/x/Main.kt', 'text').text, '#ffffff')
    assert.equal(glyphOf('/x/main.ts', 'text').text, '#ffffff')
    assert.deepEqual(glyphOf('/x/build.zig', 'text'), { glyph: '📄', tip: 'files.form.text' })
  })

  test('near-miss names do not trip the test-file rule', () => {
    for (const base of ['latest.ts', 'contest.py', 'attest.json']) {
      const g = glyphOf('/x/' + base, 'text')
      assert.notEqual(g.tip, 'files.glyph.tests', base)
    }
  })
})

describe('displayPathOf', () => {
  const ws = '/Users/bw/dev/dsh-context'

  test('workspace paths display dot-relative, with the workspace root itself as .', () => {
    assert.equal(displayPathOf(ws + '/src/client/a.ts', ws), './src/client/a.ts')
    assert.equal(displayPathOf(ws, ws), '.')
    assert.equal(displayPathOf(ws + '/', ws), '.')
    assert.equal(displayPathOf(ws + '/./a.ts', ws), './a.ts')
    assert.equal(displayPathOf('tests/client/a.spec.ts', ws), './tests/client/a.spec.ts')
    assert.equal(displayPathOf('./tests/a.ts', ws), './tests/a.ts')
    assert.equal(displayPathOf('/repo/./a.ts', '/repo'), './a.ts')
    assert.equal(displayPathOf('./', ws), '.')
    assert.equal(displayPathOf('././', ws), '.')
    assert.equal(displayPathOf('.', ws), '.')
    assert.equal(displayPathOf('..', ws), '..')
    assert.equal(displayPathOf('../x', ws), '../x')
    assert.equal(displayPathOf('/repo//a.ts', '/repo'), './a.ts')
    assert.equal(displayPathOf('/repo/a//b.ts', '/repo'), './a/b.ts')
    assert.equal(displayPathOf('/', '/'), '.')
    assert.equal(displayPathOf('/a/b', '/'), './a/b')
    assert.equal(displayPathOf('a/b', '/'), './a/b')
  })

  test('outside-workspace and already-relative paths keep their spelling', () => {
    assert.equal(displayPathOf('/etc/hosts', ws), '/etc/hosts')
    assert.equal(displayPathOf('/a\\b', undefined), '/a\\b')
    assert.equal(displayPathOf(ws + '-sibling/a.ts', ws), ws + '-sibling/a.ts')
    assert.equal(displayPathOf('C:\\repo\\a.ts', ws), 'C:\\repo\\a.ts')
    assert.equal(displayPathOf('/etc/hosts', 'C:\\repo'), '/etc/hosts')
    assert.equal(displayPathOf('needle', ws), './needle')
    assert.equal(displayPathOf(ws + '/a.ts', undefined), ws + '/a.ts')
    assert.equal(displayPathOf('needle', undefined), './needle')
    assert.equal(displayPathOf('./needle', undefined), './needle')
  })

  test('Windows roots abbreviate to . with native separators, on either path style or casing', () => {
    const win = 'C:\\Users\\bw\\dev\\dsh-context'
    assert.equal(displayPathOf(win + '\\src\\client\\a.ts', win), '.\\src\\client\\a.ts')
    assert.equal(displayPathOf(win + '\\src\\client\\a.ts', win + '\\'), '.\\src\\client\\a.ts')
    assert.equal(displayPathOf(win, win), '.')
    assert.equal(displayPathOf(win + '\\', win), '.')
    assert.equal(displayPathOf('c:/users/BW/dev/dsh-context/src/a.ts', win), '.\\src\\a.ts')
    assert.equal(displayPathOf('src\\client\\a.ts', win), '.\\src\\client\\a.ts')
    assert.equal(displayPathOf('src/client/a.ts', win), '.\\src\\client\\a.ts')
    assert.equal(displayPathOf('src\\a.ts', undefined), '.\\src\\a.ts')
    assert.equal(displayPathOf('..\\x', win), '..\\x')
    assert.equal(displayPathOf('C:\\repo\\\\a.ts', 'C:\\repo'), '.\\a.ts')
    assert.equal(displayPathOf('C:\\repo\\a\\\\b.ts', 'C:\\repo'), '.\\a\\b.ts')
    assert.equal(displayPathOf('C:\\repo\\\\', 'C:\\repo'), '.')
    assert.equal(displayPathOf(win + '-sibling\\a.ts', win), win + '-sibling\\a.ts')
    assert.equal(displayPathOf('D:\\other\\a.ts', win), 'D:\\other\\a.ts')
    assert.equal(displayPathOf('C:\\repo\\a.ts', undefined), 'C:\\repo\\a.ts')
    assert.equal(displayPathOf('\\\\server\\share\\dir\\a.ts', '\\\\server\\share'), '.\\dir\\a.ts')
    assert.equal(displayPathOf('\\\\other\\share\\a.ts', '\\\\server\\share'), '\\\\other\\share\\a.ts')
  })
})

describe('activityOf — pattern rows', () => {
  test('a pathless search marks its pattern-as-target entry; a narrowed one does not', () => {
    const top = run([
      op(3, 'grep', { pattern: 'needle' }),
      op(5, 'grep', { pattern: 'needle', path: '/src' }),
    ])
    assert.equal(top.entries[0].pattern, undefined)
    assert.equal(top.entries[1].pattern, true)
    const nested = run([op(30, 'run_code', null, {}, { subCalls: [
      sub(20, 'grep', { pattern: 'needle' }),
      sub(22, 'grep', { pattern: 'needle', path: '/src' }),
    ] })])
    assert.equal(nested.entries[0].pattern, undefined)
    assert.equal(nested.entries[1].pattern, true)
  })
})

describe('absPathOf', () => {
  test('absolute paths stay; relative paths resolve against the workspace root', () => {
    const ws = '/Users/bw/dev/dsh-context'
    assert.equal(absPathOf('/etc/hosts', ws), '/etc/hosts')
    assert.equal(absPathOf('src/a.ts', ws), ws + '/src/a.ts')
    assert.equal(absPathOf('src/a.ts', ws + '/'), ws + '/src/a.ts')
    assert.equal(absPathOf('src/a.ts', undefined), undefined)
    assert.equal(absPathOf('src/a.ts', ''), undefined)
    assert.equal(absPathOf('./src/a.ts', ws), undefined)
    assert.equal(absPathOf('C:\\repo\\a.ts', ws), 'C:\\repo\\a.ts')
    assert.equal(absPathOf('C:/repo/a.ts', ws), 'C:\\repo\\a.ts')
    assert.equal(absPathOf('C:/repo/a.ts', 'C:\\repo'), 'C:\\repo\\a.ts')
  })

  test('Windows relatives join with native separators; the workspace root owns the drive prefix', () => {
    assert.equal(absPathOf('src/a.ts', 'C:\\repo'), 'C:\\repo\\src\\a.ts')
    assert.equal(absPathOf('src\\client\\a.ts', 'C:\\repo'), 'C:\\repo\\src\\client\\a.ts')
    assert.equal(absPathOf('src/a.ts', 'C:\\repo\\'), 'C:\\repo\\src\\a.ts')
    assert.equal(absPathOf('src/a.ts', 'C:/repo'), 'C:\\repo\\src\\a.ts')
    assert.equal(absPathOf('.tmp/a.ts', 'C:\\repo'), undefined)
    assert.equal(absPathOf('src/a.ts', 'C:\\'), 'C:\\src\\a.ts')
  })
})

describe('previewAddressOf', () => {
  test('a real file becomes its session-scoped resource address, workspace-relative inside the root', () => {
    const ws = '/repo'
    assert.equal(
      previewAddressOf('src/a.ts', 'text', undefined, 's1', ws),
      'dsh-resource://file/session/s1/src/a.ts',
    )
    assert.equal(
      previewAddressOf('/repo/src/a.ts', 'text', undefined, 's1', ws),
      'dsh-resource://file/session/s1/src/a.ts',
    )
    assert.equal(
      previewAddressOf('/etc/hosts', 'text', undefined, 's1', ws),
      'dsh-resource://file/session/s1//etc/hosts',
    )
    assert.equal(
      previewAddressOf('rel/b.md', 'text', undefined, 's1', undefined),
      'dsh-resource://file/session/s1/rel/b.md',
    )
    assert.equal(
      previewAddressOf('/shots/ui.png', 'image', undefined, 's1', ws),
      'dsh-resource://file/session/s1//shots/ui.png',
    )
  })

  test('pattern rows, directory targets, and a missing session have no address', () => {
    assert.equal(previewAddressOf('needle', 'text', true, 's1', '/repo'), undefined)
    assert.equal(previewAddressOf('/src/', 'dir', undefined, 's1', '/repo'), undefined)
    assert.equal(previewAddressOf('src/a.ts', 'text', undefined, undefined, '/repo'), undefined)
    assert.equal(previewAddressOf('src/a.ts', 'text', undefined, '', '/repo'), undefined)
  })

  test('a path the encoder rejects degrades to no address, never a throw', () => {
    assert.equal(previewAddressOf('\uD800', 'text', undefined, 's1', '/repo'), undefined)
  })
})

describe('activityOfOps — the fold-derived op log', () => {
  function op(over: Partial<FileOp> & { seq: number; path: string }): FileOp {
    return { kind: 'read', tool: 'read', err: false, added: 0, removed: 0, ...over }
  }

  test('aggregates the fold-derived records per file (newest first), scoped by the exclusive bound', () => {
    const ops = [
      op({ seq: 1, path: 'a.ts', read: { start: 1, count: 5 } }),
      op({ seq: 2, path: 'b.ts', kind: 'write', tool: 'write', added: 3 }),
      op({ seq: 3, path: 'a.ts', kind: 'write', tool: 'edit', added: 1, removed: 2 }),
      op({ seq: 4, path: 'c.ts', kind: 'search', tool: 'grep', hits: 7 }),
    ]
    const all = activityOfOps(ops, [], null)
    assert.deepEqual(all.entries.map(e => [e.path, e.reads, e.writes, e.searches]), [
      ['c.ts', 0, 0, 1],
      ['a.ts', 1, 1, 0],
      ['b.ts', 0, 1, 0],
    ])
    assert.deepEqual([all.totals.read.ops, all.totals.write.ops, all.totals.search.ops], [1, 2, 1])
    const a = all.entries[1]
    assert.deepEqual(a.ops.map(o => o.seq), [3, 1], 'ops newest first within the file')
    assert.deepEqual([a.added, a.removed], [1, 2])
    const scoped = activityOfOps(ops, [], 3)
    assert.deepEqual(scoped.entries.map(e => e.path).sort(), ['a.ts', 'b.ts'])
    assert.deepEqual([scoped.totals.read.ops, scoped.totals.write.ops, scoped.totals.search.ops], [1, 1, 0])
  })

  test('a nested op scopes by its parent result seq (the legacy node-level rule)', () => {
    const ops = [
      op({ seq: 2, path: 'a.ts', parent: 5, program: 'p' }),
      op({ seq: 3, path: 'b.ts' }),
    ]
    const scoped = activityOfOps(ops, [], 5)
    assert.deepEqual(scoped.entries.map(e => e.path), ['b.ts'])
  })

  test('gone joins from the detail archive by the op node (or its parent), never overriding an op stamp', () => {
    const ops = [
      op({ seq: 1, path: 'a.ts' }),
      op({ seq: 2, path: 'b.ts', gone: 50 }),
      op({ seq: 3, path: 'c.ts', parent: 10 }),
    ]
    const archive = [
      { seq: 1, cat: 'tool' as const, tokens: 1, gone: 40 },
      { seq: 2, cat: 'tool' as const, tokens: 1, gone: 99 },
      { seq: 10, cat: 'tool' as const, tokens: 1, gone: 77 },
      { seq: 30, cat: 'tool' as const, tokens: 1 },
    ]
    const out = activityOfOps(ops, archive, null)
    const byPath = new Map(out.entries.map(e => [e.path, e]))
    assert.equal(byPath.get('a.ts')?.ops[0].gone, 40, 'the archive stamp joins')
    assert.equal(byPath.get('b.ts')?.ops[0].gone, 50, 'the op\'s own stamp wins')
    assert.equal(byPath.get('c.ts')?.ops[0].gone, 77, 'a nested op reads its parent\'s stamp')
  })
})

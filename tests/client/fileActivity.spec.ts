// File activity derivation (src/client/fileActivity.ts) — the pure fold
// behind the File Activity card: tool→kind classification, path extraction,
// line-delta estimates, per-file aggregation, nested Code-Mode (PTC) call
// folding, search-meta attribution, and the locate-target lookup.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { activityOf, formOf, glyphOf, kindOfCall, kindOfTool, linesOf, locateStepOf, pathOfArgs } from '../../src/client/fileActivity'
import type { FileActivity } from '../../src/client/fileActivity'
import type { ConversationNodeLike } from '../../src/client/services'
import type { RequestRecord, SurfaceNode } from '../../src/shared/types'

const T0 = 1700000000000

/** A tool-result surface node plus its conversation join carrying the call args. */
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
  test('null or target-less args yield no path', () => {
    assert.equal(pathOfArgs('read', null), null)
    assert.equal(pathOfArgs('read', {}), null)
    assert.equal(pathOfArgs('read', { file_path: '' }), null)
    assert.equal(pathOfArgs('read', { file_path: 42 }), null)
  })

  test('read/write tools take the first path-ish argument', () => {
    assert.equal(pathOfArgs('read', { file_path: '/a.ts' }), '/a.ts')
    assert.equal(pathOfArgs('edit', { filePath: '/b.ts' }), '/b.ts')
    assert.equal(pathOfArgs('write', { path: '/c.ts' }), '/c.ts')
  })

  test('searches prefer the narrowing path and fall back to the pattern', () => {
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
    assert.equal(a.entries.length, 4)
    // Most-recently-touched first: **/*.md (seq 13) leads, /src/b.ts (9) follows.
    assert.deepEqual(a.entries.map(e => e.path), ['**/*.md', '/src', '/src/b.ts', '/src/a.ts'])

    const file = a.entries[3]
    assert.equal(file.reads, 2)
    assert.equal(file.writes, 1)
    assert.equal(file.searches, 0)
    assert.equal(file.added, 2) // edit new_string: 'x\nq'
    assert.equal(file.removed, 3) // edit old_string: 'x\ny\nz'
    assert.equal(file.errs, 0)
    // Ops newest first inside the entry.
    assert.deepEqual(file.ops.map(o => o.seq), [7, 5, 3])
    assert.equal(file.ops[0].kind, 'read')
    assert.equal(file.ops[0].time, T0 + 7)

    const written = a.entries[2]
    assert.equal(written.added, 2) // write content: 'one\ntwo\n'
    assert.equal(written.removed, 0)

    // A search naming both a path and a pattern keeps the pattern as the op detail.
    const searched = a.entries[1]
    assert.equal(searched.searches, 1)
    assert.equal(searched.ops[0].detail, 'needle')
    // A pattern-only search's target IS the pattern, with no separate detail.
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
    assert.equal(a.entries[2].form, 'image') // read_image
    assert.equal(a.entries[1].form, 'image') // .svg extension
    assert.equal(a.entries[0].form, 'dir') // trailing slash
    assert.deepEqual(a.totals.image, { files: 2, ops: 2 })
  })

  test('counts failures from the fold stamp or the snapshot error flag', () => {
    const a = run([
      op(3, 'read', { file_path: '/a.ts' }, { err: true }),
      op(5, 'read', { file_path: '/a.ts' }, {}, { isError: true }),
      op(7, 'read', { file_path: '/b.ts' }),
    ])
    const file = a.entries[1]
    assert.equal(file.errs, 2)
    assert.equal(file.ops[0].err, true)
    assert.equal(a.entries[0].errs, 0)
  })

  test('carries the archive removal stamp onto the op for locate targeting', () => {
    const a = run([op(3, 'read', { file_path: '/a.ts' }, { gone: 20 })])
    assert.equal(a.entries[0].ops[0].gone, 20)
  })

  test('the before bound excludes later ops; null serves everything', () => {
    const ops = [op(3, 'read', { file_path: '/a.ts' }), op(9, 'read', { file_path: '/b.ts' })]
    assert.equal(run(ops, 9).entries.length, 1)
    assert.equal(run(ops, 9).entries[0].path, '/a.ts')
    assert.equal(run(ops, null).entries.length, 2)
  })

  test('non-file tools and non-tool nodes never enter the fold', () => {
    const a = run([op(3, 'bash', { command: 'ls', description: 'List files' })])
    const withNoise = activityOf(
      [
        { seq: 1, cat: 'user', tokens: 5 },
        { seq: 2, cat: 'assistant', tokens: 5 },
        { seq: 3, cat: 'tool', tokens: 5 }, // no tool name at all
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
      op(3, 'read', null), // the conversation join aged out
      op(5, 'edit', {}), // args survived but name no target
      op(7, 'read', { file_path: '/a.ts' }),
    ])
    assert.equal(a.entries.length, 1)
    assert.deepEqual(a.entries[0].ops.map(o => o.seq), [7])
    // Only the path-resolved call reaches the totals.
    assert.equal(a.totals.read.ops, 1)
    assert.equal(a.totals.write.ops, 0)
    assert.equal(a.totals.read.files, 1)
  })

  test('a file-kind node the join lost entirely skips without throwing', () => {
    // The regression this locks: with the conv node gone (aged window), the
    // fold must skip the node — not dereference it and take the tab down.
    const a = activityOf(
      [
        { seq: 3, cat: 'tool', tokens: 5, tool: 'read', time: T0 },
        { seq: 5, cat: 'tool', tokens: 5, tool: 'run_code', time: T0 },
      ],
      () => undefined,
      null,
    )
    assert.deepEqual(a.entries, [])
  })

  test('one hostile join node cannot take the walk down', () => {
    const hostile: ConversationNodeLike = { kind: 'tool', seq: 3 }
    Object.defineProperty(hostile, 'call', { get(): never { throw new Error('boom') } })
    const healthy = op(5, 'read', { file_path: '/a.ts' })
    const bySeq = new Map<number, ConversationNodeLike>([[3, hostile], [5, healthy.conv]])
    const a = activityOf(
      [
        { seq: 3, cat: 'tool', tokens: 5, tool: 'read', time: T0 },
        healthy.node,
      ],
      seq => bySeq.get(seq),
      null,
    )
    // The throwing node drops; the walk carries on with the next node.
    assert.deepEqual(a.entries.map(e => e.path), ['/a.ts'])
    assert.equal(a.totals.read.ops, 1)
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

  test('nodes without a timestamp carry ops without one', () => {
    const a = run([op(3, 'read', { file_path: '/a.ts' }, { time: undefined })])
    assert.equal(a.entries[0].ops[0].time, undefined)
  })

  test('a search with a path but no pattern carries no detail', () => {
    const a = run([
      op(3, 'grep', { path: '/src' }),
      // An empty path narrows nothing: the target falls back to the pattern.
      op(5, 'grep', { pattern: 'y', path: '' }),
    ])
    assert.equal(a.entries[1].path, '/src')
    assert.equal(a.entries[1].ops[0].detail, undefined)
    assert.equal(a.entries[0].path, 'y')
    assert.equal(a.entries[0].ops[0].detail, undefined)
  })
})

describe('locateStepOf', () => {
  const requests = [{ seq: 10 }, { seq: 20 }, { seq: 30 }] as RequestRecord[]

  test('the first request dispatched after the op — while alive — shows it', () => {
    assert.equal(locateStepOf(requests, 5, undefined), 10)
    assert.equal(locateStepOf(requests, 15, 25), 20)
    // Removed before a step's dispatch: that step's surface never held it.
    assert.equal(locateStepOf(requests, 5, 10), null)
    assert.equal(locateStepOf(requests, 5, 8), null)
  })

  test('a live node no request has consumed reveals on the live surface', () => {
    assert.equal(locateStepOf(requests, 35, undefined), 'live')
    assert.equal(locateStepOf([], 1, undefined), 'live')
  })
})

/** One settled nested sub-call block, as the conversation join delivers it. */
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
    assert.equal(b.added, 3) // create 'one\ntwo\n' + str_replace 'one'
    assert.equal(b.removed, 2) // str_replace 'one\ntwo'
    assert.equal(a.entries[2].reads, 1)
    assert.equal(a.entries[0].added, 2) // insert 'x\ny'
    assert.deepEqual(a.totals.read, { files: 1, ops: 1 })
    // Writes: /b.py (create + str_replace) and /c.py (insert).
    assert.deepEqual(a.totals.write, { files: 2, ops: 3 })
  })

  test('a stringless call rows as a failed-looking but zero-delta write', () => {
    const a = run([
      op(3, 'str_replace_editor', { command: 'str_replace', path: '/a.py' }),
      op(5, 'str_replace_editor', { path: '/b.py' }),
    ])
    assert.ok(a.entries.every(e => e.writes === 1 && e.added === 0 && e.removed === 0))
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
          // A minimal settled block: no time, no error flag, no nested tree.
          { kind: 'tool-result', seq: 27, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/src/a.ts' }) } },
        ],
      }),
    ])
    // /src/a.ts leads: its newest op is the minimal read at seq 27.
    assert.deepEqual(a.entries.map(e => e.path), ['/src/a.ts', '/src', '/src/b.ts'])
    const file = a.entries[0]
    assert.equal(file.reads, 2)
    assert.equal(file.writes, 1)
    const read = file.ops.find(o => o.seq === 20)
    assert.equal(read?.parent, 30)
    assert.equal(read?.program, 'Read failing test and its fixture')
    assert.equal(read?.time, T0 + 20)
    // The minimal block carries no time and no error.
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
  })

  test('a program without a description rows its nested ops without one', () => {
    const a = run([op(30, 'run_code', { code: 'x' }, {}, { subCalls: [sub(20, 'read', { file_path: '/a.ts' })] })])
    assert.equal(a.entries[0].ops[0].program, undefined)
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
    // The parent's stamp locates the op; a failed program does not fail its
    // earlier successful reads.
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

  test('nested searches keep the pattern detail only when the path narrows', () => {
    const a = run([op(30, 'run_code', null, {}, { subCalls: [
      sub(20, 'grep', { pattern: 'needle', path: '/src' }),
      sub(21, 'glob', { pattern: '**/*.md' }),
    ] })])
    assert.equal(a.entries[0].ops[0].detail, undefined) // the pattern IS the row path
    assert.equal(a.entries[1].ops[0].detail, 'needle')
  })

  test('a nested image read keeps the image form and totals', () => {
    const a = run([op(30, 'run_code', null, {}, { subCalls: [sub(20, 'read_image', { file_path: '/ui.png' })] })])
    assert.equal(a.entries[0].form, 'image')
    assert.deepEqual(a.totals.image, { files: 1, ops: 1 })
  })

  test('running and malformed sub-call blocks drop out instead of throwing', () => {
    const a = run([op(30, 'run_code', null, {}, {
      subCalls: [
        'nope',
        null,
        42,
        { call: { name: 'read', argsRaw: '{}' }, seq: 21 }, // no kind — still running
        { kind: 'tool-result', seq: 22, call: null }, // unpaired result
        { kind: 'tool-result', seq: 23, call: 'x' }, // call not an object
        { kind: 'tool-result', seq: 24, call: { name: 'read' } }, // argsRaw missing
        { kind: 'tool-result', seq: 25, call: { name: 9, argsRaw: '{}' } }, // name not a string
        { kind: 'tool-result', call: { name: 'read', argsRaw: '{}' } }, // seq missing
        { kind: 'tool-result', seq: Number.NaN, call: { name: 'read', argsRaw: '{}' } }, // non-finite seq
        sub(26, 'read', 'not-json'), // unparseable args
        sub(27, 'read', {}), // parsed but target-less
        sub(28, 'read', { file_path: '/ok.ts' }),
      ],
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/ok.ts'])
    assert.equal(a.totals.read.ops, 1)
  })

  test('the depth cap and the cycle guard bound defensive trees', () => {
    // A 10-deep chain books only the first eight levels.
    let chain = sub(99, 'read', { file_path: '/deep.ts' })
    for (let s = 98; s >= 90; s--) chain = { ...sub(s, 'read', { file_path: '/deep.ts' }), subCalls: [chain] }
    const deep = run([op(100, 'run_code', null, {}, { subCalls: [chain] })])
    assert.equal(deep.entries[0].reads, 8)

    // A cyclic join terminates and books each block once.
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
      // A capped meta names a partial file set: the call falls back to its own target.
      op(12, 'grep', { pattern: 'broad' }, {}, {
        meta: { shape: 'matches', truncated: true, total: 500, files: [{ path: '/src/a.ts', matches: [{ lineNumber: 1, line: 'x' }] }] },
      }),
      // An archived, timeless search still stamps its meta rows with the parent's removal.
      op(14, 'grep', { pattern: 'old' }, { gone: 20, time: undefined }, {
        meta: { shape: 'paths', truncated: false, total: 1, paths: ['/old.ts'] },
      }),
    ])
    assert.deepEqual(a.entries.map(e => e.path), ['/old.ts', 'broad', '/src/a.ts', '/src/b.ts'])
    const first = a.entries[2]
    assert.equal(first.searches, 1)
    assert.equal(first.ops[0].hits, 2)
    assert.equal(first.ops[0].detail, 'needle')
    assert.equal(a.entries[3].ops[0].hits, 1)
    // The archived, timeless meta row carries the node's stamp (and no time).
    assert.equal(a.entries[0].ops[0].gone, 20)
    assert.equal(a.entries[0].ops[0].time, undefined)
    assert.deepEqual(a.totals.search, { files: 4, ops: 4 })
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
    assert.deepEqual(a.entries.map(e => e.path), ['/r.md', '/o.md', '/a.ts'])
    assert.equal(a.entries[2].ops[0].detail, 'needle (*.ts)')
    assert.equal(a.entries[1].ops[0].hits, undefined) // a listed path matched no lines
    assert.equal(a.entries[1].ops[0].detail, '**/*.md')
  })

  test('malformed or empty metas fall back to the pattern row', () => {
    const metas: unknown[] = [
      'junk',
      42,
      { truncated: false, paths: ['/a.ts'] }, // shape missing
      { shape: 'other', truncated: false, paths: ['/a.ts'] }, // unknown shape
      { shape: 'matches', truncated: false }, // files missing
      { shape: 'matches', truncated: false, files: 'x' }, // files not a list
      { shape: 'matches', truncated: false, files: [] }, // nothing retained
      { shape: 'matches', truncated: false, files: [null, 7, { path: '' }, { path: '/a.ts' }, { path: '/a.ts', matches: 'x' }] }, // all groups malformed
      { shape: 'paths', truncated: false }, // paths missing
      { shape: 'paths', truncated: false, paths: [] }, // nothing listed
    ]
    for (const [i, meta] of metas.entries()) {
      const a = run([op(10, 'grep', { pattern: 'needle', path: '/src' }, {}, { meta })])
      assert.deepEqual(a.entries.map(e => e.path), ['/src'], `meta case ${i} must fall back`)
    }
  })

  test('one valid path among malformed siblings still attributes', () => {
    const a = run([op(10, 'grep', { pattern: 'needle', path: '/src' }, {}, {
      meta: { shape: 'paths', truncated: false, total: 2, paths: ['/a.ts', ''] },
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/a.ts'])
  })

  test('a truncated flag is required — a missing one falls back', () => {
    const a = run([op(10, 'grep', { pattern: 'n', path: '/src' }, {}, {
      meta: { shape: 'paths', paths: ['/a.ts'] },
    })])
    assert.deepEqual(a.entries.map(e => e.path), ['/src'])
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
    ]
    for (const [path, glyph, tip] of cases) assert.deepEqual(glyphOf(path, 'dir'), { glyph, tip }, path)
  })

  test('files resolve special names before extensions, and buckets before the fallback', () => {
    const cases: [string, string, string][] = [
      ['pnpm-lock.yaml', '🔒', 'files.glyph.lock'],
      ['package-lock.json', '🔒', 'files.glyph.lock'],
      ['Cargo.lock', '🔒', 'files.glyph.lock'],
      ['a.test.ts', '🧪', 'files.glyph.tests'],
      ['a.spec.js', '🧪', 'files.glyph.tests'],
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
      ['app.py', '🐍', 'files.glyph.python'],
      ['notebook.ipynb', '📓', 'files.glyph.notebook'],
      ['run.sh', '🐚', 'files.glyph.shell'],
      ['index.html', '🌐', 'files.glyph.web'],
      ['main.css', '🎨', 'files.glyph.style'],
      ['schema.sql', '🗃️', 'files.glyph.database'],
      ['tsconfig.yaml', '⚙️', 'files.glyph.config'],
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
      ['main.ts', '🧩', 'files.glyph.code'],
      ['lib.go', '🧩', 'files.glyph.code'],
      ['App.vue', '🧩', 'files.glyph.code'],
      ['README', '📄', 'files.form.text'],
      ['data.parquet', '📄', 'files.form.text'],
      ['.foo', '📄', 'files.form.text'],
    ]
    for (const [base, glyph, tip] of cases) assert.deepEqual(glyphOf('/x/' + base, 'text'), { glyph, tip }, base)
  })

  test('near-miss names do not trip the test-file rule', () => {
    for (const base of ['latest.ts', 'contest.py', 'attest.json']) {
      const g = glyphOf('/x/' + base, 'text')
      assert.notEqual(g.tip, 'files.glyph.tests', base)
    }
  })
})

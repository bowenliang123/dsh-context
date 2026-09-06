// The shared file-op parser (src/shared/fileOps.ts): the ONE per-call
// assembly consumed by the host fold and the client's inline-generation
// fallback alike. Pins the whole producer matrix: the six built-ins, the
// Anthropic-style editor, the search meta attribution (complete / truncated
// / malformed / args-less), the read window vs the limit estimate, the
// pattern-target fallback, and the zero-ops degradations.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { opsOfCall, parseCallArgs } from '../../src/shared/fileOps'

/** The tool/result presentation meta of a grep with the complete by-file match groups. */
function grepMeta(files: Record<string, number>): unknown {
  return {
    shape: 'matches',
    truncated: false,
    total: Object.values(files).reduce((a, b) => a + b, 0),
    files: Object.entries(files).map(([path, n]) => ({
      path,
      matches: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: 'x' })),
    })),
  }
}

const at = (seq: number): number => 1_700_000_000_000 + seq

describe('opsOfCall — one op per settled call', () => {
  test('a read with the result meta window books the exact range', () => {
    const ops = opsOfCall({
      seq: 7, time: at(7), tool: 'read',
      argsRaw: JSON.stringify({ file_path: 'src/a.ts', offset: 10, limit: 50 }),
      meta: { path: 'src/a.ts', offset: 10, lines: [{ number: 10 }, { number: 11 }], totalLines: 99 },
    })
    assert.deepEqual(ops, [{
      seq: 7, time: at(7), tool: 'read', kind: 'read', err: false,
      added: 0, removed: 0, path: 'src/a.ts',
      read: { start: 10, count: 2 },
    }])
  })

  test('a read without meta falls back to the limit estimate; unbounded reads name no footprint', () => {
    const [est] = opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ file_path: 'a.ts', limit: 12.9 }) })
    assert.deepEqual(est.read, { count: 12, est: true })
    const [unbounded] = opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ file_path: 'a.ts' }) })
    assert.equal(unbounded.read, undefined)
  })

  test('an edit books the old/new line delta; a write books its content', () => {
    const [edit] = opsOfCall({
      seq: 1, tool: 'edit',
      argsRaw: JSON.stringify({ file_path: 'a.ts', old_string: 'x\ny', new_string: 'z' }),
    })
    assert.deepEqual([edit.added, edit.removed], [1, 2])
    const [write] = opsOfCall({ seq: 2, tool: 'write', argsRaw: JSON.stringify({ file_path: 'b.ts', content: 'a\nb\n' }) })
    assert.deepEqual([write.added, write.removed], [2, 0])
    assert.equal(write.kind, 'write')
  })

  test('str_replace_editor: view reads, the other commands write their shapes', () => {
    const [view] = opsOfCall({ seq: 1, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'view', path: '/a.ts' }) })
    assert.equal(view.kind, 'read')
    const [rep] = opsOfCall({ seq: 2, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'str_replace', path: '/a.ts', old_str: 'x', new_str: 'y\nz' }) })
    assert.deepEqual([rep.kind, rep.added, rep.removed], ['write', 2, 1])
    const [ins] = opsOfCall({ seq: 3, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'insert', path: '/a.ts', new_str: 'q' }) })
    assert.deepEqual([ins.added, ins.removed], [1, 0])
    const [create] = opsOfCall({ seq: 4, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'create', path: '/a.ts', file_text: 'q' }) })
    assert.deepEqual([create.added, create.removed], [1, 0])
    // An unknown command writes zero lines but still rows (with its error flag).
    const [odd] = opsOfCall({ seq: 5, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'undo_edit', path: '/a.ts' }), err: true })
    assert.deepEqual([odd.kind, odd.added, odd.removed, odd.err], ['write', 0, 0, true])
  })

  test('a narrowed search rows the path with the pattern detail', () => {
    const [op] = opsOfCall({
      seq: 3, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/', include: '*.ts' }),
    })
    assert.deepEqual([op.kind, op.path, op.detail, op.pattern], ['search', 'src/', 'TODO (*.ts)', undefined])
  })

  test('a pathless search rows the pattern itself, marked as a pattern', () => {
    const [op] = opsOfCall({ seq: 1, tool: 'glob', argsRaw: JSON.stringify({ pattern: '**/*.md' }) })
    assert.deepEqual([op.path, op.pattern, op.detail], ['**/*.md', true, undefined])
  })

  test('the complete matches meta attributes the searched target AND one op per hit file', () => {
    const ops = opsOfCall({
      seq: 5, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO' }),
      meta: grepMeta({ 'a.ts': 3, 'b.ts': 1 }),
    })
    // The searched path/pattern rows first (here the workspace-wide pattern),
    // then each hit file with its count.
    assert.deepEqual(ops.map(o => [o.path, o.hits]), [['TODO', undefined], ['a.ts', 3], ['b.ts', 1]])
    assert.equal(ops[0].pattern, true, 'the pathless target rows as the pattern')
    assert.ok(ops.slice(1).every(o => o.detail === 'TODO'), 'the pattern detail rides each hit op')
    assert.ok(ops.slice(1).every(o => o.pattern === undefined))
  })

  test('the complete paths meta attributes the target plus the hits without counts', () => {
    const ops = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts' }),
      meta: { shape: 'paths', truncated: false, total: 2, paths: ['a.ts', 'b.ts'] },
    })
    assert.deepEqual(ops.map(o => o.path), ['*.ts', 'a.ts', 'b.ts'])
    assert.ok(ops.every(o => o.hits === undefined))
  })

  test('a narrowed search rows the searched directory AND each hit file', () => {
    const ops = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/', include: '*.ts' }),
      meta: grepMeta({ 'src/a.ts': 2, 'src/b.ts': 1 }),
    })
    // The searched directory rows first with the pattern detail, then the hits.
    assert.deepEqual(ops.map(o => [o.path, o.hits ?? 0]), [['src/', 0], ['src/a.ts', 2], ['src/b.ts', 1]])
    assert.equal(ops[0].detail, 'TODO (*.ts)')
    assert.equal(ops[0].pattern, undefined, 'a real path is not a pattern row')
  })

  test('a single-file search does not double-row the target (it IS the matched file)', () => {
    const ops = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/a.ts' }),
      meta: grepMeta({ 'src/a.ts': 2 }),
    })
    assert.deepEqual(ops.map(o => o.path), ['src/a.ts'], 'one row, with its hit count')
    assert.equal(ops[0].hits, 2)
    assert.equal(ops[0].detail, 'TODO')
  })

  test('a truncated or malformed meta falls back to the call target', () => {
    const capped = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
      meta: { shape: 'matches', truncated: true, files: [{ path: 'a.ts', matches: [{}] }] },
    })
    assert.deepEqual(capped.map(o => o.path), ['src/'])
    const junk = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
      meta: { shape: 'matches', truncated: false, files: [{ path: 42 }, null] },
    })
    assert.deepEqual(junk.map(o => o.path), ['src/'], 'a meta whose entries are all junk falls back')
    // An empty complete list attributes nothing — the call target rows instead.
    const empty = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts', path: 'src/' }),
      meta: { shape: 'paths', truncated: false, total: 0, paths: [] },
    })
    assert.deepEqual(empty.map(o => o.path), ['src/'])
  })

  test('the meta attribution works even when the call arguments failed to parse', () => {
    const ops = opsOfCall({ seq: 1, tool: 'grep', argsRaw: '{broken', meta: grepMeta({ 'a.ts': 2 }) })
    assert.deepEqual(ops.map(o => [o.path, o.hits]), [['a.ts', 2]])
    assert.ok(ops.every(o => o.detail === undefined), 'no parsed args — no detail line')
  })

  test('zero-ops degradations: non-file tools, unparseable args, and pathless targets', () => {
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'bash', argsRaw: JSON.stringify({ command: 'ls' }) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: 'not json' }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ no_path: true }) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify(['not-a-record']) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read' }), [], 'no args at all')
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'str_replace_editor' }), [], 'the editor without args writes nothing listable')
  })

  test('the stamps ride along: err/time/gone/parent/program', () => {
    const [op] = opsOfCall({
      seq: 9, time: at(9), tool: 'write',
      argsRaw: JSON.stringify({ file_path: 'a.ts', content: 'x' }),
      err: true, gone: 40, parent: 33, program: 'fix the bug',
    })
    assert.deepEqual([op.err, op.time, op.gone, op.parent, op.program], [true, at(9), 40, 33, 'fix the bug'])
  })
})

describe('parseCallArgs', () => {
  test('parses raw JSON records; everything else is null', () => {
    assert.deepEqual(parseCallArgs('{"a":1}'), { a: 1 })
    assert.equal(parseCallArgs('[1]'), null)
    assert.equal(parseCallArgs('"s"'), null)
    assert.equal(parseCallArgs('{broken'), null)
    assert.equal(parseCallArgs(''), null)
    assert.equal(parseCallArgs(undefined), null)
    assert.equal(parseCallArgs(42), null)
    assert.equal(parseCallArgs(null), null)
  })
})

// File activity derivation (src/client/fileActivity.ts) — the pure fold
// behind the File Activity card: tool→kind classification, path extraction,
// line-delta estimates, per-file aggregation, and the locate-target lookup.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { activityOf, formOf, kindOfTool, linesOf, locateStepOf, pathOfArgs } from '../../src/client/fileActivity'
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

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { assemble, headerAt, systemAt } from '../../src/shared/assemble'
import type { ContextHeaders, HeaderRecord, SurfaceNode } from '../../src/shared/types'

const node = (seq: number, extra: Record<string, unknown> = {}): SurfaceNode =>
  ({ seq, cat: 'user', tokens: 1, ...extra }) as SurfaceNode

const header = (seq: number, extra: Record<string, unknown> = {}): HeaderRecord =>
  ({ seq, time: seq, tools: [], ...extra }) as HeaderRecord

describe('assemble', () => {
  test('headerAt picks the last row before the requested sequence', () => {
    assert.equal(headerAt(null, null), null)
    assert.equal(headerAt({ headers: [] }, null), null)
    const headers = { headers: [header(1), header(5), header(9)] } as ContextHeaders
    assert.equal(headerAt(headers, null)?.seq, 9)
    assert.equal(headerAt(headers, 5)?.seq, 1)
    assert.equal(headerAt(headers, 10)?.seq, 9)
    assert.equal(headerAt(headers, 1), null)
  })

  test('systemAt prefers positive system nodes and falls back to the header price', () => {
    assert.equal(systemAt({}, null, null), null)
    assert.equal(systemAt({ systems: [] }, null, null), null)
    assert.equal(systemAt({ systems: [{ seq: 1, time: 1, tokens: 0 }] }, null, null), null)
    const systems = [
      { seq: 1, time: 1, tokens: 3 },
      { seq: 2, time: 2, tokens: 0 },
      { seq: 4, time: 4, tokens: 5 },
    ]
    assert.equal(systemAt({ systems }, null, null)?.seq, 4)
    assert.equal(systemAt({ systems }, null, 4)?.seq, 1)
    assert.equal(systemAt({ systems }, null, 1), null)
    assert.equal(systemAt({}, header(2, { systemTokens: 7 }), null)?.tokens, 7)
    assert.equal(systemAt({}, header(2), null), null)
  })

  test('live assembly copies nodes, sorts them and reports dropped rows', () => {
    const assembled = assemble({
      nodes: [node(3), node(1), node(2)],
      archive: [node(0)],
      droppedNodes: 2,
      surfaceFloor: 5,
      archiveFloor: 9,
    }, { headers: [header(1)] }, null)
    assert.equal(assembled.live, true)
    assert.deepEqual(assembled.nodes.map(item => item.seq), [1, 2, 3])
    assert.equal(assembled.missingLive, 2)
    assert.equal(assembled.approximate, false)
    assert.equal(assembled.header?.seq, 1)
  })

  test('time travel merges live and archived rows before the sequence', () => {
    const assembled = assemble({
      nodes: [node(1), node(4), node(6)],
      archive: [node(2, { gone: 5 }), node(3, { gone: 3 }), node(0, { gone: 5 }), node(2)],
      systems: [{ seq: 1, time: 1, tokens: 2 }],
      droppedNodes: 4,
      surfaceFloor: 1,
      archiveFloor: 6,
    }, { headers: [header(1)] }, 4)
    assert.deepEqual(assembled.nodes.map(item => item.seq), [0, 1, 2])
    assert.equal(assembled.missingLive, 4)
    assert.equal(assembled.approximate, true)
    assert.equal(assembled.system?.tokens, 2)
  })

  test('time travel without a floor or drops reports no gaps', () => {
    const assembled = assemble({ nodes: [node(1)], archive: [] }, null, 2)
    assert.equal(assembled.missingLive, 0)
    assert.equal(assembled.approximate, false)
    assert.equal(assembled.header, null)
    assert.equal(assembled.system, null)
  })
})

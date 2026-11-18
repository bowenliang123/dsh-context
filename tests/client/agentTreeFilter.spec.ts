// @vitest-environment node
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { agentForestOf, runningOnlyForestOf } from '../../src/client/agentTree'
import { row, snap } from './helpers/agentTreeFixtures'

describe('runningOnlyForestOf', () => {
  test('keeps running nodes with their full ancestor chains and drops finished branches', () => {
    const forest = agentForestOf(snap({
      root: row({ running: false }),
      mate: row({ parentId: 'root', origin: 'subagent', running: true }),
      mateSub: row({ parentId: 'mate', origin: 'subagent', running: true }),
      dead: row({ parentId: 'root', origin: 'subagent', running: false }),
      deadSub: row({ parentId: 'dead', origin: 'subagent', running: false }),
    }), 'root')
    assert.ok(forest !== null)
    const view = runningOnlyForestOf(forest)
    assert.deepEqual(view.nodes.map(n => n.id), ['root', 'mate', 'mateSub'])
    assert.deepEqual(view.edges, [{ from: 'root', to: 'mate' }, { from: 'mate', to: 'mateSub' }])
    assert.equal(view.solo, false)
  })

  test('collapses to the current chain when nothing runs', () => {
    const forest = agentForestOf(snap({
      root: row({}),
      mid: row({ parentId: 'root', origin: 'subagent' }),
      leaf: row({ parentId: 'mid', origin: 'subagent' }),
    }), 'mid')
    assert.ok(forest !== null)
    const view = runningOnlyForestOf(forest)
    assert.deepEqual(view.nodes.map(n => n.id), ['root', 'mid'])
    assert.deepEqual(view.edges, [{ from: 'root', to: 'mid' }])
  })

  test('adds shared ancestors once and stops the walk on already-kept nodes', () => {
    const forest = agentForestOf(snap({
      root: row({ running: true }),
      a: row({ parentId: 'root', origin: 'subagent', running: true }),
      b: row({ parentId: 'root', origin: 'subagent', running: true }),
    }), 'root')
    assert.ok(forest !== null)
    const view = runningOnlyForestOf(forest)
    assert.deepEqual(view.nodes.map(n => n.id), ['root', 'a', 'b'])
    assert.deepEqual(view.edges, [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }])
  })

  test('keeps running chains even without a current node and passes the solo flag through', () => {
    const forest = agentForestOf(snap({
      root: row({}),
      sub: row({ parentId: 'root', origin: 'subagent', running: true }),
    }), 'root')
    assert.ok(forest !== null)
    const noCurrent = { ...forest, nodes: forest.nodes.map(n => ({ ...n, isCurrent: false })), solo: true }
    const view = runningOnlyForestOf(noCurrent)
    assert.deepEqual(view.nodes.map(n => n.id), ['root', 'sub'])
    assert.equal(view.solo, true)
  })
})

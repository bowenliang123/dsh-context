import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextDelta } from '../../../src/shared/delta'
import type { SurfaceNode } from '../../../src/shared/types'
import { flush, mount, surfaceNode, text } from '../helpers/kit'
import { Browser, catRow, pickStep, props, req, tl } from './browserHarness'

const ZERO = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }

function node(seq: number, cat: SurfaceNode['cat'], tokens: number): SurfaceNode {
  return { seq, cat, tokens }
}

function deltaOf(removed = 500): ContextDelta {
  return {
    added: [node(6199, 'assistant', 10)],
    viewNodes: Array.from({ length: 700 }, (_, i) => node(1000 + i, 'assistant', 10)),
    viewHeader: null,
    viewSystem: null,
    system: null,
    tools: [{ name: 'bash', tokens: 4 }],
    header: null,
    counts: { ...ZERO },
    tokens: { ...ZERO },
    removedCounts: { ...ZERO, assistant: removed },
    tokenUp: { ...ZERO },
    tokenDown: { ...ZERO, assistant: removed * 10 },
    items: 1,
    total: 10,
  }
}

describe('ContextBrowser host delta', () => {
  test('renders the complete removed counts and the complete view from the host', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 30, tokens: 10, cat: 'assistant', text: 'new' })],
      archive: [],
    })
    let calls = 0
    const m = await mount(h(Browser, props({
      data,
      fetchDelta: () => {
        calls += 1
        return Promise.resolve(deltaOf())
      },
    })))
    await pickStep(m, '20')
    await flush()
    assert.equal(calls, 2, 'the live view and the step change each ask the host once')
    const row = text(catRow(m, 'assistant'))
    assert.ok(row.includes('-500'), `complete removed count rides the badge: ${row}`)
    assert.ok(row.includes('-5.0k'), `complete removed tokens ride the badge: ${row}`)
    assert.ok(row.includes('700'), `the complete host view replaces the capped archive: ${row}`)
    await m.unmount()
  })

  test('a new detail revision refreshes the live delta', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 30, tokens: 10, cat: 'assistant', text: 'new' })],
    })
    let calls = 0
    let removed = 500
    const fetchDelta = () => {
      calls += 1
      return Promise.resolve(deltaOf(removed))
    }
    const m = await mount(h(Browser, props({ data, fetchDelta })))
    await pickStep(m, '20')
    await flush()
    assert.equal(calls, 2)
    assert.ok(text(catRow(m, 'assistant')).includes('-500'))
    removed = 600
    await m.update(h(Browser, props({ data: { ...data, detailRev: 1 }, fetchDelta })))
    await flush()
    assert.equal(calls, 3, 'a detail revision bump refetches the delta')
    assert.ok(text(catRow(m, 'assistant')).includes('-600'))
    await m.unmount()
  })

  test('a zero-request session keeps the local all-added diff', async () => {
    const data = tl({ nodes: [surfaceNode({ seq: 1, tokens: 5, cat: 'assistant' })] })
    let calls = 0
    const m = await mount(h(Browser, props({
      data,
      delta: true,
      fetchDelta: () => {
        calls += 1
        return Promise.resolve(null)
      },
    })))
    await flush()
    assert.equal(calls, 0, 'no boundaries means no host request')
    assert.ok(text(catRow(m, 'assistant')).includes('1 Items'))
    await m.unmount()
  })

  test('a failing host delta falls back to the local diff', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 30, tokens: 10, cat: 'assistant', text: 'new' })],
      archive: [{ ...node(1, 'assistant', 10), gone: 20 }],
    })
    const m = await mount(h(Browser, props({
      data,
      fetchDelta: () => Promise.resolve(null),
    })))
    await pickStep(m, '20')
    await flush()
    const row = text(catRow(m, 'assistant'))
    assert.ok(row.includes('-1'), `the local diff still counts the retained removal: ${row}`)
    await m.unmount()
  })

  test('a late delta never updates an unmounted browser', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 30, tokens: 10, cat: 'assistant', text: 'new' })],
    })
    let rejected = false
    let reject: (reason: unknown) => void = () => {}
    const pending = new Promise<ContextDelta | null>((_, rejectIt) => {
      reject = (reason) => {
        rejected = true
        rejectIt(reason)
      }
    })
    const m = await mount(h(Browser, props({ data, fetchDelta: () => pending })))
    await pickStep(m, '20')
    await m.unmount()
    reject(new Error('late failure'))
    await flush()
    assert.equal(rejected, true)
  })

  test('a rejected host delta also falls back to the local diff', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 1, step: 1 })],
      nodes: [surfaceNode({ seq: 30, tokens: 10, cat: 'assistant', text: 'new' })],
      archive: [{ ...node(1, 'assistant', 10), gone: 20 }],
    })
    const m = await mount(h(Browser, props({
      data,
      fetchDelta: () => Promise.reject(new Error('route down')),
    })))
    await pickStep(m, '20')
    await flush()
    const row = text(catRow(m, 'assistant'))
    assert.ok(row.includes('-1'), `the local diff still counts the retained removal: ${row}`)
    await m.unmount()
  })
})

// NodeList (src/client/components/nodes.tsx) rendered with real React, plus
// the makeNodeText label cascade (pure, driven directly).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeNodeList, makeNodeText } from '../../../src/client/components/nodes'
import { makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const nodeText = makeNodeText(kit)
const NodeList = makeNodeList(kit)

describe('makeNodeText', () => {
  test('tool results name the tool; failures carry the warning glyph', () => {
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash' }), 'Tool Result ← bash')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1 }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash', err: true }), 'Tool Result ← bash ⚠')
  })

  test('skill-tagged nodes lead with the skill name', () => {
    // The skill branch follows the tool branch: skill results keep their
    // tool-result label; the skill name leads on injected nodes.
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, skill: 'code-review' }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, skill: 'code-review' }), 'Skill: code-review')
  })

  test('assistant replies show text, a calls breadcrumb, or the empty marker', () => {
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, text: 'hi' }), 'hi')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, calls: ['bash', 'read'] }), 'Calls bash, read')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1 }), '(empty reply)')
  })

  test('snapshot-form text gets the snapshot prefix; plain text shows as-is', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'snapshot', text: 'a, b' }), 'Snapshot: a, b')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1, text: 'plain' }), 'plain')
  })

  test('textless injects label their form; anything else is a non-text message', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'notice' }), 'Notice')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1 }), 'Context Injection')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1 }), '(non-text message)')
  })
})

describe('NodeList', () => {
  test('renders the empty state', async () => {
    const m = await mount(h(NodeList, { nodes: [], dropped: 0 }))
    assert.ok(text(m.container).includes('No model-visible messages'))
    await m.unmount()
  })

  test('renders newest first with colors, times, and tokens; omitted-count row when dropped', async () => {
    const m = await mount(h(NodeList, {
      nodes: [
        { seq: 1, cat: 'user', tokens: 10, text: 'first', time: 1000 },
        { seq: 2, cat: 'assistant', tokens: 2048, text: 'second' },
      ],
      dropped: 3,
    }))
    const rows = queryAll(m.container, '.lc-node')
    assert.equal(rows.length, 2)
    assert.ok(text(rows[0]).includes('second')) // newest first
    assert.ok(text(rows[0]).includes('2.0k'))
    assert.ok(text(m.container).includes('3 earlier messages omitted'))
    await m.unmount()
  })

  test('unknown categories fall back to the grey swatch', async () => {
    const m = await mount(h(NodeList, { nodes: [{ seq: 1, cat: 'mystery' as never, tokens: 1 }], dropped: 0 }))
    const swatch = m.container.querySelector('i')
    assert.ok(swatch?.style.background.includes('rgb(153, 153, 153)') || swatch?.style.background === '#999')
    await m.unmount()
  })
})

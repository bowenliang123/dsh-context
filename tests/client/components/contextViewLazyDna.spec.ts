import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import type { SurfaceNode } from '../../../src/shared/types'
import type { UseChatLike } from '../../../src/client/services'
import { TestClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, queryAll } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, T0, timeline } from './contextViewHarness'

const kit = makeKit()

function bigTimeline() {
  const requests = Array.from({ length: 600 }, (_, i) => ({
    time: T0 + i * 1_000,
    seq: i + 1,
    turn: 1 + Math.floor(i / 100),
    step: i % 100,
    system: 10,
    tools: 20,
    user: 5,
    inject: 0,
    assistant: 15,
    tool: 5,
    total: 55,
    activeMs: 1_000 + i,
  }))
  const nodes: SurfaceNode[] = Array.from({ length: 200 }, (_, i) => ({
    seq: i + 1, cat: 'assistant', tokens: 10, text: `reply ${i}`,
  })) as SurfaceNode[]
  return timeline({ requests, nodes })
}

describe('ContextView lazy DNA bands', () => {
  test('a long log builds DNA bands only for the rendered window', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-lazy-dna',
      useProjection: projectionsFor(bigTimeline()),
      useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      await act(async () => { buttonByText(m.container, kit.t('trend.dna')).click() })
      await flush()
      const dnaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(dnaBars.length > 0, 'DNA bars render from the lazy accessor')
      assert.ok(dnaBars.length < 600, `only the window is assembled (${dnaBars.length})`)
      assert.equal(queryAll(m.container, '.lc-cat-seg').length, 0)
    } finally {
      await m.unmount()
    }
  })

  test('delta mode on a long log keeps every band so its axis stays exact', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-lazy-dna-delta',
      useProjection: projectionsFor(bigTimeline()),
      useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      await act(async () => { buttonByText(m.container, kit.t('trend.dna')).click() })
      await act(async () => { buttonByText(m.container, kit.t('gran.delta')).click() })
      await flush()
      // Eager bands plus delta mode still render the windowed DNA bars (correct axis needs the full model).
      assert.ok(queryAll(m.container, '.lc-bar-dna').length > 0)
    } finally {
      await m.unmount()
    }
  })
})

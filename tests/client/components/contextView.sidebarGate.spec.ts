import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { makeContextView } from '../../../src/client/components/contextView'
import { DICT_EN } from '../../../src/client/i18n'
import { createContextSettings } from '../../../src/client/settings'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { makeKit, mount, queryAll, text } from '../helpers/kit'
import { projectionsFor, richTimeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ContextView — the right Sidebar gate', () => {
  test('a collapsed or inactive sidebar tab mounts no body; expanding it paints the same view', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    let expanded = false
    function useTabInfo(): { sidebar: { expanded: boolean }; tab: { visible: boolean } } {
      return { sidebar: { expanded }, tab: { visible: expanded } }
    }
    const props = { sessionId: 's-gate', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()), useTabInfo }
    const m = await mount(h(View, props))
    assert.equal(queryAll(m.container, '.lc-card').length, 0, 'nothing heavy renders while collapsed')
    assert.equal(m.container.childElementCount, 1, 'the stable root stays')
    expanded = true
    await m.update(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    assert.ok(text(m.container).includes(DICT_EN['tokens.title']))
    await m.unmount()
    ctx.dispose()
  })

  test('a floating pane stays mounted even while the sidebar track is collapsed', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const props = {
      sessionId: 's-float', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()),
      useTabInfo: () => ({ sidebar: { expanded: false }, tab: { visible: true } }),
    }
    const m = await mount(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0, 'the float is on screen; visibility wins over the track')
    await m.unmount()
    ctx.dispose()
  })

  test('without the host hook the body keeps the IntersectionObserver fallback', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const m = await mount(h(View, { sessionId: 's-gate2', host: 'sidebar', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a tab-info seat that appears or disappears after mount keeps the gate rendering without shifting its hooks', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const props = { sessionId: 's-flip', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()) }
    const m = await mount(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    function useTabInfo(): { tab: { visible: boolean } } {
      const [visible] = useState(true)
      return { tab: { visible } }
    }
    const seated = { ...props, useTabInfo }
    await m.update(h(View, seated))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.update(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.unmount()
    ctx.dispose()
  })
})

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { createContextSettings } from '../../../src/client/settings'
import type { UseChatLike } from '../../../src/client/services'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestLocale } from '../helpers/harness'
import { click, flush, mount, query, queryAll, silenceWindowErrors, text } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, richTimeline, settingsWith, T0, timeline } from './contextViewHarness'

describe('ContextView — locale and settings', () => {
  const costed = timeline({
    cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } } } },
    costRead: { usd: 0.45, ready: true },
  })

  test('cost prices in USD by default (no locale service), CNY under zh', async () => {
    const cases = [
      ['sv-usd', new TestClientCtx(), '$', '¥'],
      ['sv-cny', new TestClientCtx({ services: { locale: new TestLocale('zh') } }), '¥', '$'],
      ['sv-bare', new TestClientCtx({ services: { locale: {} } }), '$', '¥'],
    ] as const
    for (const [sessionId, ctx, shown, hidden] of cases) {
      const m = await mount(h(makeView(ctx), { sessionId, useProjection: projectionsFor(costed) }))
      await flush()
      assert.ok(text(m.container).includes(shown), `${sessionId}: ${shown}`)
      assert.ok(!text(m.container).includes(hidden), `${sessionId}: no ${hidden}`)
      await m.unmount()
    }
  })

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = settingsWith({ defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path', defaultDurationCurve: 'hide' })
    const View = makeView(new TestClientCtx(), settings)
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline({
        nodes: [
          ...richTimeline().nodes,
          { seq: 7, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 6000 },
          { seq: 8, cat: 'tool', tokens: 30, tool: 'read', text: 'a', time: T0 + 7000 },
          { seq: 9, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 8000 },
        ],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] } })) as UseChatLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    assert.ok(!buttonByText(m.container, DICT_EN['trend.duration']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/a.ts', '/z.ts'])
    await m.unmount()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
      const real = createContextSettings()
      let fail = true
      const flaky = {
        ...real,
        defaultGranularity: (): 'step' | 'turn' => {
          if (fail) throw new Error('boom-settings')
          return real.defaultGranularity()
        },
      }
      const View = makeView(new TestClientCtx(), flaky)
      const m = await mount(h(View, {
        sessionId: 'sv-err',
        useProjection: projectionsFor(richTimeline()),
      }))
      assert.ok(text(m.container).includes(DICT_EN.error))
      assert.ok(text(m.container).includes('boom-settings'))

      fail = false
      await click(query(m.container, '.lc-error-retry'))
      assert.ok(text(m.container).includes(DICT_EN['overview.title']))
      assert.ok(!text(m.container).includes(DICT_EN.error))
      await m.unmount()
    } finally {
      silenceErrors()
    }
  })
})

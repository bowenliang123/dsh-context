// The always-on compatibility matrix — CLIENT side. For every supported dsh
// baseline (tests/baselines.ts) the plugin's client half is driven through
// THAT generation's faces: the finalized-nodes seat (`useChat`'s
// ChatSnapshot), the durable-image loader service, the seq-anchored history
// face and its response envelope (the remote.session gateway), and the
// MarkdownText chrome prop (required `labels`). These are the seams whose
// drift produced the recurring client-side incidents (issues #8, #12, #26).
//
// The real-code complement — the ACTUAL dsh sources per tag — runs in the
// `compat` vitest project (tests/compat/matrix.spec.ts).

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { BASELINES } from '../../baselines'
import { conversationNodesOf, imageLoaderOf } from '../../../src/client/services'
import type { SessionStandardProps } from '../../../src/client/services'
import { makeContentFetcher, watchHistoryFaces } from '../../../src/client/historyPage'
import { makeRichText } from '../../../src/client/components/richText'
import { makeContextView } from '../../../src/client/components/contextView'
import { createContextSettings } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import type { ContextTimeline } from '../../../src/shared/types'
import { h } from '../../../src/client/react'
import { asClientCtx, TestClientCtx } from '../helpers/harness'
import { click, makeKit, mount, queryAll, text } from '../helpers/kit'
import { baselineCtx, chatSeat, convNodes } from './baselineFaces'

const kit = makeKit()

// The chrome-prop capture: the plugin must hand EVERY markdown render a
// well-formed `labels` object (the primitives REQUIRE it). Intercept the
// primitive.
const captured = vi.hoisted(() => ({ markdownProps: undefined as Record<string, unknown> | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  return {
    MarkdownText: (props: Record<string, unknown>) => {
      captured.markdownProps = props
      return React.createElement('div', null, String(props.text ?? ''))
    },
  }
})

function timeline(): ContextTimeline {
  return {
    ok: true,
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    current: { system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 150, total: 1200 },
    requests: [],
    events: [],
    nodes: [
      { seq: 4, cat: 'user', tokens: 10, text: 'surface hello', time: 1 },
    ],
    droppedNodes: 0,
    archive: [],
  }
}

for (const baseline of BASELINES) {
  describe(`client faces — ${baseline.id}`, () => {
    test('the finalized-nodes seat serves the conversation window join', () => {
      const nodes = convNodes()
      assert.deepEqual(conversationNodesOf({ useChat: chatSeat(nodes) }), nodes)
      // A seat without the legacy slice: no join, no error.
      assert.equal(conversationNodesOf({ useChat: chatSeat(undefined) }), undefined)
    })

    test('the durable-image loader rides the uiConversation service', async () => {
      const { ctx, calls } = baselineCtx()
      const loader = imageLoaderOf(asClientCtx(ctx), 's-face')
      assert.ok(loader !== undefined, 'the baseline image face serves a loader')
      const url = await loader({ attachmentId: 'a1' })
      assert.equal(url, 'blob:modern-image')
      assert.equal(calls.image.length, 1)
      assert.equal(calls.image[0]?.sessionId, 's-face')
    })

    test('the targeted content fetch rides the gateway history face and envelope', async () => {
      const { ctx, calls } = baselineCtx()
      // Arm the declared inject the way the client apply does; the slot is
      // unloaded afterwards so no face stales into the next test.
      watchHistoryFaces(asClientCtx(ctx))
      const fetcher = makeContentFetcher('s-face')
      assert.ok(fetcher !== undefined, 'the baseline history face serves a fetcher')
      const node = await fetcher(4)
      assert.ok(node !== null)
      assert.equal(node.kind, 'user')
      assert.equal(node.seq, 4)
      assert.deepEqual(node.content, [{ type: 'text', text: 'history node hello' }])
      // The inclusive cut pinned to the seq, the exclusive bound one past it.
      assert.deepEqual(calls.page, [{ address: { kind: 'session', sessionId: 's-face' }, throughSeq: 4, beforeSeq: 5 }])
      // History is immutable: a re-read never re-fetches.
      await fetcher(4)
      assert.equal(calls.page.length, 1)
      ctx.dispose()
      assert.equal(makeContentFetcher('s-face'), undefined, 'the unloaded slot leaves no face behind')
    })

    test('a failed history rpc rejects (retryable), never resolving to a fake absence', async () => {
      const { ctx } = baselineCtx()
      // The inject resolves the page off the `remote` facade — fail it there.
      ctx.setService('remote', { session: { page: () => Promise.resolve({ ok: false }) } })
      watchHistoryFaces(asClientCtx(ctx))
      const fetcher = makeContentFetcher('s-face')
      assert.ok(fetcher !== undefined)
      await assert.rejects(fetcher(4))
      ctx.dispose()
    })

    test('the Context tab renders through the seats of this generation without tripping the error boundary', async () => {
      const { ctx } = baselineCtx()
      const settings = createContextSettings()
      const View = makeContextView(asClientCtx(ctx), kit, settings)
      const nodes = convNodes()
      const props: SessionStandardProps = {
        sessionId: 's-face',
        useProjection: (key: string) => (key === 'contextTimeline' ? timeline() : undefined),
        useChat: chatSeat(nodes),
      }
      const m = await mount(h(View, props))
      const rendered = text(m.container)
      assert.ok(rendered.includes(DICT_EN['overview.title']), 'the tab rendered, not the error card')
      // Open the user category (row order: system, tools, user, inject, assistant, tool) — its
      // lone row auto-expands, and the joined full content rides the baseline seat.
      await click(queryAll(m.container, '.lc-br-cat-row')[2])
      assert.ok(text(m.container).includes('window node hello'), 'the conversation-window join surfaced the seat node')
      await m.unmount()
    })

    test('a throwing history-service proxy degrades the tab, never crashes it', async () => {
      // Issue #42: a traced proxy can throw on the property READ itself
      // ("cannot get property "remote.session" without inject") — arming the
      // declared inject with such a hostile facade must leave the slot unset
      // (nothing escapes the callback) and the tab renders with its static
      // hint instead of crashing.
      const ctx = new TestClientCtx()
      ctx.setService('remote', {
        get session() { throw new Error('cannot get property "remote.session" without inject') },
      })
      ctx.setService('remote.session', {
        get page() { throw new Error('cannot get property "remote.session" without inject') },
      })
      watchHistoryFaces(asClientCtx(ctx))
      assert.equal(makeContentFetcher('s-face'), undefined, 'the hostile face left the slot unset')
      const settings = createContextSettings()
      const View = makeContextView(asClientCtx(ctx), kit, settings)
      const nodes = convNodes()
      const props: SessionStandardProps = {
        sessionId: 's-face',
        useProjection: (key: string) => (key === 'contextTimeline' ? timeline() : undefined),
        useChat: chatSeat(nodes),
      }
      const m = await mount(h(View, props))
      assert.ok(text(m.container).includes(DICT_EN['overview.title']), 'the tab still rendered around a hostile face')
      await m.unmount()
      ctx.dispose()
    })
  })
}

describe('client faces — markdown chrome prop (required)', () => {
  test('every markdown render carries a well-formed `labels` chrome', async () => {
    const { RichText } = makeRichText(kit)
    const m = await mount(h(RichText, { text: '# hello', mode: 'md' }))
    assert.ok(captured.markdownProps !== undefined, 'MarkdownText received props')
    const labels = captured.markdownProps.labels as { code: { copyLabel: string; copiedLabel: string }; footnotes: string } | undefined
    assert.ok(labels !== undefined, 'labels chrome present (required by the primitives)')
    assert.equal(typeof labels.code.copyLabel, 'string')
    assert.equal(typeof labels.code.copiedLabel, 'string')
    assert.equal(typeof labels.footnotes, 'string')
    assert.equal(captured.markdownProps.text, '# hello')
    await m.unmount()
  })
})

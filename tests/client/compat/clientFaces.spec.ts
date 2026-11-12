import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { BASELINES } from '../../baselines'
import { conversationNodesOf, imageLoaderOf, openResourceVia, openSessionVia, sessionAddressOf } from '../../../src/client/services'
import type { SessionStandardProps } from '../../../src/client/services'
import { makeContentFetcher, watchHistoryFaces } from '../../../src/client/historyPage'
import { makeRichText } from '../../../src/client/components/richText'
import { makeContextView } from '../../../src/client/components/contextView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { createContextSettings } from '../../../src/client/settings'
import { watchSidebarContextTab } from '../../../src/client/sidebar'
import { DICT_EN } from '../../../src/client/i18n'
import type { ContextTimeline } from '../../../src/shared/types'
import { asClientCtx, TestClientCtx } from '../helpers/harness'
import { click, makeKit, mount, queryAll, text } from '../helpers/kit'
import { baselineCtx, chatSeat, convNodes } from './baselineFaces'

const kit = makeKit()

const plainOf = (sessionId: string) => () => ({ kind: 'session' as const, sessionId })

const captured = vi.hoisted(() => ({ markdownProps: undefined as Record<string, unknown> | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  return {
    MarkdownText: (props: Record<string, unknown>) => {
      captured.markdownProps = props
      return React.createElement('div', null, String(props.text ?? ''))
    },
    JsonTree: () => React.createElement('div', null, 'json-tree'),
    IconCopyOutlineRegular: () => React.createElement('span', null),
    IconCheckOutlineRegular: () => React.createElement('span', null),
    IconSettingsOutlineMedium: () => React.createElement('span', null),
    useCodeHighlighter: () => () => undefined,
    useDismissOnOutsidePointer: () => undefined,
    writeClipboard: async () => true,
  }
})

function timeline(): ContextTimeline {
  return {
    ok: true,
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    current: { system: 100, tools: 200, user: 300, inject: 50, skill: 0, assistant: 400, tool: 150, total: 1200 },
    requests: [],
    events: [],
    nodes: [
      { seq: 4, cat: 'user', tokens: 10, text: 'surface hello', time: 1 },
    ],
    droppedNodes: 0,
    archive: [],
  }
}

function mountTab(ctx: TestClientCtx) {
  const settings = createContextSettings()
  const View = makeContextView(asClientCtx(ctx), kit, settings, makeAgentHeads())
  const nodes = convNodes()
  const props: SessionStandardProps = {
    sessionId: 's-face',
    useProjection: (key: string) => (key === 'contextTimeline' ? timeline() : undefined),
    useChat: chatSeat(nodes),
  }
  return mount(h(View, props))
}

for (const baseline of BASELINES) {
  describe(`client faces — ${baseline.id}`, () => {
    test('the finalized-nodes seat serves the conversation window join', () => {
      const nodes = convNodes()
      assert.deepEqual(conversationNodesOf({ useChat: chatSeat(nodes) }), nodes)
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
      watchHistoryFaces(asClientCtx(ctx))
      const fetcher = makeContentFetcher(plainOf('s-face'))
      assert.ok(fetcher !== undefined, 'the baseline history face serves a fetcher')
      const node = await fetcher(4)
      assert.ok(node !== null)
      assert.equal(node.kind, 'user')
      assert.equal(node.seq, 4)
      assert.deepEqual(node.content, [{ type: 'text', text: 'history node hello' }])
      assert.deepEqual(calls.page, [{ address: { kind: 'session', sessionId: 's-face' }, throughSeq: 4, beforeSeq: 5 }])
      await fetcher(4)
      assert.equal(calls.page.length, 1)
      ctx.dispose()
      assert.equal(makeContentFetcher(plainOf('s-face')), undefined, 'the unloaded slot leaves no face behind')
    })

    test('a subagent child read carries its durable parent address (issue #193)', async () => {
      const { ctx, calls } = baselineCtx()
      ctx.setService('sessions', {
        subagentAddress: (id: string) => ({ parentSessionId: 's-parent', childSessionId: id, mode: 'continuable' }),
      })
      watchHistoryFaces(asClientCtx(ctx))
      const fetcher = makeContentFetcher(() => sessionAddressOf(asClientCtx(ctx), 's-child'))
      assert.ok(fetcher !== undefined)
      assert.equal((await fetcher(4))?.kind, 'user')
      assert.deepEqual(calls.page, [{
        address: { kind: 'subagent', parentSessionId: 's-parent', childSessionId: 's-child', mode: 'continuable' },
        throughSeq: 4,
        beforeSeq: 5,
      }])
      ctx.dispose()
    })

    test('the session jump rides this generation\'s navigation seam (issue #90)', () => {
      const { ctx } = baselineCtx()
      const nav = baseline.client.sessionNav
      const jumped: string[] = []
      ctx.setService('uiWorkspace', { openSession: (id: string) => { jumped.push(id) } })
      ctx.setService('sessions', nav.sessionsOpen
        ? { open: (id: string) => { jumped.push(`legacy:${id}`) } }
        : { list: { getSnapshot: () => ({}) } })
      openSessionVia(asClientCtx(ctx), 's-jump')
      assert.deepEqual(jumped, ['s-jump'], 'the jump landed through the view owner')
      ctx.dispose()
    })

    test('a failed history rpc rejects (retryable), never resolving to a fake absence', async () => {
      const { ctx } = baselineCtx()
      ctx.setService('remote', { session: { page: () => Promise.resolve({ ok: false }) } })
      watchHistoryFaces(asClientCtx(ctx))
      const fetcher = makeContentFetcher(plainOf('s-face'))
      assert.ok(fetcher !== undefined)
      await assert.rejects(fetcher(4))
      ctx.dispose()
    })

    test('the Context tab renders through the seats of this generation without tripping the error boundary', async () => {
      const { ctx } = baselineCtx()
      const m = await mountTab(ctx)
      const rendered = text(m.container)
      assert.ok(rendered.includes(DICT_EN['overview.title']), 'the tab rendered, not the error card')
      await click(queryAll(m.container, '.lc-br-cat-row')[2])
      assert.ok(text(m.container).includes('window node hello'), 'the conversation-window join surfaced the seat node')
      await m.unmount()
    })

    test('the right Sidebar Context tab is optional: absent seam = inert, present seam = registered', () => {
      const { ctx } = baselineCtx()
      const settings = createContextSettings()
      const View = makeContextView(asClientCtx(ctx), kit, settings, makeAgentHeads())
      assert.doesNotThrow(() => {
        watchSidebarContextTab(asClientCtx(ctx), View, kit.t, 'dsh-context')
      })
      assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
      const definitions: unknown[] = []
      ctx.setService('sidebarRightTabs', {
        register: (definition: unknown) => {
          definitions.push(definition)
          return () => {}
        },
      })
      assert.equal(definitions.length, 1, 'the generation with the seam gets the tab')
      assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
      assert.equal(ctx.slots.of('sidebar.right.pane.tab.title').length, 1, 'the chip-title seat is registered on this generation')
      ctx.dispose()
    })

    test('the Sidebar preview opener is optional: absent face = no opener, present face = wired', () => {
      const { ctx } = baselineCtx()
      assert.equal(openResourceVia(asClientCtx(ctx)), undefined, 'no navigation face = no preview opener')
      const opened: string[] = []
      ctx.setService('sidebarRight', { openResource: (address: string) => { opened.push(address) } })
      const open = openResourceVia(asClientCtx(ctx))
      assert.ok(open !== undefined, 'the generation with the column serves the opener')
      assert.equal(open('dsh-resource://file/session/s/a.ts'), true)
      assert.deepEqual(opened, ['dsh-resource://file/session/s/a.ts'])
      ctx.dispose()
    })

    test('a throwing history-service proxy degrades the tab, never crashes it', async () => {
      const ctx = new TestClientCtx()
      ctx.setService('remote', {
        get session() { throw new Error('cannot get property "remote.session" without inject') },
      })
      ctx.setService('remote.session', {
        get page() { throw new Error('cannot get property "remote.session" without inject') },
      })
      watchHistoryFaces(asClientCtx(ctx))
      assert.equal(makeContentFetcher(plainOf('s-face')), undefined, 'the hostile face left the slot unset')
      const m = await mountTab(ctx)
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

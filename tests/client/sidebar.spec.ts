import { createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { makeAgentHeads } from '../../src/client/agentHeads'
import { makeContextView } from '../../src/client/components/contextView'
import { createContextSettings } from '../../src/client/settings'
import {
  SIDEBAR_CONTEXT_ID,
  SIDEBAR_CONTEXT_KIND,
  watchSidebarContextTab,
} from '../../src/client/sidebar'
import type { ContextViewProps, SidebarTabDefinitionLike } from '../../src/client/services'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { makeKit, mount, query, text } from './helpers/kit'

const NS = 'dsh-context'

function registry(): { definitions: SidebarTabDefinitionLike[]; disposed: number; register: (d: SidebarTabDefinitionLike) => () => void } {
  const rec = {
    definitions: [] as SidebarTabDefinitionLike[],
    disposed: 0,
    register: (definition: SidebarTabDefinitionLike): (() => void) => {
      rec.definitions.push(definition)
      return () => { rec.disposed += 1 }
    },
  }
  return rec
}

function wire(ctx: TestClientCtx, view: (props: ContextViewProps) => unknown = props => props): void {
  const t = ctx.locale.bind(NS)
  watchSidebarContextTab(asClientCtx(ctx), view, t, NS)
}

describe('watchSidebarContextTab — the optional registration', () => {
  test('a harness without the sidebar registry registers nothing until the registry arms (deferred inject)', () => {
    const ctx = new TestClientCtx()
    wire(ctx)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 1)
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test('registers the type, the body and chip-title seats, and the guide fields it supplies; unload unwinds them', async () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)

    const def = tabs.definitions[0]
    assert.equal(def.id, SIDEBAR_CONTEXT_ID)
    assert.equal(def.kind, SIDEBAR_CONTEXT_KIND, 'the kind is namespaced so a foreign `context` cannot collide')
    assert.equal(def.title(), 'Context')
    assert.equal(def.guide?.length, 1)
    assert.equal(def.guide?.[0].id, SIDEBAR_CONTEXT_ID, 'the guide entry carries the stable entry identity')
    assert.equal(def.guide?.[0].order, 20, 'after the shipped Files entry (order 10)')
    assert.equal(def.guide?.[0].title(), 'Context')
    assert.equal(def.guide?.[0].description?.(), DICT_EN['sidebar.guideDescription'])
    assert.equal(typeof def.guide?.[0].icon, 'function', 'the guide capsule carries the bundled emblem')

    const body = ctx.slots.of('sidebar.right.pane.tab')
    assert.equal(body.length, 1)
    assert.equal(body[0].registration.key, SIDEBAR_CONTEXT_ID, 'the keyed seat dispatches on the type id')
    assert.equal(body[0].registration.locale, NS, 'the framework synthesizes the t seat for the panel')

    const title = ctx.slots.of('sidebar.right.pane.tab.title')
    assert.equal(title.length, 1, 'the chip-title seat is registered for the type')
    assert.equal(title[0].registration.key, SIDEBAR_CONTEXT_ID)

    const m = await mount(h(title[0].component as () => ReactElement))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    assert.equal(text(m.container), 'Context')
    await m.unmount()

    ctx.dispose()
    assert.equal(tabs.disposed, 1, 'the type registration was disposed')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'the body seat was disposed')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab.title'), [], 'the chip-title seat was disposed')
  })

  test('the labels follow the active locale at call time', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)
    assert.equal(tabs.definitions[0].title(), '上下文')
    assert.equal(tabs.definitions[0].guide?.[0].title(), '上下文')
    assert.equal(tabs.definitions[0].guide?.[0].description?.(), DICT_ZH['sidebar.guideDescription'])
    ctx.dispose()
  })

  test('the body renders the injected view with the seat props and the sidebar host marker', () => {
    const ctx = new TestClientCtx()
    const seen: ContextViewProps[] = []
    const view = (props: ContextViewProps): string => {
      seen.push(props)
      return 'context-view'
    }
    ctx.setService('sidebarRightTabs', registry())
    wire(ctx, view)
    const component = ctx.slots.of('sidebar.right.pane.tab')[0].component
    const props = { sessionId: 's-1', useProjection: () => undefined }
    assert.equal(component(props), 'context-view')
    assert.equal(seen.length, 1)
    assert.notEqual(seen[0], props, 'the marker rides a copy, never the seat object')
    assert.equal(seen[0].sessionId, 's-1')
    assert.equal(seen[0].useProjection, props.useProjection, 'the standard kit survives the spread')
    assert.equal(seen[0].host, 'sidebar', 'the panel host marker')
    ctx.dispose()
  })

  test('the real Context view through this seat keeps the Agent Network card inline', async () => {
    const snapshot = { byId: { 's-1': { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: {
            getSnapshot: (): unknown => snapshot,
            subscribe: (): (() => void) => () => {},
          },
        },
      },
    })
    ctx.setService('sidebarRightTabs', registry())
    const view = makeContextView(asClientCtx(ctx), makeKit(), createContextSettings(), makeAgentHeads())
    wire(ctx, view)
    const component = ctx.slots.of('sidebar.right.pane.tab')[0].component
    const m = await mount(component({
      sessionId: 's-1',
      useProjection: (key: string) => (key === 'contextTimeline'
        ? { ok: true, current: { system: 10, tools: 20, user: 30, inject: 0, skill: 0, assistant: 0, tool: 0, total: 60 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
        : undefined),
    }) as ReactElement)
    assert.ok(query(m.container, '.lc-agents') !== null, 'the panel keeps the family card')
    assert.ok(text(m.container).includes(DICT_EN['agents.solo']), 'and renders it with real data')
    await m.unmount()
    ctx.dispose()
  })

  test('a throwing registry is swallowed: the plugin keeps its other seats', () => {
    const ctx = new TestClientCtx()
    ctx.setService('sidebarRightTabs', {
      register: () => { throw new Error('id already registered') },
    })
    assert.doesNotThrow(() => { wire(ctx) })
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'no body seat without a type')
    ctx.dispose()
  })

  test('a failure mid-registration unwinds the seats that already landed', () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    let calls = 0
    ;(ctx as unknown as { slots: unknown }).slots = {
      inject: (_name: string, callback: () => unknown) => {
        calls += 1
        if (calls === 2) throw new Error('title seat unavailable')
        return callback()
      },
      register: () => () => {},
    }
    assert.doesNotThrow(() => { wire(ctx) })
    assert.equal(tabs.disposed, 1, 'the type registration was rolled back')
    ctx.dispose()
  })

  test('a shapeless service (no register, a primitive) registers nothing', () => {
    for (const service of [{}, 'registry', 7, null]) {
      const ctx = new TestClientCtx()
      ctx.setService('sidebarRightTabs', service)
      assert.doesNotThrow(() => { wire(ctx) })
      assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
      ctx.dispose()
    }
  })

  test('a foreign slots face returning no disposer is tolerated on unload', () => {
    const ctx = new TestClientCtx()
    ctx.setService('sidebarRightTabs', registry())
    ;(ctx as unknown as { slots: unknown }).slots = {
      inject: () => undefined,
      register: () => () => {},
    }
    wire(ctx)
    assert.doesNotThrow(() => { ctx.dispose() })
  })
})

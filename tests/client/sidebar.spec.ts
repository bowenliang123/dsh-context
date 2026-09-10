// The right Sidebar's Context tab (src/client/sidebar.ts): the OPTIONAL
// two-stage registration — tab type into `sidebarRightTabs`, body into the
// keyed `sidebar.right.pane.tab` seat — and its silent degrade on every
// harness that serves no right Sidebar (the older supported lines).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import {
  SIDEBAR_CONTEXT_ID,
  SIDEBAR_CONTEXT_KIND,
  watchSidebarContextTab,
} from '../../src/client/sidebar'
import type { ContextViewProps, SidebarTabDefinitionLike } from '../../src/client/services'
import { TestClientCtx, asClientCtx } from './helpers/harness'

const NS = 'dsh-context'

/** A registry stand-in recording what it was handed (and its disposer calls). */
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
  test('a harness without the sidebar registry registers nothing and never throws', () => {
    const ctx = new TestClientCtx()
    wire(ctx)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test('the registry armed LATER still gets the tab (deferred inject, not a missed race)', () => {
    const ctx = new TestClientCtx()
    wire(ctx)
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 1)
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
  })

  test('registers the type and the body seat with the plugin namespace', () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)

    const def = tabs.definitions[0]
    assert.equal(def.id, SIDEBAR_CONTEXT_ID)
    assert.equal(def.kind, SIDEBAR_CONTEXT_KIND, 'the kind is namespaced so a foreign `context` cannot collide')
    assert.equal(def.title(), 'Context')
    assert.equal(def.guide?.length, 1)
    assert.equal(def.guide?.[0].order, 20, 'after the shipped Files entry (order 10)')
    assert.equal(def.guide?.[0].title(), 'Context')
    assert.equal(def.guide?.[0].description?.(), DICT_EN['sidebar.guideDescription'])
    assert.deepEqual(
      Object.keys(def.guide?.[0] ?? {}).sort(),
      ['description', 'icon', 'order', 'title'],
      'the capsule carries exactly the rc.1 guide-entry fields',
    )
    assert.equal(typeof def.guide?.[0].icon, 'function', 'the guide capsule carries a glyph')

    const body = ctx.slots.of('sidebar.right.pane.tab')
    assert.equal(body.length, 1)
    assert.equal(body[0].registration.key, SIDEBAR_CONTEXT_ID, 'the keyed seat dispatches on the type id')
    assert.equal(body[0].registration.locale, NS, 'the framework synthesizes the t seat for the panel')
    ctx.dispose()
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

  test('a throwing registry is swallowed: the plugin keeps its other seats', () => {
    const ctx = new TestClientCtx()
    ctx.setService('sidebarRightTabs', {
      register: () => { throw new Error('id already registered') },
    })
    assert.doesNotThrow(() => { wire(ctx) })
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'no body seat without a type')
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
    // A slots implementation whose inject() returns nothing (the plugin's face
    // types the return as unknown): the disposer must guard the call.
    ;(ctx as unknown as { slots: unknown }).slots = {
      inject: () => undefined,
      register: () => () => {},
    }
    wire(ctx)
    assert.doesNotThrow(() => { ctx.dispose() })
  })

  test('unload disposes both registrations', () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
    assert.equal(tabs.disposed, 1, 'the type registration was disposed')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'the body seat was disposed')
  })
})

import type { ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICTS } from '../../src/client/i18n'
import { modalStoreOf, type ModalStore } from '../../src/client/modalStore'
import type { SettingsField, SettingsScopeLike, SettingsState } from '../../src/client/settings'
import { TestClientCtx, TestSessions, asClientCtx } from './helpers/harness'

const { name, inject, apply } = (await import('../../src/client/index')) as unknown as {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
}

function applyTo(ctx: TestClientCtx): void {
  apply(asClientCtx(ctx))
}

function makeScope(snapshot: { status: string; value: unknown; writable: boolean }): SettingsScopeLike & {
  subscribes: number
  sets: { field: string; value: unknown }[]
} {
  const rec = {
    subscribes: 0,
    sets: [] as { field: string; value: unknown }[],
    getSnapshot: () => snapshot,
    subscribe: (_listener: () => void) => {
      rec.subscribes += 1
      return () => {}
    },
    set: async (field: string, value: unknown) => {
      rec.sets.push({ field, value })
    },
  }
  return rec
}

function formsServing(form: SettingsScopeLike): {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
} {
  return {
    get: () => form,
    whileServed: () => () => {},
  }
}

function scopeWith(snapshot: { status: string; value: unknown; writable: boolean }): SettingsScopeLike & {
  emit(next: { status: string; value: unknown; writable: boolean }): void
} {
  let current = snapshot
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: () => Promise.resolve(),
    emit(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

describe('client entry: identity and dictionaries', () => {
  test('name and inject declare the plugin identity; apply registers all locale dictionaries and dispose removes them', () => {
    assert.equal(name, 'dsh-context')
    assert.deepEqual(inject, ['slots', 'locale'])

    const ctx = new TestClientCtx()
    applyTo(ctx)
    const dicts = ctx.locale.namespaces.get('dsh-context')
    assert.ok(dicts)
    for (const [locale, dict] of Object.entries(DICTS)) assert.equal(dicts[locale], dict)
    assert.equal(ctx.locale.bind('dsh-context')('tab.context'), 'Context')
    ctx.dispose()
    assert.equal(ctx.locale.namespaces.has('dsh-context'), false)

    const zh = new TestClientCtx({ locale: 'zh' })
    applyTo(zh)
    assert.equal(zh.locale.bind('dsh-context')('tab.context'), '上下文')
    zh.dispose()
  })
})

describe('client entry: conversation.view slot', () => {
  test('registers the Context and Fleet tabs with locale-following labels and the expected component types', () => {
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } } } })
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.view')
    assert.equal(entries.length, 2)
    const [contextTab, fleetTab] = entries
    assert.equal(contextTab.registration.name, 'conversation.view')
    assert.equal(contextTab.registration.id, 'context')
    assert.equal(contextTab.registration.order, 20)
    assert.equal(contextTab.registration.locale, 'dsh-context')
    assert.equal(contextTab.registration.label?.(), 'Context')
    const contextEl = contextTab.component({ sessionId: 's1', useProjection: () => undefined }) as ReactElement
    assert.equal(typeof contextEl.type, 'function')
    assert.equal((contextEl.type as { name: string }).name, 'ContextView')

    assert.equal(fleetTab.registration.name, 'conversation.view')
    assert.equal(fleetTab.registration.id, 'fleet')
    assert.equal(fleetTab.registration.order, 30)
    assert.equal(fleetTab.registration.locale, 'dsh-context')
    assert.equal(fleetTab.registration.label?.(), 'Fleet')
    const fleetEl = fleetTab.component({ sessionId: 's1', useProjection: () => undefined }) as ReactElement
    assert.equal(typeof fleetEl.type, 'function')
    assert.equal((fleetEl.type as { name: string }).name, 'FleetView')

    const zh = new TestClientCtx({ locale: 'zh' })
    applyTo(zh)
    assert.deepEqual(zh.slots.of('conversation.view').map(e => e.registration.label?.()), ['上下文', '编队'])
    zh.dispose()
    ctx.dispose()
  })

})

describe('client entry: assistant-actions seat', () => {
  test('registers the chat→Context jump entry and resolves its component type', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.chat.assistant-actions')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.chat.assistant-actions')
    assert.equal(registration.id, 'context-jump')
    assert.equal(registration.order, 20, 'right of the shipped feedback entry')
    assert.equal(registration.locale, 'dsh-context')

    assert.equal(typeof component, 'function')
    assert.equal(typeof component({ messageId: 'm1' }), 'object')
    ctx.dispose()
  })
})

describe('client entry: optional service seams', () => {
  test('absent sessions and inputTriggers are noops; a present sessions seam mounts and disposes the plugin cleanly', () => {
    const bare = new TestClientCtx()
    applyTo(bare)
    assert.equal(bare.slots.of('conversation.view').length, 2, 'absent optional services still mount the tabs')
    bare.dispose()
    assert.deepEqual(bare.slots.of('conversation.view'), [], 'dispose unwinds the tabs')

    const ctx = new TestClientCtx({ services: { sessions: new TestSessions() } })
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, 2, 'the sessions seam never gates the mounts')
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
  })
})

describe('client entry: /context command effect', () => {
  test('present inputTriggers registers the source and dispose unregisters it', () => {
    const sources: { trigger: string; name: string }[] = []
    const inputTriggers = {
      registerSource(src: { trigger: string; name: string }): () => void {
        sources.push(src)
        return () => {
          const i = sources.indexOf(src)
          if (i >= 0) sources.splice(i, 1)
        }
      },
    }
    const ctx = new TestClientCtx({ services: { inputTriggers } })
    applyTo(ctx)
    assert.equal(sources.length, 1)
    assert.equal(sources[0].trigger, '/')
    assert.equal(sources[0].name, 'context')
    ctx.dispose()
    assert.equal(sources.length, 0)
  })
})

describe('client entry: conversation.input.overlay slot', () => {
  test('registers the modal overlay; inject binds the per-session modal store and resolves its component type', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.input.overlay')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.input.overlay')
    assert.equal(registration.id, 'context-modal')
    assert.equal(registration.order, 10)
    assert.equal(registration.locale, 'dsh-context')

    const face = registration.inject?.('sess-1') as { hooks: { contextModal: ModalStore } }
    assert.equal(face.hooks.contextModal, modalStoreOf('sess-1'))

    const el = component({
      sessionId: 'sess-1',
      useContextModal: (sel: (open: boolean) => boolean) => sel(modalStoreOf('sess-1').getSnapshot()),
    }) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'ContextModal')
    ctx.dispose()
  })
})

describe('client entry: Context Insights page seats', () => {
  test('registers the keyed main page and the sidebar panel-list entry under one id', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)

    const pages = ctx.slots.of('main')
    assert.equal(pages.length, 1)
    const pageEl = pages[0].component({}) as ReactElement
    assert.equal((pageEl.type as { name: string }).name, 'OverviewPanel')

    const entries = ctx.slots.of('sidebar.panellist')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].registration.id, 'dsh-context', 'the entry id addresses the main panel')
    ctx.dispose()
  })

})

describe('client entry: configForms inject', () => {
  function fakeConfigForms(form: SettingsScopeLike): {
    gets: string[]
    whileServedCalls: string[][]
    register: () => () => void
    whileServed(namespaces: readonly string[], register: () => () => void): () => void
  } {
    const rec = {
      gets: [] as string[],
      whileServedCalls: [] as string[][],
      register: (): (() => void) => () => {},
      get(namespace: string): SettingsScopeLike {
        rec.gets.push(namespace)
        return form
      },
      whileServed(namespaces: string[], register: () => () => void): () => void {
        rec.whileServedCalls.push(namespaces)
        rec.register = register
        return () => {}
      },
    }
    return rec
  }

  test('absent at apply time and defensively armed leave no slot and never throw', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.equal(ctx.slots.of('plugins.bundle.config').length, 0)
    ctx.dispose()
    const ctx2 = new TestClientCtx()
    ctx2.setService('configForms', { get: () => makeScope({ status: 'ready', value: {}, writable: true }) })
    applyTo(ctx2)
    assert.equal(ctx2.slots.of('plugins.bundle.config').length, 0)
    ctx2.dispose()
    const ctx3 = new TestClientCtx()
    ctx3.setService('configForms', undefined)
    applyTo(ctx3)
    assert.equal(ctx3.slots.of('plugins.bundle.config').length, 0)
    ctx3.dispose()
  })

  test('armed later: the form binds the namespace and the served registration claims the Plugins-page seat', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const scope = makeScope({ status: 'ready', value: { defaultTrendMode: 'delta' }, writable: true })
    const forms = fakeConfigForms(scope)
    ctx.setService('configForms', forms)
    assert.deepEqual(forms.gets, ['dsh-context'])
    assert.equal(scope.subscribes, 1, 'the settings store attached to the form')
    assert.deepEqual(forms.whileServedCalls, [['dsh-context']])
    assert.equal(ctx.slots.of('plugins.bundle.config').length, 0)
    const disposeRegistration = forms.register()
    const entries = ctx.slots.of('plugins.bundle.config')
    assert.equal(entries.length, 1)
    const registration = entries[0].registration as never as {
      name: string
      key?: string
      locale?: string
      inject?: () => unknown
    }
    assert.equal(registration.name, 'plugins.bundle.config')
    assert.equal(registration.key, 'dsh-context')
    assert.equal(registration.locale, 'dsh-context')
    const face = registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState } }
      set: (field: SettingsField, value: string) => void
    }
    assert.equal(face.hooks.contextSettings.getSnapshot().mode, 'delta', 'the card reads the form snapshot')
    face.set('defaultToolSort', 'name')
    assert.deepEqual(scope.sets, [{ field: 'defaultToolSort', value: 'name' }])
    const el = entries[0].component({}) as ReactElement
    assert.equal((el.type as { name: string }).name, 'PluginConfigCard')
    disposeRegistration()
    assert.deepEqual(ctx.slots.of('plugins.bundle.config'), [], 'the registration disposer withdraws the seat')
    ctx.dispose()
  })
})

describe('client entry: right Sidebar Context tab', () => {
  test('absent at apply time no tab seats; armed later the pending inject registers the type and body', () => {
    const bare = new TestClientCtx()
    applyTo(bare)
    assert.deepEqual(bare.slots.of('sidebar.right.pane.tab'), [])
    bare.dispose()

    const ctx = new TestClientCtx()
    applyTo(ctx)
    const definitions: { id?: string; kind?: string; title?: () => string }[] = []
    ctx.setService('sidebarRightTabs', {
      register: (definition: { id?: string; kind?: string; title?: () => string }) => {
        definitions.push(definition)
        return () => {}
      },
    })
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].id, 'dsh-context')
    const bodies = ctx.slots.of('sidebar.right.pane.tab')
    assert.equal(bodies.length, 1)
    ctx.dispose()
  })
})

describe('client entry: placement gating', () => {
  function registry(): { definitions: unknown[]; disposed: number; register(d: unknown): () => void } {
    const rec = {
      definitions: [] as unknown[],
      disposed: 0,
      register(d: unknown): () => void {
        rec.definitions.push(d)
        return () => { rec.disposed += 1 }
      },
    }
    return rec
  }

  test('a registry that hands back no disposer unwinds the tab mount without a throw', () => {
    const ctx = new TestClientCtx()
    ;(ctx.slots as unknown as { register: () => unknown }).register = () => undefined
    applyTo(ctx)
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
  })

  test("the persisted 'sidebar' placement skips the Context tab and keeps the sidebar", () => {
    const scope = scopeWith({ status: 'ready', value: { defaultPlacement: 'sidebar' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['fleet'], 'the Context tab is dropped; the Fleet tab is not')
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 1, 'the kept sidebar still registers')
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
    assert.equal(tabs.disposed, 1)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test("the persisted 'hide' placement registers neither surface; the Fleet tab still serves, and a flip to 'all' mounts both", () => {
    const scope = scopeWith({ status: 'ready', value: { defaultPlacement: 'hide' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['fleet'], 'only the independent Fleet tab is served')
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 0, 'the sidebar never registers')

    scope.emit({ status: 'ready', value: { defaultPlacement: 'all' }, writable: true })
    assert.equal(tabs.definitions.length, 1, 'the sidebar joins live')
    assert.equal(ctx.slots.of('conversation.view').length, 2, 'the Context tab joins live')
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test("the persisted 'insightsEntry: hide' withdraws both Insights surfaces, and live flips mount and withdraw them", () => {
    const scope = scopeWith({ status: 'ready', value: { insightsEntry: 'hide' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.equal(ctx.slots.of('main').length, 0, 'the hidden Insights entry seats no main panel')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0, 'nor its panel-list row')

    scope.emit({ status: 'ready', value: { insightsEntry: 'show' }, writable: true })
    assert.equal(ctx.slots.of('main').length, 1, 'showing mounts the main panel')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1, 'and its panel-list row')

    scope.emit({ status: 'ready', value: { insightsEntry: 'hide' }, writable: true })
    assert.equal(ctx.slots.of('main').length, 0, 'hiding again withdraws both')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0)
    ctx.dispose()
  })

  test("the persisted 'fleetTab: hide' withholds only the Fleet tab, and live flips seat and withdraw it", () => {
    const scope = scopeWith({ status: 'ready', value: { fleetTab: 'hide' }, writable: true })
    const ctx = new TestClientCtx({ services: { configForms: formsServing(scope) } })
    applyTo(ctx)
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context'], 'the Context tab still serves')

    scope.emit({ status: 'ready', value: { fleetTab: 'show' }, writable: true })
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context', 'fleet'], 'showing seats the Fleet tab')

    scope.emit({ status: 'ready', value: { fleetTab: 'hide' }, writable: true })
    assert.deepEqual(ctx.slots.of('conversation.view').map(e => e.registration.id), ['context'], 'the Fleet tab alone is withdrawn')
    ctx.dispose()
  })

})

describe('client entry: second-mount guard', () => {
  test('a ledger already seating the jump marker skips the whole apply', () => {
    const sources: unknown[] = []
    const ctx = new TestClientCtx({ services: { inputTriggers: { registerSource: (src: unknown) => {
      sources.push(src)
      return () => {
        const i = sources.indexOf(src)
        if (i >= 0) sources.splice(i, 1)
      }
    } } } })
    applyTo(ctx)
    const first = ctx.slots.of('conversation.view').length
    assert.ok(first > 0, 'the first mount registers')
    assert.equal(sources.length, 1, 'the first mount registers the /context source')
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, first, 'no second tab is seated')
    assert.equal(ctx.slots.of('conversation.chat.assistant-actions').length, 1)
    assert.equal(ctx.slots.of('conversation.input.overlay').length, 1)
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    assert.equal(sources.length, 1, 'no second /context source')
    ctx.dispose()
  })

  test('a ledger seating foreign entries or a hostile ledger face fails open into a full mount', () => {
    const ctx = new TestClientCtx()
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'feedback' }, () => null)
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view').length, 2, 'the tabs register')
    assert.equal(ctx.slots.of('conversation.chat.assistant-actions').length, 2, 'the jump registers beside the foreign row')
    ctx.dispose()

    const hostile = new TestClientCtx()
    ;(hostile.slots as unknown as { entries: () => never }).entries = () => {
      throw new Error('boom')
    }
    applyTo(hostile)
    assert.equal(hostile.slots.of('conversation.view').length, 2)
    hostile.dispose()
  })
})

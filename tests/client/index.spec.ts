// Client entry (src/client/index.ts): the plugin's apply() wiring asserted
// through the faithful harness-context seams — dictionaries, slots, the
// /context trigger source, and the deferred settingsScope inject — plus real
// renders of the registered components.

import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { modalStoreOf, type ModalStore } from '../../src/client/modalStore'
import { h } from '../../src/client/react'
import type { SettingsField, SettingsScopeLike, SettingsState } from '../../src/client/settings'
import { TestClientCtx, TestSessions, asClientCtx } from './helpers/harness'
import { click, mount, query, queryAll } from './helpers/kit'

// The entry ships via `module.exports` (bundle handoff shape); its runtime
// exports are the plugin triple, opaque to the static import type.
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

describe('client entry: constants', () => {
  test('name and inject declare the plugin identity and hard dependencies', () => {
    assert.equal(name, 'dsh-context')
    assert.deepEqual(inject, ['slots', 'locale'])
  })
})

describe('client entry: dictionaries', () => {
  test('apply registers the real zh/en dicts; dispose removes them', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const dicts = ctx.locale.namespaces.get('dsh-context')
    assert.ok(dicts)
    assert.equal(dicts.zh, DICT_ZH)
    assert.equal(dicts.en, DICT_EN)
    // The bound translate resolves through the active-locale → en chain.
    assert.equal(ctx.locale.bind('dsh-context')('tab'), 'Context')
    ctx.dispose()
    assert.equal(ctx.locale.namespaces.has('dsh-context'), false)
  })

  test('the zh active locale binds the zh dictionary arm', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    applyTo(ctx)
    assert.equal(ctx.locale.bind('dsh-context')('tab'), '上下文')
    ctx.dispose()
  })
})

describe('client entry: conversation.view slot', () => {
  test('registers the Context tab whose label follows the locale and whose component renders', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.view')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.view')
    assert.equal(registration.id, 'context')
    assert.equal(registration.order, 20)
    assert.equal(registration.locale, 'dsh-context')
    assert.equal(registration.label?.(), 'Context')

    const el = component({ sessionId: 's1', useProjection: () => undefined }) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'ContextView')
    const m = await mount(el)
    assert.equal(query(m.container, '.lc-empty').textContent, 'Reading the session log…')
    await m.unmount()
    ctx.dispose()
  })

  test('the tab label translates to zh under an zh locale', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    applyTo(ctx)
    assert.equal(ctx.slots.of('conversation.view')[0].registration.label?.(), '上下文')
    ctx.dispose()
  })
})

describe('client entry: assistant-actions seat', () => {
  test('registers the chat→Context jump entry whose component renders the labelled icon button', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.chat.assistant-actions')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.chat.assistant-actions')
    assert.equal(registration.id, 'context-jump')
    assert.equal(registration.order, 20, 'right of the shipped feedback entry')
    assert.equal(registration.locale, 'dsh-context')

    const el = component({ messageId: 'm1' }) as ReactElement
    const m = await mount(el)
    assert.equal(query(m.container, 'button.lc-jump').getAttribute('aria-label'), 'View this turn in the Context tab')
    await m.unmount()

    // Interruption-frozen partials address no durable message: nothing renders.
    const nil = await mount(component({ messageId: 7 }) as ReactElement)
    assert.equal(queryAll(nil.container, 'button').length, 0)
    await nil.unmount()
    ctx.dispose()
  })
})

describe('client entry: composer dock seat', () => {
  test('registers the stats-line jump entry below the shipped stats row', async () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const entries = ctx.slots.of('conversation.composer.dock')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.composer.dock')
    assert.equal(registration.id, 'stats-jump')
    assert.equal(registration.order, 10, 'below the shipped stats entry (order 0)')
    assert.equal(registration.locale, 'dsh-context')

    // The entry renders only the invisible anchor: this bare mount has no
    // stats row beside it, so nothing gets decorated.
    const el = component({}) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'StatsJump')
    const m = await mount(el)
    assert.equal(queryAll(m.container, 'span.lc-stats-jump[hidden]').length, 1)
    assert.equal(queryAll(m.container, '.lc-stats-jump-row').length, 0)
    await m.unmount()
    ctx.dispose()
  })
})

describe('client entry: sessions scope seam', () => {
  test('absent sessions service: apply is a noop for the sessions seams', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    ctx.dispose()
  })

  test('sessions present: apply wires through and disposes cleanly', () => {
    const sessions = new TestSessions()
    const ctx = new TestClientCtx({ services: { sessions } })
    applyTo(ctx)
    ctx.dispose()
  })
})

describe('client entry: /context command effect', () => {
  test('absent inputTriggers service: no source, nothing thrown', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    ctx.dispose()
  })

  test('inputTriggers present: the source registers and dispose unregisters it', () => {
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
  test('registers the modal overlay; inject binds the per-session modal store; closed renders null', async () => {
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
    const m = await mount(el)
    assert.equal(m.container.textContent, '')
    await m.unmount()
    ctx.dispose()
  })
})

describe('client entry: settingsScope inject', () => {
  test('absent at apply time: the inject stays pending — no settings.plugin.item slot', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 0)
    ctx.dispose()
  })

  test('armed later: the pending inject runs — scope attached and card slot registered', () => {
    const ctx = new TestClientCtx()
    applyTo(ctx)
    const scope = makeScope({ status: 'ready', value: {}, writable: true })
    const specs: { namespace: string }[] = []
    ctx.setService('settingsScope', {
      bind: (spec: { namespace: string }) => {
        specs.push(spec)
        return scope
      },
    })
    assert.deepEqual(specs, [{ namespace: 'dsh-context' }])
    assert.equal(scope.subscribes, 1)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 1)
    ctx.dispose()
  })

  test('defensive arm: service key present but undefined — early return, no slot, no throw', () => {
    const ctx = new TestClientCtx()
    ctx.setService('settingsScope', undefined)
    applyTo(ctx)
    assert.equal(ctx.slots.of('settings.plugin.item').length, 0)
    ctx.dispose()
  })
})

describe('client entry: settings card slot', () => {
  function setup(): {
    ctx: TestClientCtx
    scope: ReturnType<typeof makeScope>
    registration: { name: string; key?: string; locale?: string; inject?: () => unknown }
    component: (props: Record<string, unknown>) => unknown
  } {
    const scope = makeScope({ status: 'loading', value: null, writable: false })
    const ctx = new TestClientCtx({
      services: { settingsScope: { bind: () => scope } },
    })
    applyTo(ctx)
    const entry = ctx.slots.of('settings.plugin.item')[0]
    return {
      ctx,
      scope,
      registration: entry.registration as never,
      component: entry.component as never,
    }
  }

  test('registers the keyed card; inject exposes the settings store and a set verb', () => {
    const { ctx, scope, registration } = setup()
    assert.equal(registration.name, 'settings.plugin.item')
    assert.equal(registration.key, 'dsh-context')
    assert.equal(registration.locale, 'dsh-context')

    const face = registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState } }
      set: (field: SettingsField, value: string) => void
    }
    assert.equal(face.hooks.contextSettings.getSnapshot().granularity, 'step')
    face.set('defaultGranularity', 'turn')
    assert.equal(face.hooks.contextSettings.getSnapshot().granularity, 'turn')
    assert.deepEqual(scope.sets, [{ field: 'defaultGranularity', value: 'turn' }])
    ctx.dispose()
  })

  test('the component renders the card DOM (loading status → disabled selects)', async () => {
    const { ctx, component } = setup()
    const el = component({}) as ReactElement
    assert.equal(typeof el.type, 'function')
    assert.equal((el.type as { name: string }).name, 'SettingsCard')
    const store = (ctx.slots.of('settings.plugin.item')[0].registration.inject?.() as {
      hooks: { contextSettings: { getSnapshot(): SettingsState } }
    }).hooks.contextSettings
    const m = await mount(h(el.type as never, {
      useContextSettings: <T,>(sel: (state: SettingsState) => T): T => sel(store.getSnapshot()),
    }))
    assert.ok(query(m.container, '.lc-settings-card'))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.equal(selects.length, 3)
    for (const s of selects) assert.ok((s as HTMLButtonElement).disabled)
    await m.unmount()
    ctx.dispose()
  })
})

describe('client entry: dispose', () => {
  test('a full apply unwinds dictionaries and the command source', () => {
    const sources: unknown[] = []
    const inputTriggers = {
      registerSource(src: unknown): () => void {
        sources.push(src)
        return () => {
          const i = sources.indexOf(src)
          if (i >= 0) sources.splice(i, 1)
        }
      },
    }
    const ctx = new TestClientCtx({ services: { inputTriggers } })
    applyTo(ctx)
    assert.ok(ctx.locale.namespaces.has('dsh-context'))
    assert.equal(sources.length, 1)
    ctx.dispose()
    assert.equal(ctx.locale.namespaces.has('dsh-context'), false)
    assert.equal(sources.length, 0)
  })
})

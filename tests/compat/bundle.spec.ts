import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, test } from 'vitest'
import { JSDOM } from 'jsdom'
import React from 'react'
import ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as staging from './staging'

describe.skipIf(staging.artifactsMissing())('bundle smoke — the built lib/client.js', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
  const globals = globalThis as { window?: unknown; document?: unknown }

  let handoff: { id: string; factory: (require: (spec: string) => unknown) => unknown } | null = null
  const state: {
    plugin?: { name: string; inject: string[]; apply(ctx: unknown): void }
    dicts: Map<string, Record<string, Record<string, string>>>
    slots: [string, { name?: string; order?: number; id?: string; label?: () => string; inject?: (sessionId?: string) => unknown }][]
    sources: { trigger: string }[]
    disposers: (() => void)[]
  } = { dicts: new Map(), slots: [], sources: [], disposers: [] }

  const styleTags = (): HTMLElement[] =>
    [...dom.window.document.head.querySelectorAll<HTMLElement>('style[data-plugin="dsh-context"]')]

  beforeAll(() => {
    globals.window = dom.window
    globals.document = dom.window.document

    const inert = (name: string) => {
      const C = (): null => null
      ;(C as { displayName?: string }).displayName = name
      return C
    }
    const moduleTable = (spec: string): unknown => {
      if (spec === 'react') return React
      if (spec === 'react/jsx-runtime') return jsxRuntime
      if (spec === 'react-dom') return ReactDOM
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
        return new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? inert(key) : undefined) })
      }
      throw new Error(`bundle required a non-platform module: ${spec}`)
    }

    ;(dom.window as { __ModuleLoader__: unknown }).__ModuleLoader__ = { load: (h: typeof handoff) => { handoff = h } }
    new Function(readFileSync(join(staging.REPO, 'lib', 'client.js'), 'utf8'))()
    assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')

    const removeFrom = <T,>(list: T[]) => (item: T) => () => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
    }
    const ctx: Record<string, unknown> = {
      get(name: string) {
        if (name === 'inputTriggers') return { registerSource: (s: { trigger: string }) => { state.sources.push(s); return removeFrom(state.sources)(s) } }
        if (name === 'sessions') return { scope: () => undefined }
        return undefined
      },
      inject(_deps: string[], cb: (c: unknown) => void) {
        cb(ctx)
      },
      effect(fn: () => (() => void) | void) {
        const d = typeof fn === 'function' ? fn() : undefined
        if (typeof d === 'function') state.disposers.push(d)
        return d
      },
      locale: {
        register: (ns: string, d: Record<string, Record<string, string>>) => { state.dicts.set(ns, d); return () => state.dicts.delete(ns) },
        bind: (ns: string) => (key: string, vars?: Record<string, string | number>) => {
          let s = state.dicts.get(ns)?.zh[key] ?? key
          if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
          return s
        },
      },
      slots: {
        inject: (_name: string, fn: () => unknown) => fn(),
        register: (opts: (typeof state.slots)[number][1]) => {
          state.slots.push([opts.name ?? '', opts])
          return () => {
            const i = state.slots.findIndex(entry => entry[1] === opts)
            if (i >= 0) state.slots.splice(i, 1)
          }
        },
      },
    }
    state.plugin = handoff.factory(moduleTable) as typeof state.plugin
    state.plugin.apply(ctx)
  })

  test('handoff: the bundle registers as dsh-context with the factory closure', () => {
    assert.ok(handoff !== null, 'bundle must register through __ModuleLoader__.load')
    assert.equal(handoff.id, 'dsh-context', 'handoff id is the package name')
    assert.equal(state.plugin?.name, 'dsh-context')
    assert.deepEqual(state.plugin?.inject, ['slots', 'locale'])
  })

  test('CSS channel: plugin-owned style tags, one per sheet, minified', () => {
    assert.ok(styleTags().length > 1, 'plugin-owned <style data-plugin> tags injected at factory execution')
    const tagIds = styleTags().map(tag => tag.dataset.pluginCss)
    assert.ok(tagIds.every(id => typeof id === 'string' && id.startsWith('dsh-context/')), 'official data-plugin-css tag ids')
    assert.equal(new Set(tagIds).size, tagIds.length, 'one tag per stylesheet, no duplicate tag ids')
    const css = styleTags().map(tag => tag.textContent).join('\n')
    for (const marker of ['.lc-root', '.lc-br-elem-row', '.lc-stacked-seg', '.lc-bar-tip-on', '.lc-stat-tip', '.lc-occupied-box-on']) {
      assert.ok(css.includes(marker), `styles carry ${marker}`)
    }
    assert.ok(!css.includes('120ms ease'), 'lightningcss minified the sheet')
  })

  test('command lists chain their scrolling to the page', () => {
    const css = styleTags().map(tag => tag.textContent).join('\n')
    for (const selector of ['.lc-cmd-list', '.lc-cmd-progs-list']) {
      assert.ok(css.includes(selector + '{'), `styles carry a ${selector} rule`)
      const contained = new RegExp(selector.replaceAll('.', '\\.') + '[^{}]*\\{[^{}]*overscroll-behavior')
      assert.ok(!contained.test(css), `${selector} does not contain its scrolling`)
    }
  })

  test('registrations: bilingual dictionaries, six slots, the /context trigger source', () => {
    assert.ok(state.dicts.get('dsh-context')?.zh && state.dicts.get('dsh-context')?.en, 'bilingual dictionaries registered')
    assert.equal(state.slots.length, 6, 'view tabs + assistant action + input overlay + insight page and sidebar entry slots')
    assert.equal(state.slots[0]?.[0], 'conversation.view')
    assert.equal(state.slots[0]?.[1].order, 20)
    assert.equal(state.slots[0]?.[1].label?.(), '上下文', 'tab label localized')
    assert.equal(state.slots[1]?.[0], 'conversation.view')
    assert.equal(state.slots[1]?.[1].order, 30, 'the Fleet tab follows the Context tab')
    assert.equal(state.slots[1]?.[1].label?.(), '编队', 'fleet tab label localized')
    assert.equal(state.slots[2]?.[0], 'conversation.chat.assistant-actions')
    assert.equal(state.slots[2]?.[1].id, 'context-jump', 'jump action rides its own slot id')
    assert.equal(state.slots[3]?.[0], 'conversation.input.overlay')
    const overlayInject = state.slots[3]?.[1].inject
    const overlayHooks = overlayInject?.('s1') as { hooks: { contextModal: { getSnapshot: unknown } } } | undefined
    assert.equal(typeof overlayHooks?.hooks.contextModal.getSnapshot, 'function', 'overlay hooks carry the modal store')
    assert.equal(state.slots[4]?.[0], 'main', 'the insight page rides the layout\'s keyed main seat')
    assert.equal(state.slots[4]?.[1].key, 'dsh-context', 'the page panel key is the plugin id')
    assert.equal(state.slots[5]?.[0], 'sidebar.panellist', 'the insight entry rides the sidebar panel list')
    assert.equal(state.slots[5]?.[1].id, 'dsh-context', 'the entry id addresses the main panel')
    assert.equal(state.slots[5]?.[1].label?.(), '上下文洞察', 'the entry label localized')
    assert.equal(state.sources.length, 1, '/context trigger source registered')
    assert.equal(state.sources[0]?.trigger, '/', 'trigger is the slash')
  })

  test('HMR safety: fiber dispose removes every registration; the style tags survive it', () => {
    for (const d of state.disposers) d()
    assert.equal(state.dicts.size, 0, 'dictionaries unregistered on dispose')
    assert.equal(state.sources.length, 0, 'trigger source removed on dispose')
    assert.ok(styleTags().length > 0, 'style tags survive fiber dispose (the HMR receiver claims them)')
  })
})

// @vitest-environment jsdom
import assert from 'node:assert/strict'
import * as React from 'react'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Config, DEFAULT_BOUNDS } from '../../src/host/config'
import { apply, inject, name } from '../../src/host/index'
import { watchTerminal } from '../../src/host/terminal'
import type { CommandDefinition, PanelDescriptor, SceneProps } from '../../src/tui/hostTypes'
import { COMMAND_NAMES, PANEL_ID, SCENE_ID, mountTerminal, type TerminalOptions } from '../../src/tui/mount'
import { captureLogs, until } from '../host/helpers/backfill'
import { fakeHost, fakeWatch, panelUi, pressPanel, render, sceneUi, settle, textOf, timelineFixture, type InputHolder } from './helpers'

interface Rig {
  panels: { descriptor: PanelDescriptor; disposed: boolean }[]
  scenes: { descriptor: { id: string; component: (props: SceneProps) => unknown }; disposed: boolean }[]
  opens: [string, unknown][]
  commands: { definition: CommandDefinition; via: 'host' | 'plain'; disposed: boolean }[]
}

function services(rig: Rig, opts: { hostCommands?: 'ok' | 'throw' | 'absent'; plainThrows?: boolean; sceneThrows?: boolean; panelRejects?: boolean; openResult?: boolean } = {}) {
  const sessionData = { watchProjection: (key: string) => fakeWatch(key === 'contextTimeline' ? timelineFixture() : null) }
  const tuiPanels = {
    register: (descriptor: PanelDescriptor) => {
      if (opts.panelRejects === true) return undefined
      const entry = { descriptor, disposed: false }
      rig.panels.push(entry)
      return () => { entry.disposed = true }
    },
  }
  const tuiScenes = {
    register: (descriptor: Rig['scenes'][number]['descriptor']) => {
      if (opts.sceneThrows === true) throw new Error('duplicate scene')
      const entry = { descriptor, disposed: false }
      rig.scenes.push(entry)
      return () => { entry.disposed = true }
    },
    open: (id: string, params?: unknown) => {
      rig.opens.push([id, params])
      return opts.openResult ?? true
    },
  }
  const plain = (via: 'host' | 'plain') => (definition: CommandDefinition) => {
    if (via === 'plain' && opts.plainThrows === true) throw new Error('duplicate command')
    const entry = { definition, via, disposed: false }
    rig.commands.push(entry)
    return () => { entry.disposed = true }
  }
  const tuiPluginHost = opts.hostCommands === 'absent' ? {} : {
    registerCommand: (_ctx: unknown, definition: CommandDefinition) => {
      if (opts.hostCommands === 'throw') throw new Error('COMPONENT_NOT_ADMITTED')
      return plain('host')(definition)
    },
  }
  return { sessionData, tuiPanels, tuiScenes, commands: { register: plain('plain') }, tuiPluginHost }
}

const options: TerminalOptions = { bounds: DEFAULT_BOUNDS, preferences: () => ({ granularity: 'step', fileSort: 'count' }) }

async function boot(opts: Parameters<typeof services>[1] = {}) {
  const rig: Rig = { panels: [], scenes: [], opens: [], commands: [] }
  const ctx = new Context()
  const logs = captureLogs(ctx)
  const s = services(rig, opts)
  ctx.provide('tuiSessionData', s.sessionData)
  const scenesOff = ctx.provide('tuiScenes', s.tuiScenes)
  ctx.provide('tuiPanels', s.tuiPanels)
  ctx.provide('commands', s.commands)
  ctx.provide('tuiPluginHost', s.tuiPluginHost)
  const fiber = await ctx.plugin({
    name: 'dsh-context',
    apply: (owner: Context) => {
      owner.inject(['tuiSessionData'], (scope) => { mountTerminal(owner, scope, options) })
    },
  })
  await settle()
  return { ctx, rig, logs, fiber, scenesOff }
}

describe('mountTerminal', () => {
  test('registers the panel, the scene and the attributed command, all released with the plugin', async () => {
    const { rig, fiber } = await boot({ hostCommands: 'ok' })
    assert.equal(rig.panels.length, 1)
    const panel = rig.panels[0].descriptor
    assert.deepEqual([panel.apiVersion, panel.id, panel.title, panel.icon, panel.minColumns, panel.compact?.maxRows], [1, PANEL_ID, 'Context', '◔', 28, 1])
    assert.equal(rig.scenes[0].descriptor.id, SCENE_ID)
    assert.deepEqual(rig.commands.map(c => [c.definition.name, c.via]), [['context', 'host'], ['ctx', 'host']])
    assert.deepEqual([...COMMAND_NAMES], ['context', 'ctx'])
    await fiber.dispose()
    assert.ok(rig.panels[0].disposed && rig.scenes[0].disposed && rig.commands.every(c => c.disposed))
  })

  test('the command opens the scene on the asked tab; a refused open is an error', async () => {
    const { rig } = await boot()
    const handler = rig.commands[0].definition.handler
    assert.deepEqual(handler({ rawInput: ' trend' }), { kind: 'success' })
    assert.deepEqual(rig.opens, [[SCENE_ID, { tab: 'trend' }]])
    handler({ rawInput: '' })
    assert.deepEqual(rig.opens[1], [SCENE_ID, undefined])
    assert.deepEqual(rig.commands[1].definition.handler({ rawInput: 'events' }), { kind: 'success' }, '/ctx is the same command')
    assert.deepEqual(rig.opens[2], [SCENE_ID, { tab: 'events' }])
    const Scene = rig.scenes[0].descriptor.component as never
    const input: InputHolder = {}
    const props = { React, ui: sceneUi(input, { columns: 80, rows: 20 }), close: () => {} }
    handler({ rawInput: 'files' })
    const first = await render(React.createElement(Scene, props))
    assert.ok(textOf(first.container).includes('File Activity'), 'the scene opens on the requested tab')
    await first.unmount()
    handler({ rawInput: '' })
    const again = await render(React.createElement(Scene, props))
    assert.ok(!textOf(again.container).includes('File Activity'), 'every opening states its own tab')
    await again.unmount()
    const refused = await boot({ openResult: false })
    assert.deepEqual(refused.rig.commands[0].definition.handler({ rawInput: '' }), { kind: 'error', text: 'dsh-context: the context scene could not open' })
  })

  test('the panel opens the scene through the same opener, which leaves with the scene service', async () => {
    const { rig, scenesOff } = await boot()
    const host = fakeHost({ lang: 'en' })
    const view = await render(React.createElement(rig.panels[0].descriptor.component as never, { React, ui: panelUi, host, width: 40, height: 20, focused: true }))
    await pressPanel(host, '', { return_: true })
    assert.deepEqual(rig.opens, [[SCENE_ID, undefined]])
    await scenesOff()
    await settle()
    assert.equal(rig.scenes[0].disposed, true)
    assert.ok(rig.commands.every(c => c.disposed))
    await pressPanel(host, '', { return_: true })
    assert.equal(rig.opens.length, 1, 'no scene service, nothing to open')
    await view.unmount()
  })

  test('an unadmitted plugin falls back to the plain registry; a refused plain registration only warns', async () => {
    const fallback = await boot({ hostCommands: 'throw' })
    assert.deepEqual(fallback.rig.commands.map(c => c.via), ['plain', 'plain'])
    assert.ok(fallback.logs.some(l => l.text.includes('/context is not attributed (Error: COMPONENT_NOT_ADMITTED)')))
    const noHost = await boot({ hostCommands: 'absent' })
    assert.deepEqual(noHost.rig.commands.map(c => c.via), ['plain', 'plain'])
    const refused = await boot({ hostCommands: 'absent', plainThrows: true })
    assert.equal(refused.rig.commands.length, 0)
    assert.ok(refused.logs.some(l => l.text.includes('/context is not registered (Error: duplicate command)')))
  })

  test('a refused scene registers no command; a refused panel is simply absent', async () => {
    const { rig, logs } = await boot({ sceneThrows: true, panelRejects: true })
    assert.deepEqual([rig.scenes.length, rig.commands.length, rig.panels.length], [0, 0, 0])
    assert.ok(logs.some(l => l.text.includes('the context scene is not registered (Error: duplicate scene)')))
  })

  test('no usable session-data face: nothing registers, one warning', async () => {
    for (const face of [{}, { watchProjection: () => undefined }]) {
      const ctx = new Context()
      const logs = captureLogs(ctx)
      const registered: unknown[] = []
      ctx.provide('tuiSessionData', face)
      ctx.provide('tuiPanels', { register: (d: unknown) => { registered.push(d); return () => {} } })
      await ctx.plugin({ name: 'dsh-context', apply: (owner: Context) => { owner.inject(['tuiSessionData'], (scope) => { mountTerminal(owner, scope, options) }) } })
      await settle()
      assert.equal(registered.length, 0)
      assert.ok(logs.some(l => l.text.includes('the terminal surfaces need tuiSessionData.watchProjection')))
    }
  })
})

describe('watchTerminal (the host half)', () => {
  test('the terminal module loads only once a dsh-TUI session-data service exists, reading the preferences live', async () => {
    const ctx = new Context()
    const calls: [unknown, unknown, TerminalOptions][] = []
    let loads = 0
    const load = () => {
      loads++
      return Promise.resolve({ mountTerminal: (owner: unknown, scope: unknown, opts: TerminalOptions) => { calls.push([owner, scope, opts]) } } as never)
    }
    // The loader hands apply the RESOLVED config, whose volatile preferences are live `{ get }` references.
    const configs: Config[] = [{}, { defaultGranularity: 'turn', defaultFileSort: 'path', maxEvents: 9 }, Config({ defaultGranularity: 'turn', defaultFileSort: 'lines' })]
    for (const config of configs) await ctx.plugin({ name: 'dsh-context', apply: (c: Context) => { watchTerminal(c, config, load) } })
    await settle()
    assert.equal(loads, 0, 'a web deployment never imports the terminal half')
    ctx.provide('tuiSessionData', { watchProjection: () => undefined })
    await until(() => (calls.length === 3 ? true : undefined), 'every activation mounted')
    assert.equal(loads, 3)
    assert.deepEqual(calls[0][2].bounds, DEFAULT_BOUNDS)
    assert.deepEqual(calls[0][2].preferences(), { granularity: undefined, fileSort: undefined })
    assert.deepEqual(calls[1][2].bounds, { ...DEFAULT_BOUNDS, maxEvents: 9 })
    assert.deepEqual(calls[1][2].preferences(), { granularity: 'turn', fileSort: 'path' })
    assert.deepEqual(calls[2][2].preferences(), { granularity: 'turn', fileSort: 'lines' }, 'read through the live references')
    assert.notEqual(calls[0][0], calls[0][1], 'registrations ride the plugin context, lifetimes the deferred scope')
  })

  test('the real plugin composes the terminal half end to end', async () => {
    const rig: Rig = { panels: [], scenes: [], opens: [], commands: [] }
    const ctx = new Context()
    const s = services(rig)
    ctx.provide('tuiSessionData', s.sessionData)
    ctx.provide('tuiPanels', s.tuiPanels)
    ctx.provide('tuiScenes', s.tuiScenes)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin({ name, inject, apply } as never, {} as never)
    await until(() => (rig.panels.length === 1 && rig.scenes.length === 1 ? true : undefined), 'the panel and the scene registered')
  })
})

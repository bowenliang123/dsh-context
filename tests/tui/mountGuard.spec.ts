// dsh-TUI admits a service call only from the activation that is executing: a call made while one plugin callback runs
// but through another activation's context (e.g. the parent plugin's) is refused as stale (dsh-TUI
// src/dsh-adapter/host-access.ts, `assertLiveContext`), and the mediated `tuiPluginHost.registerCommand(ctx, …)` holds
// the context it is handed to the same rule (src/dsh-adapter/plugin-host.ts, `assertActivationContext`). These fakes
// enforce both on a real cordis composition the way dsh-TUI does: the executing fiber rides an AsyncLocalStorage set
// around each plugin callback.

import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest'
import { Context, Fiber, Service } from '@deepseek-ai/cordis'
import { DEFAULT_BOUNDS } from '../../src/host/config'
import type { CommandDefinition } from '../../src/tui/hostTypes'
import { mountTerminal } from '../../src/tui/mount'
import { fakeWatch, settle, timelineFixture } from './helpers'

const executing = new AsyncLocalStorage<object>()
type Runner = { execute: (...args: unknown[]) => unknown }
const prototype = Fiber.prototype as unknown as { _execute: (this: { _runner?: unknown }, runner: Runner) => unknown }
const original = prototype._execute

beforeAll(() => {
  prototype._execute = function (runner) {
    if (runner !== this._runner) return original.call(this, runner)
    const fiber = this as object
    const execute = runner.execute
    return original.call(this, { ...runner, execute(this: unknown, ...args: unknown[]) {
      return executing.run(fiber, () => execute.apply(this, args))
    } } as Runner)
  }
})

afterAll(() => {
  prototype._execute = original
})

let refused: string[] = []
let registered: string[] = []

beforeEach(() => {
  refused = []
  registered = []
})

function admit(fiber: unknown, capability: string): void {
  const running = executing.getStore()
  if (running !== undefined && running !== fiber) {
    refused.push(capability)
    throw new Error(`refused: ${capability} called through another activation`)
  }
}

/** A host service that refuses a call made through a context whose fiber is not the one executing. */
class Guarded extends Service {
  protected guard(capability: string): void {
    admit(this.ctx.fiber, capability)
  }
}

class Panels extends Guarded {
  constructor(ctx: Context) { super(ctx, 'tuiPanels') }
  register(descriptor: { id: string }): () => void {
    this.guard('tuiPanels.register')
    registered.push(`panel:${descriptor.id}`)
    return () => {}
  }
}

class Scenes extends Guarded {
  constructor(ctx: Context) { super(ctx, 'tuiScenes') }
  register(descriptor: { id: string }): () => void {
    this.guard('tuiScenes.register')
    registered.push(`scene:${descriptor.id}`)
    return () => {}
  }
}

class Commands extends Guarded {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: CommandDefinition): () => void {
    this.guard('commands.register')
    registered.push(`command:${definition.name}`)
    return () => {}
  }
}

class PluginHost extends Guarded {
  constructor(ctx: Context) { super(ctx, 'tuiPluginHost') }
  registerCommand(pluginCtx: Context, definition: CommandDefinition): () => void {
    this.guard('tuiPluginHost.registerCommand')
    admit(pluginCtx.fiber, 'tuiPluginHost.registerCommand(pluginCtx)')
    registered.push(`host-command:${definition.name}`)
    return () => {}
  }
}

class SessionData extends Guarded {
  constructor(ctx: Context) { super(ctx, 'tuiSessionData') }
  watchProjection(key: string): ReturnType<typeof fakeWatch> {
    this.guard('tuiSessionData.watchProjection')
    return fakeWatch(key === 'contextTimeline' ? timelineFixture() : null)
  }
}

async function mount(services: (typeof SessionData | typeof Panels | typeof Scenes | typeof Commands | typeof PluginHost)[]): Promise<void> {
  const ctx = new Context()
  for (const plugin of services) await ctx.plugin(plugin)
  await ctx.plugin({
    name: 'dsh-context',
    apply: (owner: Context) => {
      owner.inject(['tuiSessionData'], (scope) => {
        mountTerminal(owner, scope, { bounds: DEFAULT_BOUNDS, preferences: () => ({}) })
      })
    },
  })
  await settle()
}

describe('registration under dsh-TUI\'s executing-activation guard', () => {
  test('every surface registers through the activation that is running', async () => {
    await mount([SessionData, Panels, Scenes, Commands])
    assert.deepEqual(refused, [])
    assert.deepEqual(registered.sort(), ['command:context', 'command:ctx', 'panel:context', 'scene:dsh-context'])
  })

  test('the mediated command path is handed the running activation too', async () => {
    await mount([SessionData, Panels, Scenes, Commands, PluginHost])
    assert.deepEqual(refused, [])
    assert.deepEqual(registered.sort(), ['host-command:context', 'host-command:ctx', 'panel:context', 'scene:dsh-context'])
  })
})

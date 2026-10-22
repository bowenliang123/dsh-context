/** Registration on a dsh-TUI host. dsh-TUI admits a service call only from the activation that is executing, so each
 * registration goes through the context of the deferred inject it runs in; those nested fibers inherit the plugin's verified
 * Component identity (dsh-plugin.json), keeping the `dsh-context:` ids. */

import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from '../host/config'
import type { CommandDefinition, CommandsService, PanelsService, PluginHostService, ScenesService, SessionDataService } from './hostTypes'
import { createContextCompact, createContextPanel } from './panel'
import { createContextScene, sceneTabOf, type SceneDeps, type SceneTab } from './scene'
import { createContextSource, createDetailReader, type ContextSource } from './source'

/** The host prefixes panel ids with the component id; scene ids are global, hence the plugin-named scene. */
export const PANEL_ID = 'context'
export const SCENE_ID = 'dsh-context'
/** The manifest's commands: dsh-TUI's built-in `/context` shadows the first (reached as `/dsh-context:context`), `/ctx` runs bare. */
export const COMMAND_NAMES = ['context', 'ctx'] as const

export interface TerminalOptions {
  bounds: FoldBounds
  /** The stored display preferences, read live (dsh-TUI edits them in /settings without a remount). */
  preferences: SceneDeps['defaults']
}

/** Watches are taken through `scope`, so they release when the session-data service leaves. */
export function sourceOf(owner: Context, scope: Context, bounds: FoldBounds): ContextSource | undefined {
  const service = scope.get('tuiSessionData', false) as SessionDataService | undefined
  if (typeof service?.watchProjection !== 'function') return undefined
  const timeline = service.watchProjection('contextTimeline')
  if (timeline === undefined) return undefined
  return createContextSource(timeline, service.watchProjection('contextHeaders'), createDetailReader(owner, bounds))
}

/** The mediated path attributes the command to the admitted Component; a host without it still has the plain registry. */
function registerCommand(ctx: Context, definition: CommandDefinition): (() => void) | undefined {
  const host = ctx.get('tuiPluginHost', false) as PluginHostService | undefined
  if (typeof host?.registerCommand === 'function') {
    try {
      return host.registerCommand(ctx, definition)
    } catch (error) {
      ctx.logger.warn(`dsh-context: /${definition.name} is not attributed (${String(error)})`)
    }
  }
  try {
    return (ctx.get('commands') as CommandsService).register(definition)
  } catch (error) {
    ctx.logger.warn(`dsh-context: /${definition.name} is not registered (${String(error)})`)
    return undefined
  }
}

export function mountTerminal(owner: Context, scope: Context, options: TerminalOptions): void {
  const source = sourceOf(owner, scope, options.bounds)
  if (source === undefined) {
    owner.logger.warn('dsh-context: the terminal surfaces need tuiSessionData.watchProjection')
    return
  }
  let opening: { tab?: SceneTab; serial: number } = { serial: 0 }
  let opener: ((tab?: SceneTab) => boolean) | undefined

  scope.inject(['tuiScenes'], (c) => {
    const scenes = c.get('tuiScenes') as ScenesService
    const component = createContextScene({
      source,
      defaults: options.preferences,
      opening: () => opening,
    })
    let dispose: () => void
    try {
      dispose = scenes.register({ id: SCENE_ID, title: 'Context', component })
    } catch (error) {
      c.logger.warn(`dsh-context: the context scene is not registered (${String(error)})`)
      return
    }
    const open = (tab?: SceneTab): boolean => {
      opening = { serial: opening.serial + 1, ...(tab !== undefined ? { tab } : {}) }
      return scenes.open(SCENE_ID, tab === undefined ? undefined : { tab })
    }
    opener = open
    c.effect(() => () => {
      opener = undefined
      dispose()
    }, 'dsh-context: terminal scene')
    c.inject(['commands'], (cc) => {
      for (const name of COMMAND_NAMES) {
        const release = registerCommand(cc, {
          name,
          description: 'Open the context dashboard (tabs: overview, trend, browser, events, files)',
          handler: ({ rawInput }) => open(sceneTabOf(rawInput))
            ? { kind: 'success' }
            : { kind: 'error', text: 'dsh-context: the context scene could not open' },
        })
        if (release !== undefined) cc.effect(() => release, `dsh-context: /${name}`)
      }
    })
  })

  scope.inject(['tuiPanels'], (c) => {
    const dispose = (c.get('tuiPanels') as PanelsService).register({
      apiVersion: 1,
      id: PANEL_ID,
      title: 'Context',
      icon: '◔',
      minColumns: 28,
      component: createContextPanel({ source, openScene: tab => opener?.(tab) ?? false }),
      compact: { maxRows: 1, component: createContextCompact(source) },
    })
    if (dispose !== undefined) c.effect(() => dispose, 'dsh-context: terminal panel')
  })
}

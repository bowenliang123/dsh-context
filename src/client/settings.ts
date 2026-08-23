/**
 * The plugin's user-settings binding (browser half). The Host-served
 * `dsh-context` namespace carries per-user display preferences; the Context
 * tab reads the default trend granularity at mount, and the Plugin
 * configuration card (Settings → Plugins) writes it through the settings
 * scope. Both degrade to the schema default when the settings surface is
 * absent (older host) or read-only (remote browser in memory mode).
 *
 * The scope faces are minimally re-typed here (the services.ts discipline):
 * the runtime service comes from the user's harness, and type-only imports
 * of the contract package would still be erased — spelling the consumed
 * members keeps the dependency graph honest.
 */

export type DefaultGranularity = 'step' | 'turn'

/** The bound settings scope (ctx.settingsScope.bind result), as consumed. */
export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The ctx.settingsScope binder face, as consumed. */
export interface SettingsScopeBinderFace {
  bind(spec: { namespace: string }): SettingsScopeLike
}

/** The preference snapshot the card renders and the view reads at mount. */
export interface SettingsState {
  /** Scope sync: loading until the first Host section, unavailable when unserved. */
  status: 'loading' | 'ready' | 'unavailable'
  granularity: DefaultGranularity
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store, bound onto card props as `useContextSettings`. */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  /** The granularity a freshly mounted view opens with. */
  defaultGranularity(): DefaultGranularity
  /** Attach the bound namespace scope; returns the subscription disposer. */
  attach(scope: SettingsScopeLike): () => void
  /** Persist one granularity choice (local echo, then the fenced scope write). */
  choose(granularity: DefaultGranularity): void
}

function granularityOf(value: unknown): DefaultGranularity | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const g = (value as { defaultGranularity?: unknown }).defaultGranularity
  return g === 'step' || g === 'turn' ? g : undefined
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', granularity: 'step', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.granularity === state.granularity && next.writable === state.writable) return
    state = next
    for (const listener of listeners) listener()
  }
  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    defaultGranularity: () => state.granularity,
    attach(bound) {
      scope = bound
      const sync = (): void => {
        const snap = bound.getSnapshot()
        publish({
          status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
          // A section without the field (older Host half) keeps the default.
          granularity: granularityOf(snap.value) ?? state.granularity,
          writable: snap.writable,
        })
      }
      sync()
      return bound.subscribe(sync)
    },
    choose(granularity) {
      publish({ ...state, granularity })
      void scope?.set('defaultGranularity', granularity)
    },
  }
}

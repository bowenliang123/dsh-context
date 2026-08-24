/**
 * The plugin's user-settings binding (browser half). The Host-served
 * `dsh-context` namespace carries per-user display preferences; the Context
 * tab reads them at mount, and the Plugin configuration card (Settings →
 * Plugins) writes them through the settings scope. Both degrade to the
 * schema defaults when the settings surface is absent (older host) or
 * read-only (remote browser in memory mode).
 *
 * The scope faces are minimally re-typed here (the services.ts discipline):
 * the runtime service comes from the user's harness, and type-only imports
 * of the contract package would still be erased — spelling the consumed
 * members keeps the dependency graph honest.
 */

export type DefaultGranularity = 'step' | 'turn'
export type DefaultTrendMode = 'total' | 'delta'

/** The section fields the card edits, as the Host schema names them. */
export type SettingsField = 'defaultGranularity' | 'defaultTrendMode'

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
  mode: DefaultTrendMode
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store, bound onto card props as `useContextSettings`. */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  attach(scope: SettingsScopeLike): () => void
  /** Persist one preference choice (local echo, then the fenced scope write). */
  set(field: SettingsField, value: string): void
}

function prefsOf(value: unknown): { granularity?: DefaultGranularity; mode?: DefaultTrendMode } {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', granularity: 'step', mode: 'total', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.granularity === state.granularity
      && next.mode === state.mode && next.writable === state.writable) return
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
    defaultTrendMode: () => state.mode,
    attach(bound) {
      scope = bound
      const sync = (): void => {
        const snap = bound.getSnapshot()
        const prefs = prefsOf(snap.value)
        publish({
          status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
          // A section without the field (older Host half) keeps the default.
          granularity: prefs.granularity ?? state.granularity,
          mode: prefs.mode ?? state.mode,
          writable: snap.writable,
        })
      }
      sync()
      return bound.subscribe(sync)
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      void scope?.set(field, value)
    },
  }
}

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

import type { DefaultFileSort, DefaultGranularity, DefaultTrendMode, SettingsField } from '../shared/types'

// The preference vocabulary is declared once in shared/types.ts; re-exported
// here so client-side consumers keep their canonical import path.
export type { DefaultFileSort, DefaultGranularity, DefaultTrendMode, SettingsField } from '../shared/types'

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
  fileSort: DefaultFileSort
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store, bound onto card props as `useContextSettings`. */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  defaultFileSort(): DefaultFileSort
  attach(scope: SettingsScopeLike): () => void
  /** Persist one preference choice (local echo, then the fenced scope write). */
  set(field: SettingsField, value: string): void
}

function prefsOf(value: unknown): { granularity?: DefaultGranularity; mode?: DefaultTrendMode; fileSort?: DefaultFileSort } {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' ? { fileSort: v.defaultFileSort } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', granularity: 'step', mode: 'total', fileSort: 'count', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.granularity === state.granularity
      && next.mode === state.mode && next.fileSort === state.fileSort && next.writable === state.writable) return
    state = next
    for (const listener of listeners) listener()
  }
  // Republish from the bound scope's current snapshot; the attach sync and
  // the failed-write rollback share this one read.
  const sync = (bound: SettingsScopeLike): void => {
    const snap = bound.getSnapshot()
    const prefs = prefsOf(snap.value)
    publish({
      status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
      // A section without the field (older Host half) keeps the default.
      granularity: prefs.granularity ?? state.granularity,
      mode: prefs.mode ?? state.mode,
      fileSort: prefs.fileSort ?? state.fileSort,
      writable: snap.writable,
    })
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
    defaultFileSort: () => state.fileSort,
    attach(bound) {
      scope = bound
      sync(bound)
      return bound.subscribe(() => { sync(bound) })
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      // The scope write settles asynchronously and its promise REJECTS on a
      // transport failure (dsh keeps only its internal queue tail fulfilled)
      // — never let it float unhandled. Roll the optimistic echo back to the
      // scope's truth; a refused (non-2xx) write needs nothing here, the
      // scope's own recovery re-reads the Host and republishes via subscribe.
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => { sync(bound) })
    },
  }
}

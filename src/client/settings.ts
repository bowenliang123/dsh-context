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

import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

// The preference vocabulary is declared once in shared/types.ts; re-exported
// here so client-side consumers keep their canonical import path.
export type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

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

/**
 * The ctx.configForms service face (the Config-form generation's settings
 * transport), as consumed: forms bind per namespace, and `whileServed` keeps
 * a registration alive while the Host serves any of them. The bound form
 * satisfies {@link SettingsScopeLike} (same snapshot/subscribe/set shape).
 */
export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

/** The preference snapshot the card renders and the view reads at mount. */
export interface SettingsState {
  /** Scope sync: loading until the first Host section, unavailable when unserved. */
  status: 'loading' | 'ready' | 'unavailable'
  placement: DefaultPlacement
  granularity: DefaultGranularity
  mode: DefaultTrendMode
  deltaBase: DefaultDeltaBase
  toolSort: DefaultToolSort
  fileSort: DefaultFileSort
  insightsEntry: InsightsEntry
  durationCurve: DefaultDurationCurve
  writable: boolean
}

export interface ContextSettings {
  /** Observable snapshot store, bound onto card props as `useContextSettings`. */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  defaultPlacement(): DefaultPlacement
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  defaultDeltaBase(): DefaultDeltaBase
  defaultToolSort(): DefaultToolSort
  defaultFileSort(): DefaultFileSort
  insightsEntry(): InsightsEntry
  defaultDurationCurve(): DefaultDurationCurve
  attach(scope: SettingsScopeLike): () => void
  /** Persist one preference choice (local echo, then the fenced scope write). */
  set(field: SettingsField, value: string): void
}

type Prefs = {
  placement?: DefaultPlacement
  granularity?: DefaultGranularity
  mode?: DefaultTrendMode
  deltaBase?: DefaultDeltaBase
  toolSort?: DefaultToolSort
  fileSort?: DefaultFileSort
  insightsEntry?: InsightsEntry
  durationCurve?: DefaultDurationCurve
}

function prefsOf(value: unknown): Prefs {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultPlacement === 'all' || v.defaultPlacement === 'tab' || v.defaultPlacement === 'sidebar' ? { placement: v.defaultPlacement } : {}),
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultDeltaBase === 'step' || v.defaultDeltaBase === 'turn' ? { deltaBase: v.defaultDeltaBase } : {}),
    ...(v.defaultToolSort === 'size' || v.defaultToolSort === 'count' || v.defaultToolSort === 'name' ? { toolSort: v.defaultToolSort } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' ? { fileSort: v.defaultFileSort } : {}),
    ...(v.insightsEntry === 'show' || v.insightsEntry === 'hide' ? { insightsEntry: v.insightsEntry } : {}),
    ...(v.defaultDurationCurve === 'show' || v.defaultDurationCurve === 'hide' ? { durationCurve: v.defaultDurationCurve } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.placement === state.placement && next.granularity === state.granularity
      && next.mode === state.mode && next.deltaBase === state.deltaBase && next.toolSort === state.toolSort
      && next.fileSort === state.fileSort && next.insightsEntry === state.insightsEntry && next.durationCurve === state.durationCurve
      && next.writable === state.writable) return
    state = next
    for (const listener of listeners) listener()
  }
  // Republish from the bound scope's current snapshot; the attach sync and
  // the failed-write rollback share this one read. Returns the scope's valid
  // placement and insights entry, if it carries them.
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry } => {
    const snap = bound.getSnapshot()
    const prefs = prefsOf(snap.value)
    // Fail open: a config problem must never leave an entry hidden. A valid
    // value wins; one the plugin cannot understand degrades to the field's
    // default; a section without the field (older Host half) keeps the
    // current state.
    const raw = snap.value !== null && typeof snap.value === 'object'
      ? snap.value as Record<string, unknown>
      : undefined
    publish({
      status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
      placement: prefs.placement ?? (raw?.defaultPlacement === undefined ? state.placement : 'all'),
      granularity: prefs.granularity ?? state.granularity,
      mode: prefs.mode ?? state.mode,
      deltaBase: prefs.deltaBase ?? state.deltaBase,
      toolSort: prefs.toolSort ?? state.toolSort,
      fileSort: prefs.fileSort ?? state.fileSort,
      insightsEntry: prefs.insightsEntry ?? (raw?.insightsEntry === undefined ? state.insightsEntry : 'show'),
      durationCurve: prefs.durationCurve ?? (raw?.defaultDurationCurve === undefined ? state.durationCurve : 'show'),
      writable: snap.writable,
    })
    return { placement: prefs.placement, insightsEntry: prefs.insightsEntry }
  }
  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    defaultPlacement: () => state.placement,
    defaultGranularity: () => state.granularity,
    defaultTrendMode: () => state.mode,
    defaultDeltaBase: () => state.deltaBase,
    defaultToolSort: () => state.toolSort,
    defaultFileSort: () => state.fileSort,
    insightsEntry: () => state.insightsEntry,
    defaultDurationCurve: () => state.durationCurve,
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
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // A visibility gate that failed to persist must not keep an entry
        // hidden on an unpersisted echo: with no valid value in the scope's
        // truth, degrade each gate to its default.
        if (field === 'defaultPlacement' && truth.placement === undefined) {
          publish({ ...state, placement: 'all' })
        }
        if (field === 'insightsEntry' && truth.insightsEntry === undefined) {
          publish({ ...state, insightsEntry: 'show' })
        }
      })
    },
  }
}

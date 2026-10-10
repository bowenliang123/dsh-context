/** The plugin's user-settings binding (browser half): the Host-served `dsh-context` namespace carries per-user
 * display preferences, degrading to the schema defaults wherever that surface is absent or read-only. */

import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, FleetTab, InsightsEntry, SettingsField } from '../shared/types'

export type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, FleetTab, InsightsEntry, SettingsField } from '../shared/types'

/** The bound settings form (`ctx.configForms.get`), as consumed. */
export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The `ctx.configForms` service face, as consumed; the bound form satisfies {@link SettingsScopeLike}
 *  (same snapshot/subscribe/set shape). */
export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

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
  fleetTab: FleetTab
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
  fleetTab(): FleetTab
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
  fleetTab?: FleetTab
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
    ...(v.fleetTab === 'show' || v.fleetTab === 'hide' ? { fleetTab: v.fleetTab } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', fleetTab: 'show', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  /** Every field is a scalar, so a shallow compare is the store's identity check — and a new preference
   *  joins it without editing a growing chain of `&&`s. */
  const unchanged = (a: SettingsState, b: SettingsState): boolean =>
    (Object.keys(b) as (keyof SettingsState)[]).every(key => a[key] === b[key])
  const publish = (next: SettingsState): void => {
    if (unchanged(state, next)) return
    state = next
    for (const listener of listeners) listener()
  }
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry; fleetTab?: FleetTab } => {
    const snap = bound.getSnapshot()
    const prefs = prefsOf(snap.value)
    // Fail open: a config problem must never leave an entry hidden. A value the plugin cannot understand
    // degrades to the field's default; a section without the field (older Host half) keeps the current state.
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
      fleetTab: prefs.fleetTab ?? (raw?.fleetTab === undefined ? state.fleetTab : 'show'),
      writable: snap.writable,
    })
    return { placement: prefs.placement, insightsEntry: prefs.insightsEntry, fleetTab: prefs.fleetTab }
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
    fleetTab: () => state.fleetTab,
    attach(bound) {
      scope = bound
      sync(bound)
      return bound.subscribe(() => { sync(bound) })
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      // The scope write's promise REJECTS on a transport failure (dsh keeps only its queue tail fulfilled),
      // so never let it float: roll the optimistic echo back to the scope's truth; a refused write recovers via subscribe.
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // A gate whose write was refused must not stay hidden on an unpersisted echo: it degrades to the
        // default, while a scope that DOES carry a readable value keeps that truth (the sync above already did).
        const refused: Partial<SettingsState> = {}
        if (field === 'defaultPlacement' && truth.placement === undefined) refused.placement = 'all'
        else if (field === 'insightsEntry' && truth.insightsEntry === undefined) refused.insightsEntry = 'show'
        else if (field === 'fleetTab' && truth.fleetTab === undefined) refused.fleetTab = 'show'
        if (Object.keys(refused).length > 0) publish({ ...state, ...refused })
      })
    },
  }
}

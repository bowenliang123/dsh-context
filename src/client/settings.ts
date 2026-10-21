import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultOverviewRange, DefaultPlacement, DefaultToolSort, DefaultTrendMode, DisplayCurrency, FleetTab, InsightsEntry, OverviewAutoSteps, SettingsField } from '../shared/types'
import { setDisplayCurrencyPreference } from './currency'

export type { DefaultDeltaBase, DefaultFileSort, DefaultToolSort, SettingsField } from '../shared/types'

export function overviewThresholdOf(value: OverviewAutoSteps): number | null {
  return value === 'off' ? null : Number(value)
}

export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The `ctx.configForms` service face, as consumed; the bound form satisfies {@link SettingsScopeLike}. */
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
  overviewAutoSteps: OverviewAutoSteps
  overviewRange: DefaultOverviewRange
  fleetTab: FleetTab
  displayCurrency: DisplayCurrency
  promptPrefix: string
  promptSuffix: string
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
  overviewAutoSteps(): OverviewAutoSteps
  defaultOverviewRange(): DefaultOverviewRange
  fleetTab(): FleetTab
  displayCurrency(): DisplayCurrency
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
  overviewAutoSteps?: OverviewAutoSteps
  overviewRange?: DefaultOverviewRange
  fleetTab?: FleetTab
  displayCurrency?: DisplayCurrency
  promptPrefix?: string
  promptSuffix?: string
}

/** The preference values the scope actually carried; a missing field lets a refused write force its default. */
interface SettingsTruth {
  placement?: DefaultPlacement
  insightsEntry?: InsightsEntry
  fleetTab?: FleetTab
  displayCurrency?: DisplayCurrency
}

function prefsOf(value: unknown): Prefs {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultPlacement === 'all' || v.defaultPlacement === 'tab' || v.defaultPlacement === 'sidebar' || v.defaultPlacement === 'hide' ? { placement: v.defaultPlacement } : {}),
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultDeltaBase === 'step' || v.defaultDeltaBase === 'turn' ? { deltaBase: v.defaultDeltaBase } : {}),
    ...(v.defaultToolSort === 'size' || v.defaultToolSort === 'count' || v.defaultToolSort === 'name' ? { toolSort: v.defaultToolSort } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'lines' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' || v.defaultFileSort === 'name' ? { fileSort: v.defaultFileSort } : {}),
    ...(v.insightsEntry === 'show' || v.insightsEntry === 'hide' ? { insightsEntry: v.insightsEntry } : {}),
    ...(v.defaultDurationCurve === 'show' || v.defaultDurationCurve === 'hide' ? { durationCurve: v.defaultDurationCurve } : {}),
    ...(v.overviewAutoSteps === '100' || v.overviewAutoSteps === '200' || v.overviewAutoSteps === '300' || v.overviewAutoSteps === 'off' ? { overviewAutoSteps: v.overviewAutoSteps } : {}),
    ...(v.defaultOverviewRange === 'today' || v.defaultOverviewRange === '7d' || v.defaultOverviewRange === '30d' || v.defaultOverviewRange === 'all' ? { overviewRange: v.defaultOverviewRange } : {}),
    ...(v.fleetTab === 'show' || v.fleetTab === 'hide' ? { fleetTab: v.fleetTab } : {}),
    ...(v.displayCurrency === 'auto' || v.displayCurrency === 'cny' || v.displayCurrency === 'usd' ? { displayCurrency: v.displayCurrency } : {}),
    ...(typeof v.promptPrefix === 'string' ? { promptPrefix: v.promptPrefix } : {}),
    ...(typeof v.promptSuffix === 'string' ? { promptSuffix: v.promptSuffix } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'lines', insightsEntry: 'show', durationCurve: 'show', overviewAutoSteps: '200', overviewRange: '30d', fleetTab: 'show', displayCurrency: 'auto', promptPrefix: '', promptSuffix: '', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  /** Every field is a scalar, so a shallow compare is the identity check; a new preference joins it automatically. */
  const unchanged = (a: SettingsState, b: SettingsState): boolean =>
    (Object.keys(b) as (keyof SettingsState)[]).every(key => a[key] === b[key])
  const publish = (next: SettingsState): void => {
    setDisplayCurrencyPreference(next.displayCurrency)
    if (unchanged(state, next)) return
    state = next
    for (const listener of listeners) listener()
  }
  const sync = (bound: SettingsScopeLike): SettingsTruth => {
    const snap = bound.getSnapshot()
    // Bounded catch: a value throwing on property access keeps the current state instead of breaking the mirror's fan-out.
    let prefs: Prefs = {}
    let raw: Record<string, unknown> | undefined
    try {
      prefs = prefsOf(snap.value)
      raw = snap.value !== null && typeof snap.value === 'object' ? snap.value as Record<string, unknown> : undefined
    } catch { /* hostile value */ }
    // Fail open: an unreadable value degrades to the field's default; a section missing the field keeps the current state.
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
      overviewAutoSteps: prefs.overviewAutoSteps ?? (raw?.overviewAutoSteps === undefined ? state.overviewAutoSteps : '200'),
      overviewRange: prefs.overviewRange ?? (raw?.defaultOverviewRange === undefined ? state.overviewRange : '30d'),
      fleetTab: prefs.fleetTab ?? (raw?.fleetTab === undefined ? state.fleetTab : 'show'),
      displayCurrency: prefs.displayCurrency ?? (raw?.displayCurrency === undefined ? state.displayCurrency : 'auto'),
      promptPrefix: prefs.promptPrefix ?? (raw?.promptPrefix === undefined ? state.promptPrefix : ''),
      promptSuffix: prefs.promptSuffix ?? (raw?.promptSuffix === undefined ? state.promptSuffix : ''),
      writable: snap.writable,
    })
    return {
      placement: prefs.placement,
      insightsEntry: prefs.insightsEntry,
      fleetTab: prefs.fleetTab,
      displayCurrency: prefs.displayCurrency,
    }
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
    overviewAutoSteps: () => state.overviewAutoSteps,
    defaultOverviewRange: () => state.overviewRange,
    fleetTab: () => state.fleetTab,
    displayCurrency: () => state.displayCurrency,
    attach(bound) {
      scope = bound
      sync(bound)
      const unsubscribe = bound.subscribe(() => { sync(bound) })
      return () => {
        unsubscribe()
        // A set() after disposal must not write into a dead form.
        if (scope === bound) scope = undefined
      }
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
        else if (field === 'displayCurrency' && truth.displayCurrency === undefined) refused.displayCurrency = 'auto'
        if (Object.keys(refused).length > 0) publish({ ...state, ...refused })
      })
    },
  }
}

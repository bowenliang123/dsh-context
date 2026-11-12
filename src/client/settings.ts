import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultOverviewRange, DefaultPlacement, DefaultToolSort, DefaultTrendMode, FleetTab, InsightsEntry, OverviewAutoSteps, SettingsField } from '../shared/types'

export type { DefaultDeltaBase, DefaultFileSort, DefaultToolSort, SettingsField } from '../shared/types'

export function overviewThresholdOf(value: OverviewAutoSteps): number | null {
  return value === 'off' ? null : Number(value)
}

export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

export interface SettingsState {
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
  promptPrefix: string
  promptSuffix: string
  writable: boolean
}

export interface ContextSettings {
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
  attach(scope: SettingsScopeLike): () => void
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
  promptPrefix?: string
  promptSuffix?: string
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
    ...(v.defaultOverviewRange === 'today' || v.defaultOverviewRange === '7d' || v.defaultOverviewRange === '30d' ? { overviewRange: v.defaultOverviewRange } : {}),
    ...(v.fleetTab === 'show' || v.fleetTab === 'hide' ? { fleetTab: v.fleetTab } : {}),
    ...(typeof v.promptPrefix === 'string' ? { promptPrefix: v.promptPrefix } : {}),
    ...(typeof v.promptSuffix === 'string' ? { promptSuffix: v.promptSuffix } : {}),
  }
}

export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'lines', insightsEntry: 'show', durationCurve: 'show', overviewAutoSteps: '100', overviewRange: '30d', fleetTab: 'show', promptPrefix: '', promptSuffix: '', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  const unchanged = (a: SettingsState, b: SettingsState): boolean =>
    (Object.keys(b) as (keyof SettingsState)[]).every(key => a[key] === b[key])
  const publish = (next: SettingsState): void => {
    if (unchanged(state, next)) return
    state = next
    for (const listener of listeners) listener()
  }
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry; fleetTab?: FleetTab } => {
    const snap = bound.getSnapshot()
    let prefs: Prefs = {}
    let raw: Record<string, unknown> | undefined
    try {
      prefs = prefsOf(snap.value)
      raw = snap.value !== null && typeof snap.value === 'object' ? snap.value as Record<string, unknown> : undefined
    } catch {}
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
      overviewAutoSteps: prefs.overviewAutoSteps ?? (raw?.overviewAutoSteps === undefined ? state.overviewAutoSteps : '100'),
      overviewRange: prefs.overviewRange ?? (raw?.defaultOverviewRange === undefined ? state.overviewRange : '30d'),
      fleetTab: prefs.fleetTab ?? (raw?.fleetTab === undefined ? state.fleetTab : 'show'),
      promptPrefix: prefs.promptPrefix ?? (raw?.promptPrefix === undefined ? state.promptPrefix : ''),
      promptSuffix: prefs.promptSuffix ?? (raw?.promptSuffix === undefined ? state.promptSuffix : ''),
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
    overviewAutoSteps: () => state.overviewAutoSteps,
    defaultOverviewRange: () => state.overviewRange,
    fleetTab: () => state.fleetTab,
    attach(bound) {
      scope = bound
      sync(bound)
      const unsubscribe = bound.subscribe(() => { sync(bound) })
      return () => {
        unsubscribe()
        if (scope === bound) scope = undefined
      }
    },
    set(field, value) {
      publish({ ...state, ...prefsOf({ [field]: value }) })
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        const refused: Partial<SettingsState> = {}
        if (field === 'defaultPlacement' && truth.placement === undefined) refused.placement = 'all'
        else if (field === 'insightsEntry' && truth.insightsEntry === undefined) refused.insightsEntry = 'show'
        else if (field === 'fleetTab' && truth.fleetTab === undefined) refused.fleetTab = 'show'
        if (Object.keys(refused).length > 0) publish({ ...state, ...refused })
      })
    },
  }
}

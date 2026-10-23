/** The Context Insights page: registered on the layout's keyed `main` slot, so its mount IS its open. The page is the
 * `lc-ov` query container — unlike the shipped first-level 960px frame, the column spans the pane; tips portal to `body`. */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { costBreakdownOf, estimateSessionCost, formatCost, type CostCurrency, type CostPrefs, type ModelBook } from '../cost'
import { fmt } from '../format'
import { useModelPrices } from '../modelPrices'
import {
  aggregateDays, coveredRowsOf, dayRangeWindow, filterRows, groupCountsOf, inGroup, kpisOf,
  pageOf, rangeWindowOf, refreshSessions, requestActivityBackfill, rowsOfSnapshot,
  rowLoadedSkill, sessionGroupsOf, sessionsSnapshotOf, skillLoadsOf, sortRows,
  UNGROUPED_KEY, workspacesSnapshotOf,
  type DayRange, type OverviewCoverage, type OverviewRange, type OverviewRow, type OverviewSort, type SkillSort,
} from '../overview'
import { openPluginSettings, openSessionVia, type ClientCtx } from '../services'
import { readSkillCatalog } from '../skills'
import type { ContextSettings } from '../settings'
import { costPrefsOf } from '../settings'
import type { SkillInfo } from '../../shared/types'
import { dayKeyOf } from '../../shared/days'
import type { ViewKit } from '../viewkit'
import { makeBalanceCapsule } from './balanceCapsule'
import { makeDateRange } from './dateRange'
import { makeErrorBoundary } from './errorBoundary'
import { makeHeatmap, todayKey, type HeatMetric } from './heatmap'
import { Donut } from './donut'
import { useHoverTip } from './hoverTip'
import { makeOverviewTokens } from './overviewTokens'
import { makeCostCard } from './costCard'
import { makeOverviewUsage } from './overviewUsage'
import { makeStatsTiming } from './statsTiming'
import { makeOverviewCard } from './overviewCard'
import { makeOverviewSkills } from './overviewSkills'
import { makeUpdatePill } from './updatePill'
import { IconSettings } from '../primitives'

export interface OverviewPanelProps {
  useSessions?: unknown
  useWorkspaces?: unknown
}

const RANGES: readonly OverviewRange[] = ['today', '7d', '30d', 'all']
const SORTS: readonly OverviewSort[] = ['recent', 'tokens', 'context']
const COVERAGE: readonly OverviewCoverage[] = ['all', 'active', 'archived']
const METRICS: readonly HeatMetric[] = ['sessions', 'tokens']

export function makeOverviewPanel(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: OverviewPanelProps) => ReactElement | null {
  const { t, fmtDuration } = kit
  const subscribeSettings = settings.store.subscribe.bind(settings.store)
  const Heatmap = makeHeatmap(kit)
  const OverviewCard = makeOverviewCard(kit)
  const BalanceCapsule = makeBalanceCapsule(ctx, kit)
  const DateRange = makeDateRange(kit)
  const OverviewTokens = makeOverviewTokens(kit, Donut)
  const StatsTiming = makeStatsTiming(kit, Donut)
  const OverviewUsage = makeOverviewUsage(kit)
  const CostCard = makeCostCard(kit)
  const OverviewSkills = makeOverviewSkills(kit)
  const UpdatePill = makeUpdatePill(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  // Read per render: the slot outlet re-renders on a locale switch.
  function activeLocale(): string {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  function activeCurrency(): CostCurrency {
    return activeLocale() === 'zh' ? 'cny' : 'usd'
  }

  function OverviewBody(props: OverviewPanelProps): ReactElement | null {
    const { book } = useModelPrices()
    const snapshot = sessionsSnapshotOf(props)
    const wsSnapshot = workspacesSnapshotOf(props)
    const stored = useSyncExternalStore(subscribeSettings, () => settings.store.getSnapshot())
    const costPrefs = useMemo(() => costPrefsOf(stored), [stored])
    // The preset follows the served default until the reader picks one; a pick is written back as the new default where
    // settings are writable, and a late-arriving section still lands while none is picked.
    const configuredRange = stored.overviewRange
    const usageWindow = stored.usageWindow
    const [picked, setPicked] = useState<OverviewRange | null>(null)
    const preset = picked ?? configuredRange
    const [custom, setCustom] = useState<DayRange | null>(null)
    const [coverage, setCoverage] = useState<OverviewCoverage>('all')
    const [day, setDay] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string | null>(null)
    const [skill, setSkill] = useState<string | null>(null)
    const [skillSort, setSkillSort] = useState<SkillSort>('loads')
    const [sort, setSort] = useState<OverviewSort>('recent')
    const [metric, setMetric] = useState<HeatMetric>('tokens')
    const [page, setPage] = useState(0)
    const { zoneProps, bubble } = useHoverTip()

    const rows = useMemo(() => rowsOfSnapshot(snapshot, wsSnapshot), [snapshot, wsSnapshot])
    const groups = useMemo(() => sessionGroupsOf(wsSnapshot), [wsSnapshot])
    const [catalog, setCatalog] = useState<ReadonlyMap<string, SkillInfo> | null>(null)

    // The skill catalogue resolves per SESSION (the workspace selects the project layer, the preset the discovery
    // scope), so the current session anchors it; a switch re-reads, and a failed read leaves the card unenriched.
    const currentRow = (rows ?? []).find(row => row.current)
    const currentCwd = currentRow?.cwd
    const currentId = currentRow?.id
    useEffect(() => {
      let alive = true
      setCatalog(null)
      void readSkillCatalog(currentCwd, currentId).then((next) => { if (alive && next !== null) setCatalog(next) })
      return () => { alive = false }
    }, [currentCwd, currentId])

    // On mount (the panel's open): summon the host's projection warm-up (this page is the rows' only reader — one pass
    // per host process) and re-pull the list once, so backfilled rows reach a long-connected page.
    useEffect(() => {
      requestActivityBackfill()
      refreshSessions(ctx)
    }, [])

    useEffect(() => { setPage(0) }, [preset, custom, coverage, day, query, group, skill, sort])

    const currency = activeCurrency()
    const now = Date.now()
    const allRows = rows ?? []
    const covered = coveredRowsOf(allRows, coverage)
    // The scope window every figure reads: the calendar's picked range (a malformed key keeps the preset), else the preset's floor.
    const scope = (custom !== null ? dayRangeWindow(custom) : null) ?? rangeWindowOf(preset, now)
    // The head's date span reads off that same window so the picker and presets can never disagree.
    const spanFrom = scope.start === null ? null : dayKeyOf(scope.start)
    const spanTo = scope.start === null ? null : dayKeyOf(scope.end ?? now)
    const span = spanFrom !== null && spanTo !== null ? { from: spanFrom, to: spanTo } : null
    // The scope scopes the KPI band, composition donut and grid; the heatmap keeps its own fixed window.
    const ranged = filterRows(covered, { scope, day: null, query: '' })
    // Group chips count the day/query-scoped rows BEFORE the group filter, so selecting a chip never collapses its row.
    const scoped = filterRows(ranged, { scope, day, query })
    const counts = groupCountsOf(scoped, wsSnapshot)
    // A selection whose group fell out of scope keeps a phantom chip (count 0) so the filter stays visible, one click out.
    const chips = group !== null && !counts.some(c => c.key === group)
      ? [...counts, { key: group, count: 0 }]
      : counts
    const visible = sortRows(
      (group === null ? scoped : scoped.filter(row => inGroup(row, group, groups)))
        // The skill row pin narrows the list to the skill's loaders within the card's own scope (scope window + pinned day).
        .filter(row => skill === null || rowLoadedSkill(row, skill, { scope, day })),
      sort,
    )
    const paged = pageOf(visible, page)
    const kpi = kpisOf(ranged, book, currency, scope, costPrefs)
    const days = aggregateDays(covered, book, currency, costPrefs)
    // The cost KPI's per-model disclosure, priced by the same prefs.
    const breakdown = costBreakdownOf(kpi.usage, book, currency, costPrefs)
    /** A preset pick applies at once and becomes the stored default where the settings form is writable. */
    const pickPreset = (range: OverviewRange): void => {
      setPicked(range)
      setCustom(null)
      const state = settings.store.getSnapshot()
      if (state.status === 'ready' && state.writable) settings.set('defaultOverviewRange', range)
    }
    const openOne = (id: string): void => {
      // The view owner's verb navigates the center column back to the conversation itself, so the page needs no close.
      openSessionVia(ctx, id)
    }
    // The sessions card mirrors its coverage: All prices in the window's archived share; the narrow scopes name the full total.
    const sessionsLabel = coverage === 'archived' ? t('ov.kpi.archived') : coverage === 'active' ? t('ov.kpi.sessions') : t('ov.kpi.allSessions')
    const sessionsSub = coverage === 'all'
      ? t('ov.kpi.inclArchived', { n: ranged.filter(row => row.archived).length })
      : t('ov.kpi.ofTotal', { n: allRows.length })

    return (
      <section className="lc-ov-page" aria-label={t('ov.title')} {...zoneProps}>
        {bubble}
        <div className="lc-ov-pagescroll">
          <div className="lc-ov-pagecontent">
            <div className="lc-ov-pagehead" data-window-drag>
              <h1 className="lc-ov-pagetitle">{t('ov.title')}</h1>
              <button type="button" className="lc-ov-settings" title={t('plugin.settingsOpen')} onClick={() => { openPluginSettings(ctx) }}>
                <IconSettings size={14} />{t('plugin.settings')}
              </button>
              {/* Renders nothing until a live figure lands, so the heading row never reflows for it. */}
              <BalanceCapsule />
              <UpdatePill />
              {/* One wrapper so the head's right cluster pushes once; a bare `.lc-gran` sibling would split the free space. */}
              <div className="lc-ov-headctl">
                <DateRange
                  value={span}
                  picked={custom !== null}
                  onChange={(next) => { setCustom(next) }}
                  today={todayKey()}
                  locale={activeLocale()}
                />
                <div className="lc-gran lc-ov-range" role="group" aria-label={t('ov.range.label')}>
                  {RANGES.map(r => (
                    <button
                      key={r}
                      type="button"
                      className={'lc-gran-btn' + (custom === null && preset === r ? ' lc-gran-on' : '')}
                      onClick={() => { pickPreset(r) }}
                    >{t('ov.range.' + r)}</button>
                  ))}
                </div>
              </div>
            </div>

            {rows === null ? (
              <div className="lc-empty">{t('ov.unavailable')}</div>
            ) : (
              <>
                {/* The range selector does not scope the usage chart; it reads the merged daily ledger. */}
                <div className="lc-ov-first">
                  <div className="lc-ov-kpis">
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{sessionsLabel}</span>
                      <span className="lc-stat-value">{kpi.sessions}</span>
                      <span className="lc-stat-sub">{sessionsSub}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.tokens')}</span>
                      <span className="lc-stat-value">{fmt(kpi.tokens)}</span>
                      <span className="lc-stat-sub">{t('stats.turns')} {fmt(kpi.turns)}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cost')}</span>
                      <span className="lc-stat-value">
                        {kpi.cost === null ? '—' : formatCost(kpi.cost, currency)}
                        {costPrefs.multiplier !== 1 && (
                          <span className="lc-ov-kpi-mult" title={t('ov.kpi.multTip')}>×{costPrefs.multiplier}</span>
                        )}
                      </span>
                      <span className="lc-stat-sub">{t('ov.kpi.pricedSub', { n: kpi.costSessions, total: kpi.sessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cacheHit')}</span>
                      <span className="lc-stat-value">{kpi.cacheHit === null ? '—' : kpi.cacheHit + '%'}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.sessionsSub', { n: kpi.usageSessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.toolCalls')}</span>
                      <span className="lc-stat-value">{fmt(kpi.toolCalls)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.toolSub', { dur: fmtDuration(kpi.toolsMs) })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('timing.total')}</span>
                      <span className="lc-stat-value">{fmtDuration(kpi.wallMs)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.wallSub', { n: fmt(kpi.calls) })}</span>
                    </div>
                  </div>
                  <OverviewUsage days={days} currency={currency} today={todayKey()} window={usageWindow} />
                </div>
                <div className="lc-ov-stats">
                  <OverviewTokens tokens={kpi.tokenParts} />
                  <StatsTiming timing={kpi.timing} />
                </div>
                <CostCard lines={breakdown} currency={currency} prefs={costPrefs} />
                <div className="lc-ov-body">
                  <div className="lc-ov-left">
                    <div className="lc-card lc-ov-heat-card">
                      <div className="lc-card-title">
                        <span className="lc-card-title-text">{t('ov.heat.title')}</span>
                        <span className="lc-heat-ctl">
                          <span className="lc-card-sub">{t('ov.heat.sub')}</span>
                          <div className="lc-gran" role="group" aria-label={t('ov.heat.metric')}>
                            {METRICS.map(m => (
                              <button
                                key={m}
                                type="button"
                                className={'lc-gran-btn' + (metric === m ? ' lc-gran-on' : '')}
                                onClick={() => { setMetric(m) }}
                              >{t('ov.heat.metric.' + m)}</button>
                            ))}
                          </div>
                        </span>
                      </div>
                      <Heatmap days={days} metric={metric} selected={day} onSelect={setDay} today={todayKey()} />
                    </div>
                    {/* Scope: the range group plus the heatmap's pinned day; the list's search and group chips are list-local. */}
                    <OverviewSkills
                      stats={skillLoadsOf(ranged, { scope, day, sort: skillSort })}
                      day={day}
                      selected={skill}
                      onSelect={setSkill}
                      sort={skillSort}
                      onSort={setSkillSort}
                      catalog={catalog}
                      now={now}
                    />
                  </div>

                  <div className="lc-ov-right">
                    <div className="lc-ov-list-head">
                      <span className="lc-ov-list-title">{t('ov.list.title')}</span>
                      <span className="lc-ov-list-count">{visible.length}</span>
                      {day !== null && (
                        <button type="button" className="lc-ov-day-chip" title={t('ov.list.dayClear')} onClick={() => { setDay(null) }}>
                          {t('ov.list.dayFilter', { day })} ×
                        </button>
                      )}
                      {skill !== null && (
                        <button type="button" className="lc-ov-day-chip" title={t('ov.list.skillClear')} onClick={() => { setSkill(null) }}>
                          {t('node.skillTag', { name: skill })} ×
                        </button>
                      )}
                      <input
                        className="lc-ov-search"
                        type="search"
                        value={query}
                        placeholder={t('ov.list.search')}
                        aria-label={t('ov.list.search')}
                        onChange={(ev) => { setQuery(ev.target.value) }}
                      />
                      <select
                        className="lc-ov-cover"
                        value={coverage}
                        aria-label={t('ov.cover.label')}
                        onChange={(ev) => { setCoverage(ev.target.value as OverviewCoverage) }}
                      >
                        {COVERAGE.map(c => (
                          <option key={c} value={c}>{t('ov.cover.' + c)}</option>
                        ))}
                      </select>
                      <div className="lc-gran" role="group" aria-label={t('ov.list.sortLabel')}>
                        {SORTS.map(s => (
                          <button
                            key={s}
                            type="button"
                            className={'lc-gran-btn' + (sort === s ? ' lc-gran-on' : '')}
                            onClick={() => { setSort(s) }}
                          >{t('ov.list.sort.' + s)}</button>
                        ))}
                      </div>
                    </div>

                    {chips.length > 0 && (
                      <div className="lc-ov-groups" role="group" aria-label={t('ov.group.label')}>
                        <button
                          type="button"
                          className={'lc-ov-chip' + (group === null ? ' lc-ov-chip-on' : '')}
                          onClick={() => { setGroup(null) }}
                        >{t('ov.range.all')}<span className="lc-ov-chip-n">{scoped.length}</span></button>
                        {chips.map(c => (
                          <button
                            key={c.key}
                            type="button"
                            className={'lc-ov-chip' + (group === c.key ? ' lc-ov-chip-on' : '')}
                            onClick={() => { setGroup(group === c.key ? null : c.key) }}
                          >{c.key === UNGROUPED_KEY ? t('ov.group.ungrouped') : c.key}<span className="lc-ov-chip-n">{c.count}</span></button>
                        ))}
                      </div>
                    )}

                    {visible.length === 0 ? (
                      <div className="lc-empty">{t(allRows.length === 0 ? 'ov.list.empty' : 'ov.list.noMatch')}</div>
                    ) : (
                      <>
                        <div className="lc-ov-grid">
                          {paged.items.map(row => (
                            <OverviewCard
                              key={row.id}
                              row={row}
                              {...(groups?.[row.id] !== undefined ? { group: groups[row.id] } : {})}
                              costLabel={cardCostOf(row, book, currency, costPrefs)}
                              now={now}
                              onOpen={openOne}
                            />
                          ))}
                        </div>
                        {paged.count > 1 && (
                          <div className="lc-ov-pager" role="navigation" aria-label={t('ov.list.pager')}>
                            <button
                              type="button"
                              className="lc-ov-pager-btn"
                              disabled={paged.index === 0}
                              aria-label={t('ov.list.prev')}
                              onClick={() => { setPage(paged.index - 1) }}
                            >‹</button>
                            <span className="lc-ov-pager-n">{t('ov.list.page', { n: paged.index + 1, total: paged.count })}</span>
                            <button
                              type="button"
                              className="lc-ov-pager-btn"
                              disabled={paged.index === paged.count - 1}
                              aria-label={t('ov.list.next')}
                              onClick={() => { setPage(paged.index + 1) }}
                            >›</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    )
  }

  return function OverviewPanel(props: OverviewPanelProps): ReactElement | null {
    return <ErrorBoundary><OverviewBody {...props} /></ErrorBoundary>
  }
}

/** One card's priced cost label at the team scope, or the dash (no book yet, nothing billed, unpriceable models). */
function cardCostOf(row: OverviewRow, book: ModelBook | null, currency: CostCurrency, prefs: CostPrefs): string {
  if (row.familyCost === null) return '—'
  const cost = estimateSessionCost(row.familyCost, book, currency, prefs)
  return cost === null ? '—' : formatCost(cost, currency)
}

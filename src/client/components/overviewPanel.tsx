/**
 * The Context Insights page: the plugin's first-level panel, registered on the layout's keyed `main` slot, so its
 * mount IS its open. Data comes from the root-scope sessions/workspaces standard kit — every list row's host-cached
 * projection values — so the page draws each session's insight without opening a log.
 *
 * Unlike the shipped first-level pages' centered 960px frame, the content column spans the pane so the grids and
 * legends adapt to it, and the page element is the `lc-ov` query container the folds key off. Hover tips portal to
 * <body>, because that container would otherwise capture their fixed positioning.
 *
 * The cluster holds ONE scope: a picked calendar range replaces the rolling preset and clicking a preset hands it
 * back, so they never both claim it, and everything the presets scope reads that one resolved window. The coverage
 * picker sits at the sessions feed's head and defaults to All: archived sessions fold into the page's every figure
 * unless the picker narrows them, and the Active Sessions card's label and sub-line follow the picked coverage.
 * Below the KPI
 * band and the usage chart, the heatmap pins both its column mates to a picked day, and a skill-card row click
 * narrows the session column to that skill's loaders within the same scope. A session card jumps through the
 * harness's own `openSessionVia`, whose navigation returns the center column to the conversation.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { costBreakdownOf, estimateSessionCost, formatCost, type CostCurrency, type CostModelLine, type CostPrefs, type ModelBook } from '../cost'
import { fmt } from '../format'
import { useModelPrices } from '../modelPrices'
import {
  aggregateDays, coveredRowsOf, dayRangeWindow, filterRows, groupCountsOf, inGroup, kpisOf,
  pageOf, rangeWindowOf, refreshSessions, requestActivityBackfill, rowsOfSnapshot,
  rowLoadedSkill, sessionGroupsOf, sessionsSnapshotOf, skillLoadsOf, sortRows,
  UNGROUPED_KEY, workspacesSnapshotOf,
  type DayRange, type OverviewCoverage, type OverviewRange, type OverviewRow, type OverviewSort, type SkillSort,
} from '../overview'
import { openSessionVia, type ClientCtx } from '../services'
import { readSkillCatalog } from '../skills'
import { openPluginSettings } from '../settingsJump'
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
/** The coverage scopes the sessions feed serves, in menu order. */
const COVERAGE: readonly OverviewCoverage[] = ['all', 'active', 'archived']
/** The heatmap's depth metrics, in toggle order (tokens is the default). */
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
  const OverviewSkills = makeOverviewSkills(kit)
  const UpdatePill = makeUpdatePill(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  // Read per render: the slot outlet re-renders on a locale switch.
  function activeLocale(): string {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  /** The display currency follows the active locale. */
  function activeCurrency(): CostCurrency {
    return activeLocale() === 'zh' ? 'cny' : 'usd'
  }

  /** The cost KPI's disclosure: one line per billed model — the tokens, the priced
   * cost, and the book face the price came from, or the reason nothing priced.
   * Renders nothing while no usage merged (no expander for an empty band). */
  function CostBreakdown(props: { lines: CostModelLine[]; currency: CostCurrency }): ReactElement | null {
    if (props.lines.length === 0) return null
    return (
      <details className="lc-ov-cost-detail">
        <summary>{t('ov.kpi.breakdown')}</summary>
        <table className="lc-ov-cost-table">
          <thead>
            <tr>
              <th scope="col">{t('ov.cost.model')}</th>
              <th scope="col">{t('ov.usage.tokens')}</th>
              <th scope="col">{t('stats.cost')}</th>
              <th scope="col">{t('ov.cost.source')}</th>
            </tr>
          </thead>
          <tbody>
            {props.lines.map(line => (
              <tr key={line.provider + '/' + line.model}>
                <td>
                  {line.model}
                  {/* The registry's spelling, when the billed id differs from the face the price read off. */}
                  {line.rate !== null && line.mid !== line.model && <span className="lc-ov-cost-face"> {line.mid}</span>}
                </td>
                <td>{fmt(line.tokens)}</td>
                <td>{line.cost === null ? '—' : formatCost(line.cost, props.currency)}</td>
                <td className={line.cost === null ? 'lc-ov-cost-unpriced' : undefined}>
                  {line.cost === null
                    ? t('ov.cost.reason.' + line.reason)
                    : `${line.pid} · ${line.mid}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    )
  }

  function OverviewBody(props: OverviewPanelProps): ReactElement | null {    const { book } = useModelPrices()
    const snapshot = sessionsSnapshotOf(props)
    const wsSnapshot = workspacesSnapshotOf(props)
    // The preset follows the served default until the reader picks one; a pick is written back as the
    // new default where settings are writable, and a late-arriving section still lands while none is picked.
    const configuredRange = useSyncExternalStore(subscribeSettings, () => settings.defaultOverviewRange())
    // The cost figures' display preferences: read per render off the store so a
    // settings edit re-prices the band, the chart, and the breakdown alike.
    const usageWindow = useSyncExternalStore(subscribeSettings, () => settings.usageWindow())
    const fxRate = useSyncExternalStore(subscribeSettings, () => settings.costFxRate())
    const peakFactor = useSyncExternalStore(subscribeSettings, () => settings.costPeakFactor())
    const multiplier = useSyncExternalStore(subscribeSettings, () => settings.costMultiplier())
    const actualPrice = useSyncExternalStore(subscribeSettings, () => settings.costActualPrice())
    const costPrefs = costPrefsOf({
      costFxRate: fxRate, costPeakFactor: peakFactor, costMultiplier: multiplier, costActualPrice: actualPrice,
    })
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

    // The skill card's metadata read: the registry resolves per SESSION (the
    // workspace selects the project layer, the preset selects the discovery
    // scope), so the current session anchors it; a session-less list still
    // serves the global layers. A switch re-reads; a failed read leaves the card unenriched rather than stale.
    const currentRow = (rows ?? []).find(row => row.current)
    const currentCwd = currentRow?.cwd
    const currentId = currentRow?.id
    useEffect(() => {
      let alive = true
      setCatalog(null)
      void readSkillCatalog(currentCwd, currentId).then((next) => { if (alive && next !== null) setCatalog(next) })
      return () => { alive = false }
    }, [currentCwd, currentId])

    // On mount (the panel's open): summon the host's projection warm-up (this
    // page is the rows' only reader — one pass per host process) and re-pull
    // the list once, so backfilled rows reach a long-connected page.
    useEffect(() => {
      requestActivityBackfill()
      refreshSessions(ctx)
    }, [])

    // Any filter change re-anchors the pager at the first page.
    useEffect(() => { setPage(0) }, [preset, custom, coverage, day, query, group, skill, sort])

    const currency = activeCurrency()
    const now = Date.now()
    const allRows = rows ?? []
    const covered = coveredRowsOf(allRows, coverage)
    // The scope window every figure below reads: the calendar's own picked
    // range while one is set (a malformed key keeps the preset, never an unprovable window), else the preset's rolling floor.
    const scope = (custom !== null ? dayRangeWindow(custom) : null) ?? rangeWindowOf(preset, now)
    // The head's date span, read off that same window so the picker and the
    // presets can never disagree: a picked range's own two days, a preset's
    // floor through today (its end is open), nothing at all under "all".
    const spanFrom = scope.start === null ? null : dayKeyOf(scope.start)
    const spanTo = scope.start === null ? null : dayKeyOf(scope.end ?? now)
    const span = spanFrom !== null && spanTo !== null ? { from: spanFrom, to: spanTo } : null
    // The scope scopes the KPI band, the composition donut, and the grid;
    // the heatmap keeps its own fixed window over the coverage-selected list.
    const ranged = filterRows(covered, { scope, day: null, query: '' })
    // The group chips count the day/query-scoped rows BEFORE the group filter
    // applies, so selecting a chip never collapses the row itself.
    const scoped = filterRows(ranged, { scope, day, query })
    const counts = groupCountsOf(scoped, wsSnapshot)
    // A selection whose group fell out of scope keeps a phantom chip (count
    // 0) so the active filter stays visible and one click out of it.
    const chips = group !== null && !counts.some(c => c.key === group)
      ? [...counts, { key: group, count: 0 }]
      : counts
    const visible = sortRows(
      (group === null ? scoped : scoped.filter(row => inGroup(row, group, groups)))
        // The skill card's row pin narrows the list to the skill's loaders
        // within the card's own scope (the scope window plus the pinned day).
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
      // The view owner's verb navigates the center column back to the
      // conversation itself (selectPanel(null)), so the page needs no close.
      openSessionVia(ctx, id)
    }
    // The sessions card mirrors its coverage: All prices in the window's
    // archived share; the narrow scopes name what the full list holds.
    const sessionsLabel = coverage === 'archived' ? t('ov.kpi.archived') : coverage === 'active' ? t('ov.kpi.sessions') : t('ov.kpi.allSessions')
    const sessionsSub = coverage === 'all'
      ? t('ov.kpi.inclArchived', { n: ranged.filter(row => row.archived).length })
      : t('ov.kpi.ofTotal', { n: allRows.length })

    return (
      <section className="lc-ov-page" aria-label={t('ov.title')} {...zoneProps}>
        {bubble}
        {/* The page's one scroll region. */}
        <div className="lc-ov-pagescroll">
          <div className="lc-ov-pagecontent">
            <div className="lc-ov-pagehead" data-window-drag>
              <h1 className="lc-ov-pagetitle">{t('ov.title')}</h1>
              <button type="button" className="lc-ov-settings" title={t('plugin.settingsOpen')} onClick={() => { openPluginSettings() }}>
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
                        {/* The actual-price badge marks a figure the multiplier moved off the book's own. */}
                        {actualPrice === 'show' && costPrefs.multiplier !== 1 && (
                          <span className="lc-ov-kpi-mult" title={t('ov.kpi.multTip')}>×{costPrefs.multiplier}</span>
                        )}
                      </span>
                      <span className="lc-stat-sub">{t('ov.kpi.pricedSub', { n: kpi.costSessions, total: kpi.sessions })}</span>
                      <CostBreakdown lines={breakdown} currency={currency} />
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

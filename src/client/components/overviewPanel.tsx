import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { estimateSessionCost, formatCost, type CostCurrency, type ModelBook } from '../cost'
import { fmt } from '../format'
import { useModelPrices } from '../modelPrices'
import {
  coveredRowsOf, DayAggregator, dayRangeWindow, filterRows, groupCountsOf, inGroup, kpisOf,
  pageOf, rangeWindowOf, refreshSessions, requestActivityBackfill, rowsOfSnapshot,
  rowHasTally, sessionGroupsOf, sessionsSnapshotOf, skillLoadsOf, sortRows,
  tallyStatsOf, UNGROUPED_KEY, workspacesSnapshotOf,
  type DayRange, type OverviewCoverage, type OverviewRange, type OverviewRow, type OverviewSort, type SkillSort,
  type TallyField, type TallyStat,
} from '../overview'
import { openPluginSettings, openSessionVia, activeMsOf, type ClientCtx } from '../services'
import { readSkillCatalog } from '../skills'
import type { ContextSettings } from '../settings'
import type { SkillInfo } from '../../shared/types'
import { dayKeyOf } from '../../shared/days'
import type { ViewKit } from '../viewkit'
import { makeBalanceCapsule } from './balanceCapsule'
import { ClearableInput } from './clearableInput'
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
import { makeOverviewTally } from './overviewTally'
import type { TallyCardKind } from './overviewTally'
import { makeUpdatePill } from './updatePill'
import { useLazyMount } from './useLazyMount'
import { IconGauge, IconSettings } from '../primitives'

export interface OverviewPanelProps {
  useSessions?: unknown
  useWorkspaces?: unknown
}

const RANGES: readonly OverviewRange[] = ['today', '7d', '30d', 'all']
const SORTS: readonly OverviewSort[] = ['recent', 'tokens', 'context']
const COVERAGE: readonly OverviewCoverage[] = ['all', 'active', 'archived']
const METRICS: readonly HeatMetric[] = ['sessions', 'tokens']
const PICK_FILTER: Record<TallyField, { label: string; clear: string }> = {
  skills: { label: 'node.skillTag', clear: 'ov.list.skillClear' },
  tools: { label: 'ov.list.toolFilter', clear: 'ov.list.toolClear' },
  cmds: { label: 'ov.list.commandFilter', clear: 'ov.list.commandClear' },
}

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
  const OverviewTally = makeOverviewTally(kit)
  const UpdatePill = makeUpdatePill(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  function activeLocale(): string {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  function activeCurrency(): CostCurrency {
    return activeLocale() === 'zh' ? 'cny' : 'usd'
  }

  function OverviewBody(props: OverviewPanelProps): ReactElement | null {
    const { book } = useModelPrices()
    const snapshot = useDeferredValue(sessionsSnapshotOf(props))
    const wsSnapshot = useDeferredValue(workspacesSnapshotOf(props))
    const configuredRange = useSyncExternalStore(subscribeSettings, () => settings.defaultOverviewRange())
    const [picked, setPicked] = useState<OverviewRange | null>(null)
    const preset = picked ?? configuredRange
    const [custom, setCustom] = useState<DayRange | null>(null)
    const [coverage, setCoverage] = useState<OverviewCoverage>('all')
    const [day, setDay] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string | null>(null)
    const [pick, setPick] = useState<{ field: TallyField; name: string } | null>(null)
    const [skillSort, setSkillSort] = useState<SkillSort>('loads')
    const [sort, setSort] = useState<OverviewSort>('recent')
    const [metric, setMetric] = useState<HeatMetric>('tokens')
    const [page, setPage] = useState(0)
    const { zoneProps, bubble } = useHoverTip()
    const [bodyRef, bodyMounted] = useLazyMount()

    const rows = useMemo(() => rowsOfSnapshot(snapshot, wsSnapshot), [snapshot, wsSnapshot])
    const groups = useMemo(() => sessionGroupsOf(wsSnapshot), [wsSnapshot])
    const [catalog, setCatalog] = useState<ReadonlyMap<string, SkillInfo> | null>(null)

    const currentRow = (rows ?? []).find(row => row.current)
    const currentCwd = currentRow?.cwd
    const currentId = currentRow?.id
    useEffect(() => {
      let alive = true
      setCatalog(null)
      void readSkillCatalog(currentCwd, currentId).then((next) => { if (alive && next !== null) setCatalog(next) })
      return () => { alive = false }
    }, [currentCwd, currentId])

    useEffect(() => {
      requestActivityBackfill()
      refreshSessions(ctx)
    }, [])

    useEffect(() => { setPage(0) }, [preset, custom, coverage, day, query, group, pick, sort])

    const currency = activeCurrency()
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000
    const nowForCards = Date.now()
    const allRows = rows ?? []
    const covered = useMemo(() => coveredRowsOf(allRows, coverage), [allRows, coverage])
    const scope = useMemo(
      () => (custom !== null ? dayRangeWindow(custom) : null) ?? rangeWindowOf(preset, nowMinute),
      [custom, preset, nowMinute],
    )
    const spanFrom = scope.start === null ? null : dayKeyOf(scope.start)
    const spanTo = scope.start === null ? null : dayKeyOf(scope.end ?? nowMinute)
    const span = spanFrom !== null && spanTo !== null ? { from: spanFrom, to: spanTo } : null
    const ranged = useMemo(() => filterRows(covered, { scope, day: null, query: '' }), [covered, scope])
    const scoped = useMemo(() => filterRows(ranged, { scope, day, query }), [ranged, scope, day, query])
    const counts = useMemo(() => groupCountsOf(scoped, wsSnapshot), [scoped, wsSnapshot])
    const chips = group !== null && !counts.some(c => c.key === group)
      ? [...counts, { key: group, count: 0 }]
      : counts
    const visible = useMemo(() => sortRows(
      (group === null ? scoped : scoped.filter(row => inGroup(row, group, groups)))
        .filter(row => pick === null || rowHasTally(row, pick.field, pick.name, { scope, day })),
      sort,
    ), [scoped, group, groups, pick, scope, day, sort])
    const paged = pageOf(visible, page)
    const kpi = useMemo(() => kpisOf(ranged, book, currency, scope), [ranged, book, currency, scope])
    const teamTiming = kpi.timing
    const dayAggregator = useRef<DayAggregator | null>(null)
    const days = useMemo(
      () => (dayAggregator.current ??= new DayAggregator()).aggregate(covered, book, currency),
      [covered, book, currency],
    )
    const skillStats = useMemo(() => skillLoadsOf(ranged, { scope, day, sort: skillSort }), [ranged, scope, day, skillSort])
    const toolStats = useMemo(() => tallyStatsOf(ranged, { scope, day, field: 'tools' }), [ranged, scope, day])
    const commandStats = useMemo(() => tallyStatsOf(ranged, { scope, day, field: 'cmds' }), [ranged, scope, day])
    const tallyCards: readonly { kind: TallyCardKind; field: TallyField; stats: TallyStat[] }[] = [
      { kind: 'tool', field: 'tools', stats: toolStats },
      { kind: 'command', field: 'cmds', stats: commandStats },
    ]
    const pickPreset = (range: OverviewRange): void => {
      setPicked(range)
      setCustom(null)
      const state = settings.store.getSnapshot()
      if (state.status === 'ready' && state.writable) settings.set('defaultOverviewRange', range)
    }
    const openOne = (id: string): void => {
      openSessionVia(ctx, id)
    }
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
              <BalanceCapsule />
              <UpdatePill />
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
                      <span className="lc-stat-value">{kpi.cost === null ? '—' : formatCost(kpi.cost, currency)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.pricedSub', { n: kpi.costSessions, total: kpi.sessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cacheHit')}</span>
                      <span className="lc-stat-value">{kpi.cacheHit === null ? '—' : kpi.cacheHit + '%'}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.sessionsSub', { n: kpi.usageSessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.toolCalls')}</span>
                      <span className="lc-stat-value">{fmt(teamTiming?.toolCalls ?? 0)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.toolSub', { dur: fmtDuration(teamTiming?.toolBusyMs ?? teamTiming?.toolsMs ?? 0) })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('timing.total')}</span>
                      <span className="lc-stat-value">{fmtDuration(activeMsOf(teamTiming))}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.wallSub', { n: fmt(teamTiming?.calls ?? 0) })}</span>
                    </div>
                  </div>
                  <OverviewUsage days={days} currency={currency} today={todayKey()} />
                </div>
                <div className="lc-ov-stats">
                  <OverviewTokens tokens={kpi.tokenParts} />
                  <StatsTiming timing={teamTiming} />
                </div>
                <div className="lc-ov-body" ref={bodyRef}>
                  {bodyMounted ? (<>
                    <div className="lc-ov-tiles">
                      <div className="lc-card lc-ov-tile lc-ov-heat-card">
                        <div className="lc-card-title">
                          <span className="lc-card-title-text">
                            <IconGauge size={14} />
                            {t('ov.heat.title')}
                          </span>
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
                      <OverviewSkills
                        stats={skillStats}
                        day={day}
                        selected={pick?.field === 'skills' ? pick.name : null}
                        onSelect={(name) => { setPick(name === null ? null : { field: 'skills', name }) }}
                        sort={skillSort}
                        onSort={setSkillSort}
                        catalog={catalog}
                        now={nowForCards}
                      />
                      {tallyCards.map(card => (
                        <OverviewTally
                          key={card.kind}
                          kind={card.kind}
                          stats={card.stats}
                          day={day}
                          selected={pick?.field === card.field ? pick.name : null}
                          onSelect={(name) => { setPick(name === null ? null : { field: card.field, name }) }}
                          now={nowForCards}
                        />
                      ))}
                    </div>

                    <div className="lc-ov-list">
                      <div className="lc-ov-list-head">
                        <span className="lc-ov-list-title">{t('ov.list.title')}</span>
                        <span className="lc-ov-list-count">{visible.length}</span>
                        {day !== null && (
                          <button type="button" className="lc-ov-day-chip" title={t('ov.list.dayClear')} onClick={() => { setDay(null) }}>
                            {t('ov.list.dayFilter', { day })} ×
                          </button>
                        )}
                        {pick !== null && (
                          <button type="button" className="lc-ov-day-chip" title={t(PICK_FILTER[pick.field].clear)} onClick={() => { setPick(null) }}>
                            {t(PICK_FILTER[pick.field].label, { name: pick.name })} ×
                          </button>
                        )}
                        <ClearableInput
                          className="lc-ov-search"
                          type="search"
                          value={query}
                          placeholder={t('ov.list.search')}
                          clearLabel={t('field.clear')}
                          onChange={setQuery}
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
                                costLabel={cardCostOf(row, book, currency)}
                                now={nowForCards}
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
                  </>) : (<>
                    <div className="lc-ov-tiles">
                      <div className="lc-card lc-deferred-skeleton lc-ov-tile" aria-hidden="true" />
                      <div className="lc-card lc-deferred-skeleton lc-ov-tile" aria-hidden="true" />
                      <div className="lc-card lc-deferred-skeleton lc-ov-tile" aria-hidden="true" />
                      <div className="lc-card lc-deferred-skeleton lc-ov-tile" aria-hidden="true" />
                    </div>
                    <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 320 }} aria-hidden="true" />
                  </>)}
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

function cardCostOf(row: OverviewRow, book: ModelBook | null, currency: CostCurrency): string {
  if (row.familyCost === null) return '—'
  const cost = estimateSessionCost(row.familyCost, book, currency)
  return cost === null ? '—' : formatCost(cost, currency)
}

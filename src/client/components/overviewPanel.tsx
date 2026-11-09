import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { formatCost, toCurrency, type CostCurrency } from '../cost'
import { RING_COLOR } from '../categories'
import { fmt } from '../format'
import {
  currentSessionOf, dayRangeWindow, rangeWindowOf, UNGROUPED_KEY,
  type DayRange, type DayTotals, type OverviewCoverage, type OverviewRange, type OverviewSort,
  type TallyField, type TallyStat,
} from '../overview'
import { useOverviewDays, useOverviewPage, useOverviewSummary, useOverviewTally } from '../overviewSource'
import type { OverviewRange as HostRange, OverviewScope, OverviewSummary } from '../../shared/types'
import { openPluginSettings, openSessionVia, activeMsOf, seatKeyOf, type ClientCtx } from '../services'
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
import { makeOverviewCard, type OverviewCardRow } from './overviewCard'
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
    const configuredRange = useSyncExternalStore(subscribeSettings, () => settings.defaultOverviewRange())
    const [picked, setPicked] = useState<OverviewRange | null>(null)
    const preset = picked ?? configuredRange
    const [custom, setCustom] = useState<DayRange | null>(null)
    const [coverage, setCoverage] = useState<OverviewCoverage>('all')
    const [day, setDay] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string | null>(null)
    const [pick, setPick] = useState<{ field: TallyField; name: string } | null>(null)
    const [sort, setSort] = useState<OverviewSort>('recent')
    const [metric, setMetric] = useState<HeatMetric>('tokens')
    const [page, setPage] = useState(0)
    const { zoneProps, bubble } = useHoverTip()
    const [bodyRef, bodyMounted] = useLazyMount()

    const current = currentSessionOf(props)
    const currentId = current?.id
    const currentCwd = current?.cwd
    const [catalog, setCatalog] = useState<ReadonlyMap<string, SkillInfo> | null>(null)
    useEffect(() => {
      let alive = true
      setCatalog(null)
      void readSkillCatalog(currentCwd, currentId).then((next) => { if (alive && next !== null) setCatalog(next) })
      return () => { alive = false }
    }, [currentCwd, currentId])

    useEffect(() => { setPage(0) }, [preset, custom, coverage, day, query, group, pick, sort])

    const currency = activeCurrency()
    const nowMinute = Math.floor(Date.now() / 60_000) * 60_000
    const nowForCards = Date.now()
    const hostRange = useMemo<HostRange>(() => {
      const window = custom === null ? null : dayRangeWindow(custom)
      if (window !== null && window.start !== null && window.end !== null) return { start: window.start, end: window.end }
      /* v8 ignore next 1 */
      return preset
    }, [custom, preset])
    const scopeWindow = useMemo(
      () => (custom !== null ? dayRangeWindow(custom) : null) ?? rangeWindowOf(preset, nowMinute),
      [custom, preset, nowMinute],
    )
    const spanFrom = scopeWindow.start === null ? null : dayKeyOf(scopeWindow.start)
    const spanTo = scopeWindow.start === null ? null : dayKeyOf(scopeWindow.end ?? nowMinute)
    const span = spanFrom !== null && spanTo !== null ? { from: spanFrom, to: spanTo } : null
    const listScope = useMemo<OverviewScope>(() => ({
      range: hostRange,
      coverage,
      ...(day === null ? {} : { day }),
      ...(group === null ? {} : { group: group === UNGROUPED_KEY ? '__ungrouped__' : group }),
      ...(query.trim() === '' ? {} : { query: query.trim() }),
    }), [hostRange, coverage, day, group, query])
    const tallyScope = useMemo<OverviewScope>(() => ({
      range: hostRange,
      coverage,
      ...(day === null ? {} : { day }),
    }), [hostRange, coverage, day])
    const summaryScope = useMemo<OverviewScope>(() => ({ range: hostRange, coverage }), [hostRange, coverage])
    const daysScope = useMemo<OverviewScope>(() => ({ coverage }), [coverage])
    const summaryState = useOverviewSummary(summaryScope, true)
    const daysState = useOverviewDays(daysScope, true)
    const pageState = useOverviewPage({
      part: 'page',
      scope: listScope,
      sort,
      page,
      ...(pick === null ? {} : { pick }),
    }, true)
    const skillsState = useOverviewTally({ part: 'tally', scope: tallyScope, tally: 'skills' }, bodyMounted)
    const toolsState = useOverviewTally({ part: 'tally', scope: tallyScope, tally: 'tools' }, bodyMounted)
    const cmdsState = useOverviewTally({ part: 'tally', scope: tallyScope, tally: 'cmds' }, bodyMounted)
    const summary: OverviewSummary | null = summaryState.data?.summary ?? null
    const pageValue = pageState.data?.page ?? null
    const pageIndex = pageValue?.index ?? 0
    const pageCount = pageValue?.count ?? 1
    const listTotal = pageValue?.total ?? 0
    const scopeTotal = pageValue?.scopeTotal ?? 0
    const rows = useMemo<OverviewCardRow[]>(
      () => (pageValue?.items ?? []).map(row => ({ ...row, current: currentId === row.id })),
      [pageValue, currentId],
    )
    const chips = useMemo(() => {
      const base = pageValue?.groups ?? []
      return group !== null && !base.some(chip => chip.key === group) ? [...base, { key: group, count: 0 }] : base
    }, [pageValue, group])
    const teamTiming = summary?.timing ?? null
    const days = useMemo<Record<string, DayTotals>>(() => {
      const out: Record<string, DayTotals> = {}
      for (const entry of daysState.data?.days ?? []) {
        out[entry.key] = {
          tokens: entry.tokens,
          sessions: entry.sessions,
          cost: entry.costUsd === null ? null : toCurrency(entry.costUsd, currency),
        }
      }
      return out
    }, [daysState.data, currency])
    const tokenParts = useMemo(() => {
      const parts = summary?.tokenParts ?? null
      if (parts === null) return null
      let total = 0
      const shown: { key: string; color: string; value: number }[] = []
      for (const part of parts) {
        if (!(part.value > 0)) continue
        total += part.value
        shown.push({ key: part.key, color: RING_COLOR[part.key] ?? 'var(--color-gray-400)', value: part.value })
      }
      return { parts: shown, total }
    }, [summary])
    const skillStats = useMemo(() => [...(skillsState.data?.tally.stats ?? [])], [skillsState.data])
    const toolStats = useMemo(() => [...(toolsState.data?.tally.stats ?? [])], [toolsState.data])
    const commandStats = useMemo(() => [...(cmdsState.data?.tally.stats ?? [])], [cmdsState.data])
    const tallyCards: readonly { kind: TallyCardKind; field: TallyField; stats: TallyStat[] }[] = [
      { kind: 'tool', field: 'tools', stats: toolStats },
      { kind: 'command', field: 'cmds', stats: commandStats },
    ]
    const busy = summaryState.pending || daysState.pending || pageState.pending
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
    const sessionsSub = summary === null
      ? '—'
      : coverage === 'all'
        ? t('ov.kpi.inclArchived', { n: summary.archivedScoped })
        : t('ov.kpi.ofTotal', { n: summary.sessionsTotal })

    return (
      <section
        className={'lc-ov-page' + (busy ? ' lc-ov-busy' : '')}
        aria-label={t('ov.title')}
        aria-busy={busy || undefined}
        {...zoneProps}
      >
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

            {pageValue === null && pageState.error ? (
              <div className="lc-empty">{t('ov.unavailable')}</div>
            ) : (
              <>
                <div className="lc-ov-first">
                  <div className="lc-ov-kpis">
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{sessionsLabel}</span>
                      <span className="lc-stat-value">{summary === null ? '—' : summary.sessions}</span>
                      <span className="lc-stat-sub">{sessionsSub}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.tokens')}</span>
                      <span className="lc-stat-value">{summary === null ? '—' : fmt(summary.tokens)}</span>
                      <span className="lc-stat-sub">{t('stats.turns')} {summary === null ? '—' : fmt(summary.turns)}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cost')}</span>
                      <span className="lc-stat-value">{summary === null || summary.costUsd === null ? '—' : formatCost(toCurrency(summary.costUsd, currency), currency)}</span>
                      <span className="lc-stat-sub">{summary === null ? '—' : t('ov.kpi.pricedSub', { n: summary.costSessions, total: summary.sessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cacheHit')}</span>
                      <span className="lc-stat-value">{summary === null || summary.cacheHit === null ? '—' : summary.cacheHit + '%'}</span>
                      <span className="lc-stat-sub">{summary === null ? '—' : t('ov.kpi.sessionsSub', { n: summary.usageSessions })}</span>
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
                  <OverviewTokens tokens={tokenParts} />
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
                        selected={pick !== null && pick.field === 'skills' ? pick.name : null}
                        onSelect={(name) => { setPick(name === null ? null : { field: 'skills', name }) }}
                        catalog={catalog}
                      />
                      {tallyCards.map(card => (
                        <OverviewTally
                          key={card.kind}
                          kind={card.kind}
                          stats={card.stats}
                          day={day}
                          selected={pick !== null && pick.field === card.field ? pick.name : null}
                          onSelect={(name) => { setPick(name === null ? null : { field: card.field, name }) }}
                        />
                      ))}
                    </div>

                    <div className="lc-ov-list">
                      <div className="lc-ov-list-head">
                        <span className="lc-ov-list-title">{t('ov.list.title')}</span>
                        <span className="lc-ov-list-count">{listTotal}</span>
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
                          >{t('ov.range.all')}<span className="lc-ov-chip-n">{scopeTotal}</span></button>
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

                      {rows.length === 0 ? (
                        <div className="lc-empty">{t((summary?.sessionsTotal ?? 0) === 0 ? 'ov.list.empty' : 'ov.list.noMatch')}</div>
                      ) : (
                        <>
                          <div className="lc-ov-grid">
                            {rows.map(row => (
                              <OverviewCard
                                key={row.id}
                                row={row}
                                {...(row.group === undefined ? {} : { group: row.group })}
                                costLabel={cardCostOf(row, currency)}
                                now={nowForCards}
                                onOpen={openOne}
                              />
                            ))}
                          </div>
                          {pageCount > 1 && (
                            <div className="lc-ov-pager" role="navigation" aria-label={t('ov.list.pager')}>
                              <button
                                type="button"
                                className="lc-ov-pager-btn"
                                disabled={pageIndex === 0}
                                aria-label={t('ov.list.prev')}
                                onClick={() => { setPage(pageIndex - 1) }}
                              >‹</button>
                              <span className="lc-ov-pager-n">{t('ov.list.page', { n: pageIndex + 1, total: pageCount })}</span>
                              <button
                                type="button"
                                className="lc-ov-pager-btn"
                                disabled={pageIndex === pageCount - 1}
                                aria-label={t('ov.list.next')}
                                onClick={() => { setPage(pageIndex + 1) }}
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
    return <ErrorBoundary><OverviewBody key={seatKeyOf(props)} {...props} /></ErrorBoundary>
  }
}

function cardCostOf(row: OverviewCardRow, currency: CostCurrency): string {
  return row.costUsd === null ? '—' : formatCost(toCurrency(row.costUsd, currency), currency)
}

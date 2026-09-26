/**
 * The Context Dashboard panel — the cross-session insight surface opened
 * from the sidebar foot (overviewButton.tsx). Rendered from the frame-wide
 * `shell.overlay` slot behind the module store's flag; data rides the
 * root-scope `useSessions` standard kit (every list row's host-cached
 * projection values), so the panel draws every session's insight without
 * opening one log.
 *
 * The panel's first row aggregates the range's sessions into the two donut
 * cards the per-session Context tab opens with — Token Stats (the
 * composition-split billed volume) and Timing Stats (the summed totals) —
 * folded over the KPI band's own scope. Below it, the body is a 3:7 column
 * pair: the insight column (the KPI 2×3 block over the activity heatmap, then
 * the preferences entry row) beside the session column (search, group chips,
 * and the card grid); the heatmap keeps its own fixed 8-week window and PINs
 * the list to a picked day (the panel's drill-down gesture). A session card
 * click jumps to that session through the harness's own selection verb
 * (openSessionVia) and closes the panel.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { estimateSessionCost, formatCost, type CostCurrency, type ModelPrices } from '../cost'
import { fmt } from '../format'
import { useModelPrices } from '../modelPrices'
import {
  aggregateDays, filterRows, groupCountsOf, inGroup, kpisOf,
  pageOf, refreshSessions, requestActivityBackfill, rowsOfSnapshot,
  sessionGroupsOf, sessionsSnapshotOf, sortRows,
  UNGROUPED_KEY, workspacesSnapshotOf,
  type OverviewRange, type OverviewRow, type OverviewSort,
} from '../overview'
import { overviewStore } from '../overviewStore'
import { openSessionVia, type ClientCtx } from '../services'
import { openPluginSettings } from '../settingsJump'
import type { ViewKit } from '../viewkit'
import { makeBalanceCapsule } from './balanceCapsule'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeHeatmap, todayKey, type HeatMetric } from './heatmap'
import { makeDonut } from './donut'
import { makeOverviewTokens } from './overviewTokens'
import { makeStatsTiming } from './statsTiming'
import { ContextIcon } from '../icon'
import { makeOverviewCard } from './overviewCard'
import { IconSettings } from '../primitives'

export interface OverviewPanelProps {
  /** The root standard kit's sessions seat (absent on a harness without it). */
  useSessions?: unknown
  /** The root standard kit's workspaces seat (the cards' breadcrumb grouping). */
  useWorkspaces?: unknown
}

const RANGES: readonly OverviewRange[] = ['24h', '7d', '30d', 'all']
const SORTS: readonly OverviewSort[] = ['recent', 'tokens', 'context']
/** The heatmap's depth metrics, in toggle order (steps is the default). */
const METRICS: readonly HeatMetric[] = ['sessions', 'steps']

export function makeOverviewPanel(ctx: ClientCtx, kit: ViewKit): (props: OverviewPanelProps) => ReactElement | null {
  const { t, fmtDuration } = kit
  const Heatmap = makeHeatmap(kit)
  const OverviewCard = makeOverviewCard(kit)
  const BalanceCapsule = makeBalanceCapsule(ctx, kit)
  // The first row's aggregate pair: the range's sessions folded into the two
  // donut cards the per-session Context tab opens with (Timing Stats reused
  // verbatim over the summed totals).
  const Donut = makeDonut(kit)
  const OverviewTokens = makeOverviewTokens(kit, Donut)
  const StatsTiming = makeStatsTiming(kit, Donut)
  const ErrorBoundary = makeErrorBoundary(t)

  /** The display currency follows the active locale (zh → CNY), read per render — the slot outlet re-renders on a locale switch. */
  function activeCurrency(): CostCurrency {
    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    return active === 'zh' ? 'cny' : 'usd'
  }

  function OverviewBody(props: OverviewPanelProps): ReactElement | null {
    const open = useSyncExternalStore(overviewStore.subscribe, overviewStore.getSnapshot)
    const { prices } = useModelPrices()
    // The hook-level standard-kit reads (unconditional; guarded inside).
    const snapshot = sessionsSnapshotOf(props)
    const wsSnapshot = workspacesSnapshotOf(props)
    const [range, setRange] = useState<OverviewRange>('30d')
    const [day, setDay] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string | null>(null)
    const [sort, setSort] = useState<OverviewSort>('recent')
    const [metric, setMetric] = useState<HeatMetric>('steps')
    const [page, setPage] = useState(0)
    const close = (): void => { overviewStore.set(false) }
    useEscapeClose(open, close)

    const rows = useMemo(() => rowsOfSnapshot(snapshot, wsSnapshot), [snapshot, wsSnapshot])
    const groups = useMemo(() => sessionGroupsOf(wsSnapshot), [wsSnapshot])

    // On open, summon the host's projection warm-up (this panel is the
    // rows' only reader — one pass per host process) and re-pull the list
    // once, so backfilled rows reach a long-connected page.
    useEffect(() => {
      if (open) {
        requestActivityBackfill()
        refreshSessions(ctx)
      }
    }, [open])

    // Any filter change re-anchors the pager at the first page.
    useEffect(() => { setPage(0) }, [range, day, query, group, sort])

    if (!open) return null

    const currency = activeCurrency()
    const now = Date.now()
    const allRows = rows ?? []
    // The range scopes the KPI band, the composition donut, and the grid;
    // the heatmap keeps its own fixed window over the whole list.
    const ranged = filterRows(allRows, { range, day: null, query: '' }, now)
    // The group chips count the day/query-scoped rows BEFORE the group filter
    // applies, so selecting a chip never collapses the row itself.
    const scoped = filterRows(ranged, { range: 'all', day, query }, now)
    const counts = groupCountsOf(scoped, wsSnapshot)
    // A selection whose group fell out of scope keeps a phantom chip (count
    // 0) so the active filter stays visible and one click out of it.
    const chips = group !== null && !counts.some(c => c.key === group)
      ? [...counts, { key: group, count: 0 }]
      : counts
    const visible = sortRows(
      group === null ? scoped : scoped.filter(row => inGroup(row, group, groups)),
      sort,
    )
    const paged = pageOf(visible, page)
    const kpi = kpisOf(ranged, allRows.length, prices, currency)
    const days = aggregateDays(allRows)
    const openOne = (id: string): void => {
      openSessionVia(ctx, id)
      overviewStore.set(false)
    }

    return (
      <div className="lc-ov-backdrop" onClick={close}>
        <div className="lc-ov-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-ov-head">
            <ContextIcon size={18} className="lc-ov-head-icon" />
            <span className="lc-ov-title">{t('ov.title')}</span>
            {/* The DeepSeek platform balance (client/balance.ts): renders nothing
                until a live figure lands, so the header row never reflows for it. */}
            <BalanceCapsule />
            <div className="lc-gran lc-ov-range" role="group" aria-label={t('ov.range.label')}>
              {RANGES.map(r => (
                <button
                  key={r}
                  type="button"
                  className={'lc-gran-btn' + (range === r ? ' lc-gran-on' : '')}
                  onClick={() => { setRange(r) }}
                >{t('ov.range.' + r)}</button>
              ))}
            </div>
            <button type="button" className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-bg-layer-2)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {rows === null ? (
            <div className="lc-empty">{t('ov.unavailable')}</div>
          ) : (
            <>
              {/* The panel's first row: the range's aggregate Token Stats and
                  Timing Stats, folded over the KPI band's own scope (the
                  composition split and summed totals off kpisOf). */}
              <div className="lc-ov-stats">
                <OverviewTokens tokens={kpi.tokenParts} />
                <StatsTiming timing={kpi.timing} />
              </div>
              <div className="lc-ov-body">
                <div className="lc-ov-left">
                  <div className="lc-ov-kpis">
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.sessions')}</span>
                      <span className="lc-stat-value">{kpi.sessions}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.ofTotal', { n: kpi.listed })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.tokens')}</span>
                      <span className="lc-stat-value">{fmt(kpi.tokens)}</span>
                      <span className="lc-stat-sub">{t('stats.turns')} {fmt(kpi.turns)}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cost')}</span>
                      <span className="lc-stat-value">{kpi.cost === null ? '—' : formatCost(kpi.cost, currency)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.sessionsSub', { n: kpi.costSessions })}</span>
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
                  <div className="lc-card lc-ov-heat-card">
                    <div className="lc-card-title">
                      <span className="lc-card-title-text">{t('ov.heat.title')}</span>
                      {/* One wrapper so the right side pushes with a single auto
                          margin (two bare auto-margin siblings would split the
                          free space and drift apart). */}
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
                  {/* The settings entry: one quiet row under the activity card, the
                      same best-effort preferences jump the Context tab's plugin-info
                      row rides. The jump drives the shell chrome behind this
                      overlay, so the panel closes with it to leave the jump visible. */}
                  <button type="button" className="lc-ov-settings" onClick={() => { openPluginSettings(); close() }}>
                    <span className="lc-ov-settings-label"><IconSettings size={14} />{t('plugin.settings')}</span>
                    <span className="lc-ov-settings-hint">{t('plugin.settingsOpen')}</span>
                  </button>
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
                    <input
                      className="lc-ov-search"
                      type="search"
                      value={query}
                      placeholder={t('ov.list.search')}
                      aria-label={t('ov.list.search')}
                      onChange={(ev) => { setQuery(ev.target.value) }}
                    />
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
                            costLabel={cardCostOf(row, prices, currency)}
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
    )
  }

  return function OverviewPanel(props: OverviewPanelProps): ReactElement | null {
    return <ErrorBoundary><OverviewBody {...props} /></ErrorBoundary>
  }
}

/** One card's priced cost label, or the dash (no book yet, nothing billed, unpriceable model). */
function cardCostOf(row: OverviewRow, prices: ModelPrices | null, currency: CostCurrency): string {
  if (row.timeline?.cost === undefined) return '—'
  const cost = estimateSessionCost(row.timeline.cost, prices, currency)
  return cost === null ? '—' : formatCost(cost, currency)
}

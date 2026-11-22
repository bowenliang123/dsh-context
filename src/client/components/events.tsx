import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranch, IconPlus } from '../primitives'
import { formLabelOf, modeLabelOf } from '../labels'
import { MilestoneIcon } from './milestoneIcons'
import type { MilestoneKind } from './timelineMilestones'
import type { Translate } from '../i18n'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'
import { LoadingLane } from './skeleton'
import { remoteStateOf } from './useRemoteState'
import { useSurfaceWindow } from './useRowWindow'

export const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model'] as const

export const EVENT_FILTERS = ['all', ...EVENT_KINDS] as const

export type EventKindFilter = (typeof EVENT_FILTERS)[number]

export function eventFilterLabelOf(t: Translate, filter: EventKindFilter): string {
  return t(filter === 'model' ? 'kind.modelSwitch' : 'kind.' + filter)
}

const EVENT_ICONS: Record<string, string> = { mode: '⇄' }

const EVENT_ROW_ESTIMATE = 25

const eventRowSize = (): number => EVENT_ROW_ESTIMATE

const WORKFLOW_ICON_KINDS: Partial<Record<ContextEventRecord['kind'], MilestoneKind>> = {
  'goal-create': 'goal-create',
  'goal-complete': 'goal-complete',
  'todo-add': 'todo-add',
  'todo-done': 'todo-done',
  ask: 'ask',
  'team-task-create': 'team-task-create',
  'team-task-complete': 'team-task-complete',
}

export interface EventListProps {
  events: ContextEventRecord[]
  state?: DetailState
  onRetry?: () => void
  onEventFocus?: (ev: ContextEventRecord) => void
  canEventFocus?: (ev: ContextEventRecord) => boolean
}

export interface EventLabelParts {
  lead: string
  tail: string
}

function agentOf(ev: ContextEventRecord): string | undefined {
  return ev.agent !== undefined && ev.agent !== '' ? ev.agent : undefined
}

function noticeAgentOf(ev: ContextEventRecord): string | undefined {
  const agent = agentOf(ev)
  return ev.form === 'notice' ? agent : undefined
}

function eventTipOf(ev: ContextEventRecord): string | undefined {
  if (ev.detail === undefined || ev.detail === '') return undefined
  return noticeAgentOf(ev) !== undefined ? ev.detail : undefined
}

export function makeEventText(t: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventLabelParts: (ev: ContextEventRecord) => EventLabelParts
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function labelParts(ev: ContextEventRecord): EventLabelParts {
    if (ev.kind === 'compaction') return { lead: '', tail: t('ev.compaction', { n: ev.count || 0 }) }
    if (ev.kind === 'prune') return { lead: '', tail: t('ev.prune') }
    if (ev.kind === 'model') return { lead: '', tail: t('ev.model', { a: ev.from || '?', b: ev.to || '?' }) }
    if (ev.kind === 'mode') return { lead: '', tail: modeLabelOf(t, ev.name) }
    if (ev.kind === 'agent') {
      return {
        lead: t('ev.agentSpawn'),
        tail: (ev.name ? ' · ' + ev.name : '') + (ev.detail ? ' · ' + ev.detail : ''),
      }
    }
    if (ev.kind === 'goal-create' || ev.kind === 'goal-complete' || ev.kind === 'team-task-complete') {
      return { lead: t('timeline.ms.' + ev.kind), tail: ev.name ? ' · ' + ev.name : '' }
    }
    if (ev.kind === 'todo-add') {
      const count = ev.count ?? 1
      return { lead: t('timeline.ms.todo-add'), tail: count > 1 ? ' · ×' + String(count) : '' }
    }
    if (ev.kind === 'team-task-create') return { lead: t('timeline.ms.team-task-create'), tail: '' }
    if (ev.kind === 'todo-done' || ev.kind === 'ask') {
      const items = ev.items ?? []
      const count = ev.count ?? items.length
      const missing = Math.max(0, count - items.length)
      return {
        lead: t('timeline.ms.' + ev.kind),
        tail: (count > 1 ? ' · ×' + String(count) : '')
          + (items.length > 0 ? ' · ' + items.join(', ') : '')
          + (missing > 0 ? ' +' + String(missing) : ''),
      }
    }
    if (ev.sub === 'skill') return { lead: t('ev.skillLead'), tail: ' · ' + (ev.name || '?') }
    const agent = agentOf(ev)
    return {
      lead: formLabelOf(t, ev.form),
      tail: (ev.name ? ' · ' + ev.name : '')
        + (ev.detail && noticeAgentOf(ev) === undefined ? ' · ' + ev.detail : '')
        + (agent !== undefined ? ' · ' + agent : ''),
    }
  }

  function eventLabel(ev: ContextEventRecord): string {
    const { lead, tail } = labelParts(ev)
    return lead + tail
  }

  function eventAt(ev: ContextEventRecord): string | null {
    if (ev.kind === 'compaction' || ev.kind === 'prune') {
      if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
        if (typeof ev.fromTurn === 'number' && typeof ev.fromStep === 'number') {
          if (ev.fromTurn === ev.turn) return t('events.range', { t: ev.turn, a: ev.fromStep, b: ev.step })
          return t('events.rangeTo', { a: ev.fromTurn, as: ev.fromStep, b: ev.turn, bs: ev.step })
        }
        return t('events.at', { t: ev.turn, s: ev.step })
      }
      return null
    }
    if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
      return t('events.at', { t: ev.turn, s: ev.step })
    }
    return null
  }

  return { eventLabel, eventLabelParts: labelParts, eventAt }
}

function syncTitles(root: HTMLElement): void {
  const labels = root.querySelectorAll<HTMLElement>('.lc-event-label')
  const clipped: HTMLElement[] = []
  for (const el of labels) {
    if (el.scrollWidth > el.clientWidth) clipped.push(el)
  }
  for (const el of labels) {
    el.title = el.getAttribute('data-tip') ?? ''
  }
  for (const el of clipped) {
    const tip = el.getAttribute('data-tip')
    const label = el.textContent || ''
    el.title = tip === null ? label : label + '\n' + tip
  }
}

export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactElement {
  const { t, fmt, fmtTime, eventLabelParts, eventAt } = kit
  const DetailNote = makeDetailNote(kit)
  const labelClass = 'lc-event-label flex-1 @max-[380px]/lc-card:basis-[calc(100%-92px)]'
  return function EventList(props: EventListProps): ReactElement {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const sorted = useMemo(() => props.events.slice().reverse(), [props.events])
    const getKey = useCallback((index: number): string => {
      const ev = sorted[index]
      return String(ev.seq) + ':' + String(ev.ord ?? '') + ':' + ev.kind
    }, [sorted])
    const scope = useSurfaceWindow(rootRef, {
      count: sorted.length,
      getKey,
      estimateSize: eventRowSize,
      overscan: 240,
      seed: 10,
    })
    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      syncTitles(root)
    }, [props.events, scope.from, scope.to])
    useEffect(() => {
      let frame = 0
      const onResize = (): void => {
        if (frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          const root = rootRef.current
          if (root !== null) syncTitles(root)
        })
      }
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('resize', onResize)
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }, [])
    const remote = remoteStateOf(props.events.length, props.state, props.onRetry)
    if (remote.kind === 'loading') return <LoadingLane />
    if (remote.kind === 'failed') return <DetailNote state="failed" onRetry={remote.retry} className="lc-empty lc-lane" />
    if (remote.kind === 'empty') return <div className="lc-empty lc-lane">{t('events.empty')}</div>
    return (
      <div className="lc-events" ref={rootRef} onKeyDown={scope.onKeyDown}>
        {scope.topPad > 0 ? <div className="lc-row-pad" style={{ height: scope.topPad }} aria-hidden="true" /> : null}
        {sorted.slice(scope.from, scope.to + 1).map((ev, offset) => {
          const index = scope.from + offset
          const key = getKey(index)
          const { lead, tail } = eventLabelParts(ev)
          const at = eventAt(ev)
          const workflowIcon = WORKFLOW_ICON_KINDS[ev.kind]
          const glyph = workflowIcon !== undefined ? <MilestoneIcon kind={workflowIcon} />
            : ev.kind === 'agent' ? <MilestoneIcon kind="spawn" />
              : ev.kind === 'compaction' ? <MilestoneIcon kind="compaction" />
                : ev.kind === 'prune' ? <MilestoneIcon kind="prune" />
                  : ev.kind === 'inject' ? <IconPlus />
                    : ev.kind === 'model' ? <IconBranch />
                      : EVENT_ICONS[ev.kind] || '•'
          const jumpable = workflowIcon !== undefined
            || ev.kind === 'inject' || ev.kind === 'compaction' || ev.kind === 'prune' || ev.kind === 'agent'
          const reveal = jumpable && (props.canEventFocus === undefined || props.canEventFocus(ev))
            ? props.onEventFocus
            : undefined
          const label = lead === '' ? tail : <><b>{lead}</b>{tail}</>
          const tip = eventTipOf(ev)
          return (
            <div key={key} ref={scope.measure(key)} className="lc-event @max-[380px]/lc-card:flex-wrap">
              <span className={'lc-event-icon lc-event-' + ev.kind}>{glyph}</span>
              <span className={'lc-kind lc-kind-' + ev.kind}>{t('kind.' + ev.kind)}</span>
              {reveal !== undefined ? (
                <button
                  type="button"
                  className={labelClass + ' lc-event-jump'}
                  tabIndex={scope.tabIndexFor(key)}
                  data-tip={tip}
                  title={tip}
                  onClick={() => { reveal(ev) }}
                >{label}</button>
              ) : (
                <span className={labelClass} data-tip={tip} title={tip}>{label}</span>
              )}
              {at !== null ? <span className="lc-event-at">{at}</span> : null}
              {ev.tokens ? (
                <span
                  className={'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down')}
                  title={ev.grossTokens !== undefined && ev.grossTokens !== ev.tokens
                    ? t('ev.compactionGross', { gross: fmt(ev.grossTokens), net: fmt(ev.tokens) })
                    : undefined}
                >
                  {(ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)}
                </span>
              ) : null}
              <span className="lc-event-time">{fmtTime(ev.time)}</span>
            </div>
          )
        })}
        {scope.bottomPad > 0 ? <div className="lc-row-pad" style={{ height: scope.bottomPad }} aria-hidden="true" /> : null}
      </div>
    )
  }
}

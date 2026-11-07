import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranch, IconPlus } from '../primitives'
import { formLabelOf, modeLabelOf } from '../labels'
import type { Translate } from '../i18n'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'
import { remoteStateOf } from './useRemoteState'

const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', mode: '⇄' }

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
    if (ev.sub === 'skill') return { lead: t('ev.skillLead'), tail: ' · ' + (ev.name || '?') }
    return {
      lead: formLabelOf(t, ev.form),
      tail: (ev.name ? ' · ' + ev.name : '') + (ev.detail ? ' · ' + ev.detail : ''),
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
  for (const el of root.querySelectorAll<HTMLElement>('.lc-event-label')) {
    el.title = el.scrollWidth > el.clientWidth ? el.textContent || '' : ''
  }
}

export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactElement {
  const { t, fmt, fmtTime, eventLabelParts, eventAt } = kit
  const DetailNote = makeDetailNote(kit)
  const labelClass = 'lc-event-label flex-1 @max-[380px]/lc-card:basis-[calc(100%-92px)]'
  return function EventList(props: EventListProps): ReactElement {
    const rootRef = useRef<HTMLDivElement | null>(null)
    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      syncTitles(root)
    }, [props.events])
    useEffect(() => {
      const onResize = (): void => {
        const root = rootRef.current
        if (root !== null) syncTitles(root)
      }
      window.addEventListener('resize', onResize)
      return () => { window.removeEventListener('resize', onResize) }
    }, [])
    const remote = remoteStateOf(props.events.length, props.state, props.onRetry)
    if (remote.kind === 'loading') return <DetailNote state="loading" className="lc-empty lc-lane" />
    if (remote.kind === 'failed') return <DetailNote state="failed" onRetry={remote.retry} className="lc-empty lc-lane" />
    if (remote.kind === 'empty') return <div className="lc-empty lc-lane">{t('events.empty')}</div>
    const sorted = props.events.slice().reverse()
    return (
      <div className="lc-events" ref={rootRef}>
        {sorted.map((ev) => {
          const { lead, tail } = eventLabelParts(ev)
          const at = eventAt(ev)
          const glyph = ev.kind === 'inject' ? <IconPlus />
            : ev.kind === 'model' ? <IconBranch />
              : EVENT_ICONS[ev.kind] || '•'
          const jumpable = ev.kind === 'inject' || ev.kind === 'compaction' || ev.kind === 'prune'
          const reveal = jumpable && (props.canEventFocus === undefined || props.canEventFocus(ev))
            ? props.onEventFocus
            : undefined
          const label = lead === '' ? tail : <><b>{lead}</b>{tail}</>
          return (
            <div key={ev.seq} className="lc-event @max-[380px]/lc-card:flex-wrap">
              <span className={'lc-event-icon lc-event-' + ev.kind}>{glyph}</span>
              <span className={'lc-kind lc-kind-' + ev.kind}>{t('kind.' + ev.kind)}</span>
              {reveal !== undefined ? (
                <button type="button" className={labelClass + ' lc-event-jump'} onClick={() => { reveal(ev) }}>{label}</button>
              ) : (
                <span className={labelClass}>{label}</span>
              )}
              {at !== null ? <span className="lc-event-at">{at}</span> : null}
              {ev.tokens ? (
                <span className={'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down')}>
                  {(ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)}
                </span>
              ) : null}
              <span className="lc-event-time">{fmtTime(ev.time)}</span>
            </div>
          )
        })}
      </div>
    )
  }
}

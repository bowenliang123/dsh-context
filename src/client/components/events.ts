/**
 * Context events — event text helpers (label + timeline range) and the
 * EventList component that renders the events column.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { fmt } from '../format'
import type { Translate } from '../i18n'
import type { ViewKit } from '../viewkit'

const React: typeof ReactNS = require('react')
const h = React.createElement

export const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', inject: '＋', model: '⇄' }

export interface EventListProps { events: ContextEventRecord[] }

/** Build the event text helpers bound to a translate pair (t, tr). */
export function makeEventText(t: Translate, tr: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return tr('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return tr('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'inject') {
      if (ev.sub === 'skill') return tr('ev.skill', { name: ev.name || '?' })
      const base = t('form.' + (ev.form || 'context'))
      return ev.name ? base + ' · ' + ev.name : base
    }
    return ev.kind
  }

  /**
   * Where this event sits in the request timeline, as a label or null.
   * Boundary events (compaction/prune) show the GAP they sit in: same-turn
   * "Step 2→3", cross-turn "Turn 50 · Step 8 → Turn 51 · Step 1". Injections
   * and model switches belong to one request and keep the single point.
   * Events with no following request (in flight) stay unlabeled.
   */
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

  return { eventLabel, eventAt }
}

export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit
  return function EventList(props: EventListProps): ReactNS.ReactElement {
    if (props.events.length === 0) {
      return h('div', { className: 'lc-empty' }, t('events.empty'))
    }
    const sorted = props.events.slice().reverse()
    return h('div', { className: 'lc-events' },
      sorted.map((ev, i) => {
        const label = eventLabel(ev)
        const at = eventAt(ev)
        return h('div', { key: ev.seq + '-' + i, className: 'lc-event' },
          h('span', { className: 'lc-event-icon lc-event-' + ev.kind }, EVENT_ICONS[ev.kind] || '•'),
          h('span', { className: 'lc-event-label', title: label }, label),
          at !== null ? h('span', { className: 'lc-event-at' }, at) : null,
          ev.tokens ? h('span', { className: 'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down') },
            (ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)) : null,
          h('span', { className: 'lc-event-time' }, fmtTime(ev.time)))
      }))
  }
}

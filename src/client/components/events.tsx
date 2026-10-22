/** Inject/model-switch reuse the harness's shared icon set (a platform seed word); compaction/prune keep the ✂
 * marker — no shared glyph exists for them. */

import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranch, IconPlus } from '../primitives'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'

const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', mode: '⇄' }

export interface EventListProps {
  events: ContextEventRecord[]
  /** The timeline source's detail state: with no events, `loading`/`failed` replace the empty claim — an
   * un-fetched list is not an empty one. */
  state?: DetailState
  onRetry?: () => void
  /** A jumpable row's click: an injection reveals its item, a compaction/prune pins the step it landed on. */
  onEventFocus?: (ev: ContextEventRecord) => void
  /** Whether a jumpable row has a landing spot (a boundary row past the retained log has none); absent = all link. */
  canEventFocus?: (ev: ContextEventRecord) => boolean
}

/** Set native `title` on labels whose text overflows (the styled tips cover cards; a plain ellipsis row still needs the
 * native fallback). Reads/writes stay separate and callers gate WHEN this runs, so it never becomes a per-render forced layout. */
function syncTitles(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.lc-event-label')) {
    el.title = el.scrollWidth > el.clientWidth ? el.textContent || '' : ''
  }
}

export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit
  const DetailNote = makeDetailNote(kit)
  // The lane both row shapes share; its 92px basis reservation covers icon + gap + the widest kind chip in both locales.
  const labelClass = 'lc-event-label flex-1 @max-[380px]/lc-card:basis-[calc(100%-92px)]'
  return function EventList(props: EventListProps): ReactElement {
    // Hooks stay unconditional (Rules of Hooks): events going empty → non-empty in one mounted instance must not
    // grow the hook count — an early return above these hooks is a React #310 class bug.
    const rootRef = useRef<HTMLDivElement | null>(null)
    // Truncation titles ride a resize listener plus an events-driven resync: this effect MUST NOT run on every
    // render — a plain re-render would force one synchronous layout per label and rebind the listener.
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
    if (props.events.length === 0) {
      if (props.state === 'loading') return <DetailNote state="loading" className="lc-empty lc-lane" />
      if (props.state === 'failed' && props.onRetry !== undefined) {
        return <DetailNote state="failed" onRetry={props.onRetry} className="lc-empty lc-lane" />
      }
      return <div className="lc-empty lc-lane">{t('events.empty')}</div>
    }
    const sorted = props.events.slice().reverse()
    return (
      <div className="lc-events" ref={rootRef}>
        {sorted.map((ev) => {
          const label = eventLabel(ev)
          const at = eventAt(ev)
          const glyph = ev.kind === 'inject' ? <IconPlus />
            : ev.kind === 'model' ? <IconBranch />
              : EVENT_ICONS[ev.kind] || '•'
          // Key on the durable seq alone: the list renders newest-first, so a fresh event lands at index 0 and an
          // index-bearing key would shift EVERY existing row's key — a full-list remount on every push.
          // Narrow cards (phone panes): the row wraps, folding the meta tail onto line 2 instead of crushing
          // the label into a scrollbar.
          const jumpable = ev.kind === 'inject' || ev.kind === 'compaction' || ev.kind === 'prune'
          const reveal = jumpable && (props.canEventFocus === undefined || props.canEventFocus(ev))
            ? props.onEventFocus
            : undefined
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

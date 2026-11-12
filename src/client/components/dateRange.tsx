import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { MONTH_KEY_RE, monthGridOf, shiftDayKey, shiftMonthKey } from '../../shared/days'
import { orderedDayRange, type DayRange } from '../overview'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'
import { clampPopoverLeft } from './tip'
import { IconChevronDown } from '../primitives'

export interface DateRangeProps {
  value: DayRange | null
  picked: boolean
  onChange: (range: DayRange | null) => void
  today: string
  locale: string
}

const GAP = 6
const MARGIN = 8

const CELL_ID = 'lc-dp-day'

function dayStepOf(key: string): number | null {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  if (key === 'ArrowUp') return -7
  if (key === 'ArrowDown') return 7
  return null
}

export function monthLabelOf(month: string, locale: string): string {
  if (!MONTH_KEY_RE.test(month)) return month
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
}

export function makeDateRange(kit: ViewKit): (props: DateRangeProps) => ReactElement {
  const { t } = kit
  return function DateRange(props: DateRangeProps): ReactElement {
    const [open, setOpen] = useState(false)
    const [month, setMonth] = useState('')
    const [cursor, setCursor] = useState('')
    const [anchor, setAnchor] = useState<string | null>(null)
    const [hover, setHover] = useState<string | null>(null)
    const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)

    const close = (): void => { setOpen(false) }
    useEscapeClose(open, close)

    useEffect(() => {
      if (!open) return undefined
      const onDown = (ev: MouseEvent): void => {
        const target = ev.target
        if (!(target instanceof Node)) return
        if (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
        close()
      }
      window.addEventListener('mousedown', onDown)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      return () => {
        window.removeEventListener('mousedown', onDown)
        window.removeEventListener('scroll', close, true)
        window.removeEventListener('resize', close)
      }
    }, [open])

    useLayoutEffect(() => {
      const anchorEl = rootRef.current
      const panelEl = panelRef.current
      if (!open || anchorEl === null || panelEl === null) return
      const rect = anchorEl.getBoundingClientRect()
      const left = clampPopoverLeft(rect.right, panelEl.offsetWidth, window.innerWidth, MARGIN)
      const below = rect.bottom + GAP
      const top = below + panelEl.offsetHeight > window.innerHeight - MARGIN
        ? Math.max(MARGIN, rect.top - panelEl.offsetHeight - GAP)
        : below
      setSpot(current => current !== null && Object.is(current.left, left) && Object.is(current.top, top) ? current : { left, top })
    })

    const draft = anchor === null ? props.value : orderedDayRange(anchor, hover ?? anchor)
    const grid = open ? monthGridOf(month) : null

    const show = (): void => {
      const home = props.today.slice(0, 7)
      setMonth(home)
      setCursor(`${home}-01`)
      setAnchor(null)
      setHover(null)
      setOpen(true)
    }

    const pick = (key: string): void => {
      if (anchor === null) {
        setAnchor(key)
        setHover(null)
        return
      }
      const next = orderedDayRange(anchor, key)
      setAnchor(null)
      setHover(null)
      setOpen(false)
      props.onChange(next)
    }

    const stepMonth = (delta: number): void => {
      const next = shiftMonthKey(month, delta)
      if (next === null) return
      setMonth(next)
      setCursor(`${next}-01`)
    }

    const onKeyDown = (ev: React.KeyboardEvent): void => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        pick(cursor)
        return
      }
      const step = dayStepOf(ev.key)
      if (step === null) return
      ev.preventDefault()
      const next = shiftDayKey(cursor, step)
      if (next !== null && next <= props.today && next.slice(0, 7) === month) setCursor(next)
    }

    const shown = spot !== null && open ? spot : null
    const from = draft?.from
    const to = anchor !== null && hover === null ? undefined : draft?.to
    return (
      <div className="lc-dp" ref={rootRef}>
        <button
          type="button"
          className={'lc-dp-trigger' + (props.picked ? ' lc-dp-trigger-on' : '')}
          aria-haspopup="dialog"
          aria-expanded={grid !== null}
          aria-label={t('ov.date.open')}
          onClick={() => { if (open) { close() } else { show() } }}
        >
          <span className={'lc-dp-half' + (from === undefined ? ' lc-dp-half-empty' : '')}>{from ?? t('ov.date.from')}</span>
          <span className="lc-dp-sep">→</span>
          <span className={'lc-dp-half' + (to === undefined ? ' lc-dp-half-empty' : '')}>{to ?? t('ov.date.to')}</span>
          <IconChevronDown size={12} />
        </button>
        {grid === null ? null : createPortal(
          <div
            ref={panelRef}
            className="lc-tip lc-dp-panel"
            role="dialog"
            aria-label={t('ov.date.label')}
            style={shown === null
              ? { left: 0, top: 0, visibility: 'hidden' }
              : { left: shown.left, top: shown.top }}
          >
            <div className="lc-dp-nav">
              <button type="button" className="lc-dp-navbtn" aria-label={t('ov.date.prev')} onClick={() => { stepMonth(-1) }}>‹</button>
              <span className="lc-dp-month">{monthLabelOf(month, props.locale)}</span>
              <button
                type="button"
                className="lc-dp-navbtn"
                aria-label={t('ov.date.next')}
                disabled={month >= props.today.slice(0, 7)}
                onClick={() => { stepMonth(1) }}
              >›</button>
            </div>
            <div className="lc-dp-wds" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5, 6].map(d => <span key={d} className="lc-dp-wd">{t(`ov.date.wd.${String(d)}`)}</span>)}
            </div>
            <div
              className="lc-dp-grid"
              role="grid"
              tabIndex={0}
              aria-label={t('ov.date.pick')}
              aria-activedescendant={CELL_ID}
              onKeyDown={onKeyDown}
            >
              {grid.map((week, w) => (
                <div className="lc-dp-week" role="row" key={w}>
                  {week.map((key, d) => {
                    if (key === null) return <span className="lc-dp-cell lc-dp-blank" key={d} />
                    const future = key > props.today
                    const edge = draft !== null && (key === draft.from || key === draft.to)
                    const inRange = draft !== null && key >= draft.from && key <= draft.to
                    const className = 'lc-dp-cell'
                      + (inRange ? ' lc-dp-in' : '')
                      + (edge ? ' lc-dp-edge' : '')
                      + (key === cursor ? ' lc-dp-cursor' : '')
                      + (key === props.today ? ' lc-dp-today' : '')
                      + (future ? ' lc-dp-future' : '')
                    const day = String(Number(key.slice(8, 10)))
                    if (future) {
                      return (
                        <span className={className} role="gridcell" aria-disabled="true" aria-label={key} key={d}>
                          {day}
                        </span>
                      )
                    }
                    return (
                      <span
                        className={className}
                        role="gridcell"
                        id={key === cursor ? CELL_ID : undefined}
                        aria-label={key}
                        aria-selected={edge}
                        key={d}
                        onMouseEnter={() => { if (anchor !== null) setHover(key) }}
                        onClick={() => { pick(key) }}
                      >
                        {day}
                      </span>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="lc-dp-foot">
              <span className="lc-dp-hint">{anchor === null ? t('ov.date.hint') : t('ov.date.hintEnd')}</span>
              {props.picked && (
                <button
                  type="button"
                  className="lc-dp-clear"
                  onClick={() => { props.onChange(null) }}
                >{t('ov.date.clear')}</button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    )
  }
}

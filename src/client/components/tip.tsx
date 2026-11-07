import { useLayoutEffect, useState, type CSSProperties, type MutableRefObject, type ReactElement } from 'react'

export function tipShiftOf(anchor: number, tipWidth: number, frameWidth: number): number {
  const leftOver = tipWidth / 2 - anchor
  if (leftOver > 0) return Math.ceil(leftOver)
  const rightOver = anchor + tipWidth / 2 - frameWidth
  return rightOver > 0 ? Math.ceil(-rightOver) : 0
}

export function clampTipLeft(anchor: number, tipWidth: number, frameWidth: number): number {
  const half = Math.min(tipWidth / 2, frameWidth / 2)
  return Math.round(Math.min(Math.max(anchor, half), frameWidth - half) - tipWidth / 2)
}

export interface TipAnchor {
  unit: 'px' | 'pct'
  value: number
}

export function useTipShift(
  wrapRef: MutableRefObject<HTMLElement | null>,
  tipRef: MutableRefObject<HTMLElement | null>,
  anchor: TipAnchor | null,
): number {
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const wrapW = wrapRef.current?.getBoundingClientRect().width ?? 0
    const tipW = tipRef.current?.getBoundingClientRect().width ?? 0
    setShift((prev) => {
      if (anchor === null || wrapW <= 0 || tipW <= 0) return prev === 0 ? prev : 0
      const next = tipShiftOf(anchor.unit === 'pct' ? anchor.value / 100 * wrapW : anchor.value, tipW, wrapW)
      return next === prev ? prev : next
    })
  })
  return shift
}

export function tipShiftTransform(shift: number): string {
  return shift === 0
    ? 'translateX(-50%)'
    : `translateX(calc(-50% ${shift > 0 ? '+' : '-'} ${Math.abs(shift)}px))`
}

export function tipShiftStyle(shift: number): CSSProperties | undefined {
  return shift === 0 ? undefined : { transform: tipShiftTransform(shift) }
}

export function TipBubble(props: {
  tipRef: MutableRefObject<HTMLDivElement | null>
  className: string
  onClass: string
  shown: boolean
  style: CSSProperties
  head?: string
  figure?: string
  note?: string
}): ReactElement {
  return (
    <div
      ref={props.tipRef}
      className={props.className + (props.shown ? ' ' + props.onClass : '')}
      role={props.shown ? 'tooltip' : undefined}
      style={props.style}
    >
      {props.shown
        ? (
          <>
            <b className="lc-bar-tip-head">{props.head}</b>
            <span className="lc-bar-tip-fig">{props.figure}</span>
            {props.note !== undefined ? <span className="lc-bar-tip-note">{props.note}</span> : null}
          </>
        )
        : null}
    </div>
  )
}

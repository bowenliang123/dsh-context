import { Fragment, memo, type ReactElement } from 'react'

interface ActualCurveProps {
  width: number
  height: number
  runs: string[]
  dots: [number, number][]
}

export const ActualCurve = memo(function ActualCurve(props: ActualCurveProps): ReactElement {
  return (
    <svg className="lc-actual" width={props.width} height={props.height} aria-hidden="true">
      {props.runs.map((pts, i) => (
        <Fragment key={i}>
          <polyline className="lc-actual-line-halo" points={pts} />
          <polyline className="lc-actual-line" points={pts} />
        </Fragment>
      ))}
      {props.dots.map((p, i) => (
        <Fragment key={i}>
          <circle className="lc-actual-dot-halo" cx={p[0]} cy={p[1]} r={2} />
          <circle className="lc-actual-dot" cx={p[0]} cy={p[1]} r={1.2} />
        </Fragment>
      ))}
    </svg>
  )
})

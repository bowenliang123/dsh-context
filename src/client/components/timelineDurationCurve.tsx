import { Fragment, memo, type ReactElement } from 'react'

interface DurationCurveProps {
  width: number
  height: number
  runs: string[]
  dots: [number, number][]
}

export const DurationCurve = memo(function DurationCurve(props: DurationCurveProps): ReactElement {
  return (
    <svg className="lc-duration" width={props.width} height={props.height} aria-hidden="true">
      {props.runs.map((pts, i) => (
        <Fragment key={i}>
          <polyline className="lc-dur-halo" points={pts} />
          <polyline points={pts} />
        </Fragment>
      ))}
      {props.dots.map((p, i) => (
        <Fragment key={i}>
          <circle className="lc-dur-halo" cx={p[0]} cy={p[1]} r={2} />
          <circle cx={p[0]} cy={p[1]} r={1.2} />
        </Fragment>
      ))}
    </svg>
  )
})

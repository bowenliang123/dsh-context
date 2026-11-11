import type { ReactElement } from 'react'

function cls(base: string, extra: string | undefined): string {
  return extra === undefined || extra === '' ? base : base + ' ' + extra
}

export function SkeletonBar(props: { className?: string }): ReactElement {
  return <span className={cls('lc-skel-bar', props.className)} aria-hidden="true" />
}

export function SkeletonRows(props: { rows?: number; className?: string }): ReactElement {
  const count = props.rows ?? 6
  return (
    <div className={cls('lc-skel-rows', props.className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className="lc-skel-bar" />)}
    </div>
  )
}

export function SkeletonPlot(): ReactElement {
  return (
    <div className="lc-skel-plot" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => <span key={i} className="lc-skel-bar" />)}
    </div>
  )
}

export function LoadingLane(props: { className?: string }): ReactElement {
  return (
    <div className={cls('lc-lane lc-loading-lane', props.className)} role="status" aria-busy="true">
      <SkeletonRows rows={9} />
    </div>
  )
}

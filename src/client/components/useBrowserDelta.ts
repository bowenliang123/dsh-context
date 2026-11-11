import { useEffect, useMemo, useState } from 'react'
import type { Assembled } from '../../shared/assemble'
import { incrementOfDelta, type ContextDelta } from '../../shared/delta'
import type { Increment } from '../../shared/increment'
import type { DeltaFetcher } from '../timelineSource'

export interface BrowserDeltaInput {
  fetchDelta?: DeltaFetcher
  seq: number | null
  baseSeq: number | null
  session?: string
  revision: number
  localView: Assembled
  prevView: Assembled | null
  localDiff: Increment
}

export interface BrowserDelta {
  view: Assembled | null
  pending: boolean
  approximate: boolean
  diff: Increment | null
}

export function useBrowserDelta(input: BrowserDeltaInput): BrowserDelta {
  const { fetchDelta, seq, baseSeq, session, revision, localView, prevView, localDiff } = input
  const noFetch = fetchDelta === undefined || (seq === null && baseSeq === null)
  const deltaKey = `${session ?? ''}:${revision}:${seq === null ? 'live' : String(seq)}:${baseSeq === null ? 'none' : String(baseSeq)}`
  const [deltaRead, setDeltaRead] = useState<{ key: string; value: ContextDelta | null } | null>(null)
  useEffect(() => {
    if (fetchDelta === undefined || (seq === null && baseSeq === null)) {
      setDeltaRead(null)
      return undefined
    }
    let cancelled = false
    setDeltaRead(null)
    void fetchDelta(seq, baseSeq).then(
      (value) => { if (!cancelled) setDeltaRead({ key: deltaKey, value }) },
      () => { if (!cancelled) setDeltaRead({ key: deltaKey, value: null }) },
    )
    return () => { cancelled = true }
  }, [fetchDelta, seq, baseSeq, noFetch, deltaKey])
  const settled = deltaRead !== null && deltaRead.key === deltaKey
  const hostDelta = settled ? deltaRead.value : null
  const inc = useMemo(() => (hostDelta === null ? null : incrementOfDelta(hostDelta)), [hostDelta])
  const view = useMemo<Assembled | null>(() => (hostDelta === null || seq === null
    ? null
    : {
      live: false,
      header: hostDelta.viewHeader,
      system: hostDelta.viewSystem,
      nodes: hostDelta.viewNodes,
      missingLive: 0,
      approximate: false,
    }), [hostDelta, seq])
  return {
    view,
    pending: !noFetch && !settled,
    approximate: hostDelta === null && (localView.approximate || prevView?.approximate === true),
    diff: inc ?? (noFetch || settled ? localDiff : null),
  }
}

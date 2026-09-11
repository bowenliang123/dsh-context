/**
 * The stats card seated over the outward sessions service.
 *
 * The cost cell prices the whole subagent subtree, so it has to follow the
 * session list — but that feed pushes on every agent update, and the
 * subscription used to be seated at the Context tab's top level, where each
 * push re-rendered the entire tab (trend chart, request table, browser) to move
 * one number. Seated on the card, a push re-renders the card alone; and a host
 * that does not render the card at all (the right Sidebar's narrow panel, which
 * drops the head row's context cards) neither subscribes nor walks the lineage.
 *
 * The face is the live one (sessionsFace.ts), so a service composed after this
 * mount still lands — the degrade when it never arrives is a lower figure with
 * no signal, which is exactly the case that must not be frozen at mount.
 */

import { useMemo, useSyncExternalStore, type ReactElement } from 'react'
import type { SessionCostUsage, TimelineCounts } from '../../shared/types'
import { sessionsListStore, subagentCostUsage } from '../agentTree'
import type { ClientCtx } from '../services'
import { useSessionsFace } from '../sessionsFace'
import type { makeStatsContext } from './statsContext'

export interface StatsContextSubagentsProps {
  sessionId?: string
  counts: TimelineCounts
  toolCalls?: number
  images?: number
  cost?: SessionCostUsage
  locale: string
}

export function makeStatsContextSubagents(
  ctx: ClientCtx,
  StatsContext: ReturnType<typeof makeStatsContext>,
): (props: StatsContextSubagentsProps) => ReactElement {
  function StatsContextSubagents(props: StatsContextSubagentsProps): ReactElement {
    const face = useSessionsFace(ctx)
    const store = useMemo(() => sessionsListStore(face), [face])
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const sessionId = props.sessionId
    const subagentCost = useMemo(
      () => subagentCostUsage(snapshot, typeof sessionId === 'string' ? sessionId : undefined),
      [snapshot, sessionId],
    )
    return (
      <StatsContext
        counts={props.counts}
        toolCalls={props.toolCalls}
        images={props.images}
        cost={props.cost}
        subagentCost={subagentCost.usage}
        subagentCount={subagentCost.count}
        locale={props.locale}
      />
    )
  }
  return StatsContextSubagents
}

/**
 * The baseline gate's fallback projection units (see host/index.ts).
 *
 * On a harness below the supported baseline (shared/version.ts) the plugin
 * registers these INSTEAD of the real folds: the log's event shapes on such
 * a harness are outside the compat matrix, so nothing is parsed at all —
 * `apply` is the identity over an opaque empty state, and `view` serves a
 * fixed value whose timeline snapshot carries the gate record (`unsupported`:
 * the detected harness version and the baseline). The client's cards render
 * the blank data and its gate modal urges the upgrade; the registry pipeline
 * (fold, cache, push feed) keeps working end to end, so nothing hangs on a
 * loading screen.
 *
 * The definition carries BOTH registry contract generations: the modern
 * `stateSchema` + `wire` block (dsh 0.1.1-rc.1+, the realistic below-baseline
 * case) and the pre-0.1.1 top-level `schema` + `view` aliases that line's
 * registry reads instead. Each registry ignores the other generation's
 * fields, so one definition serves the gate on every harness that can
 * deliver projections to clients at all.
 *
 * `stateVersion` is pinned at 1. Downgrade/upgrade cache choreography: a
 * downgrade to a gated harness refolds the timeline key from scratch (no
 * ver-1 rows exist for it) and seeds the headers key from the real unit's
 * ver-1 rows — stripped to the empty state, which the gate never reads. An
 * upgrade back discards the fallback's ver-1 timeline rows and REJECTS its
 * ver-1 headers rows at the real unit's stricter state schema, refolding
 * both from the log. Nothing stale survives in either direction.
 */

import { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ProjectionDefinition } from './compat'
import { BASELINE_DSH_VERSION } from '../shared/version'
import { contextHeadersSchema } from './headers'
import { contextTimelineSchema } from './timeline'

/**
 * The opaque fold state: the gate folds nothing, so any cached row seeds it
 * (strip-mode object — never a discard, never a throw), and the plain-JSON
 * cache-write gate trivially holds.
 */
const fallbackStateSchema = z.object({})
type FallbackState = z.infer<typeof fallbackStateSchema>

/** The pre-0.1.1 registry contract's fields (see the header note). */
interface LegacyDefinitionShape<V> {
  schema: z.ZodType<V>
  view(state: FallbackState): V
}

/** One gate unit: identity fold over the opaque state, constant view, both contract generations. */
function fallbackDefinition<K extends 'contextTimeline' | 'contextHeaders'>(
  key: K,
  wireSchema: z.ZodType<SessionProjectionMap[K]>,
  value: SessionProjectionMap[K],
): ProjectionDefinition<K, FallbackState> & LegacyDefinitionShape<SessionProjectionMap[K]> {
  const view = (): SessionProjectionMap[K] => value
  return {
    key,
    stateSchema: fallbackStateSchema,
    init: () => ({}),
    apply: state => state,
    wire: { viewSchema: wireSchema, view },
    schema: wireSchema,
    view,
    stateVersion: 1,
  }
}

/**
 * The fallback `contextTimeline` unit: serves the fixed zeroed snapshot
 * naming the detected harness `current` version against the baseline.
 */
export function createFallbackTimelineDefinition(current: string) {
  return fallbackDefinition('contextTimeline', contextTimelineSchema, {
    ok: true,
    unsupported: { current, minimum: BASELINE_DSH_VERSION },
    current: { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  })
}

/**
 * The fallback `contextHeaders` unit: an empty epoch list — the browser's
 * header sections degrade to their metadata-free rendering.
 */
export function createFallbackHeadersDefinition() {
  return fallbackDefinition('contextHeaders', contextHeadersSchema, { headers: [] })
}

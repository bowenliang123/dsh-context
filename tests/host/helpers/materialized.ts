import type { OverviewCache } from '../../../src/host/overviewCache'
import type { HostSession } from '../../../src/host/overviewCorpus'

export function materializedCache(session: HostSession): OverviewCache {
  return {
    load: async (ids) => ({
      sessions: new Map(ids.has(session.id) ? [[session.id, session]] : []),
      identities: new Map(),
      rebuild: new Set(),
    }),
    probe: async ids => ({
      warm: new Set(ids.has(session.id) ? [session.id] : []),
      identities: new Map(),
      rebuild: new Set(),
    }),
    refresh: async () => ({ identities: new Map(), changed: new Set() }),
    capture: async (ids) => new Map(ids.map(id => [id, null])),
    save: async () => true,
    flush: async () => {},
    dispose: async () => {},
  }
}

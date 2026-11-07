export interface ListRecordLike {
  header?: unknown
}

export interface SessionQueryFace {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

export interface ProjectedBlock {
  values?: unknown
  asOfSeq?: unknown
}

export interface SnapshotProjectionsFace {
  snapshot(session: unknown, keys?: ReadonlySet<string> | readonly string[]): ProjectedBlock | undefined
}

export interface StateProjectionsFace {
  stateOf?(session: unknown, key: string): unknown
  snapshot?(session: unknown, keys?: ReadonlySet<string> | readonly string[]): unknown
}

export interface CachedSnapshotFace {
  cachedSnapshot(header: unknown, keys?: ReadonlySet<string> | readonly string[]): ProjectedBlock | undefined
}

export interface SessionsFace {
  get?(id: string): unknown
}

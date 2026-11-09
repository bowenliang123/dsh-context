import { BoundedCache, lruTrim } from './boundedCache'
import type { BoundedCacheOptions } from './boundedCache'

export type RetentionScope = 'global' | 'session' | 'address' | 'owner'

export interface RetentionPolicy {
  scope: RetentionScope
  maxEntries: number
  maxBytes?: number
  maxWeight?: number
  minEntries?: number
  ttlMs?: number
}

const MIB = 1024 * 1024

const MINUTE = 60_000

export const RETENTION = {
  detailStores: { scope: 'session', maxEntries: 64, maxBytes: 6 * MIB, maxWeight: 8 },
  agentHeads: { scope: 'session', maxEntries: 128, maxBytes: MIB, ttlMs: MINUTE },
  historyContent: { scope: 'session', maxEntries: 128, ttlMs: 5 * MINUTE },
  historyHeader: { scope: 'session', maxEntries: 12, ttlMs: 5 * MINUTE },
  fleetPreview: { scope: 'session', maxEntries: 64, maxBytes: 4 * MIB, minEntries: 1, ttlMs: 5 * MINUTE },
  fleetHistory: { scope: 'session', maxEntries: 64, maxBytes: 4 * MIB, minEntries: 1, ttlMs: 5 * MINUTE },
  fleetFull: { scope: 'session', maxEntries: 4, maxBytes: 4 * MIB, minEntries: 1, ttlMs: 5 * MINUTE },
  commandHighlight: { scope: 'global', maxEntries: 600, ttlMs: 10 * MINUTE },
  commandResults: { scope: 'session', maxEntries: 8 },
  contentMissValues: { scope: 'session', maxEntries: 32 },
  historyMissValues: { scope: 'session', maxEntries: 32 },
  modalStores: { scope: 'session', maxEntries: 32, ttlMs: 10 * MINUTE },
  modalPendingConsume: { scope: 'session', maxEntries: 32 },
  pendingFocus: { scope: 'session', maxEntries: 16 },
  memberFocus: { scope: 'session', maxEntries: 8 },
  pendingWarm: { scope: 'session', maxEntries: 32 },
  upgradeDismissed: { scope: 'session', maxEntries: 64 },
  viewScroll: { scope: 'session', maxEntries: 32 },
  attachmentPaths: { scope: 'session', maxEntries: 32 },
  derivedOwner: { scope: 'owner', maxEntries: 16 },
  derivedSeq: { scope: 'owner', maxEntries: 8 },
  statsLanded: { scope: 'session', maxEntries: 256 },
} as const satisfies Record<string, RetentionPolicy>

export type RetentionName = keyof typeof RETENTION

export function retentionOf(name: RetentionName): RetentionPolicy {
  return RETENTION[name]
}

function policyOf(name: RetentionName): RetentionPolicy {
  return RETENTION[name]
}

type RetentionCacheHooks<K, V> = Partial<Pick<
  BoundedCacheOptions<K, V>,
  'sizeOf' | 'weightOf' | 'evictable' | 'onEvict' | 'now'
>>

export function makeRetentionCache<K, V>(name: RetentionName, hooks: RetentionCacheHooks<K, V> = {}): BoundedCache<K, V> {
  const policy = policyOf(name)
  return new BoundedCache<K, V>({
    maxEntries: policy.maxEntries,
    maxBytes: policy.maxBytes,
    maxWeight: policy.maxWeight,
    minEntries: policy.minEntries,
    ttlMs: policy.ttlMs,
    ...hooks,
  })
}

export function trimRetentionMap<K, V>(map: Map<K, V>, name: RetentionName): void {
  lruTrim(map, RETENTION[name].maxEntries)
}

const cleanups = new Set<() => void>()

export function registerRetentionCleanup(cleanup: () => void): () => void {
  cleanups.add(cleanup)
  return () => { cleanups.delete(cleanup) }
}

export function disposeRetention(): void {
  const pending = [...cleanups]
  cleanups.clear()
  for (const cleanup of pending) cleanup()
}

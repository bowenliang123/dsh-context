export function revisionOf(observation: unknown): string | undefined {
  const revision = (observation as { revision?: unknown } | null)?.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

export function disposeObservation(observation: unknown): void {
  const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(observation)
}

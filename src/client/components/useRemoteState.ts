import type { DetailState } from '../timelineSource'

export type RemoteKind = 'idle' | 'loading' | 'failed' | 'empty'

export interface RemoteState {
  kind: RemoteKind
  retry?: () => void
}

export function remoteStateOf(
  count: number,
  state: DetailState | undefined,
  retry?: () => void,
  requireRetryForFailure = true,
): RemoteState {
  if (count > 0) return { kind: 'idle' }
  if (state === 'loading') return { kind: 'loading' }
  if (state === 'failed' && (!requireRetryForFailure || retry !== undefined)) {
    return retry === undefined ? { kind: 'failed' } : { kind: 'failed', retry }
  }
  return { kind: 'empty' }
}

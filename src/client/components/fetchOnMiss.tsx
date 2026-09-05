/**
 * The fetch-on-miss state machine behind the Context browser's two on-demand
 * reads (a row's full message content and a header epoch's prompt/schemas):
 * one targeted history read per key the local data missed, with a visible
 * terminal state for every outcome — `absent` when the durable log does not
 * hold the key, `failed` arming the retry button, never an unhandled
 * rejection or a spinner that never resolves. Landed values cache by key:
 * history is immutable, so a resolved key never refetches.
 */

import type * as ReactNS from 'react'
import type { Translate } from '../i18n'

import { React } from '../react'

export type FetchMissState = 'idle' | 'loading' | 'absent' | 'failed'

export interface FetchOnMiss<T> {
  /** Resolved values by key (immutable history — a landed value never refetches). */
  values: Map<number, T>
  state: FetchMissState
  /** Re-arm the read after a failure (the retry button). */
  retry: () => void
}

/**
 * Run one fetch for `key` when it is set and not yet cached. `key` null (no
 * target open) or `fetcher` undefined (older host without the history face)
 * leaves the machine idle; the caller renders the matching note either way.
 */
export function useFetchOnMiss<T>(
  key: number | null,
  fetcher: ((key: number) => Promise<T | null>) | undefined,
  warn: string,
): FetchOnMiss<T> {
  const [values, setValues] = React.useState<Map<number, T>>(() => new Map())
  const [state, setState] = React.useState<FetchMissState>('idle')
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    if (key === null || fetcher === undefined || values.has(key)) return
    let live = true
    setState('loading')
    fetcher(key).then((value) => {
      if (!live) return
      if (value === null) {
        setState('absent')
        return
      }
      setValues((prev) => {
        const next = new Map(prev)
        next.set(key, value)
        return next
      })
      setState('idle')
    }, (error: unknown) => {
      console.warn(warn, error)
      if (live) setState('failed')
    })
    return () => { live = false }
  }, [key, fetcher, attempt, values])
  return { values, state, retry: () => { setAttempt(a => a + 1) } }
}

/**
 * The note a not-yet-loaded fetch target shows — one expression for both
 * on-demand reads: the legacy static hint (`emptyKey`) when no fetcher is
 * composed, `loading` while the read is in flight (and on the first frame
 * before the effect fires), `notInLog` when the durable log does not hold
 * the key, and a retry button after a failed read.
 */
export function fetchMissNote(
  t: Translate,
  fetcher: unknown,
  state: FetchMissState,
  onRetry: () => void,
  emptyKey: 'browser.noContent' | 'browser.headerMetaOnly',
): ReactNS.ReactNode {
  if (fetcher === undefined) return t(emptyKey)
  if (state === 'absent') return t('browser.notInLog')
  if (state === 'failed') {
    return (
      <button type="button" className="lc-br-retry" onClick={onRetry}>
        {t('browser.loadFailed')}
      </button>
    )
  }
  return t('browser.loading')
}

import { useEffect, useState, type ReactNode } from 'react'
import { trimRetentionMap } from '../retention'
import type { Translate } from '../i18n'

export type FetchMissState = 'idle' | 'loading' | 'absent' | 'failed'

export interface FetchOnMiss<T> {
  values: Map<number, T>
  state: FetchMissState
  retry: () => void
}

type Fetcher<T> = (key: number) => Promise<T | null>

interface MissStore<T> {
  scope: string
  fetcher: Fetcher<T> | undefined
  values: Map<number, T>
  state: FetchMissState
}

const RETRY_MS = 1_000

const RETRY_LIMIT = 3

const MISS_VALUES_SCOPE = 'contentMissValues'

export function useFetchOnMiss<T>(
  key: number | null,
  fetcher: Fetcher<T> | undefined,
  warn: string,
  scope?: string,
): FetchOnMiss<T> {
  const scopeKey = scope ?? ''
  const [store, setStore] = useState<MissStore<T>>(() => ({ scope: scopeKey, fetcher, values: new Map(), state: 'idle' }))
  if (store.scope !== scopeKey || store.fetcher !== fetcher) {
    setStore({ scope: scopeKey, fetcher, values: new Map(), state: 'idle' })
  }
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (key === null || fetcher === undefined || store.values.has(key)) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const attemptRead = (): void => {
      setStore(prev => ({ ...prev, state: 'loading' }))
      fetcher(key).then((value) => {
        if (!live) return
        if (value === null) {
          setStore(prev => ({ ...prev, state: 'absent' }))
          return
        }
        setStore((prev) => {
          const values = new Map(prev.values)
          values.set(key, value)
          trimRetentionMap(values, MISS_VALUES_SCOPE)
          return { ...prev, values, state: 'idle' }
        })
      }, (error: unknown) => {
        if (!live) return
        console.warn(warn, error)
        failures++
        if (failures > RETRY_LIMIT) {
          setStore(prev => ({ ...prev, state: 'failed' }))
          return
        }
        timer = setTimeout(attemptRead, RETRY_MS * 2 ** (failures - 1))
      })
    }
    attemptRead()
    return () => {
      live = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [key, fetcher, scopeKey, store.values, attempt])
  return {
    values: store.values,
    state: store.state,
    retry: () => {
      setStore(prev => ({ ...prev, state: 'loading' }))
      setAttempt(current => current + 1)
    },
  }
}

export function fetchMissNote(
  t: Translate,
  fetcher: unknown,
  state: FetchMissState,
  onRetry: () => void,
  emptyKey: 'browser.noContent' | 'browser.headerMetaOnly',
): ReactNode {
  if (fetcher === undefined) return t(emptyKey)
  if (state === 'absent') return t('browser.notInLog')
  if (state === 'failed') {
    return (
      <button type="button" className="lc-br-retry hover:brightness-[1.15]" onClick={onRetry}>
        {t('browser.loadFailed')}
      </button>
    )
  }
  return t('browser.loading')
}

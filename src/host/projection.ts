import type { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

export interface WiredProjection<K extends keyof SessionProjectionMap, S> {
  key: K
  stateSchema: z.ZodType<S>
  init(): S
  apply(state: S, event: SessionEvent): S
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
    summary?: boolean
  }
  stateVersion: number
}

/** Shared dependency bag for component factories, built once per plugin apply (t, formatters, catLabel, event-text helpers). */

import type { ContextEventRecord } from '../shared/types'
import { fmt, fmtDuration, fmtShare, fmtTime } from './format'
import { makeEventText } from './components/events'
import type { Translate } from './i18n'

export interface ViewKit {
  t: Translate
  fmt: typeof fmt
  fmtTime: typeof fmtTime
  fmtDuration: typeof fmtDuration
  fmtShare: typeof fmtShare
  catLabel: (key: string) => string
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
}

export function makeViewKit(t: Translate): ViewKit {
  const { eventLabel, eventAt } = makeEventText(t)
  return {
    t,
    fmt,
    fmtTime,
    fmtDuration,
    fmtShare,
    catLabel: (key: string) => t('cat.' + key),
    eventLabel,
    eventAt,
  }
}

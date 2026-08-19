/**
 * ViewKit — the shared dependency bag every component factory receives.
 * Built once per `makeView` (i.e. once per plugin apply): translation
 * (bound to the active locale), formatters, category labels, and the event
 * text helpers (event label + boundary range) that several components use.
 */

import type { ContextEventRecord } from '../shared/types'
import { fmt, fmtTime } from './format'
import { makeEventText } from './components/events'
import type { Translate } from './i18n'

export interface ViewKit {
  t: Translate
  fmt: typeof fmt
  fmtTime: typeof fmtTime
  catLabel: (key: string) => string
  eventLabel: (ev: ContextEventRecord) => string
  /** Where the event sits in the request timeline, as a label or null. */
  eventAt: (ev: ContextEventRecord) => string | null
}

export function makeViewKit(t: Translate): ViewKit {
  const { eventLabel, eventAt } = makeEventText(t)
  return {
    t,
    fmt,
    fmtTime,
    catLabel: (key: string) => t('cat.' + key),
    eventLabel,
    eventAt,
  }
}

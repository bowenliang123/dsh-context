import type { ContextEventRecord } from '../shared/types'
import type { Translate } from './i18n'

export const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

export function makeEventText(t: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return t('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return t('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'mode') return t('ev.mode.' + (ev.name || '?'))
    // The kind union narrows to 'inject' here; a new kind breaks the compile (sub/form/name are inject-only), forcing a label.
    if (ev.sub === 'skill') return t('ev.skill', { name: ev.name || '?' })
    const base = t('form.' + (ev.form || 'context'))
    let label = ev.name ? base + ' · ' + ev.name : base
    if (ev.detail) label += ' · ' + ev.detail
    return label
  }

  /** Boundary events (compaction/prune) label the GAP they sit in — same-turn 'T2 S3→4', cross-turn
   * 'T50 S8 → T51 S1'; other kinds keep their single point; no turn/step (in flight) → null. */
  function eventAt(ev: ContextEventRecord): string | null {
    if (ev.kind === 'compaction' || ev.kind === 'prune') {
      if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
        if (typeof ev.fromTurn === 'number' && typeof ev.fromStep === 'number') {
          if (ev.fromTurn === ev.turn) return t('events.range', { t: ev.turn, a: ev.fromStep, b: ev.step })
          return t('events.rangeTo', { a: ev.fromTurn, as: ev.fromStep, b: ev.turn, bs: ev.step })
        }
        return t('events.at', { t: ev.turn, s: ev.step })
      }
      return null
    }
    if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
      return t('events.at', { t: ev.turn, s: ev.step })
    }
    return null
  }

  return { eventLabel, eventAt }
}

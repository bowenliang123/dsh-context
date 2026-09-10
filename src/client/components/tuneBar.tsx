/**
 * TuneBar — the flat auto-compact control strip at the top of the Context
 * tab. Two percentage sliders (pressure trigger point, verbatim tail kept by
 * a compaction) edit a LOCAL draft; an Apply/Discard pair appears while the
 * draft is dirty, and only Apply writes the settings namespace — a stray
 * click on a slider track can never reach the harness. The Host overlays the
 * applied ratios onto the compaction engines' own resolved config, so the
 * values here ARE the threshold the built-in mechanism fires at.
 *
 * The two sliders share the engine's own invariant — the tail stays strictly
 * below the trigger, and neither may reach 0 (the engine's ratio validation
 * rejects it, so 0 would silently mean "unset"). Dragging the trigger below
 * the tail visibly pulls the tail thumb along; Apply writes the pulled pair
 * together, and the Host re-proves the same invariant per engine before any
 * overlay lands. Reset stays an immediate deliberate action: it clears both
 * fields back to "follow the engine".
 */

import { useState, useSyncExternalStore, type ReactElement } from 'react'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'

/** The harness compaction-basic defaults, shown as the sliders' rest positions while unset. */
const DEFAULT_THRESHOLD_PCT = 80
const DEFAULT_RETAIN_PCT = 16
/** Practical floor: below this the pressure check would fire on nearly every step. */
const THRESHOLD_MIN_PCT = 10

/** The local drag draft, in integer percents; `null` = settled (nothing to apply). */
interface Draft {
  threshold?: number
  retain?: number
}

export function makeTuneBar(kit: ViewKit, settings: ContextSettings): () => ReactElement {
  const { t } = kit
  return function TuneBar(): ReactElement {
    const { subscribe, getSnapshot } = settings.store
    const state = useSyncExternalStore(subscribe, getSnapshot)
    const [draft, setDraft] = useState<Draft | null>(null)
    const disabled = state.status !== 'ready' || !state.writable

    // Percent-domain values; the engine defaults double as the unset rest positions.
    const thresholdPct = state.threshold === null ? DEFAULT_THRESHOLD_PCT : Math.round(state.threshold * 100)
    const retainPct = state.retain === null ? DEFAULT_RETAIN_PCT : Math.round(state.retain * 100)
    const shownThreshold = draft?.threshold ?? thresholdPct
    // The tail stays strictly below the trigger — the same invariant the engine enforces.
    const retainMax = shownThreshold - 1
    const shownRetain = Math.min(draft?.retain ?? retainPct, retainMax)
    const dirty = draft !== null

    // Normalize a drag result: fields back at their stored values drop out,
    // and an empty draft settles back to null (no Apply/Discard pair).
    const settle = (next: Draft): void => {
      const threshold = next.threshold !== undefined && next.threshold !== thresholdPct ? next.threshold : undefined
      const retain = next.retain !== undefined && next.retain !== retainPct ? next.retain : undefined
      setDraft(threshold === undefined && retain === undefined
        ? null
        : { ...(threshold !== undefined ? { threshold } : {}), ...(retain !== undefined ? { retain } : {}) })
    }

    const dragThreshold = (pct: number): void => {
      if (disabled) return
      // The tail thumb follows through the display clamp below; Apply lands
      // the pulled pair together (see apply()).
      settle({ threshold: pct })
    }
    const dragRetain = (pct: number): void => {
      if (disabled) return
      // The ceiling trails the (possibly drafted) trigger — the engine's own
      // retention-below-trigger invariant, mirrored live.
      settle({
        ...(draft?.threshold !== undefined ? { threshold: draft.threshold } : {}),
        retain: Math.min(pct, shownThreshold - 1),
      })
    }
    const apply = (): void => {
      /* v8 ignore next 1 -- the pair renders only while a draft exists */
      if (draft === null) return
      const threshold = draft.threshold
      // A pulled tail applies together with its trigger, in engine-valid form.
      const retain = Math.min(draft.retain ?? retainPct, (threshold ?? thresholdPct) - 1)
      if (threshold !== undefined && threshold !== thresholdPct) settings.set('compactionThresholdRatio', threshold / 100)
      if (retain !== retainPct) settings.set('compactionRetainRatio', retain / 100)
      setDraft(null)
    }
    const discard = (): void => { setDraft(null) }
    const reset = (): void => {
      setDraft(null)
      settings.set('compactionThresholdRatio', null)
      settings.set('compactionRetainRatio', null)
    }

    return (
      <div className="lc-tune" role="group" aria-label={t('tune.title')}>
        <span className="lc-tune-name" title={t('tune.hint')}>{t('tune.title')}</span>
        <label className="lc-tune-ctl">
          <span className="lc-tune-tag" title={t('tune.thresholdHint')}>{t('tune.threshold')}</span>
          <input
            type="range"
            min={THRESHOLD_MIN_PCT}
            max={100}
            step={1}
            disabled={disabled}
            value={shownThreshold}
            aria-label={t('tune.threshold')}
            onChange={(e) => { dragThreshold(Number(e.target.value)) }}
          />
          <span
            className={'lc-tune-val'
              + (state.threshold === null ? ' lc-tune-val-default' : '')
              + (draft?.threshold !== undefined && draft.threshold !== thresholdPct ? ' lc-tune-val-dirty' : '')}
            title={shownThreshold === 100 ? t('tune.off') : undefined}
          >
            {shownThreshold}%
            {state.threshold === null ? <em className="lc-tune-chip" title={t('tune.defaultHint')}>{t('tune.default')}</em> : null}
          </span>
        </label>
        <label className="lc-tune-ctl">
          <span className="lc-tune-tag" title={t('tune.retainHint')}>{t('tune.retain')}</span>
          <input
            type="range"
            min={1}
            max={retainMax}
            step={1}
            disabled={disabled}
            value={shownRetain}
            aria-label={t('tune.retain')}
            onChange={(e) => { dragRetain(Number(e.target.value)) }}
          />
          <span
            className={'lc-tune-val'
              + (state.retain === null ? ' lc-tune-val-default' : '')
              + (draft?.retain !== undefined && draft.retain !== retainPct ? ' lc-tune-val-dirty' : '')}
          >
            {shownRetain}%
            {state.retain === null ? <em className="lc-tune-chip" title={t('tune.defaultHint')}>{t('tune.default')}</em> : null}
          </span>
        </label>
        {dirty
          ? (
            <span className="lc-tune-actions">
              <button type="button" className="lc-tune-apply" onClick={apply}>{t('tune.apply')}</button>
              <button type="button" className="lc-tune-discard" onClick={discard}>{t('tune.discard')}</button>
            </span>
          )
          : null}
        <button
          type="button"
          className="lc-tune-reset"
          disabled={disabled || (!dirty && state.threshold === null && state.retain === null)}
          onClick={reset}
        >{t('tune.reset')}</button>
        {!disabled
          ? null
          : (
            <span className="lc-tune-note" role="status">
              {state.status === 'ready' ? t('tune.readOnly') : t('tune.unavailable')}
            </span>
          )}
      </div>
    )
  }
}

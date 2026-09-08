/**
 * dsh-context auto-compact tuning (host half).
 *
 * Swaps the harness compaction engine's OWN resolved config — the same frozen
 * `config` the engine's built-in `agent/pre-step` pressure check reads on
 * every call (`compactIfNeeded` → `resolveTargetPolicy(this.config, …)`) — so
 * the tuned ratio is exercised by the built-in trigger path itself. There is
 * no rival listener and no second policy: the one built-in mechanism simply
 * fires at the user's threshold.
 *
 * Both ratios are fractions of the routed model's context window. The
 * pressure check prices the WHOLE next-request envelope against
 * `floor(window × thresholdRatio)`; a compaction keeps up to
 * `floor(window × retainRatio)` of recent history verbatim, so the gap
 * between the two is what one compaction can free.
 *
 * The constraint model mirrors the engine's own three-level validation:
 * each ratio ∈ (0, 1] (the tail rejects 0); the tail stays strictly below
 * the trigger; and — because a per-model policy threshold wins over the
 * default while that policy still inherits the default tail — the tuned tail
 * must clear the SMALLEST effective trigger across the default route and
 * every policy override. An overlay that cannot hold everywhere leaves the
 * engine exactly as found; a partial overlay is never written.
 *
 * The values come from the plugin's settings namespace (per-user, editable
 * from the Context tab's tune bar). An absent or out-of-range field means
 * "follow the engine's own configuration"; the reconcile pass then restores
 * any previously swapped config, so clearing the setting reverts live.
 *
 * Discovery walks the cordis reflect store for every live `compaction`
 * implementation rather than naming a class or a mounting seam: one pass
 * covers the CLI host-plane row and every web per-preset realm instance, with
 * no compile-time coupling to either harness package. Each engine is guarded
 * structurally and isolated per item — a hostile or unfamiliar implementation
 * degrades to a skip and can never break the turn the sweep rides on. An
 * engine pinning an absolute `retainTokens` keeps its tail untouched (the pin
 * wins in the engine's resolution); a lowered threshold there can in theory
 * strand the pin, but only on sub-token-window scales no real model has.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PluginSettings } from '../shared/types'

/** The settings-namespace read face the tune pass consumes. */
export interface SettingsReadFace {
  /** The re-proved section (only the two ratios are consumed), or `undefined` while no settings provider is composed. */
  read(): Partial<PluginSettings> | undefined
}

/** Ratios to overlay, both optional; `undefined` fields keep the engine's own value. */
export interface TuneWant {
  threshold?: number
  retain?: number
}

/** One engine's pre-tune config, kept until the setting clears. */
interface Stashed {
  original: Record<string, unknown>
  tuned: Record<string, unknown>
  signature: string
}

const stashed = new WeakMap<object, Stashed>()

/** Re-prove a ratio: a finite number in (0, 1]; anything else means "unset". */
function ratioOf(value: unknown, upper: '<=' | '<'): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (upper === '<=' ? value > 1 : value >= 1) return undefined
  return value
}

function wantOf(settings: Partial<PluginSettings> | undefined): TuneWant {
  const threshold = ratioOf(settings?.compactionThresholdRatio, '<=')
  const retain = ratioOf(settings?.compactionRetainRatio, '<')
  return {
    ...(threshold === undefined ? {} : { threshold }),
    ...(retain === undefined ? {} : { retain }),
  }
}

/** A config worth tuning: a plain object whose thresholdRatio is a finite number. */
function tuneableConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof (value as Record<string, unknown>).thresholdRatio === 'number'
    && Number.isFinite((value as Record<string, unknown>).thresholdRatio)
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The smallest trigger any routed model runs with after the overlay: the
 * tuned default for models without an explicit policy, floored by every
 * per-model `thresholdRatio` override (the engine's own resolution lets a
 * policy threshold win over the default while the policy still INHERITS the
 * default tail — `resolveTargetPolicy`). Policies whose shape fails the
 * re-proof are ignored rather than trusted.
 */
function minEffectiveThreshold(original: Record<string, unknown>, tunedThreshold: number): number {
  let min = tunedThreshold
  const policies = original.modelPolicies
  if (Array.isArray(policies)) {
    for (const policy of policies) {
      try {
        if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) continue
        const threshold = numOf((policy as Record<string, unknown>).thresholdRatio)
        if (threshold !== undefined && threshold < min) min = threshold
      } catch {
        // A hostile policy (throws on property access) is ignored, not fatal.
      }
    }
  }
  return min
}

/**
 * Overlay `want` on one engine: stash the original on first touch, write a
 * fresh frozen overlay built from that original (never from a previous
 * overlay, so signature changes cannot stack), and restore when `want` is
 * empty. An overlay is only written when it keeps the engine's own
 * retention-below-threshold invariant; an unusable combination leaves the
 * engine exactly as found.
 */
function tuneOne(engine: unknown, want: TuneWant): void {
  if (engine === null || typeof engine !== 'object') return
  const record = engine as { config?: unknown }
  const prior = stashed.get(engine)
  const signature = `${want.threshold === undefined ? '' : String(want.threshold)}|${want.retain === undefined ? '' : String(want.retain)}`
  if (prior !== undefined && prior.tuned === record.config && prior.signature === signature) return

  // A config that is neither our overlay nor the stashed original means the
  // engine was reconfigured underneath us (patch reload mounts a fresh
  // instance; treat any replacement the same way) — re-base on it.
  const fresh = prior === undefined || prior.tuned !== record.config
  const original = fresh
    ? record.config
    : prior.original
  if (!tuneableConfig(original)) return

  if (want.threshold === undefined && want.retain === undefined) {
    if (!fresh) {
      record.config = prior.original
      stashed.delete(engine)
    }
    return
  }

  const tuned: Record<string, unknown> = { ...original }
  if (want.threshold !== undefined) tuned.thresholdRatio = want.threshold
  // Retention is only meaningful over the ratio form: an explicit retainTokens
  // pin wins in the engine's own resolution and is left untouched here.
  const retainWrite = want.retain !== undefined && tuned.retainTokens === undefined
    ? want.retain
    : undefined
  const threshold = numOf(tuned.thresholdRatio)
  const retain = retainWrite ?? numOf(tuned.retainRatio)
  // Never write an overlay that breaks the engine's own retention-below-
  // trigger invariant (it would refuse every pressure compaction): leave the
  // engine exactly as found instead. The binding check is the SMALLEST
  // effective trigger across the default route and every per-model threshold
  // override — the engine validates that cross-product at load, and a tuned
  // default tail must clear it too. (Absolute-floored tokens can collide only
  // on sub-100-token windows, far below any real model capacity.)
  if (threshold === undefined || (retain !== undefined && retain >= minEffectiveThreshold(original, threshold))) return
  if (retainWrite !== undefined) tuned.retainRatio = retainWrite
  // The original was frozen by the engine's own loader; keep that contract.
  record.config = Object.freeze(tuned)
  stashed.set(engine, { original, tuned: record.config as Record<string, unknown>, signature })
}

/** Live `compaction` service values, straight off the root reflect store. */
function tunedEngines(ctx: Context): unknown[] {
  let store: unknown
  try {
    store = (ctx as { reflect?: { store?: unknown } }).reflect?.store
  } catch {
    return []
  }
  if (store === null || typeof store !== 'object') return []
  const engines: unknown[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    try {
      // The slot is untrusted runtime data: null or primitive records occur.
      const impl: unknown = (store as Record<symbol, unknown>)[key]
      if (impl === null || typeof impl !== 'object') continue
      const record = impl as { name?: unknown; value?: unknown }
      if (record.name !== 'compaction') continue
      if (record.value === undefined || record.value === null) continue
      engines.push(record.value)
    } catch {
      // A hostile impl record is skipped whole.
    }
  }
  return engines
}

/** One reconcile pass: overlay the current setting onto every live engine. */
export function reconcileCompaction(ctx: Context, settings: Partial<PluginSettings> | undefined): void {
  const want = wantOf(settings)
  for (const engine of tunedEngines(ctx)) {
    try {
      tuneOne(engine, want)
    } catch {
      // A hostile engine throws on property access; skip it whole.
    }
  }
}

/**
 * Arm the tuning: one immediate pass plus a sweep on every `agent/pre-step`,
 * so a change lands before the built-in pressure check that same step (this
 * listener registers at boot, ahead of any agent-mounted engine's own). The
 * sweep is bounded — tuning must never break the turn it rides on.
 */
export function installCompactionTune(ctx: Context, settings: SettingsReadFace): void {
  try {
    reconcileCompaction(ctx, settings.read())
  } catch {
    // A failing first read (or a hostile engine) skips only the initial pass;
    // every later step sweeps again.
  }
  ctx.on('agent/pre-step', async (_input, next) => {
    try {
      reconcileCompaction(ctx, settings.read())
    } catch {
      // A failing settings read or hostile engine skips this pass only.
    }
    return next()
  })
}

/**
 * dsh-context user settings — the per-user preference namespace served to
 * browsers through the harness settings seam (`ctx.settings`).
 *
 * Distinct from the cordis `config:` block (config.ts), which is
 * deployment-level: the settings document is per-user and GUI-editable
 * (Settings → Plugins → Plugin configuration, the `settings.plugin.item`
 * card keyed by this namespace, and the Context tab's tune bar). Most fields
 * are client-side display preferences; the compaction ratios are consumed on
 * the Host by the auto-compact tuning pass (compactionTune.ts), following the
 * agent-presets default-preset precedent of a Host-read settings namespace.
 *
 * Optional composition: a deployment without a settings provider never runs
 * the inject callback and browsers simply see no card (schema defaults win);
 * the tune face then reads `undefined` and the engines keep their own config.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { PluginSettings } from '../shared/types'

/** The namespace is the join key between the Host registration and the browser card. */
export const SETTINGS_NAMESPACE = 'dsh-context'

// The preference vocabulary is declared once in shared/types.ts; re-exported
// here so host-side consumers keep their canonical import path.
export type { DefaultFileSort, DefaultGranularity, DefaultTrendMode, PluginSettings } from '../shared/types'

/** Section schema: also the wire envelope the browser scope validates against. */
export const SettingsSchema: z<PluginSettings> = z.object({
  defaultGranularity: z.union(['step', 'turn']).default('step'),
  // Loose: a stale persisted value degrades to the default instead of breaking the section.
  defaultTrendMode: z.union(['total', 'delta']).default('total').loose(),
  defaultFileSort: z.union(['count', 'latest', 'path']).default('count').loose(),
  // Optional ratios (absent/null = follow the engine's own configuration);
  // the tuning pass re-proves range at the point of use, so a stale persisted
  // value degrades to "unset" instead of reaching an engine.
  compactionThresholdRatio: z.number(),
  compactionRetainRatio: z.number(),
})

/** The read face over the registered namespace the Host consumes. */
export interface SettingsReadFace {
  /** The re-proved section, or `undefined` while no settings provider is composed. */
  read(): PluginSettings | undefined
}

/** Re-prove one section at the boundary: bad or stale fields drop to defaults/unset. */
export function prefsOf(value: unknown): PluginSettings | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const ratio = (raw: unknown): number | undefined => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 1) return undefined
    return raw
  }
  const threshold = ratio(v.compactionThresholdRatio)
  const retain = ratio(v.compactionRetainRatio)
  return {
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn'
      ? { defaultGranularity: v.defaultGranularity }
      : { defaultGranularity: 'step' }),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta'
      ? { defaultTrendMode: v.defaultTrendMode }
      : { defaultTrendMode: 'total' }),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path'
      ? { defaultFileSort: v.defaultFileSort }
      : { defaultFileSort: 'count' }),
    ...(threshold === undefined ? {} : { compactionThresholdRatio: threshold }),
    ...(retain === undefined ? {} : { compactionRetainRatio: retain }),
  }
}

/**
 * Serve the namespace while a settings provider is composed, returning the
 * Host-side read face; the face yields `undefined` before the provider
 * resolves (and whenever the section cannot be read) — the tuning pass
 * treats that as "keep the engines' own configuration".
 */
export function installSettings(ctx: Context): SettingsReadFace {
  let section: { get(): unknown } | undefined
  ctx.inject(['settings'], (sctx) => {
    // The settings packages register the raw namespace string (the
    // `settingsNamespace()` brand helper is long gone); the branded cast
    // only satisfies the dsh-settings type face.
    section = sctx.settings.register(SETTINGS_NAMESPACE as SettingsNamespace, SettingsSchema)
  })
  return {
    read() {
      const current = section
      if (current === undefined) return undefined
      try {
        return prefsOf(current.get())
      } catch {
        return undefined
      }
    },
  }
}

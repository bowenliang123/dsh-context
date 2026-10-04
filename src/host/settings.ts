/**
 * dsh-context user settings — the per-user preference namespace served to
 * browsers through the harness settings seam (`ctx.settings`).
 *
 * Distinct from the cordis `config:` block (config.ts), which is
 * deployment-level: the settings document is per-user and GUI-editable (the
 * Plugin configuration card the browser half registers, keyed by this
 * namespace). The Host half only REGISTERS the namespace — every field is a
 * client-side display preference, so nothing here is consumed on the Host.
 *
 * The register face is generation-specific: dsh V4+ removed
 * `settings.register` (configuration forms derive from each loader entry's
 * own Config schema there, a surface this plugin does not publish its
 * preferences through yet), so the callback feature-detects the method and
 * stays inert on a generation without it.
 *
 * Optional composition: a deployment without a settings provider never runs
 * the inject callback and browsers simply see no card (schema defaults win).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** The namespace is the join key between the Host registration and the browser card. */
export const SETTINGS_NAMESPACE = 'dsh-context'

// The preference vocabulary is declared once in shared/types.ts; re-exported
// here so host-side consumers keep their canonical import path.
export type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, PluginSettings } from '../shared/types'

/** Section schema: also the wire envelope the browser scope validates against. */
export const SettingsSchema = z.object({
  // Loose: a stale persisted value degrades to the default instead of breaking the section.
  defaultPlacement: z.union(['all', 'tab', 'sidebar']).default('all').loose(),
  defaultGranularity: z.union(['step', 'turn']).default('step'),
  defaultTrendMode: z.union(['total', 'delta']).default('total').loose(),
  defaultDeltaBase: z.union(['step', 'turn']).default('step').loose(),
  defaultToolSort: z.union(['size', 'count', 'name']).default('count').loose(),
  defaultFileSort: z.union(['count', 'latest', 'path']).default('count').loose(),
  // Loose so a stale value also reads as the default (`show`): a config
  // problem must never take the panel's entry away.
  insightsEntry: z.union(['show', 'hide']).default('show').loose(),
  defaultDurationCurve: z.union(['show', 'hide']).default('show').loose(),
})

/** Serve the namespace while a settings provider with the register face is composed; inert otherwise. */
export function installSettings(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    const service = sctx.settings as typeof sctx.settings & { register?: (ns: SettingsNamespace, schema: unknown) => unknown }
    if (typeof service.register !== 'function') return
    // The settings packages register the raw namespace string (the
    // `settingsNamespace()` brand helper is long gone); the branded cast
    // only satisfies the dsh-settings type face.
    service.register(SETTINGS_NAMESPACE as SettingsNamespace, SettingsSchema)
  })
}

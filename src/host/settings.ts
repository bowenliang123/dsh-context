/**
 * dsh-context user settings — the per-user preference namespace served to
 * browsers through the harness settings seam (`ctx.settings`).
 *
 * Distinct from the cordis `config:` block (config.ts), which is
 * deployment-level: the settings document is per-user and GUI-editable
 * (Settings → Plugins → Plugin configuration, the `settings.plugin.item`
 * card keyed by this namespace). The Host half only REGISTERS the namespace
 * — every field is a client-side display preference, so nothing here is
 * consumed on the Host.
 *
 * Optional composition: a deployment without a settings provider never runs
 * the inject callback and browsers simply see no card (schema defaults win).
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** The namespace is the join key between the Host registration and the browser card. */
export const SETTINGS_NAMESPACE = 'dsh-context'

/** Trend-chart granularity the Context tab opens with. */
export type DefaultGranularity = 'step' | 'turn'

/** The `dsh-context` settings section. */
export interface PluginSettings {
  defaultGranularity: DefaultGranularity
}

/** Section schema: also the wire envelope the browser scope validates against. */
export const SettingsSchema: z<PluginSettings> = z.object({
  defaultGranularity: z.union(['step', 'turn']).default('step'),
})

/** Serve the namespace while a settings provider is composed; inert otherwise. */
export function installSettings(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), SettingsSchema)
  })
}

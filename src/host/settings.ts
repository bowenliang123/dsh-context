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
})

/** Serve the namespace while a settings provider is composed; inert otherwise. */
export function installSettings(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    // The settings packages register the raw namespace string (the
    // `settingsNamespace()` brand helper is long gone); the branded cast
    // only satisfies the dsh-settings type face.
    sctx.settings.register(SETTINGS_NAMESPACE as SettingsNamespace, SettingsSchema)
  })
}

/**
 * PluginInfo — the card beside Context stats introducing the plugin itself.
 * Every row is one whole-row link: the anchor wraps the label + value so the
 * entire key/value cell is one hit target. Row 1 (Plugin name + version) →
 * the repo's releases page, row 2 (the short owner/repo label) → the repo
 * root; hovering a row underlines its value. Metadata is baked into the
 * bundle from package.json via tsup `define` (see src/client/meta.ts +
 * tsup.config.ts). One live check rides on top: the card asks the npm
 * registry for the latest published version (cached with a 1-hour TTL, see
 * ../latestVersion.ts) and shows an `↑ vX.Y.Z` chip when it is newer.
 *
 * Layout: exactly two full-width rows, each a single horizontal line with
 * the label on the left and the value on the right — a compact definition
 * list instead of a multi-cell grid.
 */

import type * as ReactNS from 'react'
import { fetchLatestVersion, isNewerVersion } from '../latestVersion'
import { PLUGIN_NAME, PLUGIN_REPO, PLUGIN_REPO_SHORT, PLUGIN_VERSION } from '../meta'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export function makePluginInfo(kit: ViewKit): () => ReactNS.ReactElement {
  const { t } = kit
  const row = (label: string, value: ReactNS.ReactNode, href: string) => (
    <a className="lc-pi-row" href={href} target="_blank" rel="noreferrer">
      <div className="lc-pi-label">{label}</div>
      <div className="lc-pi-value">{value}</div>
    </a>
  )
  return function PluginInfo(): ReactNS.ReactElement {
    const [latest, setLatest] = React.useState<string | null>(null)
    React.useEffect(() => {
      // Dev bundles carry a `0.0.0-dev` placeholder version: skip the check.
      if (PLUGIN_VERSION.includes('-dev')) return
      let on = true
      fetchLatestVersion().then((v) => { if (on && v) setLatest(v) })
      return () => { on = false }
    }, [])
    const update = latest !== null && isNewerVersion(latest, PLUGIN_VERSION) ? latest : null
    const nameValue: ReactNS.ReactNode[] = [PLUGIN_NAME + ' (v' + PLUGIN_VERSION + ')']
    if (update) nameValue.push(<span key="update" className="lc-pi-update">{'↑ v' + update}</span>)
    return (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('plugin.title')}</span>
          <span className="lc-card-sub">{t('plugin.hint')}</span>
        </div>
        <div className="lc-pi-grid">
          {row(t('plugin.name'), nameValue, PLUGIN_REPO + '/releases')}
          {row(t('plugin.github'), PLUGIN_REPO_SHORT, PLUGIN_REPO)}
        </div>
      </div>
    )
  }
}

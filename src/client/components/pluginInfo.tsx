/**
  * PluginInfo — the card beside Context stats introducing the plugin. Metadata is baked in from package.json via tsdown `define` (see
  * meta.ts); one live npm-registry check (latestVersion.ts, 1-hour TTL) appends an `↑ vX.Y.Z` chip when newer.
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
      if (PLUGIN_VERSION.includes('-dev')) return
      let on = true
      // Fire-and-forget: fetchLatestVersion never rejects (every failure
      // narrows to null), and the `on` flag drops late results.
      void fetchLatestVersion().then((v) => { if (on && v) setLatest(v) })
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

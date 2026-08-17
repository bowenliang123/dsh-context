/**
 * PluginInfo — the card beside Context stats introducing the plugin itself:
 * name, version, and GitHub repository. The latest npm release is checked
 * once per page lifetime against the npm registry (a failed check stays
 * silent); any version difference turns the version cell into an "Update!"
 * link to the npm page, with the update command on hover. JSX component.
 */

import type * as ReactNS from 'react'
import { PLUGIN_NAME, PLUGIN_NPM, PLUGIN_REPO, PLUGIN_REPO_SHORT, PLUGIN_VERSION } from '../meta'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

// Module-level latest-release cache: one registry fetch per page lifetime,
// shared across tab remounts. undefined = not fetched yet, null = the check
// failed (offline / blocked) and the version cell stays plain.
let latestCache: string | null | undefined

export function makePluginInfo(kit: ViewKit): () => ReactNS.ReactElement {
  const { t, tr } = kit
  return function PluginInfo(): ReactNS.ReactElement {
    const [latest, setLatest] = React.useState<string | null | undefined>(latestCache)

    React.useEffect(() => {
      if (latestCache !== undefined) return undefined
      let alive = true
      fetch('https://registry.npmjs.org/' + PLUGIN_NAME + '/latest')
        .then(res => (res.ok ? res.json() : null))
        .then(body => {
          if (!alive) return
          latestCache = body && typeof body.version === 'string' ? body.version : null
          setLatest(latestCache)
        })
        .catch(() => {
          if (!alive) return
          latestCache = null
          setLatest(null)
        })
      return () => {
        alive = false
      }
    }, [])

    // Any difference from the registry release (newer OR older, e.g. a dev
    // build) is worth surfacing — the fix is the same update command.
    const update = typeof latest === 'string' && latest !== PLUGIN_VERSION

    // The whole cell is the link (not just the value text): an anchor with
    // the stat-cell chrome, so the entire padded box is one hit target.
    const cell = (label: string, value: ReactNS.ReactNode, href: string, title?: string) => (
      <a className="lc-stat lc-stat-cell" href={href} target="_blank" rel="noreferrer" title={title}>
        <span className="lc-stat-label">{label}</span>
        <b className="lc-stat-value lc-stat-link">{value}</b>
      </a>
    )

    return (
      <div className="lc-card lc-col lc-col-plugin">
        <div className="lc-card-title">
          {t('plugin.title')}
          <span className="lc-card-sub">{t('plugin.hint')}</span>
        </div>
        <div className="lc-stats">
          {cell(t('plugin.name'), PLUGIN_NAME, PLUGIN_REPO)}
          {cell(
            t('plugin.version'),
            <>
              {'v' + PLUGIN_VERSION}
              {update ? <span className="lc-update-badge">{t('plugin.updateBadge')}</span> : null}
            </>,
            PLUGIN_NPM,
            update ? tr('plugin.updateTip', { v: latest ?? '' }) : undefined,
          )}
          {cell('GitHub', PLUGIN_REPO_SHORT + ' ↗', PLUGIN_REPO)}
        </div>
      </div>
    )
  }
}

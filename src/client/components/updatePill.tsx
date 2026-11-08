import type { ReactElement } from 'react'
import { useNewerVersion } from '../versionSource'
import { PLUGIN_REPO } from '../meta'
import type { ViewKit } from '../viewkit'

const RELEASES_URL = PLUGIN_REPO + '/releases/latest'

export function makeUpdatePill(kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  return function UpdatePill(): ReactElement | null {
    const update = useNewerVersion()
    if (update === null) return null
    const tip = t('update.tip', { version: 'v' + update })
    return (
      <a
        className="lc-ov-update"
        href={RELEASES_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={tip}
        data-lc-tip={tip}
        data-lc-tip-side="bottom"
      >
        <span className="lc-ov-update-label">{t('update.label')}</span>
        <span className="lc-ov-update-version">↑ v{update}</span>
      </a>
    )
  }
}

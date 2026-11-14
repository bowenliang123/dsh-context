import type { ReactElement, ReactNode } from 'react'
import { IconPlugin, IconSettings } from '../primitives'
import { siDeepseek, siGithub, type SimpleIcon } from 'simple-icons'
import { useNewerVersion } from '../versionSource'
import { PLUGIN_NAME, PLUGIN_REPO, PLUGIN_REPO_SHORT, PLUGIN_VERSION } from '../meta'
import { openPluginSettings, type ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

function SiteMark({ icon }: { icon: SimpleIcon }): ReactElement {
  return (
    <svg width={12} height={12} className="lc-pi-labelicon" viewBox="-2 -2 28 28" fill="none" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}

export function makePluginInfo(kit: ViewKit, ctx: ClientCtx): () => ReactElement {
  const { t } = kit
  const row = (icon: ReactElement, label: string, value: ReactNode, href: string, hint: string, jump?: () => boolean) => (
    <a
      className="lc-pi-row group/pi"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={jump === undefined ? undefined : (event) => { if (jump()) event.preventDefault() }}
    >
      <div className="lc-pi-label">{icon}{label}</div>
      <div className="lc-pi-value group-hover/pi:underline" title={hint}>{value}</div>
    </a>
  )
  return function PluginInfo(): ReactElement {
    const update = useNewerVersion()
    const nameText = PLUGIN_NAME + ' (v' + PLUGIN_VERSION + ')'
    const nameValue: ReactNode[] = [nameText]
    if (update) nameValue.push(<span key="update" className="lc-pi-update">{'↑ v' + update}</span>)
    return (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconPlugin size={14} />
            {t('plugin.title')}
          </span>
          <a className="lc-card-sub lc-pi-hint hover:underline" href={PLUGIN_REPO} target="_blank" rel="noreferrer">
            {t('plugin.hint')}
          </a>
        </div>
        <div className="lc-pi-grid">
          {row(
            <SiteMark icon={siDeepseek} />,
            t('plugin.name'),
            nameValue,
            PLUGIN_REPO,
            update !== null ? t('update.tip', { version: 'v' + update }) : nameText,
            update !== null ? () => openPluginSettings(ctx) : undefined,
          )}
          {row(<SiteMark icon={siGithub} />, t('plugin.github'), PLUGIN_REPO_SHORT, PLUGIN_REPO, PLUGIN_REPO_SHORT)}
          <button type="button" className="lc-pi-row lc-pi-row-btn group/pi" onClick={() => { openPluginSettings(ctx) }}>
            <div className="lc-pi-label"><IconSettings size={12} className="lc-pi-labelicon" />{t('plugin.settings')}</div>
            <div className="lc-pi-value group-hover/pi:underline" title={t('plugin.settingsOpen')}>{t('plugin.settingsOpen')}</div>
          </button>
        </div>
      </div>
    )
  }
}

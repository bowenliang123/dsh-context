/**
 * The dsh-context card in Settings → Plugins → Plugin configuration.
 *
 * The tab dispatches one `settings.plugin.item` slot key per Host-served
 * settings namespace; this card claims the `dsh-context` key and owns its
 * internals (the section supplies nothing). It renders nothing while the
 * namespace is unavailable — a deployment that does not compose the Host
 * half (or a remote browser, where settings stay process-local) shows no
 * trace of it.
 */

import type * as ReactNS from 'react'
import { h } from '../react'
import type { DefaultGranularity, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

/** Props the renderer binds: the hooks-compartment selector + the write action. */
export interface SettingsCardProps {
  useContextSettings?: <T>(selector: (state: SettingsState) => T) => T
  choose?: (granularity: DefaultGranularity) => void
}

export function makeSettingsCard(kit: ViewKit): (props: SettingsCardProps) => ReactNS.ReactElement | null {
  const { t } = kit
  return function SettingsCard(props: SettingsCardProps): ReactNS.ReactElement | null {
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    const disabled = state.status !== 'ready' || !state.writable
    const option = (granularity: DefaultGranularity, label: string): ReactNS.ReactElement =>
      h('button', {
        type: 'button',
        className: 'lc-gran-btn' + (state.granularity === granularity ? ' lc-gran-on' : ''),
        disabled,
        'aria-pressed': state.granularity === granularity,
        onClick: () => { props.choose?.(granularity) },
      }, label)
    return h('li', { className: 'lc-settings-card' },
      h('div', { className: 'lc-settings-head' },
        h('span', { className: 'lc-settings-name' }, t('settings.title')),
        h('span', { className: 'lc-settings-desc' }, t('settings.desc'))),
      h('div', { className: 'lc-settings-row' },
        h('span', { className: 'lc-settings-label' }, t('settings.gran')),
        h('span', { className: 'lc-gran' },
          option('step', t('gran.step')),
          option('turn', t('gran.turn')))),
      !state.writable && state.status === 'ready'
        ? h('p', { className: 'lc-settings-note', role: 'status' }, t('settings.readOnly'))
        : null)
  }
}

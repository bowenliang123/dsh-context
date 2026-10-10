/** The dsh-context preference card, keyed on the Host-served `dsh-context` namespace: while that namespace is
 * unavailable (a deployment without the Host half, or a remote browser) the card renders nothing. */

import { useState, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../primitives'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

export interface SettingsCardProps {
  useContextSettings?: <T>(selector: (state: SettingsState) => T) => T
  set?: (field: SettingsField, value: string) => void
}

interface PrefRowProps {
  label: string
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onPick: (id: string) => void
}

function PrefRow(props: PrefRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const active = props.options.find(o => o.id === props.value)?.label ?? props.value
  return (
    <div className="lc-settings-row">
      <span className="lc-settings-label">{props.label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={props.options}
        selectedId={props.value}
        onSelect={(id) => { setOpen(false); props.onPick(id) }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className="lc-settings-select hover:enabled:bg-(--dsw-alias-interactive-bg-hover) disabled:opacity-50 disabled:cursor-default"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {active}
            <IconChevronDown />
          </button>
        )}
      />
    </div>
  )
}

type Translate = ViewKit['t']

/** The three on/off gates (entry visibility, the Fleet tab, the trend duration curve) share one row shape. */
function ShowHideRow(props: { t: Translate; label: string; value: string; disabled: boolean; onPick: (id: string) => void }): ReactElement {
  return (
    <PrefRow
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      options={[
        { id: 'show', label: props.t('showHide.show') },
        { id: 'hide', label: props.t('showHide.hide') },
      ]}
      onPick={props.onPick}
    />
  )
}

function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <PrefRow
        label={t('settings.placement')}
        value={state.placement}
        disabled={disabled}
        options={[
          { id: 'all', label: t('placement.all') },
          { id: 'tab', label: t('placement.tab') },
          { id: 'sidebar', label: t('placement.sidebar') },
        ]}
        onPick={(id) => { set?.('defaultPlacement', id) }}
      />
      <ShowHideRow t={t} label={t('settings.insightsEntry')} value={state.insightsEntry} disabled={disabled}
        onPick={(id) => { set?.('insightsEntry', id) }} />
      <ShowHideRow t={t} label={t('settings.fleetTab')} value={state.fleetTab} disabled={disabled}
        onPick={(id) => { set?.('fleetTab', id) }} />
      <PrefRow
        label={t('settings.gran')}
        value={state.granularity}
        disabled={disabled}
        options={[
          { id: 'step', label: t('gran.step') },
          { id: 'turn', label: t('gran.turn') },
        ]}
        onPick={(id) => { set?.('defaultGranularity', id) }}
      />
      <PrefRow
        label={t('settings.mode')}
        value={state.mode}
        disabled={disabled}
        options={[
          { id: 'total', label: t('gran.total') },
          { id: 'delta', label: t('gran.delta') },
        ]}
        onPick={(id) => { set?.('defaultTrendMode', id) }}
      />
      <ShowHideRow t={t} label={t('settings.durationCurve')} value={state.durationCurve} disabled={disabled}
        onPick={(id) => { set?.('defaultDurationCurve', id) }} />
      <PrefRow
        label={t('settings.deltaBase')}
        value={state.deltaBase}
        disabled={disabled}
        options={[
          { id: 'step', label: t('browser.base.step') },
          { id: 'turn', label: t('browser.base.turn') },
        ]}
        onPick={(id) => { set?.('defaultDeltaBase', id) }}
      />
      <PrefRow
        label={t('settings.toolSort')}
        value={state.toolSort}
        disabled={disabled}
        options={[
          { id: 'size', label: t('tool.sort.size') },
          { id: 'count', label: t('tool.sort.count') },
          { id: 'name', label: t('tool.sort.name') },
        ]}
        onPick={(id) => { set?.('defaultToolSort', id) }}
      />
      <PrefRow
        label={t('settings.fileSort')}
        value={state.fileSort}
        disabled={disabled}
        options={[
          { id: 'count', label: t('files.sort.count') },
          { id: 'latest', label: t('files.sort.latest') },
          { id: 'path', label: t('files.sort.path') },
        ]}
        onPick={(id) => { set?.('defaultFileSort', id) }}
      />
    </>
  )
}

/** The Plugins page owns the bundle's page and section chrome, so the rows render flat; unserved or absent degrades to nothing. */
export function makePluginConfigCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  return function PluginConfigCard(props: SettingsCardProps): ReactElement | null {
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <div className="lc-settings-prefs">
        {!state.writable && state.status === 'ready'
          ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
          : null}
        <PreferenceRows t={t} state={state} set={props.set} />
      </div>
    )
  }
}

/**
 * The dsh-context card in Settings → Plugins → Plugin configuration.
 *
 * The tab dispatches one `settings.plugin.item` slot key per Host-served
 * settings namespace; this card claims the `dsh-context` key and owns its
 * internals (the section supplies nothing). It renders nothing while the
 * namespace is unavailable — a deployment that does not compose the Host
 * half (or a remote browser, where settings stay process-local) shows no
 * trace of it.
 *
 * The chrome mirrors the official plugin cards: collapsed by default, the
 * header button discloses the controls in place. Each preference row is the
 * framework's settings-row pattern — a selector pill opening the shared
 * `Menu` dropdown — and picking an option writes immediately through the
 * settings scope (display preferences, like the official Language row).
 */

import type * as ReactNS from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { React } from '../react'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

/** Props the renderer binds: the hooks-compartment selector + the write action. */
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

/** One preference row: label + selector pill opening the framework Menu. */
function PrefRow(props: PrefRowProps): ReactNS.ReactElement {
  const [open, setOpen] = React.useState(false)
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
            className="lc-settings-select"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {active}
            <IconChevronDownOutline14 />
          </button>
        )}
      />
    </div>
  )
}

export function makeSettingsCard(kit: ViewKit): (props: SettingsCardProps) => ReactNS.ReactElement | null {
  const { t } = kit
  return function SettingsCard(props: SettingsCardProps): ReactNS.ReactElement | null {
    const [open, setOpen] = React.useState(false)
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    const disabled = state.status !== 'ready' || !state.writable
    return (
      <li className={'lc-settings-card' + (open ? ' lc-settings-open' : '')}>
        <button
          type="button"
          className="lc-settings-head"
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${t('settings.title')}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className="lc-settings-headtext">
            <span className="lc-settings-name">{t('settings.title')}</span>
            <span className="lc-settings-desc">{t('settings.desc')}</span>
          </span>
          <IconChevronDownOutline14 className="lc-settings-chevron" />
        </button>
        {open
          ? (
            <div className="lc-settings-body">
              {!state.writable && state.status === 'ready'
                ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
                : null}
              <PrefRow
                label={t('settings.gran')}
                value={state.granularity}
                disabled={disabled}
                options={[
                  { id: 'step', label: t('gran.step') },
                  { id: 'turn', label: t('gran.turn') },
                ]}
                onPick={(id) => { props.set?.('defaultGranularity', id) }}
              />
              <PrefRow
                label={t('settings.mode')}
                value={state.mode}
                disabled={disabled}
                options={[
                  { id: 'total', label: t('gran.total') },
                  { id: 'diff', label: t('gran.diff') },
                ]}
                onPick={(id) => { props.set?.('defaultTrendMode', id) }}
              />
            </div>
          )
          : null}
      </li>
    )
  }
}

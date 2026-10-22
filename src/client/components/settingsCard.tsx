/** The dsh-context preference card, keyed on the Host-served `dsh-context` namespace: while that namespace is
 * unavailable (a deployment without the Host half, or a remote browser) the card renders nothing. */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../primitives'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

interface SettingsCardProps {
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

interface PromptTextRowProps {
  label: string
  placeholder: string
  value: string
  disabled: boolean
  onCommit: (text: string) => void
}

/** One free-text preference row: a local draft committed on blur (and on an
 *  unmount without a prior blur), so typing never writes the wire per keystroke. */
function PromptTextRow(props: PromptTextRowProps): ReactElement {
  const [draft, setDraft] = useState(props.value)
  const [focused, setFocused] = useState(false)
  const latest = useRef({ draft: props.value, value: props.value, commit: props.onCommit })
  latest.current = { draft, value: props.value, commit: props.onCommit }
  // Follow the served value only while the row is idle: a host push (or the
  // optimistic echo) must never clobber in-progress typing.
  if (!focused && draft !== props.value) setDraft(props.value)
  useEffect(() => () => {
    const { draft: text, value, commit } = latest.current
    if (text !== value) commit(text)
  }, [])
  const rows = Math.min(8, Math.max(2, draft.split('\n').length))
  return (
    <div className="lc-settings-row lc-settings-textrow">
      <span className="lc-settings-label">{props.label}</span>
      <textarea
        className="lc-settings-textarea"
        rows={rows}
        placeholder={props.placeholder}
        disabled={props.disabled}
        value={draft}
        onFocus={() => { setFocused(true) }}
        onBlur={() => {
          setFocused(false)
          if (draft !== props.value) props.onCommit(draft)
        }}
        onChange={(event) => { setDraft(event.target.value) }}
      />
    </div>
  )
}

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

/** One titled preference group: the harness projects no group chrome into the
 *  `plugins.bundle.config` slot, so the card draws its own — a small heading over
 *  its rows, a hairline separating the groups. */
function Group(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="lc-settings-group" role="group" aria-label={props.title}>
      <div className="lc-settings-group-title">{props.title}</div>
      {props.children}
    </div>
  )
}

function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <Group title={t('settings.group.entry')}>
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
      </Group>
      <Group title={t('settings.group.view')}>
        <PrefRow
          label={t('settings.overviewRange')}
          value={state.overviewRange}
          disabled={disabled}
          options={[
            { id: 'today', label: t('ov.range.today') },
            { id: '7d', label: t('ov.range.7d') },
            { id: '30d', label: t('ov.range.30d') },
            { id: 'all', label: t('ov.range.all') },
          ]}
          onPick={(id) => { set?.('defaultOverviewRange', id) }}
        />
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
          label={t('settings.overviewAuto')}
          value={state.overviewAutoSteps}
          disabled={disabled}
          options={[
            { id: '100', label: t('settings.overviewAutoSteps', { n: 100 }) },
            { id: '200', label: t('settings.overviewAutoSteps', { n: 200 }) },
            { id: '300', label: t('settings.overviewAutoSteps', { n: 300 }) },
            { id: 'off', label: t('settings.overviewAutoOff') },
          ]}
          onPick={(id) => { set?.('overviewAutoSteps', id) }}
        />
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
            { id: 'name', label: t('files.sort.name') },
          ]}
          onPick={(id) => { set?.('defaultFileSort', id) }}
        />
      </Group>
      <Group title={t('settings.group.cost')}>
        <PrefRow
          label={t('settings.usageWindow')}
          value={state.usageWindow}
          disabled={disabled}
          options={[
            { id: '7d', label: t('ov.usage.title') },
            { id: '30d', label: t('ov.usage.title30') },
          ]}
          onPick={(id) => { set?.('usageWindow', id) }}
        />
        <PrefRow
          label={t('settings.costFxRate')}
          value={state.costFxRate}
          disabled={disabled}
          options={[
            { id: 'official', label: t('settings.costFxOfficial') },
            { id: '7.0', label: t('settings.costFxAt', { r: '7.0' }) },
            { id: '7.2', label: t('settings.costFxAt', { r: '7.2' }) },
            { id: '7.4', label: t('settings.costFxAt', { r: '7.4' }) },
          ]}
          onPick={(id) => { set?.('costFxRate', id) }}
        />
        <PrefRow
          label={t('settings.costPeak')}
          value={state.costPeakFactor}
          disabled={disabled}
          options={[
            { id: '1', label: t('settings.costTimes', { n: '1' }) },
            { id: '1.5', label: t('settings.costTimes', { n: '1.5' }) },
            { id: '2', label: t('settings.costTimes', { n: '2' }) },
          ]}
          onPick={(id) => { set?.('costPeakFactor', id) }}
        />
        <PrefRow
          label={t('settings.costMultiplier')}
          value={state.costMultiplier}
          disabled={disabled}
          options={[
            { id: '1', label: t('settings.costTimes', { n: '1' }) },
            { id: '0.95', label: t('settings.costTimes', { n: '0.95' }) },
            { id: '0.9', label: t('settings.costTimes', { n: '0.9' }) },
            { id: '0.8', label: t('settings.costTimes', { n: '0.8' }) },
            { id: '0.7', label: t('settings.costTimes', { n: '0.7' }) },
            { id: '0.5', label: t('settings.costTimes', { n: '0.5' }) },
          ]}
          onPick={(id) => { set?.('costMultiplier', id) }}
        />
        <ShowHideRow t={t} label={t('settings.costActualPrice')} value={state.costActualPrice} disabled={disabled}
          onPick={(id) => { set?.('costActualPrice', id) }} />
      </Group>
      <Group title={t('settings.group.prompt')}>
        <p className="lc-settings-note">{t('settings.promptHint')}</p>
        <PromptTextRow
          label={t('settings.promptPrefix')}
          placeholder={t('settings.promptPlaceholder')}
          value={state.promptPrefix}
          disabled={disabled}
          onCommit={(text) => { set?.('promptPrefix', text) }}
        />
        <PromptTextRow
          label={t('settings.promptSuffix')}
          placeholder={t('settings.promptPlaceholder')}
          value={state.promptSuffix}
          disabled={disabled}
          onCommit={(text) => { set?.('promptSuffix', text) }}
        />
      </Group>
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

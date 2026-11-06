import { memo, useEffect, useRef, type ReactElement } from 'react'
import {
  IconPanelLeftOutlineRegular,
  IconRightUpOutlineRegular,
  IconSendOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { previewOf, type CommsAgent, type CommsKindFilter } from '../commsModel'
import type { CommsRow, FleetDelegationRow } from '../fleetDetail'
import { agentPromptOf, type FleetDetailState } from '../fleetModel'
import { fmtDateTime } from '../format'
import { pulseEventGroupOf, pulseEventRowsOf, type PulseTimelineItem } from '../pulseModel'
import { scrollIntoViewIfPossible, scrollToPos, settleReveal } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import type { FleetMessage } from '../../shared/types'
import { ClearableInput } from './clearableInput'
import { AgentAvatar, channelStyle } from './commsAgent'
import { CommsEvent, CommsEventDetail, DelegationEvent } from './commsEvent'
import { PulseSelectionPill } from './pulseSelection'
import type { RichKit } from './richText'
import { useRowWindow } from './useRowWindow'

const EVENT_ROW_PITCH = 64

function fullMessageOf(details: FleetDetailState, row: CommsRow): FleetMessage | null {
  const detail = details.fullLanded.get(row.to)
  if (detail === null || detail === undefined) return null
  return detail.messages.find(message => message.seq === row.seq && message.kind === row.kind) ?? null
}

function hiddenMessagesOf(details: FleetDetailState, rows: readonly CommsRow[]): number {
  let hidden = 0
  for (const id of new Set(rows.map(row => row.to))) {
    const detail = details.historyLanded.get(id)?.detail ?? details.landed.get(id)?.detail
    if (detail?.messagesTotal !== undefined) hidden += Math.max(0, detail.messagesTotal - detail.messages.length)
  }
  return hidden
}

function delegationPreviewOf(details: FleetDetailState, delegation: FleetDelegationRow): string {
  const prompt = agentPromptOf(details, delegation.to)
  return previewOf(prompt ?? delegation.label ?? '')
}

interface PulseDelegationDetailProps {
  delegation: FleetDelegationRow
  prompt?: string
  promptPending: boolean
  agentOf: (party: string) => CommsAgent
  rich: RichKit
  pinnedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  onClose: () => void
  t: ViewKit['t']
}

function PulseDelegationDetail(props: PulseDelegationDetailProps): ReactElement {
  const { delegation, t } = props
  const from = props.agentOf(delegation.from)
  const to = props.agentOf(delegation.to)
  const brief = props.prompt ?? ''
  const view = props.rich.useRichView(brief, false)
  return (
    <div className="lc-comms-detail lc-pulse-delegation-detail" style={channelStyle(from.hue, to.hue)}>
      <div className="lc-comms-detail-meta">
        <span className="lc-agents-badge">{t('fleet.pulse.delegation')}</span>
        <span className="lc-comms-detail-time">{fmtDateTime(delegation.time)}</span>
        <span className="lc-comms-detail-seq">{t('fleet.comms.detail.seq', { n: delegation.seq })}</span>
        <span className="lc-comms-detail-actions">
          <button type="button" className="lc-inspector-btn lc-comms-detail-close" aria-label={t('fleet.collapse')} onClick={props.onClose}>×</button>
        </span>
      </div>
      <div className="lc-comms-detail-note">{t('fleet.pulse.delegationNote')}</div>
      <div className="lc-pulse-delegation-route">
        <span><AgentAvatar agent={from} size="lg" t={t} /><b>{from.name}</b></span>
        <i>→</i>
        <span><AgentAvatar agent={to} size="lg" t={t} /><b>{to.name}</b></span>
      </div>
      {delegation.label !== undefined ? (
        <section className="lc-comms-detail-section">
          <div className="lc-comms-detail-caption">{t('fleet.pulse.delegationDuty')}</div>
          <div className="lc-pulse-delegation-label">{delegation.label}</div>
        </section>
      ) : null}
      <section className="lc-comms-detail-section">
        <div className="lc-comms-detail-caption">{t('fleet.pulse.delegationMode')}</div>
        <div>{t(`fleet.pulse.mode.${delegation.mode}`)}</div>
      </section>
      {brief !== '' || props.promptPending ? (
        <section className="lc-comms-detail-section">
          <div className="lc-comms-detail-caption">{t('fleet.tasks.brief')}</div>
          {props.promptPending ? <div className="lc-comms-detail-loading">{t('fleet.comms.detail.loading')}</div> : null}
          {brief !== '' ? (
            <>
              <div className="lc-comms-detail-tools">{view.tools}</div>
              {view.body}
            </>
          ) : null}
        </section>
      ) : null}
      <div className="lc-pulse-delegation-actions">
        <button type="button" className="lc-inspector-btn" onClick={() => { props.onSelect(to.id) }}>
          {t(props.pinnedId === to.id ? 'fleet.comms.detail.unfilter' : 'fleet.comms.detail.filter')}
        </button>
        {delegation.mode !== 'external' ? (
          <>
            <button type="button" className="lc-inspector-btn" aria-label={t('fleet.openSidebar')} onClick={() => { props.onOpen(to.id) }}>
              <IconPanelLeftOutlineRegular size={11} />
            </button>
            <button type="button" className="lc-inspector-btn" aria-label={t('fleet.open')} onClick={() => { props.onEnter(to.id) }}>
              <IconRightUpOutlineRegular size={11} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

interface PulseEventsProps {
  events: readonly PulseTimelineItem[]
  scopedEvents: readonly PulseTimelineItem[]
  details: FleetDetailState
  kind: CommsKindFilter
  query: string
  selectedAgent: string | null
  selectedItem: PulseTimelineItem | undefined
  agentOf: (party: string) => CommsAgent
  onKind: (kind: CommsKindFilter) => void
  onQuery: (query: string) => void
  onSelectEvent: (row: CommsRow) => void
  onSelectDelegation: (delegation: FleetDelegationRow) => void
  onClose: () => void
  onSelectAgent: (id: string) => void
  onClearSelection: () => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

const EVENT_KINDS = ['all', 'message', 'report', 'delegation'] as const

export const PulseEvents = memo(function PulseEvents(props: PulseEventsProps): ReactElement {
  const { t } = props
  const inspectorRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const alignedRef = useRef<string | null>(null)
  const listClickRef = useRef<string | null>(null)
  const estimateRef = useRef<string | null>(null)
  const counts = { all: props.scopedEvents.length, message: 0, report: 0, delegation: 0 }
  for (const item of props.scopedEvents) counts[pulseEventGroupOf(item)] += 1
  const shown = props.selectedItem ?? (props.events.length > 0 ? props.events[0] : undefined)
  const full = shown?.kind === 'message' ? fullMessageOf(props.details, shown.row) : null
  const windowed = props.events.length >= 60
  const rowRange = useRowWindow(listRef, props.events.length, EVENT_ROW_PITCH, windowed)
  const lastRow = Math.max(0, props.events.length - 1)
  const windowFrom = Math.min(rowRange.from, lastRow)
  const windowTo = Math.min(rowRange.to, lastRow)
  const shownEvents = windowed ? props.events.slice(windowFrom, windowTo + 1) : props.events
  const scopedMessages = pulseEventRowsOf(props.scopedEvents)
  const clipped = scopedMessages.filter(row => row.clipped === true).length
  const hidden = hiddenMessagesOf(props.details, scopedMessages)
  const selectedKey = props.selectedItem?.key ?? null
  useEffect(() => {
    if (selectedKey === null) {
      alignedRef.current = null
      listClickRef.current = null
      estimateRef.current = null
      return
    }
    if (alignedRef.current === selectedKey) return
    if (listClickRef.current === selectedKey) {
      listClickRef.current = null
      alignedRef.current = selectedKey
      return
    }
    const list = listRef.current as HTMLUListElement
    const align = (): boolean => {
      const row = list.querySelector<HTMLElement>(`[data-comms-key="${CSS.escape(selectedKey)}"]`)
      if (row === null) {
        if (estimateRef.current === selectedKey) return false
        estimateRef.current = selectedKey
        const index = Math.max(0, props.events.findIndex(entry => entry.key === selectedKey))
        const target = index * EVENT_ROW_PITCH
        if (Math.abs(list.scrollTop - target) <= 1) return false
        scrollToPos(list, { top: target })
        return true
      }
      alignedRef.current = selectedKey
      const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top
      if (Math.abs(delta) <= 1) return false
      scrollToPos(list, { top: list.scrollTop + delta })
      return true
    }
    settleReveal(list, align)
  }, [props.events, rowRange.from, selectedKey])
  useEffect(() => {
    if (selectedKey !== null) {
      scrollIntoViewIfPossible(inspectorRef.current, { block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedKey])
  return (
    <section className="lc-card lc-pulse-events">
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconSendOutlineRegular size={14} />{t('fleet.pulse.events')}</span>
        <span className="lc-card-sub">{t('fleet.comms.filtered', { n: props.events.length, total: props.scopedEvents.length })}</span>
      </div>
      <div className="lc-fleet-toolbar lc-pulse-event-tools">
        <div className="lc-fleet-filters" role="group" aria-label={t('fleet.comms.kindGroup')}>
          {EVENT_KINDS.map(kind => (
            <button
              key={kind}
              type="button"
              className={'lc-gran-btn' + (props.kind === kind ? ' lc-gran-on' : '')}
              aria-pressed={props.kind === kind}
              onClick={() => { props.onKind(kind) }}
            >
              {t(`fleet.comms.kind.${kind}`)}<span className="lc-kind-n">{counts[kind]}</span>
            </button>
          ))}
        </div>
        <ClearableInput
          type="search"
          className="lc-fleet-search lc-pulse-search"
          placeholder={t('fleet.comms.search')}
          clearLabel={t('field.clear')}
          value={props.query}
          onChange={props.onQuery}
        />
        {props.selectedAgent !== null ? (
          <PulseSelectionPill agent={props.agentOf(props.selectedAgent)} onClear={props.onClearSelection} t={t} />
        ) : null}
      </div>
      <div className="lc-pulse-event-layout">
        <div className="lc-pulse-event-stream">
          {props.events.length === 0 ? <div className="lc-empty">{t(props.scopedEvents.length === 0 ? 'fleet.comms.empty' : 'fleet.comms.noMatch')}</div> : null}
          <ul className="lc-comms-list lc-pulse-event-list" ref={listRef} hidden={props.events.length === 0}>
            {windowed && windowFrom > 0 ? <li aria-hidden="true" style={{ height: windowFrom * EVENT_ROW_PITCH }} /> : null}
            {shownEvents.map(item => item.kind === 'delegation' ? (
              <DelegationEvent
                key={item.key}
                delegation={item.delegation}
                agentOf={props.agentOf}
                preview={delegationPreviewOf(props.details, item.delegation)}
                open={shown?.key === item.key}
                onToggle={() => {
                  listClickRef.current = item.key
                  props.onSelectDelegation(item.delegation)
                }}
                t={t}
              />
            ) : (
              <CommsEvent
                key={item.key}
                row={item.row}
                agentOf={props.agentOf}
                open={shown?.key === item.key}
                onToggle={() => {
                  listClickRef.current = item.key
                  props.onSelectEvent(item.row)
                }}
                full={shown?.key === item.key ? full : null}
                t={t}
              />
            ))}
            {windowed && windowTo < lastRow ? <li aria-hidden="true" style={{ height: (lastRow - windowTo) * EVENT_ROW_PITCH }} /> : null}
          </ul>
        </div>
        <div className="lc-pulse-inspector" ref={inspectorRef}>
          {shown?.kind === 'delegation' ? (
            <PulseDelegationDetail
              key={shown.key}
              delegation={shown.delegation}
              prompt={agentPromptOf(props.details, shown.delegation.to)}
              promptPending={props.details.fullPending.has(shown.delegation.to)
                || props.details.pending.has(shown.delegation.to)}
              agentOf={props.agentOf}
              rich={props.rich}
              pinnedId={props.selectedAgent}
              onSelect={props.onSelectAgent}
              onOpen={props.onOpen}
              onEnter={props.onEnter}
              onClose={props.onClose}
              t={t}
            />
          ) : shown !== undefined ? (
            <CommsEventDetail
              key={shown.key}
              row={shown.row}
              agentOf={props.agentOf}
              full={full}
              fullPending={props.details.fullPending.has(shown.row.to)}
              pinnedId={props.selectedAgent}
              onSelect={props.onSelectAgent}
              onOpen={props.onOpen}
              onEnter={props.onEnter}
              onClose={props.onClose}
              rich={props.rich}
              t={t}
            />
          ) : <div className="lc-pulse-inspector-empty">{t('fleet.pulse.selectEvent')}</div>}
        </div>
      </div>
      {props.events.length < props.scopedEvents.length || clipped > 0 || hidden > 0 ? (
        <div className="lc-comms-notes">
          {props.events.length < props.scopedEvents.length
            ? <span>{t('fleet.comms.filtered', { n: props.events.length, total: props.scopedEvents.length })}</span> : null}
          {clipped > 0 ? <span>{t('fleet.comms.clipped', { n: clipped })}</span> : null}
          {hidden > 0 ? <span>{t('fleet.comms.hidden', { n: hidden })}</span> : null}
        </div>
      ) : null}
    </section>
  )
})

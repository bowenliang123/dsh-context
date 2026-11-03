import { type ReactElement, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPanelLeftOutlineRegular, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { fromPartyOf, previewOf, settledToneOf, type CommsAgent } from '../commsModel'
import { settledVariantOf, type CommsRow } from '../fleetDetail'
import { fmtDateTime, fmtTime } from '../format'
import { IconChevronDown, IconChevronUp, IconClose } from '../primitives'
import type { ViewKit } from '../viewkit'
import type { FleetMessage } from '../../shared/types'
import { AgentAvatar, channelStyle, roleTextOf } from './commsAgent'
import { jsonOf, type RichKit } from './richText'

export interface CommsEventProps {
  row: CommsRow
  agentOf: (party: string) => CommsAgent
  open: boolean
  onToggle: () => void
  full: FleetMessage | null
  children?: ReactNode
  t: ViewKit['t']
}

function detailIdOf(key: string): string {
  return 'lc-comms-detail-' + key.replace(/[^a-zA-Z0-9_-]+/g, '-')
}

export function CommsEvent(props: CommsEventProps): ReactElement {
  const { row, t } = props
  const from = props.agentOf(fromPartyOf(row))
  const to = props.agentOf(row.to)
  const fromRole = roleTextOf(from, t)
  const toRole = roleTextOf(to, t)
  const summary = row.kind === 'settled' ? row.summary ?? row.text : undefined
  const variant = summary !== undefined ? settledVariantOf(summary) : null
  const tone = settledToneOf(variant)
  const short = variant !== null ? t(`fleet.settledShort.${variant}`) : summary ?? ''
  const preview = row.kind === 'settled'
    ? row.report !== undefined ? previewOf(row.report) : ''
    : previewOf(props.full?.text ?? row.text)
  const kindClass = `lc-comms-kind-${row.kind}` + (variant !== null ? ` lc-comms-tone-${tone}` : '')

  return (
    <li
      className={`lc-comms-event ${kindClass}` + (props.open ? ' lc-comms-event-open' : '')}
      style={channelStyle(from.hue, to.hue)}
      data-comms-key={row.key}
      data-kind={row.kind}
    >
      <button
        type="button"
        className="lc-comms-hit"
        aria-expanded={props.open}
        aria-controls={detailIdOf(row.key)}
        onClick={props.onToggle}
      >
        <span className="lc-comms-event-head">
          <time className="lc-comms-time">{fmtTime(row.time)}</time>
          <span className="lc-comms-flow">
            <span className="lc-comms-party">
              <AgentAvatar agent={from} t={t} />
              <span className="lc-comms-party-name" title={from.name}>{from.name}</span>
              {fromRole !== '' ? <span className="lc-comms-role">{fromRole}</span> : null}
            </span>
            <span className="lc-comms-arrow" aria-hidden="true">{row.kind === 'settled' ? '⇢' : '→'}</span>
            <span className="lc-comms-party">
              <AgentAvatar agent={to} t={t} />
              <span className="lc-comms-party-name" title={to.name}>{to.name}</span>
              {toRole !== '' ? <span className="lc-comms-role">{toRole}</span> : null}
            </span>
          </span>
          <span className="lc-comms-kind">
            {variant !== null ? <StateDot state={tone} size={8} /> : null}
            {t(`fleet.kind.${row.kind}`)}
          </span>
          <span className="lc-comms-chev" aria-hidden="true">
            {props.open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </span>
        </span>
        <span className="lc-comms-preview">
          {row.kind === 'settled'
            ? <span className={`lc-comms-outcome lc-comms-tone-${tone}`}>{short}</span>
            : null}
          {preview !== '' ? <span className="lc-comms-preview-text">{preview}</span> : null}
        </span>
      </button>
      {props.open ? props.children : null}
    </li>
  )
}

export interface CommsEventDetailProps {
  row: CommsRow
  agentOf: (party: string) => CommsAgent
  full: FleetMessage | null
  fullPending: boolean
  pinnedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  onClose: () => void
  rich: RichKit
  t: ViewKit['t']
}

export function CommsEventDetail(props: CommsEventDetailProps): ReactElement {
  const { row, t } = props
  const from = props.agentOf(fromPartyOf(row))
  const to = props.agentOf(row.to)
  const resolvedSummary = props.full?.summary ?? row.summary
  const resolvedVariant = resolvedSummary !== undefined ? settledVariantOf(resolvedSummary) : null
  const resolvedTone = settledToneOf(resolvedVariant)
  const settledBody = props.full?.report ?? row.report ?? ''
  const body = row.kind === 'settled'
    ? settledBody !== '' ? settledBody : resolvedSummary === undefined ? props.full?.text ?? row.text : ''
    : props.full?.text ?? row.text
  const structured = props.full?.structured ?? row.structured
  const diagnostic = props.full?.diagnostic ?? row.diagnostic
  const copyText = body !== '' ? body : (resolvedSummary ?? row.text)
  const stillClipped = props.full !== null && props.full.clipped === true
  const excerptOnly = row.clipped === true && !props.fullPending && (props.full === null || stillClipped)
  const loadingNote = props.fullPending
    ? t('fleet.comms.detail.loading')
    : excerptOnly ? t('fleet.comms.detail.excerptOnly') : null
  const people = from.id === to.id ? [from] : [from, to]
  const kindClass = `lc-comms-kind-${row.kind}` + (resolvedVariant !== null ? ` lc-comms-tone-${resolvedTone}` : '')

  return (
    <div
      className={`lc-comms-detail ${kindClass}`}
      id={detailIdOf(row.key)}
      style={channelStyle(from.hue, to.hue)}
    >
      <div className="lc-comms-detail-meta">
        <span className="lc-agents-badge">{t(`fleet.kind.${row.kind}`)}</span>
        <span className="lc-comms-detail-time">{fmtDateTime(row.time)}</span>
        <span className="lc-comms-detail-log" title={t('fleet.comms.detail.originTip')}>
          {t('fleet.comms.detail.log', { name: to.name })}
        </span>
        <span className="lc-comms-detail-seq">{t('fleet.comms.detail.seq', { n: row.seq })}</span>
        <span className="lc-comms-detail-actions">
          <props.rich.RichCopy text={copyText} />
          <button
            type="button"
            className="lc-inspector-btn lc-comms-detail-close"
            title={t('fleet.collapse')}
            aria-label={t('fleet.collapse')}
            onClick={props.onClose}
          >
            <IconClose size={11} />
          </button>
        </span>
      </div>

      <section className="lc-comms-detail-section lc-comms-participants">
        <div className="lc-comms-detail-caption">{t('fleet.comms.detail.participants')}</div>
        <div className={'lc-comms-people' + (from.id === to.id ? ' lc-comms-people-self' : '')}>
          {people.map((person, index) => {
            const role = roleTextOf(person, t)
            const party = index === 0 ? 'from' : 'to'
            return (
              <div className={`lc-comms-person lc-comms-party-${party}`} data-party={party} key={person.id}>
                <AgentAvatar agent={person} size="lg" t={t} />
                <div className="lc-comms-person-main">
                  <div className="lc-comms-person-direction">{t(`fleet.comms.detail.${party === 'from' ? 'sender' : 'recipient'}`)}</div>
                  <div className="lc-comms-person-name">
                    <b>{person.name}</b>
                    {role !== '' ? <span className="lc-agents-badge">{role}</span> : null}
                    {person.self ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
                  </div>
                  {person.description !== undefined && person.description !== '' ? (
                    <div className="lc-comms-person-desc" title={person.description}>{person.description}</div>
                  ) : null}
                </div>
                <span className="lc-comms-person-actions">
                  {!person.self && person.role !== 'other' ? (
                    <button
                      type="button"
                      className={'lc-inspector-btn' + (props.pinnedId === person.id ? ' lc-comms-person-pin-on' : '')}
                      title={t(props.pinnedId === person.id ? 'fleet.comms.detail.unfilter' : 'fleet.comms.detail.filter')}
                      onClick={() => { props.onSelect(person.id) }}
                    >
                      {t(props.pinnedId === person.id ? 'fleet.comms.detail.unfilter' : 'fleet.comms.detail.filter')}
                    </button>
                  ) : null}
                  {!person.self && person.role !== 'other' ? (
                    <>
                      <button
                        type="button"
                        className="lc-inspector-btn"
                        title={t('fleet.openSidebar')}
                        aria-label={t('fleet.openSidebar')}
                        onClick={() => { props.onOpen(person.id) }}
                      >
                        <IconPanelLeftOutlineRegular size={11} />
                      </button>
                      <button
                        type="button"
                        className="lc-inspector-btn"
                        title={t('fleet.open')}
                        aria-label={t('fleet.open')}
                        onClick={() => { props.onEnter(person.id) }}
                      >
                        <IconRightUpOutlineRegular size={11} />
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      {row.kind === 'settled' ? (
        <div className="lc-comms-detail-note">{t('fleet.comms.detail.settledNote')}</div>
      ) : null}

      {resolvedVariant !== null ? (
        <div className={`lc-comms-outcome lc-comms-tone-${resolvedTone}`}>
          <StateDot state={resolvedTone} size={10} />
          <b>{t(`fleet.settled.${resolvedVariant}`)}</b>
        </div>
      ) : resolvedSummary !== undefined ? (
        <div className="lc-comms-outcome">{resolvedSummary}</div>
      ) : null}

      {loadingNote !== null ? <div className="lc-comms-detail-loading">{loadingNote}</div> : null}

      <div className="lc-comms-detail-body">
        {body !== ''
          ? <props.rich.RichText text={body} mode="md" />
          : <div className="lc-comms-detail-empty">
            {t(row.kind === 'settled' ? 'fleet.comms.detail.noReport' : 'fleet.comms.detail.noBody')}
          </div>}
      </div>

      {structured !== undefined ? (
        <section className="lc-comms-detail-section">
          <div className="lc-comms-detail-caption">{t('fleet.comms.detail.structured')}</div>
          <props.rich.RichText text={structured} mode={jsonOf(structured) !== null ? 'json' : 'md'} />
        </section>
      ) : null}

      {diagnostic !== undefined ? (
        <section className="lc-comms-detail-section">
          <div className="lc-comms-detail-caption">{t('fleet.comms.detail.diagnostic')}</div>
          <pre className="lc-comms-detail-diagnostic">{diagnostic}</pre>
        </section>
      ) : null}
    </div>
  )
}

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { dayKeyOf } from '../../shared/days'
import type { SkillInfo } from '../../shared/types'
import { relativeTime, type SkillSort, type TallyStat } from '../overview'
import { copySkillPath } from '../skills'
import { nameColorOf } from '../nameColor'
import { IconCheck, IconCopy, IconSkill } from '../primitives'
import type { ViewKit } from '../viewkit'
import { ClearableInput } from './clearableInput'
import { TallyCard, TallyRow, shareOf } from './overviewTally'

const MAX_ROWS = 20

const MAX_DESC = 160

const COPIED_MS = 1500

const TIP_GAP = 6
const TIP_MARGIN = 8

const TIP_ID = 'lc-skilltip-bubble'

const SKILL_SORTS: readonly SkillSort[] = ['loads', 'recent']

export const skillColorOf = nameColorOf

function originLabelOf(t: ViewKit['t'], info: SkillInfo): string {
  const source = info.source
  if (source === 'project-dsh' || source === 'project-agents') return t('ov.skills.src.project')
  if (source === 'user-dsh' || source === 'user-agents') return t('ov.skills.src.user')
  if (source === 'bundled') return t('ov.skills.src.bundled')
  return source ?? ''
}

function descriptionOf(info: SkillInfo): string {
  const flat = info.description.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DESC ? flat.slice(0, MAX_DESC) + '…' : flat
}

function usageLineOf(kit: ViewKit, s: TallyStat): string {
  return `${kit.t('ov.skills.loads', { n: kit.fmt(s.n) })} · ${kit.t('ov.skills.sessions', { n: kit.fmt(s.sessions) })}`
}

function lastLineOf(kit: ViewKit, s: TallyStat): string {
  return `${dayKeyOf(s.last) ?? ''} ${kit.fmtTime(s.last)}`.trim()
}

function statsLineOf(kit: ViewKit, s: TallyStat): string {
  return `${usageLineOf(kit, s)} · ${lastLineOf(kit, s)}`
}

function DetailHead(props: { name: string; origin: string }): ReactElement {
  return (
    <div className="lc-skilld-head">
      <i className="lc-ov-tally-dot" style={{ background: skillColorOf(props.name) }} />
      <span className="lc-skilld-name">{props.name}</span>
      {props.origin !== '' && <span className="lc-skilld-chip">{props.origin}</span>}
    </div>
  )
}

interface HoverRow {
  name: string
  rect: { left: number; top: number; width: number; bottom: number }
}

export interface OverviewSkillsProps {
  stats: TallyStat[]
  day?: string | null
  selected?: string | null
  onSelect?: (name: string | null) => void
  sort?: SkillSort
  onSort?: (sort: SkillSort) => void
  catalog?: ReadonlyMap<string, SkillInfo> | null
  now: number
}

export function makeOverviewSkills(kit: ViewKit): (props: OverviewSkillsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewSkills(props: OverviewSkillsProps): ReactElement {
    const { stats } = props
    const max = stats.reduce((top, s) => Math.max(top, s.n), 0)

    const [query, setQuery] = useState('')
    const needle = query.trim().toLowerCase()
    const visible = needle === '' ? stats : stats.filter(s => s.name.toLowerCase().includes(needle))
    const visibleTotal = visible.reduce((sum, s) => sum + s.n, 0)

    const [hoverRow, setHoverRow] = useState<HoverRow | null>(null)
    const [spot, setSpot] = useState<{ forRow: HoverRow; left: number; top: number } | null>(null)
    const bubbleRef = useRef<HTMLDivElement | null>(null)
    const hoverStat = hoverRow === null ? undefined : stats.find(s => s.name === hoverRow.name)

    useEffect(() => {
      if (hoverRow === null) return undefined
      const retract = (): void => { setHoverRow(null) }
      window.addEventListener('resize', retract)
      window.addEventListener('scroll', retract, true)
      return () => {
        window.removeEventListener('resize', retract)
        window.removeEventListener('scroll', retract, true)
      }
    }, [hoverRow])

    useLayoutEffect(() => {
      if (hoverRow === null) return
      const el = bubbleRef.current
      /* v8 ignore next */
      if (el === null) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const { rect } = hoverRow
      const left = Math.max(TIP_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - TIP_MARGIN))
      const top = rect.top - h - TIP_GAP < TIP_MARGIN ? rect.bottom + TIP_GAP : rect.top - h - TIP_GAP
      setSpot({ forRow: hoverRow, left, top })
    }, [hoverRow])

    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => { setCopied(false) }, [props.selected])
    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
    const copyPath = async (path: string): Promise<void> => {
      if (await copySkillPath(path)) {
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => { setCopied(false) }, COPIED_MS)
      }
    }

    const selected = props.selected
    const pinnedStat = selected === null || selected === undefined
      ? undefined
      : stats.find(s => s.name === selected)
    const pinnedInfo = selected === null || selected === undefined
      ? undefined
      : props.catalog?.get(selected)
    const detail = selected === null || selected === undefined || (pinnedInfo === undefined && pinnedStat === undefined)
      ? null
      : {
        name: selected,
        origin: pinnedInfo === undefined ? '' : originLabelOf(t, pinnedInfo),
        description: pinnedInfo === undefined ? '' : descriptionOf(pinnedInfo),
        path: pinnedInfo?.path,
      }
    const detailPath = detail?.path
    const pinnedRowVisible = selected !== null && selected !== undefined
      && visible.slice(0, MAX_ROWS).some(s => s.name === selected)
    const detailBlock = detail === null ? null : (
      <div className="lc-ov-skill-detail">
        {!pinnedRowVisible && <DetailHead name={detail.name} origin="" />}
        {detail.description !== '' && <p className="lc-skilld-desc">{detail.description}</p>}
        <div className="lc-skilld-grid">
          {detail.origin !== '' && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.source')}</span>
              <span className="lc-skilld-v">{detail.origin}</span>
            </Fragment>
          )}
          {pinnedStat !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.usage')}</span>
              <span className="lc-skilld-v">{usageLineOf(kit, pinnedStat)}</span>
              <span className="lc-skilld-k">{t('ov.skills.k.last')}</span>
              <span className="lc-skilld-v">{lastLineOf(kit, pinnedStat)}</span>
            </Fragment>
          )}
          {detailPath !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.path')}</span>
              <button
                type="button"
                className="lc-skilld-v lc-skilld-pathv"
                data-lc-tip={t('ov.skills.copyPath')}
                onClick={() => { void copyPath(detailPath) }}
              >
                <span className="lc-skilld-pathv-text">{copied ? t('ov.skills.copied') : detailPath}</span>
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              </button>
            </Fragment>
          )}
        </div>
      </div>
    )

    const hoverTip = hoverStat === undefined ? null : (() => {
      const info = props.catalog?.get(hoverStat.name)
      const origin = info === undefined ? '' : originLabelOf(t, info)
      const description = info === undefined ? '' : descriptionOf(info)
      const pinned = props.selected === hoverStat.name
      const shown = spot !== null && spot.forRow === hoverRow ? spot : null
      return createPortal(
        <div
          ref={bubbleRef}
          id={TIP_ID}
          role="tooltip"
          className="lc-tip lc-skilltip"
          style={shown === null
            ? { left: 0, top: 0, visibility: 'hidden' }
            : { left: shown.left, top: shown.top, opacity: 1 }}
        >
          <DetailHead name={hoverStat.name} origin={origin} />
          {description !== '' && <p className="lc-skilld-desc">{description}</p>}
          {info?.path !== undefined && <div className="lc-skilld-path">{info.path}</div>}
          <div className="lc-skilld-foot">
            <span>{statsLineOf(kit, hoverStat)}</span>
            <span className="lc-skilld-hint">{pinned ? t('ov.skills.clickRelease') : t('ov.skills.clickFilter')}</span>
          </div>
        </div>,
        document.body,
      )
    })()

    const sort = props.sort ?? 'loads'
    return (
      <TallyCard
        icon={<IconSkill size={14} />}
        title={t('stats.skills')}
        day={props.day}
        summary={t('ov.skills.summary', { skills: fmt(visible.length), loads: fmt(visibleTotal) })}
        search={stats.length > 1 ? (
          <ClearableInput
            className="lc-ov-search lc-ov-skills-search"
            type="search"
            value={query}
            placeholder={t('ov.skills.search')}
            clearLabel={t('field.clear')}
            onChange={setQuery}
          />
        ) : undefined}
        controls={stats.length > 1 ? (
          <div className="lc-gran" role="group" aria-label={t('ov.skills.sortLabel')}>
            {SKILL_SORTS.map(so => (
              <button
                key={so}
                type="button"
                className={'lc-gran-btn' + (sort === so ? ' lc-gran-on' : '')}
                aria-pressed={sort === so}
                onClick={() => { props.onSort?.(so) }}
              >{t('ov.skills.sort.' + so)}</button>
            ))}
          </div>
        ) : undefined}
      >
        {!pinnedRowVisible && detailBlock}
        {stats.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.empty')}</div>
        ) : visible.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.noMatch')}</div>
        ) : (
          <div className="lc-ov-tallies" role="group" aria-label={t('stats.skills')}>
            {visible.slice(0, MAX_ROWS).map((s) => {
              const color = skillColorOf(s.name)
              const pinned = props.selected === s.name
              const rowButton = (
                <TallyRow
                  name={s.name}
                  count={fmt(s.n)}
                  share={shareOf(s.n, max)}
                  color={color}
                  last={relativeTime(t, s.last, props.now)}
                  selected={pinned}
                  describedBy={hoverRow?.name === s.name ? TIP_ID : undefined}
                  onSelect={() => { props.onSelect?.(pinned ? null : s.name) }}
                  onAnchor={(el) => {
                    const r = el.getBoundingClientRect()
                    setHoverRow({ name: s.name, rect: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } })
                  }}
                  onRelease={() => { setHoverRow(null) }}
                />
              )
              return pinned
                ? <div key={s.name} className="lc-ov-skill-unit">{rowButton}{detailBlock}</div>
                : <Fragment key={s.name}>{rowButton}</Fragment>
            })}
            {visible.length > MAX_ROWS && (
              <div className="lc-ov-tally-more">{t('ov.skills.more', { n: visible.length - MAX_ROWS })}</div>
            )}
          </div>
        )}
        {hoverTip}
      </TallyCard>
    )
  }
}

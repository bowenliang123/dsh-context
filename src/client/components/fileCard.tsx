import { memo, useEffect, useRef, useState, type ChangeEvent, type ComponentType, type MouseEvent, type ReactElement } from 'react'
import { FILE_SORTS, absPathOf, displayPathOf, fileComparators, glyphOf, surfaceSeqOf } from '../fileActivity'
import type { FileActivity, FileEntry, FileOp, FileOpKind } from '../fileActivity'
import type { ContextSettings, DefaultFileSort } from '../settings'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'
import { useRowWindow } from './useRowWindow'

export type FileFilter = 'all' | FileOpKind | 'image'

export interface FileCardProps {
  activity: FileActivity
  workspace?: string
  /** One-shot kind request from the stats board's file pills: the chip band follows it, and the request is handed
   *  back via `onFilterFocusHandled` so the same kind can jump again. Absent = the chips stay the card's own state. */
  filterFocus?: FileFilter | null
  onFilterFocusHandled?: () => void
  /** Returns whether the preview column took the file; a refusal falls through to the system opener; absent = no column. */
  onPreview?: (entry: FileEntry) => boolean
  onOpen?: (absPath: string) => void
  onLocate?: (op: FileOp) => void
  /** The turn/step whose request first carried an op's result node (the Context Browser's own stamp), by node seq;
   *  absent = op rows print no stamps. */
  stampOf?: (seq: number) => { turn: number; step: number } | null
  state?: DetailState
  onRetry?: () => void
}

export function makeFileCard(kit: ViewKit, settings: ContextSettings): ComponentType<FileCardProps> {
  const { t, fmt, fmtTime } = kit
  const DetailNote = makeDetailNote(kit)

  function matches(e: FileEntry, f: FileFilter): boolean {
    if (f === 'all') return true
    if (f === 'image') return e.form === 'image'
    if (f === 'read') return e.reads > 0
    if (f === 'write') return e.writes > 0
    return e.searches > 0
  }

  /** Signed line pair, harness diff semantics: growth on the success token, shrinkage on the error token. */
  function DeltaPair(props: { added: number; removed: number }): ReactElement {
    return (
      <span className="lc-fa-delta">
        {props.added > 0 ? <span className="lc-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="lc-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  // Memoized at the factory level: the parent's activity/onLocate props are reference-stable across hover/select
  // renders (see contextView), so the card skips reconciliation whenever its own inputs did not move.
  return memo(function FileCard(props: FileCardProps): ReactElement {
    const { activity } = props
    const [filter, setFilter] = useState<FileFilter>('all')
    // Mount-time default; in-card toggling stays mount-local and never writes back.
    const [sort, setSort] = useState<DefaultFileSort>(() => settings.defaultFileSort())
    const [query, setQuery] = useState('')
    const [openPath, setOpenPath] = useState<string | null>(null)
    // The list lane is a fixed-height virtual scroller while no row is expanded and the card is wide enough for
    // single-line rows (narrow cards wrap, so their heights are not uniform and the list renders in full).
    const listRef = useRef<HTMLDivElement | null>(null)
    const [listWide, setListWide] = useState(false)
    // Row pitch (height + any gap) is measured from the full list before windowing; windowing stays off unless every
    // collapsed row measures the same height (long paths wrap otherwise and mixed heights would break the spacers).
    const [rowPitch, setRowPitch] = useState(0)
    const [rowGap, setRowGap] = useState(0)

    // A stats-board jump re-points the chip band: the card drops its own lens and open row, so the landing is the
    // frontier the click promised. The request is handed back so an unchanged kind can fire again.
    const filterFocus = props.filterFocus
    useEffect(() => {
      if (filterFocus === null || filterFocus === undefined) return
      setFilter(filterFocus)
      setQuery('')
      setOpenPath(null)
      if (props.onFilterFocusHandled !== undefined) props.onFilterFocusHandled()
    }, [filterFocus, props.onFilterFocusHandled])

    const q = query.trim().toLowerCase()
    // Display form of an entry's path: bare workspace-relative inside the workspace, verbatim outside — except search rows,
    // whose "path" is a pattern.
    const displayOf = (e: FileEntry): string => (e.pattern === true ? e.path : displayPathOf(e.path, props.workspace))
    const countOf = (e: FileEntry): number =>
      filter === 'read' ? e.reads : filter === 'write' ? e.writes : filter === 'search' ? e.searches : e.ops.length
    const shown = activity.entries
      .filter(e => matches(e, filter) && (q === '' || displayOf(e).toLowerCase().includes(q)))
      .sort(fileComparators(countOf, displayOf)[sort])

    useEffect(() => {
      const el = listRef.current
      if (el === null) {
        setListWide(false)
        return
      }
      const sync = (): void => { setListWide(el.clientWidth >= 380) }
      sync()
      if (typeof ResizeObserver !== 'function') return
      /* v8 ignore start -- jsdom has neither a layout nor ResizeObserver; the live page covers a pane resize. */
      const observer = new ResizeObserver(sync)
      observer.observe(el)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [shown.length > 0])
    // Windowed rendering needs UNIFORM row heights. Measure the FULL list first (the initial render is unwindowed) and
    // only enable windowing when every collapsed row has the same height; mixed heights would break the spacers.
    useEffect(() => {
      setRowPitch(0)
      setRowGap(0)
    }, [shown.length, listWide, filter, query, sort, openPath])
    useEffect(() => {
      if (!listWide || openPath !== null || rowPitch > 0) return
      const el = listRef.current
      /* v8 ignore start -- the ref attaches for every non-empty list; the guards only cover a mid-swap render. */
      if (el === null) return
      const items = [...el.querySelectorAll<HTMLElement>('.lc-fa-item')]
      // The reset above re-renders the list in full; a partial window is never a valid uniformity sample.
      if (items.length < 2 || items.length !== shown.length) return
      /* v8 ignore stop */
      const rects = items.map(item => item.getBoundingClientRect())
      const first = rects[0]
      const height = Math.round(first.height)
      const uniform = height > 4 && rects.every(r => Math.abs(Math.round(r.height) - height) <= 1)
      if (!uniform) return
      const pitch = rects[1].top - first.top
      /* v8 ignore next 1 -- uniform rows with a >4px height always yield a >4px pitch. */
      if (Number.isFinite(pitch) && pitch > 4) {
        setRowPitch(Math.round(pitch))
        setRowGap(Math.max(0, Math.round(pitch - first.height)))
      }
    }, [listWide, openPath, rowPitch, rowGap, shown.length])
    const rowRange = useRowWindow(listRef, shown.length, rowPitch, listWide && openPath === null && rowPitch > 0)
    const chips: { key: FileFilter; files: number; ops: number }[] = [
      {
        key: 'all',
        files: activity.entries.length,
        ops: activity.totals.read.ops + activity.totals.write.ops + activity.totals.search.ops,
      },
      { key: 'read', files: activity.totals.read.files, ops: activity.totals.read.ops },
      { key: 'write', files: activity.totals.write.files, ops: activity.totals.write.ops },
      { key: 'search', files: activity.totals.search.files, ops: activity.totals.search.ops },
      { key: 'image', files: activity.totals.image.files, ops: activity.totals.image.ops },
    ]

    const opLine = (op: FileOp): ReactElement => {
      const stamp = props.stampOf?.(surfaceSeqOf(op)) ?? null
      const stampText = stamp !== null ? t('browser.stepAt', { t: stamp.turn, s: stamp.step }) : null
      const timeText = op.time !== undefined ? fmtTime(op.time) : null
      return (
        <>
          <span className="lc-fa-op-tool" title={op.tool}>{op.tool}</span>
          {op.detail !== undefined ? <span className="lc-fa-op-detail">{op.detail}</span> : null}
          {op.hits !== undefined ? <span className="lc-fa-op-detail">{t('files.hits', { n: fmt(op.hits) })}</span> : null}
          {op.detail === undefined && op.hits === undefined && op.program !== undefined
            ? <span className="lc-fa-op-detail">{op.program}</span>
            : null}
          <span className="lc-fa-op-meta">
            {op.read !== undefined
              ? (
                <span
                  className="lc-fa-read"
                  title={'est' in op.read
                    ? t('files.readEst')
                    : t('files.readTip', { a: fmt(op.read.start), b: fmt(op.read.start + op.read.count - 1) })}
                >
                  {('est' in op.read ? '≈' : '>>') + fmt(op.read.count)}
                </span>
              )
              : null}
            {op.added + op.removed > 0 ? <DeltaPair added={op.added} removed={op.removed} /> : null}
            {op.err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
            <span
              className="lc-fa-op-time"
              title={stamp !== null ? t('browser.stepAtTip', { t: stamp.turn, s: stamp.step }) : undefined}
            >
              {[stampText, timeText].filter(part => part !== null).join(' · ') || '—'}
            </span>
          </span>
        </>
      )
    }

    return (
      <div className="lc-card lc-fa-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('files.title')}</span>
          <span className="lc-fa-meta">
            <span>{t('files.files', { n: activity.entries.length })}</span>
            {activity.totals.added + activity.totals.removed > 0 ? (
              /* The one styled tip of the card lives OUTSIDE the scrolling list, so the bubble never clips. */
              <span className="lc-fa-meta-delta group/tip">
                <DeltaPair added={activity.totals.added} removed={activity.totals.removed} />
                <span className="lc-tip lc-fa-meta-tip group-hover/tip:opacity-100" role="tooltip">{t('files.deltaTip')}</span>
              </span>
            ) : null}
          </span>
          {/* The five chips overflow a narrow card in English — fold the group to two lines. */}
          <div className="lc-gran lc-fa-chips @max-[380px]/lc-card:flex-wrap">
            {chips.map(c => (
              <button
                key={c.key}
                type="button"
                className={'lc-gran-btn' + (filter === c.key ? ' lc-gran-on' : '')
                  + (c.key === 'image' ? '' : ' lc-fa-chip-' + c.key)}
                title={t('files.chipTip', { files: c.files, ops: c.ops })}
                onClick={() => { setFilter(cur => (cur === c.key ? 'all' : c.key)) }}
              >
                {t('files.kind.' + c.key)}
                <b className="lc-fa-n">{fmt(c.ops)}</b>
              </button>
            ))}
          </div>
        </div>
        {/* The controls and the list lane render in EVERY state, so an empty or pending card measures exactly what a
            populated one does. */}
        <div>
          <div className="lc-fa-ctl">
            <input
              className="lc-fa-search focus:border-(--dsw-alias-label-dimmed)"
              value={query}
              placeholder={t('files.search')}
              onChange={(ev: ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
            />
            <span className="lc-gran lc-fa-sort" role="group" title={t('files.sortTip')}>
              {FILE_SORTS.map(k => (
                <button
                  key={k}
                  type="button"
                  className={'lc-gran-btn' + (sort === k ? ' lc-gran-on' : '')}
                  onClick={() => { setSort(k) }}
                >
                  {t('files.sort.' + k)}
                </button>
              ))}
            </span>
          </div>
          {activity.entries.length === 0 && props.state === 'loading' ? (
            <DetailNote state="loading" className="lc-empty lc-lane" />
          ) : activity.entries.length === 0 && props.state === 'failed' && props.onRetry !== undefined ? (
            <DetailNote state="failed" onRetry={props.onRetry} className="lc-empty lc-lane" />
          ) : shown.length === 0 ? (
            <div className="lc-empty lc-lane">{t(activity.entries.length === 0 ? 'files.empty' : 'files.noMatch')}</div>
          ) : (
            <div className="lc-fa-list" ref={listRef}>
              {rowRange.from > 0 ? <div className="lc-row-pad" style={{ height: Math.max(0, rowRange.from * rowPitch - rowGap) }} aria-hidden="true" /> : null}
              {shown.slice(rowRange.from, rowRange.to + 1).map((e) => {
                const open = openPath === e.path
                const display = displayOf(e)
                const trimmed = display.endsWith('/') ? display.slice(0, -1) : display
                const slash = trimmed.lastIndexOf('/')
                const dir = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
                const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
                const glyph = glyphOf(e.path, e.form)
                const abs = e.pattern === true ? undefined : absPathOf(e.path, props.workspace)
                const previewable = props.onPreview !== undefined && e.pattern !== true && e.form !== 'dir'
                const openable = previewable || (abs !== undefined && props.onOpen !== undefined)
                return (
                  <div key={e.path} className={'lc-fa-item' + (open ? ' lc-fa-item-on' : '')}>
                    <button
                      type="button"
                      className="lc-fa-row hover:bg-(--dsw-alias-interactive-bg-hover) @max-[380px]/lc-card:flex-wrap"
                      title={e.path}
                      onClick={() => { setOpenPath(open ? null : e.path) }}
                    >
                      <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                      <span className="lc-fa-form" title={t(glyph.tip)}>
                        {glyph.color !== undefined
                          ? (
                            <span className="lc-fa-lang" style={{ background: glyph.color, color: glyph.text }}>
                              {glyph.glyph}
                            </span>
                          )
                          : glyph.glyph}
                      </span>
                      {/* Narrow cards wrap instead of crushing: the path's near-full-width basis keeps line 1 to
                            chevron + icon + path, with badges/delta/time folded onto line 2. The 46px reservation is
                            chevron (12) + gaps (2×7) + form icon (20). */}
                      <span className="lc-fa-path flex-1 @max-[380px]/lc-card:basis-[calc(100%-46px)]">
                        {dir !== '' ? <em>{dir}</em> : null}
                        {openable
                          ? (
                            <b
                              className="lc-fa-file hover:underline"
                              title={t(previewable ? 'files.preview' : 'files.open')}
                              onClick={(ev: MouseEvent) => {
                                ev.stopPropagation()
                                if (previewable && props.onPreview?.(e) === true) return
                                if (abs !== undefined) props.onOpen?.(abs)
                              }}
                            >
                              {base}
                            </b>
                          )
                          : <b>{base}</b>}
                      </span>
                      {e.reads > 0 ? (
                        <span className="lc-fa-badge lc-fa-b-read" title={t('files.kind.read')}><i />{fmt(e.reads)}</span>
                      ) : null}
                      {e.writes > 0 ? (
                        <span className="lc-fa-badge lc-fa-b-write" title={t('files.kind.write')}><i />{fmt(e.writes)}</span>
                      ) : null}
                      {e.searches > 0 ? (
                        <span className="lc-fa-badge lc-fa-b-search" title={t('files.kind.search')}><i />{fmt(e.searches)}</span>
                      ) : null}
                      {e.added + e.removed > 0 ? <DeltaPair added={e.added} removed={e.removed} /> : null}
                      {e.ops[0].time !== undefined
                        ? <span className="lc-fa-time">{fmtTime(e.ops[0].time)}</span>
                        : null}
                    </button>
                    {open ? (
                      <div className="lc-fa-ops">
                        {e.ops.map((op, i) => {
                          const onLocate = props.onLocate
                          // A meta-attributed search rows one op per matched file off ONE result — the ops share
                          // that result's seq, so the key joins the index.
                          const key = `${op.seq}:${i}`
                          return onLocate !== undefined
                            ? (
                              <button
                                key={key}
                                type="button"
                                className="lc-fa-op lc-fa-op-link hover:bg-(--dsw-alias-interactive-bg-hover)"
                                title={t('files.locate')}
                                onClick={() => { onLocate(op) }}
                              >
                                {opLine(op)}
                              </button>
                            )
                            : <div key={key} className="lc-fa-op">{opLine(op)}</div>
                        })}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {rowRange.to < shown.length - 1 ? <div className="lc-row-pad" style={{ height: Math.max(0, (shown.length - 1 - rowRange.to) * rowPitch - rowGap) }} aria-hidden="true" /> : null}
            </div>
          )}
        </div>
      </div>
    )
  })
}

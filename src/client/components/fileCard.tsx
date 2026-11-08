import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react'
import { absPathOf, baseNameOf, displayPathOf, displayStyleOf, glyphOf, mergeByDisplay, surfaceSeqOf, totalsOf } from '../fileActivity'
import type { FileActivity, FileEntry, FileOp, FileOpKind } from '../fileActivity'
import type { ContextSettings, DefaultFileSort } from '../settings'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { IconFolderOpen } from '../primitives'
import { ClearableInput } from './clearableInput'
import { makeDetailNote } from './detailNote'
import { useSurfaceWindow } from './useRowWindow'
import { remoteStateOf } from './useRemoteState'

export type FileFilter = 'all' | FileOpKind | 'image'

const FILE_ROW_ESTIMATE = 30

function slashPartsOf(path: string): { directory: string; name: string } {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  return cut >= 0
    ? { directory: trimmed.slice(0, cut + 1), name: trimmed.slice(cut + 1) }
    : { directory: '', name: trimmed }
}

export interface FileCardProps {
  activity: FileActivity
  workspace?: string
  filterFocus?: FileFilter | null
  onFilterFocusHandled?: () => void
  onPreview?: (entry: FileEntry) => boolean
  onOpen?: (absPath: string) => void
  onLocate?: (op: FileOp) => void
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

  function DeltaPair(props: { added: number; removed: number }): ReactElement {
    return (
      <span className="lc-fa-delta">
        {props.added > 0 ? <span className="lc-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="lc-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  return memo(function FileCard(props: FileCardProps): ReactElement {
    kit.useLocaleTick()
    const { activity } = props
    const [filter, setFilter] = useState<FileFilter>('all')
    const [sort, setSort] = useState<DefaultFileSort>(() => settings.defaultFileSort())
    const [query, setQuery] = useState('')
    const [openPath, setOpenPath] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement | null>(null)
    const idBase = useId()

    const filterFocus = props.filterFocus
    useEffect(() => {
      if (filterFocus === null || filterFocus === undefined) return
      setFilter(filterFocus)
      setQuery('')
      setOpenPath(null)
      if (props.onFilterFocusHandled !== undefined) props.onFilterFocusHandled()
    }, [filterFocus, props.onFilterFocusHandled])

    const workspace = props.workspace
    const displayOf = useCallback(
      (e: FileEntry): string => (e.pattern === true ? e.path : displayPathOf(e.path, workspace)),
      [workspace],
    )
    const entries = useMemo(() => mergeByDisplay(activity.entries, workspace), [activity.entries, workspace])
    const matched = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (needle === '') return entries
      return entries.filter(e => displayOf(e).toLowerCase().includes(needle))
    }, [displayOf, entries, query])
    const shown = useMemo(() => {
      const byLatest = (a: FileEntry, b: FileEntry): number => (b.ops[0]?.seq ?? 0) - (a.ops[0]?.seq ?? 0)
      const byPath = (a: FileEntry, b: FileEntry): number => (a.path < b.path ? -1 : 1)
      const linesOf = (e: FileEntry): number => e.added + e.removed
      const keyOf = (e: FileEntry): number =>
        filter === 'read' ? e.reads : filter === 'write' ? e.writes : filter === 'search' ? e.searches : e.ops.length
      const byName = (a: FileEntry, b: FileEntry): number => {
        const an = baseNameOf(displayOf(a))
        const bn = baseNameOf(displayOf(b))
        return an !== bn ? (an < bn ? -1 : 1) : byPath(a, b)
      }
      const byVolume = (key: (e: FileEntry) => number, tie: (a: FileEntry, b: FileEntry) => number) =>
        (a: FileEntry, b: FileEntry): number => key(b) - key(a) || tie(a, b)
      const comparators: Record<DefaultFileSort, (a: FileEntry, b: FileEntry) => number> = {
        count: byVolume(keyOf, byLatest),
        lines: byVolume(linesOf, byPath),
        latest: byLatest,
        name: byName,
        path: byPath,
      }
      return matched.filter(e => matches(e, filter)).sort(comparators[sort])
    }, [displayOf, filter, matched, sort])
    const matchedTotals = useMemo(() => totalsOf(matched), [matched])
    const shownTotals = useMemo(() => totalsOf(shown), [shown])
    const getKey = useCallback((index: number): string => shown[index].path, [shown])
    const scope = useSurfaceWindow(listRef, {
      count: shown.length,
      getKey,
      estimateSize: () => FILE_ROW_ESTIMATE,
      overscan: 240,
      seed: 10,
    })
    const remote = remoteStateOf(entries.length, props.state, props.onRetry)
    const chips: { key: FileFilter; files: number; ops: number }[] = [
      {
        key: 'all',
        files: matched.length,
        ops: matchedTotals.read.ops + matchedTotals.write.ops + matchedTotals.search.ops,
      },
      { key: 'read', files: matchedTotals.read.files, ops: matchedTotals.read.ops },
      { key: 'write', files: matchedTotals.write.files, ops: matchedTotals.write.ops },
      { key: 'search', files: matchedTotals.search.files, ops: matchedTotals.search.ops },
      { key: 'image', files: matchedTotals.image.files, ops: matchedTotals.image.ops },
    ]
    const bodyIdOf = (index: number): string => `${idBase}-${index}`

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
          <span className="lc-card-title-text">
            <IconFolderOpen size={14} />
            {t('files.title')}
          </span>
          <span className="lc-fa-meta">
            <span>{t(shown.length === 1 ? 'files.file' : 'files.files', { n: shown.length })}</span>
            {shownTotals.added + shownTotals.removed > 0 ? (
              <span className="lc-fa-meta-delta group/tip">
                <DeltaPair added={shownTotals.added} removed={shownTotals.removed} />
                <span className="lc-tip lc-fa-meta-tip group-hover/tip:opacity-100" role="tooltip">{t('files.deltaTip')}</span>
              </span>
            ) : null}
          </span>
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
        <div>
          <div className="lc-fa-ctl">
            <ClearableInput
              className="lc-fa-search"
              value={query}
              placeholder={t('files.search')}
              clearLabel={t('field.clear')}
              onChange={setQuery}
            />
            <span className="lc-gran lc-fa-sort" role="group" title={t('files.sortTip')}>
              {(['count', 'lines', 'latest', 'path', 'name'] as const).map(k => (
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
          {remote.kind === 'loading' ? (
            <DetailNote state="loading" className="lc-empty lc-lane" />
          ) : remote.kind === 'failed' ? (
            <DetailNote state="failed" onRetry={remote.retry} className="lc-empty lc-lane" />
          ) : shown.length === 0 ? (
            <div className="lc-empty lc-lane">{t(entries.length === 0 ? 'files.empty' : 'files.noMatch')}</div>
          ) : (
            <div className="lc-fa-list" ref={listRef} onKeyDown={scope.onKeyDown}>
              {scope.topPad > 0
                ? <div className="lc-row-pad" style={{ height: scope.topPad }} aria-hidden="true" />
                : null}
              {shown.slice(scope.from, scope.to + 1).map((e, i) => {
                const index = scope.from + i
                const open = openPath === e.path
                const alt = index % 2 === 1
                const display = displayOf(e)
                const windows = e.pattern !== true && displayStyleOf(e.path, workspace) === 'windows'
                const { directory: dir, name: base } = windows || !display.includes('\\')
                  ? pathPartsOf(display)
                  : slashPartsOf(display)
                const glyph = glyphOf(e.path, e.form)
                const abs = e.pattern === true ? undefined : absPathOf(e.path, workspace)
                const previewable = props.onPreview !== undefined && e.pattern !== true && e.form !== 'dir'
                const openable = previewable || (abs !== undefined && props.onOpen !== undefined)
                const bodyId = bodyIdOf(index)
                return (
                  <div key={e.path} className="lc-fa-slot" ref={scope.measure(e.path)}>
                    <div className={'lc-fa-item' + (open ? ' lc-fa-item-on' : '') + (alt ? ' lc-fa-item-alt' : '')}>
                      <div
                        className="lc-fa-row hover:bg-(--dsw-alias-interactive-bg-hover) @max-[380px]/lc-card:flex-wrap"
                        title={e.path}
                        onClick={() => { setOpenPath(open ? null : e.path) }}
                      >
                        <button
                          type="button"
                          className="lc-fa-toggle"
                          tabIndex={scope.tabIndexFor(e.path)}
                          aria-expanded={open}
                          {...(open ? { 'aria-controls': bodyId } : {})}
                          aria-label={t(open ? 'fleet.collapse' : 'fleet.expand')}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setOpenPath(open ? null : e.path)
                          }}
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
                        </button>
                        <span className="lc-fa-path flex-1 @max-[380px]/lc-card:basis-[calc(100%-46px)]">
                          {dir !== '' ? <em>{dir}</em> : null}
                          {openable
                            ? (
                              <button
                                type="button"
                                className="lc-fa-file hover:underline"
                                title={t(previewable ? 'files.preview' : 'files.open')}
                                aria-label={t(previewable ? 'files.preview' : 'files.open') + ' ' + base}
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  if (previewable && props.onPreview?.(e) === true) return
                                  if (abs !== undefined) props.onOpen?.(abs)
                                }}
                              >
                                {base}
                              </button>
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
                        {e.ops[0]?.time !== undefined
                          ? <span className="lc-fa-time">{fmtTime(e.ops[0].time)}</span>
                          : null}
                      </div>
                      {open ? (
                        <div className="lc-fa-ops" id={bodyId}>
                          {e.ops.map((op, opIndex) => {
                            const onLocate = props.onLocate
                            const key = `${op.seq}:${opIndex}`
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
                  </div>
                )
              })}
              {scope.bottomPad > 0
                ? <div className="lc-row-pad" style={{ height: scope.bottomPad }} aria-hidden="true" />
                : null}
            </div>
          )}
        </div>
      </div>
    )
  })
}

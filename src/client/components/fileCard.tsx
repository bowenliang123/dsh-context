/**
 * The File Activity card — the user-benefit view of a step range: not what
 * the context is MADE of (messages) but what the agent DID with its tools
 * to the user's files. One row per touched file with per-purpose counts
 * (read/written/searched), an estimated line delta, and multimodal forms
 * (image reads, directory targets) flagged; the header chips double as
 * purpose/form filters and the search box narrows by path.
 *
 * Interaction mirrors the Context browser's element rows: a row click
 * expands the file's own operation log; each operation is itself the click
 * target that jumps to (and reveals) the exact tool result in the browser.
 */

import type * as ReactNS from 'react'
import type { FileActivity, FileEntry, FileForm, FileOp, FileOpKind } from '../fileActivity'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export type FileFilter = 'all' | FileOpKind | 'image'

export interface FileCardProps {
  activity: FileActivity
  /** The range label — the picked step, or the whole-session latest view. */
  scope: string
  /** Reveal one operation's result node in the Context browser; absent = op lines render inert. */
  onLocate?: (op: FileOp) => void
}

/** An expanded file lists at most this many ops before a "+n earlier" line. */
const MAX_OPS = 8

export function makeFileCard(kit: ViewKit): (props: FileCardProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime } = kit

  function formGlyph(form: FileForm): string {
    return form === 'image' ? '🖼' : form === 'dir' ? '📁' : '📄'
  }

  function matches(e: FileEntry, f: FileFilter): boolean {
    if (f === 'all') return true
    if (f === 'image') return e.form === 'image'
    if (f === 'read') return e.reads > 0
    if (f === 'write') return e.writes > 0
    return e.searches > 0
  }

  /** Signed line pair, harness diff semantics: growth on the success token, shrinkage on the error token. */
  function DeltaPair(props: { added: number; removed: number }): ReactNS.ReactElement {
    return (
      <span className="lc-fa-delta">
        {props.added > 0 ? <span className="lc-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="lc-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  return function FileCard(props: FileCardProps): ReactNS.ReactElement {
    const { activity } = props
    const [filter, setFilter] = React.useState<FileFilter>('all')
    const [query, setQuery] = React.useState('')
    const [openPath, setOpenPath] = React.useState<string | null>(null)

    const q = query.trim().toLowerCase()
    const shown = activity.entries.filter(e => matches(e, filter) && (q === '' || e.path.toLowerCase().includes(q)))

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

    const opLine = (op: FileOp): ReactNS.ReactElement => (
      <>
        <span className="lc-fa-op-time">{op.time !== undefined ? fmtTime(op.time) : '—'}</span>
        <span className="lc-fa-op-tool">{op.tool}</span>
        {op.detail !== undefined ? <span className="lc-fa-op-detail">{op.detail}</span> : null}
        {op.added + op.removed > 0 ? <DeltaPair added={op.added} removed={op.removed} /> : null}
        {op.err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
      </>
    )

    return (
      <div className="lc-card lc-col">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('files.title')}</span>
          <span className="lc-card-sub">{props.scope}</span>
        </div>
        {activity.entries.length === 0 ? (
          <div className="lc-empty">{t('files.empty')}</div>
        ) : (
          <div>
            <div className="lc-fa-ctl">
              <div className="lc-gran">
                {chips.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    className={'lc-gran-btn' + (filter === c.key ? ' lc-gran-on' : '')}
                    title={t('files.chipTip', { files: c.files, ops: c.ops })}
                    onClick={() => { setFilter(cur => (cur === c.key ? 'all' : c.key)) }}
                  >
                    {t('files.kind.' + c.key)}
                    <b className="lc-fa-n">{fmt(c.ops)}</b>
                  </button>
                ))}
              </div>
              <input
                className="lc-fa-search"
                value={query}
                placeholder={t('files.search')}
                onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
              />
            </div>
            <div className="lc-fa-meta">
              <span>{t('files.files', { n: activity.entries.length })}</span>
              {activity.totals.added + activity.totals.removed > 0 ? (
                /* The one styled tip of the card: it lives OUTSIDE the scrolling list, so the bubble never clips. */
                <span className="lc-fa-meta-delta">
                  <DeltaPair added={activity.totals.added} removed={activity.totals.removed} />
                  <span className="lc-fa-meta-tip" role="tooltip">{t('files.deltaTip')}</span>
                </span>
              ) : null}
            </div>
            {shown.length === 0 ? (
              <div className="lc-empty">{t('files.noMatch')}</div>
            ) : (
              <div className="lc-fa-list">
                {shown.map((e) => {
                  const open = openPath === e.path
                  const trimmed = e.path.endsWith('/') ? e.path.slice(0, -1) : e.path
                  const slash = trimmed.lastIndexOf('/')
                  const dir = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
                  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
                  return (
                    <div key={e.path} className={'lc-fa-item' + (open ? ' lc-fa-item-on' : '')}>
                      <button
                        type="button"
                        className="lc-fa-row"
                        title={e.path}
                        onClick={() => { setOpenPath(open ? null : e.path) }}
                      >
                        <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')}>{'▸'}</span>
                        <span className="lc-fa-form" title={t('files.form.' + e.form)}>{formGlyph(e.form)}</span>
                        <span className="lc-fa-path">{dir !== '' ? <em>{dir}</em> : null}<b>{base}</b></span>
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
                        {e.errs > 0 ? <span className="lc-br-err-dot" title={t('files.errs', { n: e.errs })} /> : null}
                        {e.ops[0].time !== undefined
                          ? <span className="lc-fa-time">{fmtTime(e.ops[0].time)}</span>
                          : null}
                      </button>
                      {open ? (
                        <div className="lc-fa-ops">
                          {e.ops.slice(0, MAX_OPS).map((op) => {
                            const onLocate = props.onLocate
                            return onLocate !== undefined
                              ? (
                                <button
                                  key={op.seq}
                                  type="button"
                                  className="lc-fa-op lc-fa-op-link"
                                  title={t('files.locate')}
                                  onClick={() => { onLocate(op) }}
                                >
                                  {opLine(op)}
                                </button>
                              )
                              : <div key={op.seq} className="lc-fa-op">{opLine(op)}</div>
                          })}
                          {e.ops.length > MAX_OPS
                            ? <div className="lc-fa-more">{t('files.moreOps', { n: e.ops.length - MAX_OPS })}</div>
                            : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {activity.unresolved > 0
          ? <div className="lc-fa-note">{t('files.unresolved', { n: activity.unresolved })}</div>
          : null}
      </div>
    )
  }
}

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import { cacheHitPercent } from '../format'
import type { StepBrief } from '../brief'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import type { ConversationNodeLike } from '../services'
import type { StackedBarProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface RequestDetailProps {
  request: RequestRecord | null
  /**
   * Delta mode: the record displayed just before this one (null on the first
   * bar). Its PRESENCE switches the panel from cumulative makeup to the signed
   * change against that previous record — the same pairing the chart's
   * deltaOf plots.
   */
  prev?: RequestRecord | null
  marker?: ContextEventRecord | null
  /** The step's semantic identity (turn opener / inputs / reply) — see brief.ts; null hides the section. */
  brief?: StepBrief | null
  /** Conversation-snapshot join for call-argument enrichment; absent join = names only, never an error. */
  convOf?: (seq: number) => ConversationNodeLike | undefined
  /** Reveal a brief row's node in the Context browser; absent = rows render inert. */
  onLocate?: (node: SurfaceNode, isResponse: boolean) => void
}

export function makeRequestDetail(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
): (props: RequestDetailProps) => ReactNS.ReactElement | null {
  const { t, fmt, fmtTime, catLabel, eventLabel, eventAt } = kit

  /**
   * One brief row: a fixed-width kind tag plus one glanceable line. The tag carries a styled, instant explanation bubble (the
   * `.lc-stat-tip` pattern); the content span keeps the native title (preview + locate hint), so the two never stack.
   * Clickable when the browser linkage is wired.
   */
  function BriefRow(props: {
    tag: string
    tagTip: string
    node: SurfaceNode
    isResponse: boolean
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
    children: ReactNS.ReactNode
  }): ReactNS.ReactElement {
    const cls = 'lc-brief-row' + (props.onLocate !== undefined ? ' lc-brief-row-link' : '')
    const inner = (
      <>
        <span className="lc-brief-tag">
          {props.tag}
          <span className="lc-brief-tip" role="tooltip">{props.tagTip}</span>
        </span>
        {props.children}
      </>
    )
    if (props.onLocate === undefined) return <div className={cls}>{inner}</div>
    const locate = () => { props.onLocate?.(props.node, props.isResponse) }
    return (
      <button type="button" className={cls} onClick={locate}>
        {inner}
      </button>
    )
  }

  /** One-line identity of a surface node: text preview, call breadcrumb, tool name, or a localized placeholder. */
  function nodeLine(n: SurfaceNode, conv: ConversationNodeLike | undefined): string {
    if (n.cat === 'tool') return callSummaryOf(conv) ?? (n.tool ?? t('node.toolResult'))
    if (n.text !== undefined && n.text !== '') return n.text
    if (n.skill !== undefined) return t('node.skillTag', { name: n.skill })
    if (n.calls !== undefined && n.calls.length > 0) {
      const summary = blockSummaryOf(conv)
      return n.calls.join(' › ') + (summary !== null ? ' · ' + summary : '')
    }
    if (n.cat === 'assistant') return t('node.empty')
    if (n.cat === 'inject') return t('form.' + (n.form ?? 'context'))
    return t('node.nonText')
  }

  function BriefSection(props: {
    brief: StepBrief
    convOf?: (seq: number) => ConversationNodeLike | undefined
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
  }): ReactNS.ReactElement | null {
    const { opener, inputs, response } = props.brief
    if (opener === undefined && inputs.length === 0 && response === undefined) return null
    const convOf = props.convOf ?? (() => undefined)
    // The content span's native title: full preview, plus the locate hint when the row is clickable.
    const hint = props.onLocate !== undefined ? ' — ' + t('brief.locate') : ''
    // Chip click: locate THIS chip's node; stopPropagation keeps it from also firing the row's own locate.
    const locateChip = props.onLocate === undefined ? undefined : (n: SurfaceNode) =>
      (e?: ReactNS.MouseEvent) => { e?.stopPropagation(); props.onLocate?.(n, false) }
    const MAX_CHIPS = 3
    // The reply line: textless replies lead with their call breadcrumb ('→ bash › write'); a reply carrying BOTH text and calls
    // folds to text-only on the surface node, so its calls are recovered through the conversation join as a suffix.
    let replyText = ''
    let replyArrow = false
    if (response !== undefined) {
      const conv = convOf(response.seq)
      replyText = nodeLine(response, conv)
      if (response.calls !== undefined && response.calls.length > 0) {
        replyArrow = true
      } else {
        const joined = callNamesOf(conv)
        if (joined.length > 0) replyText += ' → ' + joined.join(' › ')
      }
    }
    return (
      <div className="lc-brief">
        {opener !== undefined ? (
          <BriefRow tag={t('brief.turn')} tagTip={t('brief.turnTip')} node={opener} isResponse={false} onLocate={props.onLocate}>
            <span className="lc-brief-text" title={nodeLine(opener, convOf(opener.seq)) + hint}>{nodeLine(opener, convOf(opener.seq))}</span>
          </BriefRow>
        ) : null}
        {inputs.length > 0 ? (
          // Whole-row clickable like the other rows (locates the FIRST input); each chip still locates its own node —
          // stopPropagation keeps a chip click from also firing the row's.
          <BriefRow tag={t('brief.input')} tagTip={t('brief.inputTip')} node={inputs[0]} isResponse={false} onLocate={props.onLocate}>
            {inputs.slice(0, MAX_CHIPS).map(n => (
              <span
                key={n.seq}
                className={'lc-brief-chip' + (props.onLocate !== undefined ? ' lc-brief-chip-link' : '')}
                title={nodeLine(n, convOf(n.seq)) + hint}
                onClick={locateChip !== undefined ? locateChip(n) : undefined}
              >
                {n.err === true ? <span className="lc-br-err-dot" /> : null}
                {nodeLine(n, convOf(n.seq))}
              </span>
            ))}
            {inputs.length > MAX_CHIPS ? <span className="lc-brief-more">{t('brief.more', { n: inputs.length - MAX_CHIPS })}</span> : null}
          </BriefRow>
        ) : null}
        {response !== undefined ? (
          <BriefRow tag={t('brief.reply')} tagTip={t('brief.replyTip')} node={response} isResponse onLocate={props.onLocate}>
            <span className="lc-brief-text" title={replyText + hint}>
              {replyArrow ? '→ ' : ''}{replyText}
            </span>
          </BriefRow>
        ) : null}
      </div>
    )
  }

  return function RequestDetail(props: RequestDetailProps): ReactNS.ReactElement | null {
    const req = props.request
    if (!req) return null
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? t('detail.turn', { t: req.turn ?? 0, n: req.stepCount ?? 0 })
      : t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
    // When this bar carries a boundary event (compaction/prune), the header
    // also shows WHERE the event happened: the gap between the request
    // before and the request after (e.g. "✂ Turn 49 · Step 2→3").
    const marker = props.marker ?? null
    const markerAt = marker !== null ? eventAt(marker) : null
    // Delta mode: per-category SIGNED change vs the previous record (the chart stacks them diverging
    // above/below its zero line); provider usage chips drop out — prompt/output/cacheRead are
    // per-request figures, not deltas.
    const delta = props.prev !== undefined
    const prev = props.prev ?? null
    const deltas = CATS.map(c => delta ? (req[c.key] || 0) - (prev !== null ? prev[c.key] || 0 : 0) : 0)
    let net = 0
    let maxAbs = 0
    if (delta) {
      for (const d of deltas) {
        net += d
        if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d)
      }
    }
    const parts = delta
      ? CATS.map((c, i) => ({ key: c.key, color: c.color, value: Math.abs(deltas[i]) }))
      : partsOf(req)
    return (
      <div className="lc-detail">
        <div className="lc-detail-head">
          <b>{head}</b>
          {marker !== null && markerAt !== null
            ? <span className="lc-detail-marker" title={eventLabel(marker)}>{'✂ ' + markerAt}</span>
            : null}
          {isTurn ? <span className="lc-detail-tag">{t('detail.lastStep')}</span> : null}
          {delta ? <span className="lc-detail-tag">{t('gran.delta')}</span> : null}
          <span className="lc-detail-time">{fmtTime(req.time)}</span>
          {/* Metric chips: one neutral pill per provider figure; the cache figure drops out on hosts
              that do not fold `cacheRead` (and on usage-less requests). */}
          {delta ? (
            <span className={'lc-detail-metric' + (net > 0 ? ' lc-detail-metric-up' : net < 0 ? ' lc-detail-metric-down' : '')}>
              {t('tip.delta', { n: (net > 0 ? '+' : '') + fmt(net) })}
            </span>
          ) : null}
          {!delta && req.prompt !== undefined
            ? <span className="lc-detail-metric">{t('detail.actual', { n: fmt(req.prompt) })}</span>
            : null}
          {!delta && req.output !== undefined
            ? <span className="lc-detail-metric">{t('detail.output', { n: fmt(req.output) })}</span>
            : null}
          {!delta && req.prompt !== undefined && req.cacheRead !== undefined
            ? <span className="lc-detail-metric">{t('detail.cache', { n: cacheHitPercent(req.cacheRead, req.prompt) ?? '—' })}</span>
            : null}
        </div>
        {props.brief !== null && props.brief !== undefined
          ? <BriefSection brief={props.brief} convOf={props.convOf} onLocate={props.onLocate} />
          : null}
        <StackedBar parts={parts} height={10} />
        <div className="lc-detail-rows">
          {CATS.map((c, i) => {
            const v = delta ? deltas[i] : req[c.key] || 0
            const mag = Math.abs(v)
            return (
              <div key={c.key} className="lc-detail-row">
                <i style={{ background: c.color }} />
                <span className="lc-detail-label">{catLabel(c.key)}</span>
                <span className="lc-bar-track">
                  {delta ? (
                    <>
                      {/* Mini diverging bar echoing the chart: zero at the middle, growth fills right,
                          shrinkage fills left, one shared scale across the rows. */}
                      <span className="lc-bar-zero" />
                      {v !== 0 ? (
                        <span
                          className={'lc-bar-fill ' + (v > 0 ? 'lc-bar-fill-up' : 'lc-bar-fill-down')}
                          style={{ width: `${mag / maxAbs * 50}%`, background: c.color }}
                        />
                      ) : null}
                    </>
                  ) : (
                    <span className="lc-bar-fill" style={{ width: `${req.total > 0 ? v / req.total * 100 : 0}%`, background: c.color }} />
                  )}
                </span>
                {delta ? (
                  <span className={'lc-detail-num' + (v > 0 ? ' lc-detail-num-up' : v < 0 ? ' lc-detail-num-down' : '')}>
                    {(v > 0 ? '+' : '') + fmt(v)}
                  </span>
                ) : (
                  <span className="lc-detail-num">{'≈' + fmt(v)}</span>
                )}
                <span className="lc-detail-pct">{!delta && req.total > 0 ? `${Math.round(v / req.total * 100)}%` : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}

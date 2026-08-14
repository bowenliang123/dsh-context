/**
 * dsh-context — Client half (installed package bundle).
 *
 * Registers a "上下文/Context" tab in the conversation view ring
 * (`conversation.view` slot, beside Chat/Trajectory) and renders the
 * context-composition timeline served by the Host half over the generic
 * Connection RPC channel `/dsh-context`: current makeup, per-request
 * stacked-bar history, context events, and the live message list.
 *
 * This file is the body of the package's `./client` bundle: build.mjs wraps
 * it into the web boot handoff (`window.__ModuleLoader__.load({id, factory})`),
 * so it runs inside the browser module table. Everything here must be
 * TYPE-ONLY or runtime-free of imports (verbatimModuleSyntax enforces it):
 * React arrives via the injected `require`, UI text is bilingual (zh/en)
 * through the client `locale` service, and the Host sends structured
 * event/node records which this half localizes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type * as ReactNS from 'react'

/** React comes from the browser module table (`require('react')`). */
const React: typeof ReactNS = require('react')
const h = React.createElement

// ---- local service contracts (typed subset of the client surface) -----------
//
// The `@deepseek-ai/*` service type packages publish broken dependency chains
// on npm, so this plugin declares the exact client API surface it consumes.
// These are TYPE-ONLY: the runtime services come from the user's harness.

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string } }

interface ClientConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>
}

interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  subscribe(fn: () => void): () => void
}

interface SlotRegistration {
  name: string
  id: string
  order: number
  label: () => string
}

interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string }) => unknown,
  ): unknown
}

/** The client context: cordis plus the services this plugin injects. */
type ClientCtx = Context & {
  connection: { rpc: ClientConnectionRpc }
  locale: LocaleService
  slots: SlotsService
}

// ---- snapshot wire contract (mirrors the Host half) --------------------------

type Category = 'user' | 'inject' | 'assistant' | 'tool'

interface Snapshot {
  ok: boolean
  model?: string
  provider?: string
  contextWindow?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    assistant: number
    tool: number
    total: number
  }
  toolList: { name: string; tokens: number }[]
  requests: RequestRecord[]
  events: ContextEventRecord[]
  nodes: SurfaceNode[]
  droppedNodes: number
}

interface SurfaceNode {
  seq: number
  /** Event timestamp (ms epoch); shown in the message list when present. */
  time?: number
  cat: Category
  tokens: number
  form?: string
  text?: string
  tool?: string
  err?: boolean
  skill?: string
  calls?: string[]
}

interface RequestRecord {
  turn?: number
  step?: number
  time: number
  seq: number
  system: number
  tools: number
  user: number
  inject: number
  assistant: number
  tool: number
  total: number
  prompt?: number
  output?: number
  /**
   * Turn-mode aggregate marker: the number of steps this turn collapsed
   * into one bar (set by aggregateByTurn; absent for plain step records).
   */
  stepCount?: number
}

interface ContextEventRecord {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model'
  form?: string
  tokens?: number
  count?: number
  sub?: string
  name?: string
  from?: string
  to?: string
}

// ---- dictionaries ------------------------------------------------------------

const DICT_ZH: Record<string, string> = {
  'tab': '上下文',
  'cat.system': '系统提示', 'cat.tools': '工具定义', 'cat.user': '用户消息',
  'cat.inject': '注入上下文', 'cat.assistant': '助手回复', 'cat.tool': '工具结果',
  'overview.title': '当前构成',
  'overview.ofWindow': 'tokens（约 {p}%）',
  'overview.estimate': 'tokens（估算）',
  'overview.actual': '· 上次实际 prompt {n}',
  'tools.top': '工具定义 Top：',
  'tools.more': '等 {n} 个',
  'trend.title': '历史趋势',
  'gran.step': '步骤', 'gran.turn': '轮次',
  'trend.hint': '每次模型请求一段；点击柱子查看详情，✂ 表示压缩/剪枝；左右滑动可回看更早',
  'trend.empty': '发起一轮对话后，这里会展示每次模型请求的上下文构成',
  'detail.step': 'T{t} · 第 {s} 步',
  'detail.turn': 'T{t} · 共 {n} 步',
  'detail.lastStep': '末步',
  'detail.estTotal': '估算合计 ≈ {n}',
  'detail.actual': '实际 prompt {n}',
  'detail.output': '输出 {n}',
  'events.title': '上下文事件',
  'events.empty': '暂无上下文事件（压缩、注入、模型切换会出现在这里）',
  'nodes.title': '消息构成',
  'nodes.hint': '当前模型可见的消息，最新在前',
  'nodes.more': '… 更早的 {n} 条消息已省略',
  'nodes.empty': '当前没有模型可见的消息',
  'loading': '正在读取会话日志…',
  'error': '上下文数据读取失败：',
  'footer': '估算口径：与 dsh 内置 tokenMeter 相同的固定密度启发式（约 4 字符 ≈ 1 token）；「实际」为供应商上报用量。',
  'tip.step': 'T{t} · 第{s}步',
  'tip.turn': 'T{t} · 共 {n} 步',
  'tip.total': '合计 ≈ {n}',
  'tip.actual': '（实际 {n}）',
  'ev.compaction': '压缩上下文（摘要替换 {n} 条消息）',
  'ev.prune': '剪枝工具输出',
  'ev.skill': 'Skill 注入（{name}）',
  'ev.model': '模型切换：{a} → {b}',
  'form.instructions': '指令注入', 'form.catalog': '目录更新', 'form.snapshot': '状态快照',
  'form.notice': '通知', 'form.relay': '代理转发', 'form.recall': '历史召回', 'form.context': '上下文注入',
  'node.toolResult': '工具结果',
  'node.calls': '调用 ',
  'node.empty': '(空回复)',
  'node.nonText': '(非文本消息)',
  'node.snapshot': '快照: ',
}

const DICT_EN: Record<string, string> = {
  'tab': 'Context',
  'cat.system': 'System', 'cat.tools': 'Tool schemas', 'cat.user': 'User',
  'cat.inject': 'Injected', 'cat.assistant': 'Assistant', 'cat.tool': 'Tool results',
  'overview.title': 'Current composition',
  'overview.ofWindow': 'tokens (~{p}%)',
  'overview.estimate': 'tokens (estimated)',
  'overview.actual': '· last actual prompt {n}',
  'tools.top': 'Top tool schemas:',
  'tools.more': 'of {n}',
  'trend.title': 'History',
  'gran.step': 'Step', 'gran.turn': 'Turn',
  'trend.hint': 'one bar per model request; click a bar for details, ✂ marks compaction/prune; scroll sideways to see earlier',
  'trend.empty': 'Send a message and each model request’s context makeup shows up here',
  'detail.step': 'T{t} · step {s}',
  'detail.turn': 'T{t} · {n} steps',
  'detail.lastStep': 'last step',
  'detail.estTotal': 'estimated ≈ {n}',
  'detail.actual': 'actual prompt {n}',
  'detail.output': 'output {n}',
  'events.title': 'Context events',
  'events.empty': 'No context events yet (compaction, injections, model switches appear here)',
  'nodes.title': 'Messages',
  'nodes.hint': 'currently model-visible, newest first',
  'nodes.more': '… {n} earlier messages omitted',
  'nodes.empty': 'No model-visible messages right now',
  'loading': 'Reading the session log…',
  'error': 'Failed to read context data: ',
  'footer': 'Estimate: same fixed-density heuristic as dsh’s built-in tokenMeter (~4 chars ≈ 1 token); “actual” is provider-reported usage.',
  'tip.step': 'T{t} · step {s}',
  'tip.turn': 'T{t} · {n} steps',
  'tip.total': 'total ≈ {n}',
  'tip.actual': ' (actual {n})',
  'ev.compaction': 'Context compacted (summary replaced {n} messages)',
  'ev.prune': 'Tool output pruned',
  'ev.skill': 'Skill injected ({name})',
  'ev.model': 'Model switched: {a} → {b}',
  'form.instructions': 'Instructions', 'form.catalog': 'Catalog update', 'form.snapshot': 'State snapshot',
  'form.notice': 'Notice', 'form.relay': 'Agent relay', 'form.recall': 'Recall', 'form.context': 'Context injection',
  'node.toolResult': 'Tool result',
  'node.calls': 'calls ',
  'node.empty': '(empty reply)',
  'node.nonText': '(non-text message)',
  'node.snapshot': 'snapshot: ',
}

const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', inject: '＋', model: '⇄' }

type Translate = (key: string, params?: Record<string, string | number>) => string

function fmt(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}

function fmtTime(t: number): string {
  const d = new Date(t)
  function p(x: number) { return (x < 10 ? '0' : '') + x }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/**
 * Collapse a per-step request timeline into one bar per turn: each turn is
 * represented by its LAST step's record (the context state when the turn
 * finished), tagged with the number of steps the turn spans so the bar can
 * keep the turn's column width and the detail can label it. Requests of one
 * turn are consecutive in the log, so a run of equal turns is replaced by
 * its final record.
 */
function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      out[out.length - 1] = { ...req, stepCount: runSteps }
    } else {
      runSteps = 1
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

// ---- view components ---------------------------------------------------------

interface PartsPart { key: string; color: string; value: number }
interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  /** Optional hover link: the active segment key, reported via onHoverKey. */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}
interface TrendChartProps {
  requests: RequestRecord[]
  events: ContextEventRecord[]
  selectedSeq: number | null
  hoveredSeq: number | null
  /** The turn currently highlighted (from the turn strip or a hovered bar). */
  activeTurn: number | null
  /** Display granularity; a switch re-anchors the chart at the newest bars. */
  granularity: 'step' | 'turn'
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
}
interface RequestDetailProps { request: RequestRecord | null }
interface EventListProps { events: ContextEventRecord[] }
interface NodeListProps { nodes: SurfaceNode[]; dropped: number }
interface ContextViewProps { sessionId?: string }

function makeView(ctx: ClientCtx, t: Translate): (props: ContextViewProps) => ReactNS.ReactElement {
  function tr(key: string, vars?: Record<string, string | number>): string {
    return t(key, vars)
  }

  const CATS: { key: Category | 'system' | 'tools'; color: string }[] = [
    { key: 'system', color: '#6366f1' },
    { key: 'tools', color: '#f59e0b' },
    { key: 'user', color: '#22c55e' },
    { key: 'inject', color: '#a855f7' },
    { key: 'assistant', color: '#3b82f6' },
    { key: 'tool', color: '#14b8a6' },
  ]

  function catLabel(key: string): string { return t('cat.' + key) }

  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return tr('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return tr('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'inject') {
      if (ev.sub === 'skill') return tr('ev.skill', { name: ev.name || '?' })
      const base = t('form.' + (ev.form || 'context'))
      return ev.name ? base + ' · ' + ev.name : base
    }
    return ev.kind
  }

  function nodeText(n: SurfaceNode): string {
    if (n.cat === 'tool') {
      return t('node.toolResult') + (n.tool ? ' ← ' + n.tool : '') + (n.err ? ' ⚠' : '')
    }
    if (n.skill) return 'Skill: ' + n.skill
    if (n.calls) return t('node.calls') + n.calls.join(', ')
    if (n.text) return n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
    if (n.cat === 'assistant') return t('node.empty')
    if (n.cat === 'inject') return t('form.' + (n.form || 'context'))
    return t('node.nonText')
  }

  function StackedBar(props: StackedBarProps): ReactNS.ReactElement {
    // props.parts: [{key,color,value}]; optional props.max: when max exceeds
    // the parts' total, the remainder shows as empty track.
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total

    // The tooltip is DERIVED from the shared hover key, so hovering either a
    // segment or its legend chip lights the same segment and shows the same
    // tooltip (centered on the segment; percentage positioning needs no
    // measuring). The wrapper keeps the tooltip outside the clipped stack.
    let tip: { text: string; leftPct: number } | null = null
    if (props.hoverKey !== null && props.hoverKey !== undefined) {
      let acc = 0
      for (const p of props.parts) {
        const pct = scale > 0 ? p.value / scale * 100 : 0
        if (p.key === props.hoverKey && p.value > 0) {
          tip = {
            text: catLabel(p.key) + ' ' + fmt(p.value) + ' (' + Math.round(p.value / total * 100) + '%)',
            leftPct: Math.max(12, Math.min(acc + pct / 2, 88)),
          }
          break
        }
        acc += pct
      }
    }

    return h('div', { className: 'lc-stacked-wrap' },
      h('div', {
        className: 'lc-stacked',
        style: { height: (props.height || 14) + 'px' },
        onMouseLeave: () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) },
      },
        total <= 0
          ? null
          : props.parts.map(p => {
            if (!p.value) return null
            const on = props.hoverKey !== undefined && props.hoverKey === p.key
            return h('div', {
              key: p.key,
              className: 'lc-stacked-seg' + (on ? ' lc-stacked-seg-on' : ''),
              style: { width: (p.value / scale * 100) + '%', background: p.color },
              onMouseEnter: () => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) },
            })
          })),
      tip ? h('div', { className: 'lc-bar-tip', style: { left: tip.leftPct + '%' } }, tip.text) : null)
  }

  function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactNS.ReactElement {
    let total = 0
    for (const p of props.parts) total += p.value
    return h('div', { className: 'lc-legend' },
      props.parts.map(p => {
        const on = props.hoverKey !== undefined && props.hoverKey === p.key
        return h('span', {
          key: p.key,
          className: 'lc-chip' + (on ? ' lc-chip-on' : ''),
          onMouseEnter: () => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) },
          onMouseLeave: () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) },
        },
          h('i', { style: { background: p.color } }),
          catLabel(p.key) + ' ' + fmt(p.value),
          total > 0 ? h('em', null, Math.round(p.value / total * 100) + '%') : null)
      }))
  }

  function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
    return CATS.map(c => {
      return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
    })
  }

  // Plot height in px (the marker lane above it is 18px).
  const CHART_H = 112
  // Fixed column geometry: constant bar width keeps sparse histories from
  // stretching bars, and dense histories scroll horizontally instead of
  // compressing. The turn strip below mirrors the same column grid.
  const BAR_W = 14
  const BAR_GAP = 2
  // Turn strip palette: one color per turn, cycling for long histories.
  const TURN_COLORS = ['#6366f1', '#f59e0b', '#22c55e', '#a855f7', '#3b82f6', '#14b8a6', '#ef4444', '#ec4899']

  function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const requests = props.requests
    let maxTotal = 1
    for (const req of requests) if (req.total > maxTotal) maxTotal = req.total

    // Compaction/prune markers: attach each to the first request logged after it.
    const markers: Record<number, ContextEventRecord> = {}
    for (const ev of props.events) {
      if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
      for (let r = 0; r < requests.length; r++) {
        if (requests[r].seq >= ev.seq) {
          if (!markers[r]) markers[r] = ev
          break
        }
      }
    }

    // Consecutive requests of the same turn collapse into one labeled range.
    // `span` is the number of STEP columns the group covers (step records
    // count one each). In turn granularity the bars are uniform width, so
    // the strip blocks are uniform too; in step granularity they span their
    // steps' columns. Either way bars and blocks stay aligned.
    const groups: { turn: number; count: number; span: number; agg: boolean }[] = []
    for (const req of requests) {
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, span: 0, agg: req.stepCount !== undefined }
        groups.push(grp)
      }
      grp.count++
      grp.span += req.stepCount ?? 1
    }

    // Default anchor: the newest bars at the RIGHT edge. The first layout
    // after mount scrolls unconditionally; a GRANULARITY SWITCH re-anchors
    // the same way (returning to step mode must show the newest bars, not
    // the stale left edge from the narrow turn chart); otherwise the chart
    // only sticks to the end while the user is already near it (scrolling
    // away is respected). useLayoutEffect avoids a first-paint flash at the
    // left. Edge fades stay in sync with the scroll position.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const scrolledOnce = React.useRef(false)
    const lastGranRef = React.useRef(props.granularity)
    const [edges, setEdges] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false })
    const updateEdges = (el: HTMLDivElement): void => {
      const left = el.scrollLeft > 4
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      setEdges(prev => (prev.left === left && prev.right === right) ? prev : { left, right })
    }
    React.useLayoutEffect(() => {
      const el = scrollRef.current
      if (el === null) return
      if (props.granularity !== lastGranRef.current) {
        lastGranRef.current = props.granularity
        scrolledOnce.current = false // re-anchor on every granularity switch
      }
      if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 24) {
        el.scrollLeft = el.scrollWidth
      }
      updateEdges(el)
    })

    return h('div', { className: 'lc-chartrow' },
      h('div', { className: 'lc-axis' },
        h('span', { className: 'lc-axis-top' }, fmt(maxTotal)),
        h('span', { className: 'lc-axis-mid' }, fmt(Math.round(maxTotal / 2))),
        h('span', { className: 'lc-axis-bot' }, '0')),
      h('div', {
        className: 'lc-chart-scroll',
        ref: scrollRef,
        onScroll: (e: ReactNS.UIEvent<HTMLDivElement>) => { updateEdges(e.currentTarget) },
      },
        // Edge fades: visible whenever more history sits beyond the viewport,
        // so the horizontal scroll affordance is obvious.
        edges.left ? h('div', { className: 'lc-chart-fade lc-chart-fade-l' }) : null,
        // Hovering a bar previews it in the detail below; leaving the plot
        // clears the preview (a pinned selection, if any, takes over again).
        h('div', { className: 'lc-chart', onMouseLeave: () => { props.onHover(null) } },
          h('div', { className: 'lc-grid lc-grid-top' }),
          h('div', { className: 'lc-grid lc-grid-mid' }),
          requests.map((req, i) => {
            const selected = props.selectedSeq === req.seq
            const hovered = props.hoveredSeq === req.seq
            const inTurn = props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn
            const tip = (req.stepCount !== undefined && req.stepCount > 1
              ? tr('tip.turn', { t: req.turn ?? 0, n: req.stepCount })
              : tr('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 }))
              + ' · ' + fmtTime(req.time) + '\n'
              + tr('tip.total', { n: fmt(req.total) })
              + (req.prompt !== undefined ? tr('tip.actual', { n: fmt(req.prompt) }) : '') + '\n'
              + CATS.map(c => catLabel(c.key) + ' ' + fmt(req[c.key] || 0)).join(' / ')
            return h('div', {
              key: req.seq,
              // Uniform column width in BOTH granularities: turn aggregates
              // keep the same fixed width as step bars.
              className: 'lc-bar'
                + (selected ? ' lc-bar-selected' : '')
                + (hovered ? ' lc-bar-hovered' : '')
                + (inTurn ? ' lc-bar-in-turn' : ''),
              style: { width: BAR_W + 'px' },
              title: tip,
              onClick: () => { props.onSelect(selected ? null : req.seq) },
              onMouseEnter: () => { props.onHover(req.seq) },
            },
              markers[i] ? h('span', { className: 'lc-bar-marker', title: eventLabel(markers[i]) }, '✂') : null,
              h('div', { className: 'lc-bar-stack' },
                CATS.map(c => {
                  const v = req[c.key] || 0
                  if (!v) return null
                  // px heights: the stack's height is content-driven, so
                  // percentage heights would collapse against an indefinite base.
                  return h('div', { key: c.key, style: { height: Math.max(1, Math.round(v / maxTotal * CHART_H)) + 'px', background: c.color } })
                })))
          })),
        // Turn strip: one COLOR BLOCK per turn, spanning exactly its bars'
        // columns, so the partition reads at a glance and lines up with the
        // steps above. Hovering a block highlights that turn's bars in the
        // chart (and hovering a bar highlights its block — the active turn
        // is shared hover-only state).
        h('div', { className: 'lc-turns', onMouseLeave: () => { props.onHoverTurn(null) } },
          groups.map((grp, gi) => {
            // Turn mode: uniform blocks under uniform bars (1:1). Step mode:
            // blocks span their steps' columns. The flex gap between blocks
            // mirrors the bar gap, so blocks always line up with the bars.
            const on = props.activeTurn === grp.turn
            const blockW = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
            return h('span', {
              key: 'turn-' + gi,
              className: 'lc-turn' + (on ? ' lc-turn-on' : ''),
              style: {
                width: blockW + 'px',
                background: TURN_COLORS[gi % TURN_COLORS.length],
              },
              title: 'T' + grp.turn,
              onMouseEnter: () => { props.onHoverTurn(grp.turn) },
            }, 'T' + grp.turn)
          })),
        edges.right ? h('div', { className: 'lc-chart-fade lc-chart-fade-r' }) : null))
  }

  function RequestDetail(props: RequestDetailProps): ReactNS.ReactElement | null {
    const req = props.request
    if (!req) return null
    // Turn aggregates are labeled with their step count, and the breakdown
    // below is explicitly tagged as the turn's LAST step (that is the record
    // the bar carries).
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? tr('detail.turn', { t: req.turn ?? 0, n: req.stepCount ?? 0 })
      : tr('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
    return h('div', { className: 'lc-detail' },
      h('div', { className: 'lc-detail-head' },
        h('b', null, head),
        isTurn ? h('span', { className: 'lc-detail-tag' }, t('detail.lastStep')) : null,
        h('span', null, fmtTime(req.time)),
        h('span', null, tr('detail.estTotal', { n: fmt(req.total) })),
        req.prompt !== undefined ? h('span', { className: 'lc-actual' }, tr('detail.actual', { n: fmt(req.prompt) })) : null,
        req.output !== undefined ? h('span', null, tr('detail.output', { n: fmt(req.output) })) : null),
      h(StackedBar, { parts: partsOf(req), height: 10 }),
      h('div', { className: 'lc-detail-rows' },
        CATS.map(c => {
          const v = req[c.key] || 0
          return h('div', { key: c.key, className: 'lc-detail-row' },
            h('i', { style: { background: c.color } }),
            h('span', { className: 'lc-detail-label' }, catLabel(c.key)),
            h('span', { className: 'lc-bar-track' },
              h('span', { className: 'lc-bar-fill', style: { width: (req.total > 0 ? v / req.total * 100 : 0) + '%', background: c.color } })),
            h('span', { className: 'lc-detail-num' }, fmt(v)),
            h('span', { className: 'lc-detail-pct' }, req.total > 0 ? Math.round(v / req.total * 100) + '%' : ''))
        })))
  }

  function EventList(props: EventListProps): ReactNS.ReactElement {
    if (props.events.length === 0) {
      return h('div', { className: 'lc-empty' }, t('events.empty'))
    }
    const sorted = props.events.slice().reverse()
    return h('div', { className: 'lc-events' },
      sorted.map((ev, i) => {
        const label = eventLabel(ev)
        return h('div', { key: ev.seq + '-' + i, className: 'lc-event' },
          h('span', { className: 'lc-event-icon lc-event-' + ev.kind }, EVENT_ICONS[ev.kind] || '•'),
          h('span', { className: 'lc-event-label', title: label }, label),
          ev.tokens ? h('span', { className: 'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down') },
            (ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)) : null,
          h('span', { className: 'lc-event-time' }, fmtTime(ev.time)))
      }))
  }

  function NodeList(props: NodeListProps): ReactNS.ReactElement {
    if (props.nodes.length === 0) {
      return h('div', { className: 'lc-empty' }, t('nodes.empty'))
    }
    const catColor: Record<string, string> = {}
    for (const c of CATS) catColor[c.key] = c.color
    const rows = props.nodes.slice().reverse()
    return h('div', { className: 'lc-nodes' },
      props.dropped > 0 ? h('div', { className: 'lc-nodes-more' }, tr('nodes.more', { n: props.dropped })) : null,
      rows.map(n => {
        const text = nodeText(n)
        return h('div', { key: n.seq, className: 'lc-node' },
          h('i', { style: { background: catColor[n.cat] || '#999' } }),
          h('span', { className: 'lc-node-preview', title: text }, text),
          // Timestamp when the host event carried one.
          typeof n.time === 'number' ? h('span', { className: 'lc-node-time' }, fmtTime(n.time)) : null,
          h('span', { className: 'lc-node-tokens' }, fmt(n.tokens)))
      }))
  }

  function ContextView(props: ContextViewProps): ReactNS.ReactElement {
    const sessionId = props.sessionId
    const [data, setData] = React.useState<Snapshot | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = React.useState<number | null>(null)
    const [tick, setTick] = React.useState(0)
    const [granularity, setGranularity] = React.useState<'step' | 'turn'>('step')
    // Shared hover link between the composition bar and its legend below.
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)

    React.useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      let alive = true
      const load = () => {
        // Generic Connection RPC channel served by the Host half.
        ctx.connection.rpc.call('/dsh-context', 'snapshot', { sessionId }).then(res => {
          if (!alive) return
          if (res && res.ok) { setData(res.value as Snapshot); setError(null) }
          else setError(res && res.error ? String(res.error.message || res.error.code) : 'failed')
        }, (err: unknown) => {
          if (alive) setError(String(err instanceof Error ? err.message : err))
        })
      }
      load()
      const timerId = setInterval(load, 2000)
      return () => { alive = false; clearInterval(timerId) }
    }, [sessionId])

    // Re-render on locale switch.
    React.useEffect(() => {
      const localeSvc = ctx.get('locale') as LocaleService | undefined
      if (!localeSvc) return undefined
      return localeSvc.subscribe(() => setTick(x => x + 1))
    }, [])

    void tick

    if (error) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('error') + error))
    }
    if (!data) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('loading')))
    }

    const current = data.current
    const requests = data.requests || []
    const events = data.events || []
    const nodes = data.nodes || []
    // Display granularity: one bar per step (default) or one bar per turn
    // (each turn shown by its LAST step's record).
    const displayRequests = granularity === 'turn' ? aggregateByTurn(requests) : requests

    // The detail below follows the pointer: hover previews a bar, a pinned
    // click takes over when the pointer leaves, and both fall back to the
    // newest request. The active turn (for strip/bar highlighting) follows
    // the turn strip hover, or the hovered bar's turn.
    let pinnedReq: RequestRecord | null = null
    for (const req of displayRequests) if (req.seq === selectedSeq) pinnedReq = req
    let activeReq: RequestRecord | null = null
    if (hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) activeReq = req
    }
    if (activeReq === null) activeReq = pinnedReq
    if (activeReq === null && displayRequests.length > 0) activeReq = displayRequests[displayRequests.length - 1]

    // The turn highlight is hover-only: the turn strip hover wins, then the
    // hovered bar's turn (no fallback — a pinned or default selection must
    // not keep a turn glowing).
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    const windowPct = data.contextWindow ? Math.min(100, Math.round(current.total / data.contextWindow * 100)) : null

    return h('div', { className: 'lc-root' },

      // ---- overview ----
      h('div', { className: 'lc-card' },
        h('div', { className: 'lc-card-title' },
          t('overview.title'),
          h('span', { className: 'lc-card-sub' },
            (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : ''))),
        h('div', { className: 'lc-overview-num' },
          h('b', null, fmt(current.total)),
          h('span', null, data.contextWindow
            ? ' / ' + fmt(data.contextWindow) + ' ' + tr('overview.ofWindow', { p: windowPct ?? 0 })
            : ' ' + t('overview.estimate')),
          // The provider-reported prompt of the last request is the best
          // ground truth for what the model actually received; the fixed
          // density heuristic can undercount CJK-heavy content, so show the
          // real number alongside the estimate.
          displayRequests.length > 0 && displayRequests[displayRequests.length - 1].prompt !== undefined
            ? h('span', { className: 'lc-actual' },
              tr('overview.actual', { n: fmt(displayRequests[displayRequests.length - 1].prompt ?? 0) }))
            : null),
        h(StackedBar, { parts: partsOf(current), height: 16, max: data.contextWindow, hoverKey: hoverCat, onHoverKey: setHoverCat }),
        h(Legend, { parts: partsOf(current), hoverKey: hoverCat, onHoverKey: setHoverCat }),
        (data.toolList && data.toolList.length > 0) ? h('div', { className: 'lc-tools' },
          t('tools.top'),
          data.toolList.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(tool => {
            return h('span', { key: tool.name, className: 'lc-tool-chip' }, tool.name + ' ' + fmt(tool.tokens))
          }),
          data.toolList.length > 5 ? h('span', { className: 'lc-card-sub' }, ' ' + tr('tools.more', { n: data.toolList.length })) : null) : null),

      // ---- trend ----
      h('div', { className: 'lc-card' },
        h('div', { className: 'lc-card-title' },
          t('trend.title'),
          h('span', { className: 'lc-card-sub' }, t('trend.hint')),
          h('div', { className: 'lc-gran' },
            h('button', {
              className: 'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : ''),
              onClick: () => { setGranularity('step') },
            }, t('gran.step')),
            h('button', {
              className: 'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : ''),
              onClick: () => { setGranularity('turn') },
            }, t('gran.turn')))),
        displayRequests.length === 0
          ? h('div', { className: 'lc-empty' }, t('trend.empty'))
          : h('div', null,
            h(TrendChart, {
              // Remount per session: switching sessions re-anchors the chart
              // at the newest bars instead of inheriting stale scroll state.
              key: sessionId,
              // The host caps the log at 160 requests; render them ALL so
              // earlier turns/steps stay reachable via horizontal scroll.
              requests: displayRequests,
              events,
              selectedSeq: pinnedReq ? pinnedReq.seq : null,
              hoveredSeq,
              activeTurn,
              granularity,
              onSelect: setSelectedSeq,
              onHover: setHoveredSeq,
              onHoverTurn: setHoverTurn,
            }),
            h(RequestDetail, { request: activeReq }))),

      // ---- events + messages ----
      h('div', { className: 'lc-cols' },
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' }, t('events.title')),
          h(EventList, { events })),
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' },
            t('nodes.title'),
            h('span', { className: 'lc-card-sub' }, t('nodes.hint'))),
          h(NodeList, { nodes, dropped: data.droppedNodes || 0 }))),

      h('div', { className: 'lc-foot' }, t('footer')))
  }

  return ContextView
}

const STYLES = [
  '.lc-root { padding: 16px 20px 32px; overflow-y: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }',
  '.lc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }',
  '.lc-card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: baseline; gap: 8px; }',
  '.lc-card-sub { font-weight: 400; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-gran { margin-left: auto; display: flex; gap: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 1px; }',
  '.lc-gran-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 5px; cursor: pointer; font-family: inherit; }',
  '.lc-gran-btn:hover { color: var(--dsw-alias-label-primary); }',
  '.lc-gran-on, .lc-gran-on:hover { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }',
  '.lc-overview-num { margin-bottom: 8px; }',
  '.lc-overview-num b { font-size: 20px; }',
  '.lc-overview-num span { color: var(--dsw-alias-label-secondary); }',
  '.lc-stacked-wrap { position: relative; width: 100%; }',
  '.lc-stacked { display: flex; width: 100%; border-radius: 5px; overflow: hidden; background: rgba(128,128,128,0.18); }',
  '.lc-bar-tip { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; white-space: nowrap; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; font-size: 12px; color: var(--dsw-alias-label-primary); box-shadow: 0 2px 8px rgba(0,0,0,0.18); pointer-events: none; }',
  '.lc-stacked > div { height: 100%; }',
  '.lc-stacked-seg-on { filter: brightness(1.18); }',
  '.lc-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; }',
  '.lc-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-primary); }',
  '.lc-chip i, .lc-detail-row i, .lc-node i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }',
  '.lc-chip em { font-style: normal; color: var(--dsw-alias-label-secondary); }',
  '.lc-chip-on { font-weight: 600; }',
  '.lc-chip-on i { box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }',
  '.lc-tools { margin-top: 10px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
  '.lc-tool-chip { background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 1px 7px; font-size: 12px; color: var(--dsw-alias-label-primary); }',
  '.lc-chartrow { display: flex; gap: 6px; align-items: stretch; }',
  '.lc-axis { position: relative; width: 40px; height: 150px; padding-top: 18px; box-sizing: border-box; color: var(--dsw-alias-label-secondary); font-size: 11px; }',
  '.lc-axis span { position: absolute; right: 0; line-height: 1; }',
  '.lc-axis-top { top: 13px; }',
  '.lc-axis-mid { top: 69px; }',
  '.lc-axis-bot { top: 125px; }',
  '.lc-chart-scroll { position: relative; flex: 1; overflow-x: auto; overflow-y: hidden; min-width: 0; scrollbar-width: thin; }',
  '.lc-chart-scroll::-webkit-scrollbar { height: 8px; }',
  '.lc-chart-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); border-radius: 4px; }',
  '.lc-chart-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 70%, transparent); }',
  '.lc-chart-scroll::-webkit-scrollbar-track { background: transparent; }',
  '.lc-chart-fade { position: absolute; top: 0; bottom: 0; width: 26px; pointer-events: none; z-index: 2; }',
  '.lc-chart-fade-l { left: 0; background: linear-gradient(to right, var(--dsw-alias-bg-layer-1), transparent); }',
  '.lc-chart-fade-r { right: 0; background: linear-gradient(to left, var(--dsw-alias-bg-layer-1), transparent); }',
  '.lc-chart { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 130px; padding-top: 18px; box-sizing: border-box; width: max-content; min-width: 100%; }',
  '.lc-grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-border-l1); pointer-events: none; }',
  '.lc-grid-top { top: 18px; }',
  '.lc-grid-mid { top: 74px; }',
  '.lc-bar { position: relative; width: 14px; flex: none; height: 100%; display: flex; align-items: flex-end; cursor: pointer; border-radius: 2px; }',
  '.lc-bar:hover { background: var(--dsw-alias-bg-layer-2); }',
  '.lc-bar-selected { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
  '.lc-bar-hovered { outline: 1px dashed var(--dsw-alias-brand-primary); outline-offset: 1px; }',
  '.lc-bar-in-turn { background: rgba(99,102,241,0.14); }',
  '.lc-bar-stack { display: flex; flex-direction: column-reverse; width: 100%; }',
  '.lc-bar-stack > div { width: 100%; }',
  '.lc-bar-marker { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--dsw-alias-state-warn-primary); }',
  '.lc-turns { display: flex; gap: 2px; width: max-content; min-width: 100%; margin-top: 4px; }',
  '.lc-turn { flex: none; box-sizing: border-box; text-align: center; font-size: 10px; line-height: 14px; font-weight: 600; color: #fff; border-radius: 3px; height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; transition: filter 120ms; }',
  '.lc-turn-on { filter: brightness(1.35); box-shadow: 0 0 0 1px rgba(255,255,255,0.4); }',
  '.lc-detail { margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; }',
  '.lc-detail-head { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary); }',
  '.lc-detail-head b { color: var(--dsw-alias-label-primary); }',
  '.lc-detail-head .lc-actual { color: var(--dsw-alias-state-success-primary); }',
  '.lc-detail-tag { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
  '.lc-detail-rows { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }',
  '.lc-detail-row { display: flex; align-items: center; gap: 8px; }',
  '.lc-detail-label { min-width: 70px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }',
  '.lc-bar-track { flex: 1; height: 5px; border-radius: 3px; background: rgba(128,128,128,0.18); overflow: hidden; display: block; }',
  '.lc-bar-fill { display: block; height: 100%; border-radius: 3px; }',
  '.lc-detail-num { width: 44px; text-align: right; }',
  '.lc-detail-pct { width: 34px; text-align: right; color: var(--dsw-alias-label-secondary); }',
  '.lc-cols { display: flex; gap: 14px; flex-wrap: wrap; }',
  '.lc-col { flex: 1; min-width: 280px; }',
  '.lc-events, .lc-nodes { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }',
  '.lc-event { display: flex; align-items: center; gap: 8px; padding: 3px 0; }',
  '.lc-event-icon { width: 18px; text-align: center; color: var(--dsw-alias-state-warn-primary); }',
  '.lc-event-icon.lc-event-inject { color: #a855f7; }',
  '.lc-event-icon.lc-event-model { color: var(--dsw-alias-brand-primary); }',
  '.lc-event-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.lc-event-tokens { color: var(--dsw-alias-state-success-primary); }',
  '.lc-event-tokens.lc-up { color: var(--dsw-alias-state-warn-primary); }',
  '.lc-event-time { color: var(--dsw-alias-label-secondary); font-size: 12px; }',
  '.lc-node { display: flex; align-items: center; gap: 8px; padding: 3px 0; }',
  '.lc-node-preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }',
  '.lc-node-time { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 54px; text-align: right; }',
  '.lc-node-tokens { color: var(--dsw-alias-label-secondary); }',
  '.lc-nodes-more { color: var(--dsw-alias-label-secondary); padding: 3px 0; }',
  '.lc-empty { color: var(--dsw-alias-label-secondary); padding: 18px 0; text-align: center; }',
  '.lc-foot { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }',
].join('\n')

function apply(ctx: ClientCtx): void {
  // Bilingual dictionaries; the tab label thunk and all UI text follow the
  // active locale through the bound translate (missing keys fall back to
  // zh, then the key itself). The registration rides ctx.effect, so a stop
  // or HMR reload disposes it.
  ctx.effect(() => {
    return ctx.locale.register('dsh-context', { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-context: dictionaries')
  const t = ctx.locale.bind('dsh-context')

  // Theme-native styles, injected as a plugin-owned <style> tag (the web
  // boot loader claims and removes tags carrying data-plugin on unload).
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-context')
    tag.textContent = STYLES
    document.head.appendChild(tag)
    return () => {
      if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }
  }, 'dsh-context: styles')

  const ContextView = makeView(ctx, t)
  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      // order 20 renders right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: 'context', order: 20, label: () => t('tab') },
      props => h(ContextView, props),
    )
  })
}

module.exports = {
  name: 'dsh-context',
  inject: ['connection', 'slots', 'locale'],
  apply,
}

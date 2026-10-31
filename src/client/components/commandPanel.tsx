import { memo, Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import { attentionOf, byLatest, bySlowest, durationOf, matchesFilter, matchesQuery, previewTextOf, programsOf, resultTextOf, surfaceSeqOf, tallyOfCommands, viewsOf } from '../commands'
import type { Command, CommandFilter, CommandSort, CommandView } from '../commands'
import { grammarOfTool, highlightRuns } from '../commandHighlight'
import type { ContentFetcher } from '../services'
import { nameColorOf } from '../nameColor'
import type { CommandStats } from '../../shared/types'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { ClearableInput } from './clearableInput'
import { makeDetailNote } from './detailNote'
import { makeRichText } from './richText'
import { IconApi, IconShare } from '../primitives'
import { Section } from './section'
import { useRowWindow } from './useRowWindow'
import type { CommandFill } from './useCommandLog'

export interface CommandPanelProps {
  commands: Command[]
  stats?: CommandStats
  floor?: number
  fill?: CommandFill
  workspace?: string
  stampOf?: (seq: number) => { turn: number; step: number } | null
  onLocate?: (rec: Command) => void
  focusProgram?: string | null
  onFocusProgramHandled?: () => void
  fetchContent?: ContentFetcher
  state?: DetailState
  onRetry?: () => void
}

function CmdText(props: { text: string; runs: readonly HighlightSpan[][] | undefined }): ReactElement {
  const { runs } = props
  if (runs === undefined) return <>{props.text}</>
  return (
    <>
      {runs.map((line, index) => (
        <Fragment key={index}>
          {index === 0 ? null : '\n'}
          {line.map((run, at) => <span key={at} style={run.style}>{run.text}</span>)}
        </Fragment>
      ))}
    </>
  )
}

export function makeCommandPanel(kit: ViewKit): ComponentType<CommandPanelProps> {
  const { t, fmt, fmtTime, fmtDuration } = kit
  const DetailNote = makeDetailNote(kit)
  const rich = makeRichText(kit)

  const FILTERS: readonly CommandFilter[] = ['all', 'failed', 'slow', 'background']
  const SORTS: readonly CommandSort[] = ['latest', 'slowest']
  const WINDOW_MIN_ROWS = 100

  function statusGlyphOf(rec: Command): { glyph: string; cls: string; tip: string } {
    if (rec.status === 'running') return { glyph: '⏳', cls: 'run', tip: t('cmds.status.running') }
    if (rec.status === 'completed') return { glyph: '✓', cls: 'ok', tip: t('cmds.status.completed') }
    if (rec.status === 'failed') return { glyph: '✕', cls: 'fail', tip: t('cmds.status.failed') }
    return { glyph: '🛑', cls: 'kill', tip: t(rec.stopped === true ? 'cmds.status.stopped' : 'cmds.status.killed') }
  }

  function FindCard(props: {
    label: string
    text: string
    headNote?: string
    meta?: ReactNode
    leading?: ReactNode
    trailing?: ReactNode
    children: ReactNode
  }): ReactElement {
    const find = rich.useRichFind(props.text, 'raw')
    return (
      <Section
        label={props.label}
        foldHead
        headNote={props.headNote}
        meta={props.meta}
        actions={<>
          {props.leading}
          <rich.RichCopy text={props.text} />
          {find.button}
        </>}
      >
        {find.bar}
        <div key={find.bodyKey} ref={find.bodyRef}>{props.children}</div>
        {props.trailing}
      </Section>
    )
  }

  return memo(function CommandPanel(props: CommandPanelProps): ReactElement {
    kit.useLocaleTick()
    const highlightShell = useCodeHighlighter('bash')
    const highlightPwsh = useCodeHighlighter('powershell')
    const runsOf = (tool: string, text: string): readonly HighlightSpan[][] | undefined => {
      const grammar = grammarOfTool(tool)
      if (grammar === undefined) return undefined
      return highlightRuns(grammar === 'bash' ? highlightShell : highlightPwsh, grammar, text)
    }
    const { commands } = props
    const fillStatus = props.fill?.status ?? 'idle'
    const fillTotal = props.fill?.total
    const retryFill = props.fill?.retry
    const [filter, setFilter] = useState<CommandFilter>('all')
    const [sort, setSort] = useState<CommandSort>('latest')
    const [query, setQuery] = useState('')
    const [programPick, setProgramPick] = useState<string | null>(null)
    const [openSeq, setOpenSeq] = useState<number | null>(null)
    type ResultRead = { state: 'loading' } | { state: 'miss' } | { state: 'empty' } | { state: 'failed' } | { state: 'ready'; text: string }
    const [results, setResults] = useState<Partial<Record<number, ResultRead>>>({})
    const openRec = openSeq === null ? undefined : commands.find(rec => rec.seq === openSeq)
    const openTarget = openRec !== undefined ? surfaceSeqOf(openRec) : undefined
    useEffect(() => {
      const fetchContent = props.fetchContent
      if (openTarget === undefined || fetchContent === undefined) return
      let live = true
      setResults(cur => (cur[openTarget] !== undefined ? cur : { ...cur, [openTarget]: { state: 'loading' } }))
      void fetchContent(openTarget).then(
        (node) => {
          if (!live) return
          const text = node === null ? null : resultTextOf(node)
          setResults(cur => ({ ...cur, [openTarget]: node === null ? { state: 'miss' } : text === null ? { state: 'empty' } : { state: 'ready', text } }))
        },
        () => { if (live) setResults(cur => ({ ...cur, [openTarget]: { state: 'failed' } })) },
      )
      return () => { live = false }
    }, [openTarget, props.fetchContent])

    const q = query.trim().toLowerCase()
    const views = useMemo(() => viewsOf(commands, props.workspace), [commands, props.workspace])
    const searched = useMemo(() => views.filter(view => matchesQuery(view.rec, q, view.programs)), [views, q])
    const picked = useMemo(
      () => (programPick === null ? searched : searched.filter(view => view.programs.includes(programPick))),
      [searched, programPick],
    )
    const scoped = useMemo(() => picked.filter(view => matchesFilter(view.rec, filter)), [picked, filter])
    const shown = useMemo(
      () => scoped.slice().sort((a, b) => (sort === 'slowest' ? bySlowest(a.rec, b.rec) : byLatest(a.rec, b.rec))),
      [scoped, sort],
    )
    const tally = props.stats ?? tallyOfCommands(commands)
    const counts = useMemo(() => ({
      all: picked.length,
      failed: picked.filter(view => matchesFilter(view.rec, 'failed')).length,
      slow: picked.filter(view => matchesFilter(view.rec, 'slow')).length,
      background: picked.filter(view => matchesFilter(view.rec, 'background')).length,
    }), [picked])
    const programs = useMemo(() => programsOf(views), [views])
    const attention = useMemo(() => attentionOf(views), [views])
    useEffect(() => {
      if (programPick === null || programs.some(p => p.name === programPick)) return
      setProgramPick(null)
    }, [programPick, programs])

    const listRef = useRef<HTMLDivElement | null>(null)
    const [rowPitch, setRowPitch] = useState(0)
    const [rowGap, setRowGap] = useState(0)
    const measured = useRef(false)
    useEffect(() => {
      if (measured.current || openSeq !== null || shown.length < WINDOW_MIN_ROWS) return
      const el = listRef.current
      /* v8 ignore next 1 */
      if (el === null) return
      const items = [...el.querySelectorAll<HTMLElement>('.lc-cmd-item')]
      /* v8 ignore next 1 */
      if (items.length !== shown.length) return
      measured.current = true
      const rects = items.map(item => item.getBoundingClientRect())
      const height = Math.round(rects[0].height)
      const uniform = height > 4 && rects.every(r => Math.abs(Math.round(r.height) - height) <= 1)
      if (!uniform) return
      const pitch = rects[1].top - rects[0].top
      /* v8 ignore next 1 */
      if (Number.isFinite(pitch) && pitch > 4) {
        setRowPitch(Math.round(pitch))
        setRowGap(Math.max(0, Math.round(pitch - height)))
      }
    }, [openSeq, shown.length])
    const windowed = openSeq === null && rowPitch > 0 && shown.length >= WINDOW_MIN_ROWS
    const rowRange = useRowWindow(listRef, shown.length, rowPitch, windowed)
    const lastRow = Math.max(0, shown.length - 1)
    const windowFrom = Math.min(rowRange.from, lastRow)
    const windowTo = Math.min(rowRange.to, lastRow)
    const [progQuery, setProgQuery] = useState('')
    const railPreview = (cmd: string): string => {
      const first = previewTextOf(cmd, props.workspace)
      return first.length > 34 ? first.slice(0, 34) + '…' : first
    }
    type LensPatch = { filter?: CommandFilter; query?: string; sort?: CommandSort; program?: string | null }
    const lensActive = (patch: LensPatch): boolean =>
      (patch.filter ?? 'all') === filter &&
      (patch.query ?? '') === query &&
      (patch.sort ?? 'latest') === sort &&
      (patch.program ?? null) === programPick
    const applyLens = (patch: LensPatch): void => {
      setProgramPick(patch.program ?? null)
      setFilter(patch.filter ?? 'all')
      setQuery(patch.query ?? '')
      setSort(patch.sort ?? 'latest')
    }
    const changeQuery = (value: string): void => {
      setProgramPick(null)
      setQuery(value)
    }
    const pickProgram = (name: string | null): void => {
      setProgramPick(name)
      setQuery(name ?? '')
    }
    const focusProgram = props.focusProgram
    useEffect(() => {
      if (focusProgram === undefined || focusProgram === null) return
      applyLens({ query: focusProgram, program: focusProgram })
      props.onFocusProgramHandled?.()
    }, [focusProgram, props.onFocusProgramHandled])

    interface AttentionRow {
      key: string
      label: string
      value: string
      n: string
      title?: string
      active: boolean
      apply: () => void
    }
    const attentionRows: AttentionRow[] = []
    const pushAttention = (row: Omit<AttentionRow, 'active' | 'apply'>, lens: LensPatch): void => {
      const active = lensActive(lens)
      attentionRows.push({ ...row, active, apply: () => { applyLens(active ? {} : lens) } })
    }
    if (attention.slowest !== undefined) {
      const s = attention.slowest
      pushAttention({ key: 'slowest', label: t('cmds.rail.slowest'), value: railPreview(s.cmd), n: fmtDuration(s.ms), title: s.cmd }, { query: previewTextOf(s.cmd, props.workspace), sort: 'slowest' })
    }
    if (attention.failing !== undefined) {
      const f = attention.failing
      pushAttention({ key: 'failing', label: t('cmds.rail.failing'), value: f.program, n: '×' + fmt(f.count) }, { filter: 'failed', program: f.program, query: f.program })
    }
    if (attention.repeats !== undefined) {
      const r = attention.repeats
      pushAttention({ key: 'repeats', label: t('cmds.rail.repeats'), value: railPreview(r.cmd), n: '×' + fmt(r.count), title: r.cmd }, { query: r.cmd })
    }
    if (attention.background !== undefined) {
      const bg = attention.background
      pushAttention({ key: 'background', label: t('cmds.rail.bgRuns'), value: '', n: '×' + fmt(bg) }, { filter: 'background' })
    }
    const topProgramN = Math.max(1, ...programs.map(p => p.n))
    const pq = progQuery.trim().toLowerCase()
    const showProgSearch = programs.length > 6 || pq !== ''
    const shownPrograms = programs.filter(p => p.name === programPick || pq === '' || p.name.toLowerCase().includes(pq))

    const loadingChannel = commands.length === 0 && props.state === 'loading'
    const failedChannel = commands.length === 0 && props.state === 'failed'
    const fillNote = ((): ReactNode => {
      if (props.floor === undefined || commands.length === 0 || fillStatus === 'done') return null
      if (fillStatus === 'loading') {
        return (
          <div className="lc-cmd-floor">
            {fillTotal !== undefined
              ? t('cmds.coverageLoading', { n: fmt(commands.length), total: fmt(fillTotal) })
              : t('cmds.loadingEarlier')}
          </div>
        )
      }
      if (fillStatus === 'failed') {
        return (
          <div className="lc-cmd-floor">
            {t('cmds.coverageFailed', { n: fmt(commands.length) })}
            <button type="button" className="lc-cmd-floor-btn" onClick={retryFill}>{t('cmds.coverageRetry')}</button>
          </div>
        )
      }
      return <div className="lc-cmd-floor">{t('cmds.coverage', { n: fmt(commands.length) })}</div>
    })()
    const showRail = !loadingChannel && !failedChannel
    const totalTime = commands.length === 0 ? '0' : fmtDuration(tally.ms)
    const rail = showRail ? (
      <div className="lc-cmd-rail">
        <div className="lc-cmd-rail-sec">
          <div className="lc-cmd-rail-h" title={t('cmds.rail.summaryTip')}>{t('cmds.rail.summary')}</div>
          <div className="lc-cmd-kpis">
            <div className="lc-cmd-kpi"><b>{fmt(tally.runs)}</b><span>{t('cmds.rail.runs')}</span></div>
            <div className="lc-cmd-kpi lc-cmd-kpi-time"><b>{totalTime}</b><span>{t('cmds.rail.totalTime')}</span></div>
            <div className="lc-cmd-kpi lc-cmd-kpi-fail">
              <b>{fmt(tally.failed)}</b>
              <span>{t('cmds.rail.failed')}{tally.runs > 0 ? ' · ' + kit.fmtShare(tally.failed, tally.runs) : ''}</span>
            </div>
            <div className="lc-cmd-kpi lc-cmd-kpi-bg"><b>{fmt(tally.bg)}</b><span>{t('cmds.rail.background')}</span></div>
          </div>
        </div>
        {attentionRows.length > 0 ? (
          <div className="lc-cmd-rail-sec lc-cmd-attn">
            <div className="lc-cmd-rail-h" title={t('cmds.rail.attentionTip')}>{t('cmds.rail.attention')}</div>
            <div className="lc-cmd-attn-rows">
              {attentionRows.map(row => (
                <button
                  key={row.key}
                  type="button"
                  className={'lc-cmd-attn-row lc-cmd-attn-' + row.key + (row.active ? ' lc-cmd-attn-on' : '')}
                  title={row.title}
                  aria-pressed={row.active}
                  onClick={row.apply}
                >
                  <i className="lc-cmd-attn-dot" />
                  <span className="lc-cmd-attn-k">{row.label}</span>
                  <span className="lc-cmd-attn-v">{row.value}</span>
                  <span className="lc-cmd-attn-n">{row.n}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {programs.length > 0 ? (
          <div className="lc-cmd-rail-sec lc-cmd-progs">
            <div className="lc-cmd-rail-h lc-cmd-progs-h">
              <span title={t('cmds.rail.topScope')}>{t('cmds.rail.top', { n: programs.length })}</span>
              {showProgSearch ? (
                <ClearableInput
                  className="lc-cmd-prog-search"
                  type="search"
                  value={progQuery}
                  placeholder={t('cmds.rail.topSearch')}
                  clearLabel={t('field.clear')}
                  onChange={setProgQuery}
                />
              ) : null}
            </div>
            <div className="lc-cmd-progs-list" role="group" aria-label={t('cmds.rail.top', { n: programs.length })}>
              {shownPrograms.map((p) => {
                const color = nameColorOf(p.name)
                return (
                  <button
                    key={p.name}
                    type="button"
                    className={'lc-cmd-prog' + (programPick === p.name ? ' lc-cmd-prog-on' : '')}
                    title={t(programPick === p.name ? 'cmds.rail.topTipOn' : 'cmds.rail.topTip', { name: p.name })}
                    aria-pressed={programPick === p.name}
                    onClick={() => { pickProgram(programPick === p.name ? null : p.name) }}
                  >
                    <i className="lc-cmd-prog-dot" style={{ background: color }} />
                    <span className="lc-cmd-prog-name">{p.name}</span>
                    <span className="lc-cmd-prog-n">{'×' + fmt(p.n)}</span>
                    <span className="lc-cmd-prog-runs">
                      {t(p.runs === 1 ? 'cmds.rail.programRun' : 'cmds.rail.programRuns', { n: fmt(p.runs) })}
                    </span>
                    <i className="lc-cmd-prog-bar" style={{ width: `calc(${Math.round(p.n / topProgramN * 100)}% - ${Math.round(p.n / topProgramN * 12)}px)`, background: color }} />
                  </button>
                )
              })}
              {shownPrograms.length === 0 ? <div className="lc-cmd-prog-none">{t('cmds.noMatch')}</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    ) : null

    const detailOf = (view: CommandView): ReactElement => {
      const rec = view.rec
      const target = surfaceSeqOf(rec)
      const locatable = props.onLocate !== undefined && target !== undefined
      const stamp = target !== undefined ? props.stampOf?.(target) ?? null : null
      const facts: ReactElement[] = []
      if (rec.exit !== undefined && rec.tool !== 'run_code') {
        facts.push(
          <span key="exit" title={rec.exitInferred === true ? t('cmds.exitInferredTip') : undefined}>
            {t('cmds.exit', { n: rec.exit })}{rec.exitInferred === true ? ' ≈' : ''}
          </span>,
        )
      }
      const d = durationOf(rec)
      if (d !== undefined) {
        facts.push(
          <span key="dur" title={rec.derived === true ? t('cmds.derivedTip') : undefined}>
            {rec.derived === true ? '≈' : ''}{fmtDuration(d)}
          </span>,
        )
      }
      if (rec.cwd !== undefined) facts.push(<span key="cwd" className="lc-cmd-fact-cwd" title={rec.cwd}>{rec.cwd}</span>)
      if (rec.timeoutMs !== undefined) facts.push(<span key="to">{t('cmds.timeoutSet', { t: fmtDuration(rec.timeoutMs) })}</span>)
      if (rec.outChars !== undefined) {
        facts.push(
          <span key="out">
            {t('cmds.output', { n: fmt(rec.outChars) })}
            {rec.outTruncated === true ? <em>{t('cmds.outTruncated')}</em> : null}
          </span>,
        )
      }
      if (rec.stderr === true) facts.push(<span key="err">{t('cmds.hasStderr')}</span>)
      if (rec.timedOut === true) facts.push(<span key="tout">{t('cmds.timedOut')}</span>)
      if (rec.denied === true) facts.push(<span key="deny">{t('cmds.denied')}</span>)
      if (rec.signal !== undefined) facts.push(<span key="sig">{t('cmds.signalOf', { s: rec.signal })}</span>)
      if (rec.sandbox !== undefined) facts.push(<span key="sand">{t('cmds.sandboxAsk', { s: rec.sandbox })}</span>)
      const result = target !== undefined ? results[target] : undefined
      const factsEl = facts.length > 0 ? <div className="lc-cmd-detail-facts">{facts}</div> : null
      const stampSuffix = stamp !== null ? ' · ' + t('browser.stepAt', { t: stamp.turn, s: stamp.step }) : ''
      const resultCard = target !== undefined && props.fetchContent !== undefined ? (
        result !== undefined && result.state === 'ready' ? (
          <FindCard
            label={t('block.result')}
            text={result.text}
            meta={<span className="lc-ts-card-meta">{t('cmds.lines', { n: result.text.split(/\r\n|\r|\n/).length })}</span>}
            trailing={factsEl}
          >
            <pre className="lc-cmd-full">{result.text}</pre>
          </FindCard>
        ) : (
          <Section label={t('block.result')}>
            {result === undefined || result.state === 'loading' ? (
              <DetailNote state="loading" className="lc-cmd-result-note" />
            ) : result.state === 'miss' ? (
              <div className="lc-cmd-result-note">{t('browser.noContent')}</div>
            ) : result.state === 'empty' ? (
              <div className="lc-cmd-result-note">{t('cmds.result.empty')}</div>
            ) : (
              <div className="lc-cmd-result-note">{t('cmds.result.failed')}</div>
            )}
            {factsEl}
          </Section>
        )
      ) : null
      return (
        <div className="lc-cmd-detail">
          <FindCard
            label={t('cmds.kv.cmd')}
            text={rec.cmd ?? ''}
            headNote={rec.description}
            meta={<span className="lc-ts-card-meta">{t('cmds.lines', { n: view.shape.lines })}</span>}
            leading={locatable ? (
              <button
                type="button"
                className="lc-find-btn"
                title={t('cmds.revealTip') + stampSuffix}
                aria-label={t('cmds.act.reveal') + stampSuffix}
                onClick={() => { props.onLocate?.(rec) }}
              ><IconShare size={13} /></button>
            ) : undefined}
            trailing={resultCard === null ? factsEl : undefined}
          >
            <pre className="lc-cmd-full"><CmdText text={rec.cmd ?? ''} runs={runsOf(rec.tool, rec.cmd ?? '')} />{rec.cmdTruncated === true ? ' …' : ''}</pre>
          </FindCard>
          {resultCard}
        </div>
      )
    }

    const rowOf = (view: CommandView, index: number): ReactElement => {
      const rec = view.rec
      const open = openSeq === rec.seq
      const st = statusGlyphOf(rec)
      const d = durationOf(rec)
      const target = surfaceSeqOf(rec)
      const stamp = target !== undefined ? props.stampOf?.(target) ?? null : null
      const locatable = props.onLocate !== undefined && target !== undefined
      return (
        <div key={rec.seq} className={'lc-cmd-item' + (index % 2 === 1 ? ' lc-cmd-item-alt' : '') + (open ? ' lc-cmd-item-on' : '')}>
          <button
            type="button"
            className="lc-cmd-row hover:bg-(--dsw-alias-interactive-bg-hover)"
            title={rec.description ?? view.preview}
            onClick={() => { setOpenSeq(open ? null : rec.seq) }}
          >
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
            <span className={'lc-cmd-st lc-cmd-st-' + st.cls} title={st.tip}>{st.glyph}</span>
            <span className="lc-cmd-cmd">
              {rec.tool !== 'bash' ? <span className="lc-cmd-tool">{rec.tool === 'run_code' ? t('cmds.tool.code') : rec.tool}</span> : null}
              {rec.codeMode === true && rec.tool === 'bash' ? <span className="lc-cmd-tool">{t('cmds.tool.nested')}</span> : null}
              <CmdText text={view.preview} runs={runsOf(rec.tool, view.preview)} />
            </span>
            <span className="lc-cmd-badges">
              {view.shape.lines > 1 ? <span className="lc-cmd-badge">{t('cmds.lines', { n: view.shape.lines })}</span> : null}
              {view.shape.heredoc ? <span className="lc-cmd-badge">{t('cmds.heredoc')}</span> : null}
              {view.shape.inline ? <span className="lc-cmd-badge">{t('cmds.inline')}</span> : null}
              {rec.background === true ? <span className="lc-cmd-badge lc-cmd-badge-bg">{t('cmds.bgBadge')}</span> : null}
            </span>
            {d !== undefined
              ? (
                <span
                  className={'lc-cmd-dur' + (d >= 60_000 ? ' lc-cmd-dur-3' : d >= 10_000 ? ' lc-cmd-dur-2' : d >= 1000 ? ' lc-cmd-dur-1' : '')}
                  title={rec.derived === true ? t('cmds.derivedTip') : undefined}
                >
                  {rec.derived === true ? '≈' : ''}{fmtDuration(d)}
                </span>
              )
              : <span className="lc-cmd-dur lc-cmd-dur-run">{t('cmds.status.running')}</span>}
            {locatable
              ? (
                <span
                  className="lc-cmd-time lc-cmd-time-link"
                  role="link"
                  title={t('cmds.revealTip')}
                  onClick={(ev: MouseEvent) => {
                    ev.stopPropagation()
                    props.onLocate?.(rec)
                  }}
                >
                  {stamp !== null ? t('browser.stepAt', { t: stamp.turn, s: stamp.step }) + ' · ' : ''}{fmtTime(rec.time)}
                </span>
              )
              : <span className="lc-cmd-time">{stamp !== null ? t('browser.stepAt', { t: stamp.turn, s: stamp.step }) + ' · ' : ''}{fmtTime(rec.time)}</span>}
          </button>
          {open ? detailOf(view) : null}
        </div>
      )
    }

    return (
      <div className="lc-card lc-cmd-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconApi size={14} />
            {t('cmds.title')}
          </span>
          <div className="lc-gran lc-cmd-chips @max-[380px]/lc-card:flex-wrap">
            {FILTERS.map(f => (
              <button
                key={f}
                type="button"
                className={'lc-gran-btn lc-cmd-chip-' + f + (filter === f ? ' lc-gran-on' : '')}
                onClick={() => { setFilter(cur => (cur === f ? 'all' : f)) }}
              >
                {t('cmds.filter.' + f)}
                <b className="lc-fa-n">{fmt(counts[f])}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="lc-cmd-body">
          {rail}
          <div className="lc-cmd-main">
            <div className="lc-cmd-ctl">
              <ClearableInput
                className="lc-fa-search"
                value={query}
                placeholder={t('cmds.search')}
                clearLabel={t('field.clear')}
                onChange={changeQuery}
              />
              <span className="lc-gran lc-fa-sort" role="group" title={t('cmds.sortTip')}>
                {SORTS.map(k => (
                  <button
                    key={k}
                    type="button"
                    className={'lc-gran-btn' + (sort === k ? ' lc-gran-on' : '')}
                    onClick={() => { setSort(k) }}
                  >
                    {t('cmds.sort.' + k)}
                  </button>
                ))}
              </span>
            </div>
            {fillNote}
            {loadingChannel ? (
              <DetailNote state="loading" className="lc-empty lc-lane" />
            ) : failedChannel ? (
              <DetailNote state="failed" onRetry={props.onRetry} className="lc-empty lc-lane" />
            ) : shown.length === 0 ? (
              <div className="lc-empty lc-lane">{t(commands.length === 0 ? 'cmds.empty' : 'cmds.noMatch')}</div>
            ) : (
              <div className="lc-cmd-list" ref={listRef}>
                {windowed && windowFrom > 0
                  ? <div className="lc-row-pad" style={{ height: Math.max(0, windowFrom * rowPitch - rowGap) }} aria-hidden="true" />
                  : null}
                {windowed
                  ? shown.slice(windowFrom, windowTo + 1).map((view, i) => rowOf(view, windowFrom + i))
                  : shown.map(rowOf)}
                {windowed && windowTo < lastRow
                  ? <div className="lc-row-pad" style={{ height: Math.max(0, (lastRow - windowTo) * rowPitch - rowGap) }} aria-hidden="true" />
                  : null}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  })
}

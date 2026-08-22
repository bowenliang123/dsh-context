/**
 * Context-view trend-chart spec: fixed-width bars, horizontal scroll, turn
 * ranges, stats board, plugin info card, hover tooltips, legend chips,
 * granularity toggle, edge fades, full history, right-edge anchoring,
 * message times, event range labels, and the overview headline.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { bootViewBed, byClass, plainText, textOf } from './helpers/viewBed.mjs'

const bed = await bootViewBed()
const { hookStates, renderView, snapshot } = bed

test('context view: trend chart, stats board, plugin info, hover linking, granularity, fades, anchoring, events, overview headline', async () => {
  // The ContextView fiber: the boundary wrapper owns an EMPTY hook slot array,
  // so the data-driven body's fiber is the one carrying the view hooks.
  const ctxKey = [...hookStates.keys()].find(k => k.includes('ContextView') && hookStates.get(k).length > 0)
  assert.ok(ctxKey, 'ContextView fiber registered')
  bed.dataValue = snapshot
  const tree = renderView()

  const bars = byClass(tree, 'lc-bar')
  assert.equal(bars.length, 4, 'one bar per request')
  const turns = byClass(tree, 'lc-turn')
  assert.equal(turns.length, 3, 'three turn ranges (T1 has two bars, T2/T3 one each)')
  assert.deepEqual(turns.map(t => t.args[2]), ['T1', 'T2', 'T3'], 'turn labels in order')
  const turnWidths = turns.map(t => t.args[1].style.width)
  assert.equal(turnWidths[0], '30px', 'T1 tick spans two columns (2*16-2)')
  assert.equal(turnWidths[1], '14px', 'T2 tick spans one column')
  assert.ok(byClass(tree, 'lc-chart-scroll').length === 1, 'scroll container present')
  assert.ok(byClass(tree, 'lc-turns').length === 1, 'turn tick row present')

  // ---- context stats board: totals over the retained window ----
  // fixture: 4 requests (turns 1,1,2,3), no events yet -> all event counters 0.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const statVals = byClass(tree, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statVals.length, 8, 'eight stats cells (turns / steps / injections / compactions / prunes / images / cache hit / cost)')
  assert.equal(statVals[0], '3', 'turns counted by distinct turn')
  assert.equal(statVals[1], '4', 'steps = request count')
  assert.equal(statVals[2], '0', 'no injections yet')
  assert.equal(statVals[3], '0', 'no compactions yet')
  assert.equal(statVals[4], '0', 'no prunes yet')
  assert.equal(statVals[5], '0', 'no image blocks in the fixture log')
  assert.equal(statVals[6], '—', 'no tokenUsage projection yet -> cache-hit cell shows a dash')
  assert.equal(statVals[7], '—', 'no cost totals yet -> cost cell shows a dash')

  // ---- plugin info card: two full-width rows; every row is itself a link ----
  const piLabels = byClass(tree, 'lc-pi-label').map(n => n.args[2])
  const piValues = byClass(tree, 'lc-pi-value').map(n => n.args[2])
  const piGrid = byClass(tree, 'lc-pi-grid')
  assert.equal(piGrid.length, 1, 'plugin info rendered as one grid')
  assert.equal(piLabels.length, 2, 'plugin info: two rows (Plugin / GitHub)')
  assert.equal(plainText(piValues[0]), 'dsh-context (v' + pkg.version + ')', 'Plugin row combines package id + version (update chip only after the npm check resolves)')
  assert.equal(plainText(piValues[1]), 'bowenliang123/dsh-context', 'GitHub row shows the short owner/repo')

  // Each row IS the link — Plugin goes to the repo's releases page, GitHub to
  // the repo root.
  const linkRows = byClass(tree, 'lc-pi-row')
  assert.equal(linkRows.length, 2, 'every row is a whole-row link')
  assert.equal(linkRows[0].args[1].href, 'https://github.com/bowenliang123/dsh-context/releases', 'Plugin → GitHub releases page')
  assert.equal(linkRows[1].args[1].href, 'https://github.com/bowenliang123/dsh-context', 'GitHub → GitHub repo')
  // Hover affordance is CSS-driven (row-level `:hover` underlines the value);
  // no JS state needed, so no onMouseEnter/onMouseLeave handlers.

  // ---- hover linking: hovering a trend bar updates the detail below ----
  const ctxSlots = hookStates.get(ctxKey) // selected(0) hovered(1) hoverTurn(2) tick(3) gran(4) focusTurn(5) hoverCat(6)
  const detailStep = (tr) => {
    const head = byClass(tr, 'lc-detail-head')[0]
    return head === undefined ? '' : textOf(head).trim()
  }

  let tr = renderView()
  assert.match(detailStep(tr), /Turn 3/, 'detail defaults to the newest request (Turn 3)')
  assert.equal(byClass(tr, 'lc-bar-hovered').length, 0, 'no hovered bar initially')

  ctxSlots[1][1](3) // setHoveredSeq(seq 3, turn 2)
  tr = renderView()
  assert.match(detailStep(tr), /Turn 2/, 'hovering a bar links the detail below to it')
  const hovered = byClass(tr, 'lc-bar-hovered')
  assert.equal(hovered.length, 1, 'exactly one hovered bar')
  assert.equal(hovered[0].args[1]['data-seq'], 3, 'hovered bar is seq 3')
  const bar3 = byClass(tr, 'lc-bar').find(b => b.args[1]['data-seq'] === 3)
  assert.equal(typeof bar3.args[1].onMouseEnter, 'function', 'bars carry onMouseEnter')
  assert.equal(typeof bar3.args[1].onClick, 'function', 'bars carry onClick')
  // the instant custom tooltip replaces the delayed native title
  const chartTip = byClass(tr, 'lc-chart-tip')
  assert.equal(chartTip.length, 1, 'hovering shows the custom tooltip immediately')
  assert.match(textOf(chartTip[0]), /Turn 2 · Step 0/, 'tooltip names the hovered request')
  assert.match(textOf(chartTip[0]), /total ≈ 107/, 'tooltip carries the estimated total')
  assert.equal(typeof chartTip[0].args[1].style.left, 'string', 'tooltip is positioned at the bar column')
  // turn-aware dimming: the chart is in dim mode while a turn is focused
  assert.equal(byClass(tr, 'lc-chart-dim').length, 1, 'bar hover activates the turn-aware dim')

  ctxSlots[1][1](null) // leave the plot
  tr = renderView()
  assert.match(detailStep(tr), /Turn 3/, 'leaving the plot reverts the detail to the newest request')
  assert.equal(byClass(tr, 'lc-chart-tip').length, 0, 'tooltip clears with the hover')
  assert.equal(byClass(tr, 'lc-chart-dim').length, 0, 'dim clears with the hover')

  // ---- overview stacked bar: themed hover tooltip per segment ----
  const overviewStack = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
  assert.ok(overviewStack, 'overview stacked bar present')
  const segment = overviewStack.args.slice(2).flat().find(s => s !== null)
  assert.ok(segment, 'overview has segments')
  assert.equal(segment.args[1].title, undefined, 'native title replaced by the custom tooltip')
  assert.equal(typeof segment.args[1].onMouseEnter, 'function', 'segments carry onMouseEnter')
  segment.args[1].onMouseEnter({ clientX: 120 }) // fake pointer; ref is null in tests -> centered fallback
  tr = renderView()
  const tip = byClass(tr, 'lc-bar-tip-on')
  assert.equal(tip.length, 1, 'hovering a segment shows the tooltip')
  assert.match(textOf(tip[0]), /\(10%\)/, 'tooltip shows the segment share of the total')
  // The occupied-region reference frame appears on hover (there is a free
  // track here, so the legend % refers to the boxed part, not the bar width).
  assert.equal(byClass(tr, 'lc-occupied-box-on').length, 1, 'hovered segment frames the occupied region')
  const occBox = byClass(tr, 'lc-occupied-box-on')[0]
  assert.equal(typeof occBox.args[1].style.width, 'string', 'frame width follows the used share')
  assert.equal(typeof tip[0].args[1].style.left, 'string', 'tooltip is positioned along the pointer')

  // ---- composition bar hover highlights the matching legend chip (and back) ----
  // the tooltip test above left the first segment hovered -> its chip is on
  let chipsOn = byClass(tr, 'lc-chip-on')
  assert.equal(chipsOn.length, 1, 'hovered segment highlights its legend chip')
  const chip0 = byClass(tr, 'lc-chip')[0]
  assert.equal(typeof chip0.args[1].onMouseEnter, 'function', 'legend chips carry onMouseEnter')
  chip0.args[1].onMouseEnter()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 2, 'hovering a chip highlights its segment (overview + mirrored browser bar)')
  assert.equal(byClass(tr, 'lc-bar-tip-on').length, 1, 'hovering a chip also shows the tooltip above its segment')
  assert.match(textOf(byClass(tr, 'lc-bar-tip-on')[0]), /\(10%\)/, 'chip-driven tooltip carries the share')
  chip0.args[1].onMouseLeave()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'leaving the chip clears the segment highlight')
  assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'leaving the chip clears the chip highlight')
  assert.equal(byClass(tr, 'lc-bar-tip-on').length, 0, 'leaving the chip fades the tooltip out')
  // segment -> chip, on a different category
  const seg1 = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
    .args.slice(2).flat().filter(s => s !== null)[1]
  seg1.args[1].onMouseEnter({ clientX: 80 })
  tr = renderView()
  const chipsOn2 = byClass(tr, 'lc-chip-on')
  assert.equal(chipsOn2.length, 1, 'hovering another segment moves the chip highlight')
  // the label is now a styled span; compare its text (the highlighted chip's
  // category name must equal the matching chip's)
  assert.equal(textOf(chipsOn2[0].args[3]), textOf(byClass(tr, 'lc-chip')[1].args[3]), 'the matching chip is highlighted')
  assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 2, 'the hovered segment is marked (overview + mirrored browser bar)')

  // ---- the free window space (blank track) is hoverable too ----
  // fixture: window 128000 vs anchored occupancy 83017 -> 44983 free (35%)
  const freeSeg = byClass(tr, 'lc-stacked-free')[0]
  assert.ok(freeSeg, 'free window segment present when contextWindow > usage')
  assert.equal(typeof freeSeg.args[1].onMouseEnter, 'function', 'free segment carries onMouseEnter')
  freeSeg.args[1].onMouseEnter()
  tr = renderView()
  const freeTip = byClass(tr, 'lc-bar-tip-on')
  assert.equal(freeTip.length, 1, 'hovering the blank space shows the tooltip')
  assert.equal(byClass(tr, 'lc-occupied-box-on').length, 1, 'hovering the free track still frames the occupied region')
  assert.match(textOf(freeTip[0]), /Free window 45\.0k \(35%\)/, 'tooltip names the free window and its share')
  assert.equal(byClass(tr, 'lc-stacked-free-on').length, 1, 'free segment highlights on hover')
  assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'no legend chip matches the free space')
  const stackEl = byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
  stackEl.args[1].onMouseLeave()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar-tip-on').length, 0, 'leaving the stack fades the free tooltip out')
  assert.equal(byClass(tr, 'lc-occupied-box-on').length, 0, 'leaving the stack fades the occupied frame out')

  // ---- auto-compaction reserve band: the rightmost (1−0.8) of the window is
  // striped headroom; hovering it explains the area instead of the free track.
  // fixture: max 128000 (window) > 83017 used -> scale = window -> 80%/20%.
  const reserveEl = byClass(tr, 'lc-reserve')[0]
  assert.ok(reserveEl, 'auto-compaction reserve band rendered when the window is known')
  assert.equal(reserveEl.args[1].style.left, '80%', 'reserve starts at the 80% threshold')
  assert.equal(reserveEl.args[1].style.width, '20%', 'reserve covers the rightmost 20% of the window')
  assert.equal(typeof reserveEl.args[1].onMouseEnter, 'function', 'reserve band is hoverable')
  reserveEl.args[1].onMouseEnter()
  tr = renderView()
  const reserveTip = byClass(tr, 'lc-bar-tip-on')
  assert.equal(reserveTip.length, 1, 'hovering the reserve shows its explanation')
  assert.match(textOf(reserveTip[0]), /compact reserve 80%/, 'reserve tooltip names the compaction threshold')
  assert.equal(byClass(tr, 'lc-occupied-box-on').length, 0, 'reserve hover clears the segment reference frame')
  reserveEl.args[1].onMouseLeave()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar-tip-on').length, 0, 'leaving the reserve hides its tooltip')

  // ---- turn strip: one color block per turn, aligned with the bars above ----
  let turnBlocks = byClass(tr, 'lc-turn')
  assert.equal(turnBlocks.length, 3, 'one turn block per turn')
  assert.equal(typeof turnBlocks[0].args[1].onMouseEnter, 'function', 'turn blocks carry onMouseEnter')
  const blockColors = turnBlocks.map(b => b.args[1].style.background)
  assert.ok(blockColors.every(c => typeof c === 'string' && c.length > 0), 'turn blocks carry a color')
  assert.notEqual(blockColors[0], blockColors[1], 'consecutive turns get distinct colors')
  assert.equal(turnBlocks[0].args[1].title, 'T1', 'turn blocks carry a full-label tooltip')
  turnBlocks[0].args[1].onMouseEnter() // T1 (covers seq 1 and 2)
  tr = renderView()
  const inTurn = byClass(tr, 'lc-bar-in-turn')
  assert.equal(inTurn.length, 2, 'hovering T1 highlights its two bars')
  assert.deepEqual(inTurn.map(b => b.args[1]['data-seq']), [1, 2], 'highlighted bars are seq 1 and 2')
  const onBlocks = byClass(tr, 'lc-turn-on')
  assert.equal(onBlocks.length, 1, 'exactly one turn block highlighted')
  assert.equal(onBlocks[0].args[2], 'T1', 'highlighted block is T1')
  assert.equal(byClass(tr, 'lc-chart-dim').length, 1, 'strip hover also dims bars outside the turn')

  // leaving the strip clears the turn highlight
  const strip = byClass(tr, 'lc-turns')[0]
  assert.equal(typeof strip.args[1].onMouseLeave, 'function', 'strip carries onMouseLeave')
  strip.args[1].onMouseLeave()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar-in-turn').length, 0, 'leaving the strip clears bar highlights')
  assert.equal(byClass(tr, 'lc-chart-dim').length, 0, 'leaving the strip clears the dim')

  // hovering a bar highlights its turn block (bidirectional)
  ctxSlots[1][1](3) // hover seq 3 (turn 2)
  tr = renderView()
  const onBlocks2 = byClass(tr, 'lc-turn-on')
  assert.equal(onBlocks2.length, 1, 'bar hover highlights exactly one turn block')
  assert.equal(onBlocks2[0].args[2], 'T2', 'hovering a bar highlights its turn block')
  ctxSlots[1][1](null)

  // ---- granularity toggle: one bar per step vs one bar per turn ----
  // the trend card scopes its own toggle row: the events card kind toggles
  // reuse the pill-button classes, so address the row, not the buttons.
  const granRow = () => byClass(tr, 'lc-gran')[0].args.slice(2)
  const onBtns = (row) => row.filter(b => String(b.args[1].className || '').includes('lc-gran-on'))
  let granBtns = granRow()
  assert.equal(granBtns.length, 2, 'granularity toggle has two buttons')
  assert.equal(granBtns[0].args[2], 'Step', 'first button is step granularity')
  assert.equal(granBtns[1].args[2], 'Turn', 'second button is turn granularity')
  assert.equal(onBtns(granRow()).length, 1, 'step is active by default')
  assert.equal(byClass(tr, 'lc-bar').length, 4, 'step mode: one bar per step')

  // switch to turn granularity: the 4 steps collapse into 3 turn bars
  granBtns[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar').length, 3, 'turn mode: one bar per turn')
  assert.equal(byClass(tr, 'lc-turn').length, 3, 'turn strip still has one block per turn')
  const turnOn = onBtns(granRow())
  assert.equal(turnOn[0].args[2], 'Turn', 'turn button is active after switching')

  // turn bars keep the uniform column width and align with their strip blocks
  const turnBars = byClass(tr, 'lc-bar')
  const t1Bar = turnBars.find(b => b.args[1]['data-seq'] === 2)
  assert.ok(t1Bar, 'T1 is aggregated into its last step (seq 2)')
  for (const b of turnBars) assert.equal(b.args[1].style.width, '14px', 'every turn bar keeps the uniform column width')
  const turnBlocks2 = byClass(tr, 'lc-turn')
  for (const blk of turnBlocks2) assert.equal(blk.args[1].style.width, '14px', 'every turn block matches the bar width (aligned)')
  assert.equal(turnBlocks2[0].args[1].style.width, t1Bar.args[1].style.width, 'T1 bar and block align 1:1')

  // the turn detail is labeled with the step count and tagged as the last step
  t1Bar.args[1].onMouseEnter()
  tr = renderView()
  assert.match(detailStep(tr), /Turn 1 · 2 steps/, 'turn detail shows the step count, not a bare step number')
  assert.equal(byClass(tr, 'lc-detail-tag').length, 1, 'the last-step tag marks the shown breakdown')
  assert.equal(byClass(tr, 'lc-detail-tag')[0].args[2], 'last step', 'tag text localized')
  ctxSlots[1][1](null)

  // back to step granularity
  granBtns = granRow()
  granBtns[0].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar').length, 4, 'back to one bar per step')
  assert.equal(onBtns(granRow())[0].args[2], 'Step', 'step button active again')

  // ---- edge fades signal reachable history beyond the viewport ----
  let scroller = byClass(tr, 'lc-chart-scroll')[0]
  const fakeScroller = { scrollLeft: 200, clientWidth: 120, scrollWidth: 800 }
  scroller.args[1].onScroll({ currentTarget: fakeScroller })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade shown while scrolled into history')
  assert.equal(byClass(tr, 'lc-chart-fade-r').length, 1, 'right fade shown while more bars follow')
  fakeScroller.scrollLeft = 680
  scroller.args[1].onScroll({ currentTarget: fakeScroller })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-chart-fade-r').length, 0, 'right fade gone at the right end')
  assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade stays at the right end')
  fakeScroller.scrollLeft = 0
  scroller.args[1].onScroll({ currentTarget: fakeScroller })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-chart-fade-l').length, 0, 'left fade gone at the start')

  // ---- no 80-bar cap: every request the host sends is rendered ----
  const bigRequests = []
  for (let i = 0; i < 120; i++) {
    bigRequests.push({
      seq: 1000 + i, turn: 1 + Math.floor(i / 4), step: i % 4, time: 1000 * i,
      system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100,
    })
  }
  bed.dataValue = { ...snapshot, requests: bigRequests }
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar').length, 120, 'all requests render — earlier turns/steps stay reachable')
  assert.equal(byClass(tr, 'lc-turn').length, 30, 'turn strip follows the full history')
  bed.dataValue = snapshot
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar').length, 4, 'snapshot restored')

  // ---- default anchor: the newest bars sit at the right edge ----
  const scrollNode = byClass(tr, 'lc-chart-scroll')[0]
  const scrollEl = { scrollLeft: 0, clientWidth: 120, scrollWidth: 800 }
  scrollNode.args[1].ref.current = scrollEl // attach a fake layout element
  const trendKey = [...hookStates.keys()].find(k => k.includes('TrendChart'))
  assert.ok(trendKey, 'TrendChart fiber registered')
  const layoutEffectSlot = hookStates.get(trendKey).find(s => s && typeof s.effect === 'function')
  assert.ok(layoutEffectSlot, 'chart layout effect captured')
  layoutEffectSlot.effect()
  assert.equal(scrollEl.scrollLeft, 800, 'initial layout anchors at the right (newest bars)')
  scrollEl.scrollLeft = 200
  layoutEffectSlot.effect()
  assert.equal(scrollEl.scrollLeft, 200, 'scrolling away from the end is respected')
  scrollEl.scrollLeft = 780
  layoutEffectSlot.effect()
  assert.equal(scrollEl.scrollLeft, 800, 'stays anchored at the end while near it')
  tr = renderView()
  assert.equal(byClass(tr, 'lc-chart-fade-l').length, 1, 'left fade shown once anchored at the newest bars')
  assert.equal(byClass(tr, 'lc-chart-fade-r').length, 0, 'no right fade at the end')

  // ---- granularity switches re-anchor at the newest bars ----
  // (the turn->step report: returning to step must show the right edge)
  const latestEffect = () => hookStates.get(trendKey).find(s => s && typeof s.effect === 'function')
  scrollEl.scrollLeft = 0 // stale left edge from the narrow turn chart
  const granTurnBtn = granRow()[1]
  granTurnBtn.args[1].onClick() // step -> turn
  tr = renderView()
  latestEffect().effect()
  assert.equal(scrollEl.scrollLeft, 800, 'switching to turn re-anchors at the newest bars')
  scrollEl.scrollLeft = 0
  const granStepBtn = granRow()[0]
  granStepBtn.args[1].onClick() // turn -> step
  tr = renderView()
  latestEffect().effect()
  assert.equal(scrollEl.scrollLeft, 800, 'switching back to step re-anchors at the newest bars')
  // a plain re-render (poll) without a switch must NOT yank a scrolled-away view
  scrollEl.scrollLeft = 200
  latestEffect().effect()
  assert.equal(scrollEl.scrollLeft, 200, 'plain re-renders still respect the scroll position')

  // ---- message list: newest first, with timestamps when available ----
  const nodeRows = byClass(tr, 'lc-node')
  assert.equal(nodeRows.length, 2, 'message rows rendered')
  assert.equal(nodeRows[0].args[1].key, 2, 'newest message on top')
  assert.equal(nodeRows[1].args[1].key, 1, 'older message below')
  const nodeTimes = byClass(tr, 'lc-node-time')
  assert.equal(nodeTimes.length, 2, 'timestamps shown for every node')
  // fmtTime renders LOCAL time; mirror the same formatting for expectations.
  const fmtTimeLocal = (t) => {
    const d = new Date(t)
    const p = (x) => (x < 10 ? '0' : '') + x
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }
  assert.equal(nodeTimes[0].args[2], fmtTimeLocal(65000), 'formatted time (65000ms)')
  assert.equal(nodeTimes[1].args[2], fmtTimeLocal(1000), 'formatted time (1000ms)')

  // ---- context events show where they sit in the request timeline ----
  // The host sends events oldest->newest; the list reverses them. Boundary
  // events (compaction/prune) show the GAP between the request before and the
  // request after (same-turn "Step a→b", cross-turn "Turn a·s → Turn b·s");
  // inject/model switches keep the single point of the request they belong
  // to; events with no following request (in flight) stay bare. The same
  // attachment drives the ✂ marker and the detail header chip.
  bed.dataValue = {
    ...snapshot,
    events: [
      { seq: 3, kind: 'compaction', time: 1200, tokens: 900, count: 2, fromTurn: 1, fromStep: 0, turn: 2, step: 0 }, // attaches to request seq 3 (Turn 2 · Step 0)
      { seq: 6, kind: 'prune', time: 1500, tokens: 60, fromTurn: 1, fromStep: 0, turn: 1, step: 1 },
      { seq: 7, kind: 'prune', time: 2000, tokens: 100, fromTurn: 1, fromStep: 1, turn: 2, step: 0 },
      { seq: 8, kind: 'model', time: 3000, from: 'a', to: 'b', turn: 1, step: 1 },
      { seq: 9, kind: 'inject', time: 4000, tokens: 5, form: 'notice', turn: 2, step: 0 },
      { seq: 10, kind: 'compaction', time: 5000, tokens: 5000, count: 4, fromTurn: 2, fromStep: 0 }, // no request after -> unlabeled
    ],
  }
  tr = renderView()
  const evRows = byClass(tr, 'lc-event')
  assert.equal(evRows.length, 6, 'event rows rendered newest first')
  const kindChips = byClass(tr, 'lc-kind')
  assert.equal(kindChips.length, 6, 'every event row carries a kind chip (注入/压缩/剪枝/切换)')
  const atLabels = byClass(tr, 'lc-event-at')
  assert.equal(atLabels.length, 5, 'boundary + single-point events carry labels; in-flight stays bare')
  assert.equal(atLabels[0].args[2], 'Turn 2 · Step 0', 'inject keeps the single point of the request it fed')
  assert.equal(atLabels[1].args[2], 'Turn 1 · Step 1', 'model switch keeps the single point')
  assert.equal(atLabels[2].args[2], 'Turn 1 · Step 1 → Turn 2 · Step 0', 'cross-turn boundary shows the gap')
  assert.equal(atLabels[3].args[2], 'Turn 1 · Step 0→1', 'same-turn boundary compresses to a step range')
  assert.equal(atLabels[4].args[2], 'Turn 1 · Step 0 → Turn 2 · Step 0', 'oldest boundary event shows its gap')

  // the events card header carries the four kind buttons as a picker, all
  // picked by default: clicking an unpicked kind adds it (A -> A+B -> ...),
  // clicking a picked one removes it, clicking the last one resets to all
  let kindsRow = byClass(tr, 'lc-kinds')
  assert.equal(kindsRow.length, 1, 'events card shows the kind buttons inline')
  const kindBtns = () => byClass(tr, 'lc-kinds')[0].args.slice(2)
  assert.equal(kindBtns().length, 4, 'four kind buttons (注入/压缩/剪枝/切换)')
  assert.equal(onBtns(kindBtns()).length, 4, 'all four kinds are picked by default')
  assert.equal(byClass(tr, 'lc-event').length, 6, 'default shows every event')
  const click = (i) => { kindBtns()[i].args[1].onClick(); tr = renderView() }
  click(0) // pick-only 注入
  assert.equal(byClass(tr, 'lc-event').length, 1, 'clicking 注入 among all shows only injections')
  assert.ok(String(kindBtns()[0].args[1].className || '').includes('lc-gran-on'), 'picked button is highlighted')
  assert.ok(String(kindBtns()[0].args[1].className || '').includes('lc-kind-inject'), 'highlight carries the kind color')
  assert.equal(onBtns(kindBtns()).length, 1, 'the other three turned off')
  click(1) // add 压缩
  assert.equal(byClass(tr, 'lc-event').length, 3, 'adding 压缩 shows 注入 + 压缩')
  click(2) // add 剪枝
  assert.equal(byClass(tr, 'lc-event').length, 5, 'adding 剪枝 shows 注入 + 压缩 + 剪枝')
  click(0) // remove 注入
  assert.equal(byClass(tr, 'lc-event').length, 4, 'removing 注入 leaves 压缩 + 剪枝')
  click(3) // add 切换
  assert.equal(byClass(tr, 'lc-event').length, 5, 'adding 切换 shows 压缩 + 剪枝 + 切换')
  click(1); click(2) // remove 压缩 and 剪枝
  assert.equal(byClass(tr, 'lc-event').length, 1, 'only 切换 stays picked')
  click(3) // remove the last one -> reset to all
  assert.equal(byClass(tr, 'lc-event').length, 6, 'removing the last picked kind restores all')
  assert.equal(onBtns(kindBtns()).length, 4, 'all four kinds picked again')

  // the stats board picks up the event counters
  const statVals2 = byClass(tr, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statVals2[2], '1', 'one injection counted')
  assert.equal(statVals2[3], '2', 'two compactions counted')
  assert.equal(statVals2[4], '2', 'two prunes counted')
  assert.equal(statVals2[5], '0', 'image cell still zero')
  assert.equal(statVals2[6], '—', 'cache-hit cell still a dash before a tokenUsage projection lands')

  // the cache-hit cell reuses the OFFICIAL token-meter `tokenUsage` projection —
  // the exact same data the chat stats line below the input box reads, same
  // formula (cache reads over billed input = uncached + reads + writes).
  bed.usageValue = { uncachedInputTokens: 10, outputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 10 }
  tr = renderView()
  const statVals3 = byClass(tr, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statVals3.length, 8, 'eight stats cells with the cache-hit and cost cells')
  assert.equal(statVals3[6], '80.00%', 'cache hit = cacheRead / (uncached + cacheRead + cacheWrite), two decimals')
  assert.equal(statVals3[7], '—', 'cost cell stays a dash without cost totals')
  assert.equal(statVals3[0], '3', 'turn count unchanged by the usage projection')
  assert.equal(statVals3[3], '2', 'compaction count unchanged by the usage projection')
  // truncation proof: 8334 / 25000 = 33.336% -> cut to 33.33%, never rounded up
  bed.usageValue = { uncachedInputTokens: 10000, outputTokens: 40, cacheReadTokens: 8334, cacheWriteTokens: 6666 }
  tr = renderView()
  const statVals4 = byClass(tr, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statVals4[6], '33.33%', 'two decimals are TRUNCATED, not rounded (33.336 -> 33.33)')
  bed.usageValue = undefined

  // the cost cell prices the host-folded cumulative totals with the hardcoded
  // DeepSeek V4 list prices (test host has no getLocale -> USD): 1M off-peak
  // flash cache reads ($0.007) + 1M off-peak misses ($0.22) = $0.227 -> $0.23
  const prevData = bed.dataValue
  bed.dataValue = { ...prevData, cost: { flash: { off: { uncached: 1000000, cacheRead: 1000000, cacheWrite: 0, output: 0 } } } }
  tr = renderView()
  const statVals5 = byClass(tr, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statVals5[7], '$0.23', 'cost = (cacheRead x hit + uncached x miss) at the off-peak flash rate')
  const costCell = byClass(tr, 'lc-stat')[7]
  assert.equal(byClass(tr, 'lc-stat-q').length, 1, 'cost cell label shows the "?" affordance')
  // The explanation is a styled DOM bubble (the native `title` attribute is
  // invisible in the harness GUI): intro sentence + the price list built from
  // cost.ts (test dict falls back to keys; no locale -> USD rates).
  const costTipEls = byClass(tr, 'lc-stat-tip')
  assert.equal(costTipEls.length, 1, 'cost cell carries a styled explanation bubble')
  const tipText = plainText(costTipEls[0])
  assert.match(tipText, /stats\.costTip/, 'bubble explains the whole-session estimate')
  assert.match(tipText, /stats\.costPriceHead/, 'bubble sections the price list under its own head')
  assert.match(tipText, /\$0\.014|\$0\.44/, 'bubble lists the peak flash input rate ($0.014 hit / $0.44 miss per 1M)')
  assert.match(tipText, /\$0\.007|\$0\.22/, 'bubble lists the off-peak flash input rate (half price)')
  bed.dataValue = prevData
  tr = renderView()

  // the ✂ marker sits on the bar it attaches to and tooltips the event gap
  const barMark = byClass(tr, 'lc-bar-marker')
  assert.equal(barMark.length, 1, 'one ✂ marker on the attached bar')
  assert.match(barMark[0].args[1].title, /Turn 1 · Step 0 → Turn 2 · Step 0/, '✂ tooltip carries the event gap')

  // the detail header shows the same gap as a chip when that bar is active
  ctxSlots[1][1](3) // hover the attached bar (seq 3, Turn 2 · Step 0)
  tr = renderView()
  const markerChip = byClass(tr, 'lc-detail-marker')
  assert.equal(markerChip.length, 1, 'detail header shows the attached boundary event')
  assert.equal(markerChip[0].args[2], '✂ Turn 1 · Step 0 → Turn 2 · Step 0', 'chip shows the event gap')
  assert.equal(typeof markerChip[0].args[1].title, 'string', 'chip tooltips the event text')
  ctxSlots[1][1](null) // leave the plot
  tr = renderView()
  assert.equal(byClass(tr, 'lc-detail-marker').length, 0, 'chip clears with the hover')
  bed.dataValue = snapshot
  tr = renderView()
  assert.equal(byClass(tr, 'lc-event').length, 0, 'event list restored to the empty state')

  // ---- overview headline is the provider-based occupancy (like the chat
  // ring); the composition is anchored to it, proportions stay heuristic ----
  // fixture (no `contextPressure` projection -> derived fallback): last request
  // prompt 83000, last total 83, current total 100, window 128000
  // -> occupancy = 83000 + (100 - 83) = 83017 (65%), raw heuristic = 100.
  const overviewNum = byClass(tr, 'lc-overview-num')[0]
  assert.ok(overviewNum, 'overview number row present')
  assert.match(textOf(overviewNum), /83\.0k/, 'headline shows the provider-based occupancy')
  assert.match(textOf(overviewNum), /\/ 128\.0k tokens/, 'window shown next to the occupancy')
  assert.match(textOf(overviewNum), /65%/, 'occupancy percent is the emphasized figure of the line')
  assert.ok(!/~65%/.test(textOf(overviewNum)), 'no conflicting heuristic percentage next to the headline')

  // ---- the OFFICIAL token-meter `contextPressure` projection wins over the
  // derived fallback (the chat ring's own value, read as a second projection) ----
  bed.pressureValue = { pressureTokens: 90000, projectedTokens: 90010, contextWindow: 200000 }
  tr = renderView()
  const overviewNum2 = byClass(tr, 'lc-overview-num')[0]
  assert.match(textOf(overviewNum2), /90\.0k/, 'official contextPressure projection is the headline when present')
  assert.match(textOf(overviewNum2), /45%/, 'contextPressure window is the percent denominator')
  bed.pressureValue = undefined
  bed.dataValue = snapshot
  tr = renderView()

  // ---- the OFFICIAL token-meter `contextBreakdown` projection drives the
  // legend counts (the chat ring panel's rows): system/tools read it
  // verbatim, the message bucket subdivides by the fold ratios, and the four
  // surface categories always sum exactly to the delivered messageTokens ----
  // Fixture fold sums: user 30 / inject 5 / assistant 15 / tool 20 (70).
  bed.breakdownValue = { systemTokens: 111, toolsTokens: 222, messageTokens: 600 }
  tr = renderView()
  const chipsBd = byClass(tr, 'lc-chip')
  // Chip layout: [icon, label, nums] with nums = ['≈N', <em>share%</em>] —
  // read the ≈ text node directly (a flat textOf would glue the share on).
  const chipVal = (i) => chipsBd[i].args[4].args[2]
  assert.equal(chipVal(0), '≈111', 'system chip shows the official systemTokens')
  assert.equal(chipVal(1), '≈222', 'tools chip shows the official toolsTokens')
  // 600 subdivided by 30/5/15/20 of 70 -> 257/43/129/171 (residue to user).
  assert.equal(chipVal(2), '≈257', 'user chip subdivides the official messageTokens')
  assert.equal(chipVal(5), '≈171', 'tool chip subdivides the official messageTokens')
  const msgSum = [2, 3, 4, 5]
    .map(i => Number(chipVal(i).slice(1)))
    .reduce((a, b) => a + b, 0)
  assert.equal(msgSum, 600, 'surface categories sum exactly to the official message figure')
  bed.breakdownValue = undefined
  tr = renderView()

  console.log('✔ chart render test passed (context stats board, free window hover, fixed-width bars, scroll container, turn ranges, hover linking, overview tooltip, turn strip, granularity toggle, edge fades, full history, right-anchored default, message times, event range labels, detail marker chip, overview actual)')

  // ---- Context browser card: step picker + category accordion + element
})

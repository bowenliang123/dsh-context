/**
 * last-context — Client half.
 *
 * Registers a "上下文/Context" tab in the conversation view ring
 * (`conversation.view` slot, beside Chat/Trajectory) and renders the
 * context-composition timeline served by the Host half: current makeup,
 * per-request stacked-bar history, context events, and the live message list.
 *
 * UI text is bilingual (zh/en) through the client `locale` service; the Host
 * sends structured event/node records and this half localizes the labels.
 */

var h = React.createElement

var DICT_ZH = {
  'tab': '上下文',
  'cat.system': '系统提示', 'cat.tools': '工具定义', 'cat.user': '用户消息',
  'cat.inject': '注入上下文', 'cat.assistant': '助手回复', 'cat.tool': '工具结果',
  'overview.title': '当前构成',
  'overview.ofWindow': 'tokens（约 {p}%）',
  'overview.estimate': 'tokens（估算）',
  'tools.top': '工具定义 Top：',
  'tools.more': '等 {n} 个',
  'trend.title': '历史趋势',
  'trend.hint': '每次模型请求一段；点击柱子查看详情，✂ 表示压缩/剪枝',
  'trend.empty': '发起一轮对话后，这里会展示每次模型请求的上下文构成',
  'detail.step': 'T{t} · 第 {s} 步',
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

var DICT_EN = {
  'tab': 'Context',
  'cat.system': 'System', 'cat.tools': 'Tool schemas', 'cat.user': 'User',
  'cat.inject': 'Injected', 'cat.assistant': 'Assistant', 'cat.tool': 'Tool results',
  'overview.title': 'Current composition',
  'overview.ofWindow': 'tokens (~{p}%)',
  'overview.estimate': 'tokens (estimated)',
  'tools.top': 'Top tool schemas:',
  'tools.more': 'of {n}',
  'trend.title': 'History',
  'trend.hint': 'one bar per model request; click a bar for details, ✂ marks compaction/prune',
  'trend.empty': 'Send a message and each model request’s context makeup shows up here',
  'detail.step': 'T{t} · step {s}',
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

var EVENT_ICONS = { compaction: '✂', prune: '✂', inject: '＋', model: '⇄' }

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}

function fmtTime(t) {
  var d = new Date(t)
  function p(x) { return (x < 10 ? '0' : '') + x }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function makeView(ctx, t, localeSvc) {
  function tr(key, vars) {
    var s = t(key)
    if (vars) for (var k in vars) s = s.replace('{' + k + '}', String(vars[k]))
    return s
  }

  var CATS = [
    { key: 'system', color: '#6366f1' },
    { key: 'tools', color: '#f59e0b' },
    { key: 'user', color: '#22c55e' },
    { key: 'inject', color: '#a855f7' },
    { key: 'assistant', color: '#3b82f6' },
    { key: 'tool', color: '#14b8a6' },
  ]

  function catLabel(key) { return t('cat.' + key) }

  function eventLabel(ev) {
    if (ev.kind === 'compaction') return tr('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return tr('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'inject') {
      if (ev.sub === 'skill') return tr('ev.skill', { name: ev.name || '?' })
      var base = t('form.' + (ev.form || 'context'))
      return ev.name ? base + ' · ' + ev.name : base
    }
    return ev.kind
  }

  function nodeText(n) {
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

  function StackedBar(props) {
    // props.parts: [{key,color,value}]; optional props.max: when max exceeds
    // the parts' total, the remainder shows as empty track.
    var total = 0
    for (var i = 0; i < props.parts.length; i++) total += props.parts[i].value
    var scale = props.max !== undefined && props.max > total ? props.max : total
    return h('div', { className: 'lc-stacked', style: { height: (props.height || 14) + 'px' } },
      total <= 0
        ? null
        : props.parts.map(function (p) {
          if (!p.value) return null
          return h('div', {
            key: p.key,
            title: catLabel(p.key) + ' ' + fmt(p.value) + ' (' + Math.round(p.value / total * 100) + '%)',
            style: { width: (p.value / scale * 100) + '%', background: p.color },
          })
        }))
  }

  function Legend(props) {
    var total = 0
    for (var i = 0; i < props.parts.length; i++) total += props.parts[i].value
    return h('div', { className: 'lc-legend' },
      props.parts.map(function (p) {
        return h('span', { key: p.key, className: 'lc-chip' },
          h('i', { style: { background: p.color } }),
          catLabel(p.key) + ' ' + fmt(p.value),
          total > 0 ? h('em', null, Math.round(p.value / total * 100) + '%') : null)
      }))
  }

  function partsOf(breakdown) {
    return CATS.map(function (c) {
      return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
    })
  }

  // Plot height in px (the marker lane above it is 18px).
  var CHART_H = 112

  function TrendChart(props) {
    var requests = props.requests
    var maxTotal = 1
    for (var i = 0; i < requests.length; i++) if (requests[i].total > maxTotal) maxTotal = requests[i].total

    // Compaction/prune markers: attach each to the first request logged after it.
    var markers = {}
    for (var m = 0; m < props.events.length; m++) {
      var ev = props.events[m]
      if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
      for (var r = 0; r < requests.length; r++) {
        if (requests[r].seq >= ev.seq) {
          if (!markers[r]) markers[r] = ev
          break
        }
      }
    }

    return h('div', { className: 'lc-chartrow' },
      h('div', { className: 'lc-axis' },
        h('span', { className: 'lc-axis-top' }, fmt(maxTotal)),
        h('span', { className: 'lc-axis-mid' }, fmt(Math.round(maxTotal / 2))),
        h('span', { className: 'lc-axis-bot' }, '0')),
      h('div', { className: 'lc-chart' },
        h('div', { className: 'lc-grid lc-grid-top' }),
        h('div', { className: 'lc-grid lc-grid-mid' }),
        requests.map(function (req, i) {
          var selected = props.selectedSeq === req.seq
          var tip = tr('tip.step', { t: req.turn, s: req.step }) + ' · ' + fmtTime(req.time) + '\n'
            + tr('tip.total', { n: fmt(req.total) })
            + (req.prompt !== undefined ? tr('tip.actual', { n: fmt(req.prompt) }) : '') + '\n'
            + CATS.map(function (c) { return catLabel(c.key) + ' ' + fmt(req[c.key] || 0) }).join(' / ')
          return h('div', {
            key: req.seq,
            className: 'lc-bar' + (selected ? ' lc-bar-selected' : ''),
            title: tip,
            onClick: function () { props.onSelect(selected ? null : req.seq) },
          },
            markers[i] ? h('span', { className: 'lc-bar-marker', title: eventLabel(markers[i]) }, '✂') : null,
            h('div', { className: 'lc-bar-stack' },
              CATS.map(function (c) {
                var v = req[c.key] || 0
                if (!v) return null
                // px heights: the stack's height is content-driven, so
                // percentage heights would collapse against an indefinite base.
                return h('div', { key: c.key, style: { height: Math.max(1, Math.round(v / maxTotal * CHART_H)) + 'px', background: c.color } })
              })))
        })))
  }

  function RequestDetail(props) {
    var req = props.request
    if (!req) return null
    return h('div', { className: 'lc-detail' },
      h('div', { className: 'lc-detail-head' },
        h('b', null, tr('detail.step', { t: req.turn, s: req.step })),
        h('span', null, fmtTime(req.time)),
        h('span', null, tr('detail.estTotal', { n: fmt(req.total) })),
        req.prompt !== undefined ? h('span', { className: 'lc-actual' }, tr('detail.actual', { n: fmt(req.prompt) })) : null,
        req.output !== undefined ? h('span', null, tr('detail.output', { n: fmt(req.output) })) : null),
      h(StackedBar, { parts: partsOf(req), height: 10 }),
      h('div', { className: 'lc-detail-rows' },
        CATS.map(function (c) {
          var v = req[c.key] || 0
          return h('div', { key: c.key, className: 'lc-detail-row' },
            h('i', { style: { background: c.color } }),
            h('span', { className: 'lc-detail-label' }, catLabel(c.key)),
            h('span', { className: 'lc-bar-track' },
              h('span', { className: 'lc-bar-fill', style: { width: (req.total > 0 ? v / req.total * 100 : 0) + '%', background: c.color } })),
            h('span', { className: 'lc-detail-num' }, fmt(v)),
            h('span', { className: 'lc-detail-pct' }, req.total > 0 ? Math.round(v / req.total * 100) + '%' : ''))
        })))
  }

  function EventList(props) {
    if (props.events.length === 0) {
      return h('div', { className: 'lc-empty' }, t('events.empty'))
    }
    var sorted = props.events.slice().reverse()
    return h('div', { className: 'lc-events' },
      sorted.map(function (ev, i) {
        var label = eventLabel(ev)
        return h('div', { key: ev.seq + '-' + i, className: 'lc-event' },
          h('span', { className: 'lc-event-icon lc-event-' + ev.kind }, EVENT_ICONS[ev.kind] || '•'),
          h('span', { className: 'lc-event-label', title: label }, label),
          ev.tokens ? h('span', { className: 'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down') },
            (ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)) : null,
          h('span', { className: 'lc-event-time' }, fmtTime(ev.time)))
      }))
  }

  function NodeList(props) {
    if (props.nodes.length === 0) {
      return h('div', { className: 'lc-empty' }, t('nodes.empty'))
    }
    var catColor = {}
    CATS.forEach(function (c) { catColor[c.key] = c.color })
    var rows = props.nodes.slice().reverse()
    return h('div', { className: 'lc-nodes' },
      props.dropped > 0 ? h('div', { className: 'lc-nodes-more' }, tr('nodes.more', { n: props.dropped })) : null,
      rows.map(function (n) {
        var text = nodeText(n)
        return h('div', { key: n.seq, className: 'lc-node' },
          h('i', { style: { background: catColor[n.cat] || '#999' } }),
          h('span', { className: 'lc-node-preview', title: text }, text),
          h('span', { className: 'lc-node-tokens' }, fmt(n.tokens)))
      }))
  }

  function ContextView(props) {
    var sessionId = props.sessionId
    var state = React.useState(null)
    var data = state[0]
    var setData = state[1]
    var errState = React.useState(null)
    var error = errState[0]
    var setError = errState[1]
    var selState = React.useState(null)
    var selectedSeq = selState[0]
    var setSelectedSeq = selState[1]
    var tickState = React.useState(0)
    var setTick = tickState[1]

    React.useEffect(function () {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      var alive = true
      var load = function () {
        host.call('snapshot', { sessionId: sessionId }).then(function (res) {
          if (!alive) return
          if (res && res.ok) { setData(res); setError(null) }
          else setError(res && res.error ? String(res.error) : 'failed')
        }, function (err) {
          if (alive) setError(String(err && err.message ? err.message : err))
        })
      }
      load()
      var dispose = ctx.interval(load, 2000)
      return function () { alive = false; dispose() }
    }, [sessionId])

    // Re-render on locale switch.
    React.useEffect(function () {
      if (!localeSvc) return undefined
      return localeSvc.subscribe(function () { setTick(function (x) { return x + 1 }) })
    }, [])

    if (error) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('error') + error))
    }
    if (!data) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('loading')))
    }

    var current = data.current
    var requests = data.requests || []
    var events = data.events || []
    var nodes = data.nodes || []

    var selReq = null
    for (var i = 0; i < requests.length; i++) if (requests[i].seq === selectedSeq) selReq = requests[i]
    if (!selReq && requests.length > 0) selReq = requests[requests.length - 1]

    var windowPct = data.contextWindow ? Math.min(100, Math.round(current.total / data.contextWindow * 100)) : null

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
            ? ' / ' + fmt(data.contextWindow) + ' ' + tr('overview.ofWindow', { p: windowPct })
            : ' ' + t('overview.estimate'))),
        h(StackedBar, { parts: partsOf(current), height: 16, max: data.contextWindow }),
        h(Legend, { parts: partsOf(current) }),
        (data.toolList && data.toolList.length > 0) ? h('div', { className: 'lc-tools' },
          t('tools.top'),
          data.toolList.slice().sort(function (a, b) { return b.tokens - a.tokens }).slice(0, 5).map(function (tool) {
            return h('span', { key: tool.name, className: 'lc-tool-chip' }, tool.name + ' ' + fmt(tool.tokens))
          }),
          data.toolList.length > 5 ? h('span', { className: 'lc-card-sub' }, ' ' + tr('tools.more', { n: data.toolList.length })) : null) : null),

      // ---- trend ----
      h('div', { className: 'lc-card' },
        h('div', { className: 'lc-card-title' },
          t('trend.title'),
          h('span', { className: 'lc-card-sub' }, t('trend.hint'))),
        requests.length === 0
          ? h('div', { className: 'lc-empty' }, t('trend.empty'))
          : h('div', null,
            h(TrendChart, { requests: requests.slice(-80), events: events, selectedSeq: selReq ? selReq.seq : null, onSelect: setSelectedSeq }),
            h(RequestDetail, { request: selReq }))),

      // ---- events + messages ----
      h('div', { className: 'lc-cols' },
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' }, t('events.title')),
          h(EventList, { events: events })),
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' },
            t('nodes.title'),
            h('span', { className: 'lc-card-sub' }, t('nodes.hint'))),
          h(NodeList, { nodes: nodes, dropped: data.droppedNodes || 0 }))),

      h('div', { className: 'lc-foot' }, t('footer')))
  }

  return ContextView
}

return {
  inject: ['timer'],
  apply(ctx) {
    var slots = ctx.get('slots')
    if (slots === undefined) return

    // Bilingual dictionaries; the tab label thunk and all UI text follow the
    // active locale (missing keys fall back to zh, then the key itself).
    // Registrations ride ctx.effect so a stop/update disposes them; the catch
    // tolerates dictionaries leaked by an earlier run of this same plugin
    // (re-registering a live (ns, locale) pair throws).
    var localeSvc = ctx.get('locale')
    var t
    if (localeSvc !== undefined) {
      try {
        ctx.effect(function () {
          var d1 = localeSvc.register('last-context', 'zh', DICT_ZH)
          var d2 = localeSvc.register('last-context', 'en', DICT_EN)
          return function () { d1(); d2() }
        }, 'locale-dicts')
      } catch (e) { /* dictionaries from an earlier run are still live; reuse them */ }
      t = localeSvc.bind('last-context')
    } else {
      t = function (key) { return DICT_ZH[key] !== undefined ? DICT_ZH[key] : key }
    }

    styles.insert([
      '.lc-root { padding: 16px 20px 32px; overflow-y: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.lc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }',
      '.lc-card-title { font-weight: 600; margin-bottom: 10px; display: flex; align-items: baseline; gap: 8px; }',
      '.lc-card-sub { font-weight: 400; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
      '.lc-overview-num { margin-bottom: 8px; }',
      '.lc-overview-num b { font-size: 20px; }',
      '.lc-overview-num span { color: var(--dsw-alias-label-secondary); }',
      '.lc-stacked { display: flex; width: 100%; border-radius: 5px; overflow: hidden; background: rgba(128,128,128,0.18); }',
      '.lc-stacked > div { height: 100%; }',
      '.lc-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; }',
      '.lc-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-primary); }',
      '.lc-chip i, .lc-detail-row i, .lc-node i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }',
      '.lc-chip em { font-style: normal; color: var(--dsw-alias-label-secondary); }',
      '.lc-tools { margin-top: 10px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
      '.lc-tool-chip { background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 1px 7px; font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.lc-chartrow { display: flex; gap: 6px; align-items: stretch; }',
      '.lc-axis { position: relative; width: 40px; height: 130px; padding-top: 18px; box-sizing: border-box; color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.lc-axis span { position: absolute; right: 0; line-height: 1; }',
      '.lc-axis-top { top: 13px; }',
      '.lc-axis-mid { top: 69px; }',
      '.lc-axis-bot { top: 125px; }',
      '.lc-chart { position: relative; flex: 1; display: flex; align-items: flex-end; gap: 2px; height: 130px; padding-top: 18px; box-sizing: border-box; }',
      '.lc-grid { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-border-l1); pointer-events: none; }',
      '.lc-grid-top { top: 18px; }',
      '.lc-grid-mid { top: 74px; }',
      '.lc-bar { position: relative; flex: 1; min-width: 5px; height: 100%; display: flex; align-items: flex-end; cursor: pointer; border-radius: 2px; }',
      '.lc-bar:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.lc-bar-selected { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
      '.lc-bar-stack { display: flex; flex-direction: column-reverse; width: 100%; }',
      '.lc-bar-stack > div { width: 100%; }',
      '.lc-bar-marker { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--dsw-alias-state-warn-primary); }',
      '.lc-detail { margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; }',
      '.lc-detail-head { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary); }',
      '.lc-detail-head b { color: var(--dsw-alias-label-primary); }',
      '.lc-detail-head .lc-actual { color: var(--dsw-alias-state-success-primary); }',
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
      '.lc-node-tokens { color: var(--dsw-alias-label-secondary); }',
      '.lc-nodes-more { color: var(--dsw-alias-label-secondary); padding: 3px 0; }',
      '.lc-empty { color: var(--dsw-alias-label-secondary); padding: 18px 0; text-align: center; }',
      '.lc-foot { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }',
    ].join('\n'))

    var ContextView = makeView(ctx, t, localeSvc)
    slots.inject('conversation.view', function () {
      return slots.register(
        // NOTE: for dynamic packages the client Guard overrides `priority`
        // with its own page-local rank (negative), so dynamic tabs always sort
        // BEFORE the shipped priority-0 tabs — the tab currently renders
        // leftmost by sandbox design. The priority/order pair below takes
        // effect (right of Trajectory) once the plugin is installed as a real
        // package in a preset composition instead of dynamically.
        { name: 'conversation.view', id: 'context', order: 20, priority: 10, label: function () { return t('tab') } },
        function (props) { return h(ContextView, props) },
      )
    })
  },
}

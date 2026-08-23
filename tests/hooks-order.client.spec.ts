/**
 * Rules-of-Hooks regression (issue #12): a component whose hook count grows
 * between renders crashes with React #310 (rendered more hooks than during
 * the previous render), caught by the tab's ErrorBoundary as a fake "数据
 * 读取失败". Two real transitions used to trip it:
 *
 *   1. ContextViewBody: the projection value arrives AFTER a loading first
 *      render (if (!data) returned before the displayRequests/markers
 *      useMemos — 16 hooks, then 18).
 *   2. EventList: events go from empty to non-empty in one mounted instance
 *      (the empty branch returned before useRef/useLayoutEffect — 0 hooks,
 *      then 2).
 *
 * Both mounts run the BUILT client bundle on real react/react-dom in jsdom,
 * like the harness's slot renderer does.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  let handoff = null
  globalThis.window.__ModuleLoader__ = { load(h) { handoff = h } }
  const require = (spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconPlusOutline16: (p) => React.createElement('svg', p, null),
        IconBranchOutline16: (p) => React.createElement('svg', p, null),
      }
    }
    throw new Error(`unexpected module: ${spec}`)
  }
  new Function(bundle)()
  const plugin = handoff.factory(require)

  const localeRegs = []
  let viewComponent = null
  const ctx = {
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (ns, dicts) => { localeRegs.push(dicts); return () => {} },
      bind: () => (key, vars) => {
        const dict = localeRegs[0].zh
        let s = dict[key] !== undefined ? dict[key] : key
        if (vars) for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]))
        return s
      },
    },
    slots: {
      inject: (name, fn) => { fn() },
      register: (opts, component) => { if (opts.name === 'conversation.view') viewComponent = component; return opts },
    },
  }
  plugin.apply(ctx)
  assert.ok(viewComponent !== null)

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const boundaryErrors = []
  // Hook-list corruption does not always throw: some React builds recover
  // from the EventList empty->non-empty transition after logging an internal
  // error ("Expected static flag was missing") instead of raising #310.
  // Capture console.error so BOTH failure shapes fail the test.
  const reactErrors = []
  const origError = console.error
  console.error = (...args) => {
    const s = args.map(String).join(' ')
    if (/hook|static flag|React error/i.test(s)) reactErrors.push(s)
    origError(...args)
  }
  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null } }
    componentDidCatch(err) { boundaryErrors.push(err); this.setState({ err }) }
    render() { return this.state.err ? React.createElement('pre', null, 'CRASHED') : this.props.children }
  }
  const render = (proj) => {
    root.render(React.createElement(Boundary, null, React.createElement(viewComponent, {
      sessionId: 's1', useProjection: (key) => (key === 'contextTimeline' ? proj : undefined),
    })))
  }
  const restore = () => { console.error = origError }
  return { container, root, boundaryErrors, reactErrors, render, restore }
}

const baseSnapshot = {
  ok: true, model: 'deepseek-v4-flash', provider: 'opencode-go', contextWindow: 1000000,
  current: { system: 4400, tools: 8200, user: 1100, inject: 1700, assistant: 2600, tool: 2600, total: 20600 },
  toolList: [],
  requests: [
    { seq: 1, turn: 1, step: 1, time: 1700000000000, system: 4400, tools: 8200, user: 1100, inject: 1700, assistant: 2600, tool: 2600, total: 20600, prompt: 20000 },
    { seq: 2, turn: 1, step: 2, time: 1700000001000, system: 4400, tools: 8200, user: 1100, inject: 1700, assistant: 2600, tool: 2600, total: 20600, prompt: 20000 },
  ],
  events: [], nodes: [], droppedNodes: 0,
}

const injectEvent = { seq: 3, time: 1700000002000, kind: 'inject', form: 'instructions', sub: 'skill', name: 'code-review', tokens: 100, turn: 1, step: 2 }

test('issue #12: projection arriving after a loading first render never hits React #310', async () => {
  const { container, root, boundaryErrors, reactErrors, render, restore } = boot()
  try {
    render(undefined) // loading frame: the projection has not pushed yet
    await new Promise(r => setTimeout(r, 30))
    assert.ok(container.textContent.includes('正在读取会话日志'), 'loading frame rendered')
    render(baseSnapshot) // data lands on the SAME mounted instance
    await new Promise(r => setTimeout(r, 30))
    assert.equal(boundaryErrors.length, 0, 'no render crash: ' + (boundaryErrors[0] && boundaryErrors[0].message))
    assert.deepEqual(reactErrors, [], 'no hook-order console errors')
    assert.ok(!container.textContent.includes('上下文数据读取失败'), 'plugin ErrorBoundary stayed quiet')
    assert.ok(container.textContent.includes('历史趋势'), 'loaded view rendered')
  } finally {
    restore()
    try { root.unmount() } catch { /* ignore */ }
  }
})

test('issue #12: events appearing after an empty first render never hits React #310', async () => {
  const { container, root, boundaryErrors, reactErrors, render, restore } = boot()
  try {
    render(baseSnapshot) // events: [] — the empty EventList branch
    await new Promise(r => setTimeout(r, 30))
    assert.ok(container.textContent.includes('暂无上下文事件'), 'empty events frame rendered')
    render({ ...baseSnapshot, events: [injectEvent] }) // an event lands in the SAME instance
    await new Promise(r => setTimeout(r, 30))
    assert.equal(boundaryErrors.length, 0, 'no render crash: ' + (boundaryErrors[0] && boundaryErrors[0].message))
    assert.deepEqual(reactErrors, [], 'no hook-order console errors')
    assert.ok(!container.textContent.includes('上下文数据读取失败'), 'plugin ErrorBoundary stayed quiet')
    assert.ok(container.textContent.includes('Skill 注入'), 'the arrived event rendered')
  } finally {
    restore()
    try { root.unmount() } catch { /* ignore */ }
  }
})

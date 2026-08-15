#!/usr/bin/env node
/**
 * Real-React reproduction harness: mounts the built client bundle with the
 * ACTUAL react/react-dom (module table) inside jsdom, drives the RPC with a
 * large synthetic snapshot, and toggles the granularity buttons — the exact
 * step -> turn -> step flow reported to black-screen the tab.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- jsdom browser environment ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
// jsdom lacks scrollWidth/clientWidth semantics; emulate just enough layout
// for the scroll container: content width follows the bar count (so a
// granularity switch genuinely flips the overflow state — a static stub
// never changes the edge fades and cannot regress-test the React #185
// setState cascade this script exists for).
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get() {
    if (this.classList && this.classList.contains('lc-chart-scroll')) {
      const chart = this.querySelector('.lc-chart')
      return Math.max(this.clientWidth, chart ? chart.children.length * 16 : 0)
    }
    return this.__scrollW ?? 0
  },
})
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.__clientW ?? 400 } })
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollLeft', {
  configurable: true,
  get() { return this.__scrollL ?? 0 },
  set(v) {
    this.__scrollL = Math.max(0, Math.min(v, Math.max(0, this.scrollWidth - this.clientWidth)))
    // Real browsers dispatch an async scroll event for programmatic scrolls;
    // jsdom does not. The event lands mid-cascade and its dispatch is what
    // disabled the same-value eager bailout in the no-deps layout effect
    // (React #185 on a granularity switch) — emulate it or the bug stays
    // invisible here.
    const el = this
    queueMicrotask(() => { if (el.isConnected) el.dispatchEvent(new dom.window.Event('scroll')) })
  },
})

// ---- module table: real React ----
let handoff = null
globalThis.window.__ModuleLoader__ = {
  load(h) { handoff = h },
}
const require = (spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    // Glyph-only usage in this bundle; render inert svgs (never asserted).
    return {
      IconPlusOutline16: (p) => React.createElement('svg', p, null),
      IconBranchOutline16: (p) => React.createElement('svg', p, null),
    }
  }
  throw new Error(`unexpected module: ${spec}`)
}
const start = bundle.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
const end = bundle.indexOf('    return module.exports;')
const factory = new Function('require', 'module', 'window', 'document',
  bundle.slice(start, end) + '\n    return module.exports;')
const m = { exports: {} }
const plugin = factory(require, m, globalThis.window, dom.window.document)

// ---- snapshot: many steps across turns (mirrors a long tool-heavy session) ----
const requests = []
for (let i = 0; i < 460; i++) {
  requests.push({
    seq: i + 1, turn: 1 + Math.floor(i / 12), step: i % 12, time: 1700000000000 + i * 1000,
    system: 4400, tools: 8200, user: 1100, inject: 1700, assistant: 2600, tool: 2600,
    total: 4400 + 8200 + 1100 + 1700 + 2600 + 2600, prompt: 594000,
  })
}
const snapshot = {
  ok: true, model: 'deepseek-v4-flash', provider: 'opencode-go', contextWindow: 1000000,
  current: { system: 4400, tools: 8200, user: 1100, inject: 1700, assistant: 2600, tool: 2600, total: 20600 },
  toolList: [], requests, events: [], nodes: [], droppedNodes: 0,
}

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
    register: (opts, component) => { viewComponent = component; return opts },
  },
}
plugin.apply(ctx)
assert.ok(viewComponent !== null)
// The framework standard kit delivers the timeline as a push-fed projection;
// hand it straight to the stub so the chart renders on the first commit.
const viewProps = { sessionId: 's1', useProjection: (key) => (key === 'contextTimeline' ? snapshot : undefined) }

// ---- mount with real React (behind a boundary so #185-style crashes are
// catchable; without one an update-depth error unmounts the whole root) ----
const container = dom.window.document.createElement('div')
dom.window.document.body.appendChild(container)
const root = createRoot(container)
let caught = null
const boundaryErrors = []
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  componentDidCatch(err) { boundaryErrors.push(err); this.setState({ err }) }
  render() { return this.state.err ? React.createElement('pre', null, 'CRASHED') : this.props.children }
}
try {
  root.render(React.createElement(Boundary, null, React.createElement(viewComponent, viewProps)))
  // the projection value is present on the first commit — no poll to wait on
  await new Promise(r => setTimeout(r, 60))
  assert.ok(container.textContent.includes('tokens'), 'chart rendered')
  // Wide viewport: the step chart overflows (460 bars) but the turn chart
  // fits (≈41 columns), so toggling flips the edge-fade state for real.
  const scroller = container.querySelector('.lc-chart-scroll')
  scroller.__clientW = 800
  const buttons = [...container.querySelectorAll('.lc-gran-btn')]
  assert.equal(buttons.length, 2, 'toggle buttons rendered')
  // Rapid toggles: the overflow state flips each time (wide step chart vs
  // narrow turn chart), which used to cascade setEdges dispatches inside the
  // no-deps layout effect until React #185 (maximum update depth) fired.
  for (let i = 0; i < 8; i++) {
    const btns = [...container.querySelectorAll('.lc-gran-btn')]
    assert.equal(btns.length, 2, `toggle buttons still mounted after ${i} switches`)
    btns[i % 2].click()
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(boundaryErrors.length, 0, 'no render crash: ' + (boundaryErrors[0] && boundaryErrors[0].message))
  // back to step mode: all step bars render again
  const finalBtns = [...container.querySelectorAll('.lc-gran-btn')]
  finalBtns[0].click()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(boundaryErrors.length, 0, 'no render crash: ' + (boundaryErrors[0] && boundaryErrors[0].message))
  assert.ok(container.querySelectorAll('.lc-bar').length > 100, 'step mode re-rendered many bars')
  console.log('✔ real-React repro passed: 8 rapid step<->turn toggles render without throwing')
} catch (err) {
  caught = err
  console.error('✘ REAL-REACT REPRO FAILED:', err && err.message ? err.message : err)
  console.error(err && err.stack)
  process.exitCode = 1
} finally {
  try { root.unmount() } catch { /* ignore */ }
}

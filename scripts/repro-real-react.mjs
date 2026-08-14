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
// jsdom lacks scrollWidth/clientWidth semantics; stub layout-ish reads.
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.__scrollW ?? 0 } })
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.__clientW ?? 400 } })
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollLeft', { configurable: true, get() { return this.__scrollL ?? 0 }, set(v) { this.__scrollL = v } })

// ---- module table: real React ----
let handoff = null
globalThis.window.__ModuleLoader__ = {
  load(h) { handoff = h },
}
const require = (spec) => {
  if (spec === 'react') return React
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
  connection: { rpc: { call: async () => ({ ok: true, value: snapshot }) } },
  slots: {
    inject: (name, fn) => { fn() },
    register: (opts, component) => { viewComponent = component; return opts },
  },
}
plugin.apply(ctx)
assert.ok(viewComponent !== null)

// ---- mount with real React ----
const container = dom.window.document.createElement('div')
dom.window.document.body.appendChild(container)
const root = createRoot(container)
let caught = null
try {
  root.render(React.createElement(viewComponent, { sessionId: 's1' }))
  // let the RPC resolve and the poll-free render settle
  await new Promise(r => setTimeout(r, 60))
  assert.ok(container.textContent.includes('tokens'), 'chart rendered')
  const buttons = [...container.querySelectorAll('.lc-gran-btn')]
  assert.equal(buttons.length, 2, 'toggle buttons rendered')
  // step -> turn
  buttons[1].click()
  await new Promise(r => setTimeout(r, 30))
  assert.ok(container.textContent.includes('T'), 'turn mode rendered')
  // turn -> step (the reported black screen)
  const back = [...container.querySelectorAll('.lc-gran-btn')][0]
  back.click()
  await new Promise(r => setTimeout(r, 30))
  assert.ok(container.querySelectorAll('.lc-bar').length > 100, 'step mode re-rendered many bars')
  console.log('✔ real-React repro passed: step->turn->step renders without throwing')
} catch (err) {
  caught = err
  console.error('✘ REAL-REACT REPRO FAILED:', err && err.message ? err.message : err)
  console.error(err && err.stack)
  process.exitCode = 1
} finally {
  try { root.unmount() } catch { /* ignore */ }
}

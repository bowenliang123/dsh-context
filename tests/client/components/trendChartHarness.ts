/**
 * jsdom reports zero layout metrics, so beforeAll overrides them (scrollWidth follows the bar count, clientWidth is
 * test-controlled, the scrollLeft setter dispatches a real scroll event in a microtask) — the overflow/scroll-anchor
 * logic runs FOR REAL — and afterAll restores the originals.
 */

import assert from 'node:assert/strict'
import { act } from 'react'
import { afterAll, beforeAll } from 'vitest'
import { makeTrendChart, type TrendChartProps } from '../../../src/client/components/trendChart'
import type { RequestRecord } from '../../../src/shared/types'
import { flush, makeKit, queryAll } from '../helpers/kit'

const kit = makeKit()
const TrendChart = makeTrendChart(kit)

const CHART_H = 112
const BAR_CELL = 16 // BAR_W 14 + BAR_GAP 2

/** Module-level default client width; tests may retarget it (with try/finally) before mounting. */
const viewport = { clientW: 400 }

type LayoutEl = HTMLElement & { __clientW?: number; __scrollL?: number; __scrollW?: number }

let saved: [string, PropertyDescriptor | undefined][] = []

beforeAll(() => {
  saved = (['scrollWidth', 'clientWidth', 'scrollLeft'] as const)
    .map((name): [string, PropertyDescriptor | undefined] => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: LayoutEl): number {
      if (this.classList && this.classList.contains('lc-chart-scroll')) {
        const total = Number(this.querySelector('.lc-chart')?.getAttribute('data-lc-bars') ?? '')
        const columns = Number.isFinite(total) && total > 0 ? total : this.querySelectorAll('.lc-bar').length
        return Math.max(this.clientWidth, columns * BAR_CELL)
      }
      return this.__scrollW ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: LayoutEl): number { return this.__clientW ?? viewport.clientW },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: LayoutEl): number { return this.__scrollL ?? 0 },
    set(this: LayoutEl, v: number) {
      this.__scrollL = Math.max(0, Math.min(v, Math.max(0, this.scrollWidth - this.clientWidth)))
      const el = this
      queueMicrotask(() => { if (el.isConnected) el.dispatchEvent(new Event('scroll')) })
    },
  })
})

afterAll(() => {
  for (const [name, desc] of saved) {
    if (desc === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, desc)
  }
})

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: 1700000000000 + seq * 60000, seq, turn: 1, step: seq - 1,
    system: 100, tools: 50, user: 30, inject: 20, assistant: 40, tool: 60, total: 300,
    ...over,
  }
}

interface Spies {
  select: (number | null)[]
  hover: (number | null)[]
  hoverTurn: (number | null)[]
  pickTurn: number[]
  focusHandled: number
}

function makeSpies(): { spies: Spies; handlers: Pick<TrendChartProps, 'onSelect' | 'onHover' | 'onHoverTurn' | 'onPickTurn' | 'onFocusTurnHandled'> } {
  const spies: Spies = { select: [], hover: [], hoverTurn: [], pickTurn: [], focusHandled: 0 }
  return {
    spies,
    handlers: {
      onSelect: (s) => { spies.select.push(s) },
      onHover: (s) => { spies.hover.push(s) },
      onHoverTurn: (t) => { spies.hoverTurn.push(t) },
      onPickTurn: (t) => { spies.pickTurn.push(t) },
      onFocusTurnHandled: () => { spies.focusHandled++ },
    },
  }
}

function propsOf(requests: RequestRecord[], over: Partial<TrendChartProps> = {}): TrendChartProps {
  const { handlers } = makeSpies()
  return {
    requests,
    markers: requests.map(() => undefined),
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    focusTurn: null,
    hoverCat: null,
    ...handlers,
    ...over,
  }
}

function bars(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-bar')
}

/** jsdom/cssstyle may keep hex or normalize to rgb(); accept the exact color either way. */
function assertColor(actual: string, hex: string): void {
  const n = parseInt(hex.slice(1), 16)
  const rgb = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  assert.ok(actual === hex || actual === rgb, `expected ${actual} to be ${hex}`)
}

async function scrollTo(el: LayoutEl, v: number): Promise<void> {
  await act(async () => { el.scrollLeft = v })
  await flush()
}

async function scrollEvent(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new Event('scroll')) })
  await flush()
}

export {
  BAR_CELL, CHART_H, TrendChart, assertColor, bars, kit, makeSpies, propsOf, req, scrollEvent, scrollTo, viewport,
}
export type { LayoutEl }

import { act } from 'react'
import { afterEach, vi } from 'vitest'
import { makeContextBrowser, type ContextBrowserProps } from '../../../src/client/components/browser'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import { createContextSettings } from '../../../src/client/settings'
import type { ContextHeaders, ContextTimeline, HeaderEpochContent, RequestRecord } from '../../../src/shared/types'
import { makeKit, query, queryAll, type Mounted } from '../helpers/kit'

export const kit = makeKit()
export const settings = createContextSettings()
export const Browser = makeContextBrowser(kit, makeStackedBar(kit), settings)

// Tests that arm the fetch-on-miss retry with a deliberately failing fetcher
// silence the production `console.warn` the failure legitimately emits.
afterEach(() => {
  vi.restoreAllMocks()
})

export function silenceFetchWarn(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

// Category row index follows the CATS order.
export const ROW = { system: 0, tools: 1, user: 2, inject: 3, skill: 4, assistant: 5, tool: 6 } as const

export function tl(over: Partial<ContextTimeline>): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    ...over,
  }
}

export function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    time: 1_000, seq: 1, turn: 1, step: 0,
    system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...over,
  }
}

export function catRow(m: Mounted, cat: keyof typeof ROW): HTMLElement {
  return queryAll(m.container, '.lc-br-cat-row')[ROW[cat]]
}

/** The browser's browsable content rows; the DNA list's folded group header is a control, not one of them. */
export function elemRows(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-br-elem-row:not(.lc-br-fold)')
}

/** Type into the tool-schema search box like a real user (native setter + input event). */
export async function typeToolSearch(m: Mounted, value: string): Promise<void> {
  await act(async () => {
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export async function pickStep(m: Mounted, value: string): Promise<void> {
  const sel = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
  await act(async () => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export function props(over: Partial<ContextBrowserProps>): ContextBrowserProps {
  return { data: tl({}), headers: null, ...over }
}

/** Pair metadata-only `contextHeaders` with a fetchHeader serving per-epoch
 * CONTENT — the lazy-load contract the browser consumes: the projection
 * carries boundaries and token prices, the content arrives on demand. */
export function withEpochContent(
  headers: ContextHeaders,
  contents: Record<number, HeaderEpochContent>,
): { headers: ContextHeaders; fetchHeader: (seq: number) => Promise<HeaderEpochContent | null> } {
  return { headers, fetchHeader: seq => Promise.resolve(contents[seq] ?? null) }
}

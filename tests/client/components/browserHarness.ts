import { act } from 'react'
import { afterEach, vi } from 'vitest'
import { makeContextBrowser, type ContextBrowserProps } from '../../../src/client/components/browser'
import { makeStackedBar } from '../../../src/client/components/stackedBar'
import { createContextSettings } from '../../../src/client/settings'
import type { ContextHeaders, ContextTimeline, HeaderEpochContent, RequestRecord } from '../../../src/shared/types'
import { makeKit, click, query, queryAll, text, typeText, type Mounted } from '../helpers/kit'

export const kit = makeKit()
export const settings = createContextSettings()
export const Browser = makeContextBrowser(kit, makeStackedBar(kit), settings)

afterEach(() => {
  vi.restoreAllMocks()
})

export function silenceFetchWarn(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

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

export function elemRows(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-br-elem-row')
}

export function filterStat(m: Mounted): string {
  return text(query(m.container, '.lc-br-filter-stat'))
}

export async function typeToolSearch(m: Mounted, value: string): Promise<void> {
  await act(async () => {
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function pickValue(m: Pick<Mounted, 'container'>): string {
  return query<HTMLElement>(m.container, '.lc-br-pick').dataset.value ?? ''
}

export async function pickLabels(m: Pick<Mounted, 'container'>): Promise<string[]> {
  const trigger = query<HTMLButtonElement>(m.container, '.lc-br-pick')
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true'
  if (!wasOpen) await click(trigger)
  const labels = queryAll(m.container, '.lc-br-pick-opt').map(option => text(option))
  if (!wasOpen) await click(trigger)
  return labels
}

export async function pickFind(m: Pick<Mounted, 'container'>, queryText: string): Promise<string[]> {
  const trigger = query<HTMLButtonElement>(m.container, '.lc-br-pick')
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger)
  await typeText(query<HTMLInputElement>(m.container, '.lc-br-pick-search'), queryText)
  const labels = queryAll(m.container, '.lc-br-pick-opt').map(option => text(option))
  await click(trigger)
  return labels
}

export async function pickStep(m: Pick<Mounted, 'container'>, value: string): Promise<void> {
  const trigger = query<HTMLButtonElement>(m.container, '.lc-br-pick')
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger)
  await click(query(m.container, `.lc-br-pick-opt[data-value="${value}"]`))
}

export function props(over: Partial<ContextBrowserProps>): ContextBrowserProps {
  return { data: tl({}), headers: null, ...over }
}

export function withEpochContent(
  headers: ContextHeaders,
  contents: Record<number, HeaderEpochContent>,
): { headers: ContextHeaders; fetchHeader: (seq: number) => Promise<HeaderEpochContent | null> } {
  return { headers, fetchHeader: seq => Promise.resolve(contents[seq] ?? null) }
}

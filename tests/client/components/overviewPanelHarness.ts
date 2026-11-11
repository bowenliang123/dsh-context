import { act, createElement as h } from 'react'
import { vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import type { DefaultOverviewRange } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, settle, type Mounted } from '../helpers/kit'
import { panelSessionsSnapshot as sessionsSnapshot, useHookOf } from '../overview.fixtures'

export function makeCtx(sessions: Record<string, unknown> = {}): TestClientCtx {
  return new TestClientCtx({ services: { sessions } })
}

export function settingsWith(range?: DefaultOverviewRange): ContextSettings {
  const settings = createContextSettings()
  if (range !== undefined) {
    settings.attach({
      getSnapshot: () => ({ status: 'ready', value: { defaultOverviewRange: range }, writable: true }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
    })
  }
  return settings
}

export function propsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { useSessions: useHookOf(sessionsSnapshot()), ...over }
}

export async function openPanel(
  ctx: TestClientCtx,
  props: Record<string, unknown> = {},
  settings: ContextSettings = settingsWith(),
): Promise<{ m: Mounted; Panel: ReturnType<typeof makeOverviewPanel> }> {
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), settings)
  const m = await mount(h(Panel, propsOf(props)))
  await flush()
  await settle(5)
  return { m, Panel }
}

export async function openPanelFake(
  ctx: TestClientCtx,
  props: Record<string, unknown> = {},
  settings: ContextSettings = settingsWith(),
): Promise<{ m: Mounted; Panel: ReturnType<typeof makeOverviewPanel> }> {
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), settings)
  const m = await mount(h(Panel, propsOf(props)))
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  return { m, Panel }
}

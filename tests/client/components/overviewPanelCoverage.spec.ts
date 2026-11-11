import assert from 'node:assert/strict'
import { act } from 'react'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { resetInvalidations } from '../../../src/client/invalidation'
import { text } from '../helpers/kit'
import { panelSummaryRaw as summaryRaw, pinCurrentSession, stubPanelRoutes as stubRoutes } from '../overview.fixtures'
import { makeCtx, openPanelFake } from './overviewPanelHarness'

beforeEach(() => {
  pinCurrentSession('a')
})

afterEach(async () => {
  resetInvalidations()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  await new Promise(resolve => setTimeout(resolve, 1))
})

describe('OverviewPanel coverage state', () => {
  test('an incomplete coverage shows the folding progress and posts the warm-up backfill route', async () => {
    vi.useFakeTimers()
    const incomplete = { complete: false, running: false, remaining: 2, failed: 0, total: 3, covered: 1, unsupported: 0 }
    const calls = stubRoutes({
      summary: () => ({ revision: 's0', pricingReady: true, summary: summaryRaw({ coverage: incomplete }) }),
    })
    const { m } = await openPanelFake(makeCtx())
    assert.equal(calls.filter(c => c.route.endsWith('/overview')).length, 6, 'summary, days, page, and three tallies fetched once')
    assert.ok(text(m.container).includes('Folding projections 1/3'), 'the partial projection set is annotated')
    assert.equal(calls.filter(c => c.route.endsWith('/backfill')).length, 0)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(calls.filter(c => c.route.endsWith('/backfill')).length, 1, 'the incomplete coverage posted the backfill route')
    await m.unmount()
  })

  test('a running or failed coverage never posts the warm-up backfill route', async () => {
    vi.useFakeTimers()
    const running = { complete: false, running: true, remaining: 2, failed: 0, total: 3, covered: 1, unsupported: 0 }
    const runningCalls = stubRoutes({
      summary: () => ({ revision: 's0', pricingReady: true, summary: summaryRaw({ coverage: running }) }),
    })
    const first = await openPanelFake(makeCtx())
    assert.ok(text(first.m.container).includes('Folding projections 1/3'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(runningCalls.filter(c => c.route.endsWith('/backfill')).length, 0, 'a running pass is left alone')
    await first.m.unmount()

    const failed = { complete: false, running: false, remaining: 0, failed: 1, total: 3, covered: 2, unsupported: 0 }
    const failedCalls = stubRoutes({
      summary: () => ({ revision: 's1', pricingReady: true, summary: summaryRaw({ coverage: failed }) }),
    })
    const second = await openPanelFake(makeCtx())
    assert.ok(text(second.m.container).includes('1 sessions failed to fold'), 'a failed pass is marked, not silent')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(failedCalls.filter(c => c.route.endsWith('/backfill')).length, 0, 'a failed pass is not retried forever')
    await second.m.unmount()

    const startingCalls = stubRoutes({
      summary: () => ({
        revision: 's2',
        pricingReady: true,
        summary: summaryRaw({ coverage: { complete: false, running: false, remaining: 0, failed: 0, total: 0, covered: 0, unsupported: 0 } }),
      }),
    })
    const third = await openPanelFake(makeCtx())
    assert.ok(text(third.m.container).includes('Folding projections…'), 'an unlisted pass reads as starting')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(startingCalls.filter(c => c.route.endsWith('/backfill')).length, 1, 'the unlisted pass requests its first pass')
    await third.m.unmount()
  })
})

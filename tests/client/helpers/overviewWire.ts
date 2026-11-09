import type { BackfillCoverage } from '../../../src/shared/types'

export const BASE_COVERAGE: BackfillCoverage = {
  complete: true,
  running: false,
  remaining: 0,
  failed: 0,
  total: 2,
  covered: 2,
  unsupported: 0,
}

export function coverageOf(over: Partial<BackfillCoverage> = {}): BackfillCoverage {
  return { ...BASE_COVERAGE, ...over }
}

export function summaryRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 2,
    sessionsTotal: 3,
    sessionsArchived: 1,
    archivedScoped: 1,
    tokens: 1800,
    turns: 5,
    costUsd: 0.5,
    costSessions: 1,
    usageSessions: 1,
    cacheHit: '33.33',
    tokenParts: [{ key: 'system', value: 100 }, { key: 'tools', value: 20 }],
    timing: { wallMs: 1000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
    coverage: coverageOf(),
    ...over,
  }
}

export function summaryValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, summary: summaryRaw(), ...over }
}

export function daysValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, days: [{ key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 }], ...over }
}

export function pageValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: false,
    page: {
      items: [{
        id: 's1',
        title: 'one',
        cwd: '/repo',
        updatedAt: 5,
        running: true,
        archived: false,
        group: 'w',
        tokens: 10,
        turns: 2,
        steps: 3,
        parts: [{ key: 'system', value: 7 }],
        total: 7,
        contextWindow: 100,
        maxOutputTokens: 50,
        model: 'm',
        lastUser: 'hi',
        costUsd: 0.25,
        createdDay: '2026-09-10',
      }],
      index: 0,
      count: 1,
      total: 1,
      scopeTotal: 4,
      groups: [{ key: 'w', count: 1 }],
    },
    ...over,
  }
}

export function tallyValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: true,
    tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
    ...over,
  }
}

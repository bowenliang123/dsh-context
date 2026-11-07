import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  DetailStore,
  detailBytesOf,
  detailStoreOf,
  factsOf,
  makeFactsFetchers,
  resetTimelineDetailStores,
} from '../../src/client/timelineSource'
import type { FactPart, FactsRead } from '../../src/client/timelineSource'
import type { ContextTimelineDetail } from '../../src/shared/types'
import { until } from './helpers/kit'

afterEach(() => { vi.unstubAllGlobals() })

const T0 = 1_700_000_000_000

function head(rev: number): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
    counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 },
    detailRev: rev,
  }
}

function series(rev: number): Record<string, unknown>[] {
  return [{ seq: rev, time: T0, total: 15, turn: 1, step: 0 }]
}

function core(rev: number): FactsRead {
  return { rev, live: true, asOfSeq: rev, parts: { head: head(rev) as never, series: series(rev) as never } }
}

function factsResponse(rev: number, parts: Record<string, unknown>, missing?: string[]): unknown {
  return { ok: true, value: { rev, live: true, parts, ...(missing === undefined ? {} : { missing }) } }
}

describe('factsOf decoding', () => {
  test('rejects unusable payloads', () => {
    assert.equal(factsOf(null), null)
    assert.equal(factsOf(42), null)
    assert.equal(factsOf({}), null)
    assert.equal(factsOf({ rev: '1', parts: {} }), null)
    assert.equal(factsOf({ rev: 1 }), null)
  })

  test('decodes core, nodes, files, commands and spans parts', () => {
    const read = factsOf({
      rev: 3,
      live: true,
      asOfSeq: 7,
      parts: {
        head: head(3),
        series: series(3),
        nodes: {
          nodes: [{ seq: 3, cat: 'user', tokens: 2 }],
          archive: [{ seq: 1, cat: 'tool', tokens: 1, gone: 3 }],
          droppedNodes: 1,
          surfaceFloor: 2,
          archiveFloor: 1,
        },
        events: [{ seq: 3, time: T0, kind: 'inject', form: 'context' }],
        files: { fileOps: [{ seq: 3, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }], fileOpsFloor: 2 },
        commands: {
          commands: [{ seq: 3, time: T0, tool: 'bash', cmd: 'ls', start: T0, status: 'completed', err: false }],
          commandsFloor: 1,
          commandStats: { runs: 1, failed: 0, ms: 5, bg: 0 },
        },
        spans: [{ kind: 'text', start: 1, end: 2 }],
      },
      missing: ['spans', 'nope'],
    })
    assert.ok(read !== null)
    assert.equal(read.rev, 3)
    assert.equal(read.live, true)
    assert.equal(read.asOfSeq, 7)
    assert.equal(read.parts.head?.detailRev, 3)
    assert.equal(read.parts.series?.length, 1)
    assert.equal(read.parts.nodes?.nodes.length, 1)
    assert.equal(read.parts.nodes?.archive.length, 1)
    assert.equal(read.parts.nodes?.surfaceFloor, 2)
    assert.equal(read.parts.events?.length, 1)
    assert.equal(read.parts.files?.fileOps.length, 1)
    assert.equal(read.parts.files?.fileOpsFloor, 2)
    assert.equal(read.parts.commands?.commands.length, 1)
    assert.equal(read.parts.commands?.commandsFloor, 1)
    assert.equal(read.parts.commands?.commandStats?.runs, 1)
    assert.equal(read.parts.spans?.length, 1)
    assert.deepEqual(read.missing, ['spans', 'nope'])
  })

  test('fills defaults for optional window and stats fields', () => {
    const read = factsOf({
      rev: 2,
      parts: {
        requests: series(2),
        nodes: { nodes: [], archive: [] },
        files: { fileOps: [] },
        commands: { commands: [], commandStats: { runs: 1 } },
      },
      missing: [42, 'nodes'],
    })
    assert.ok(read !== null)
    assert.equal(read.parts.requests?.length, 1)
    assert.equal(read.parts.nodes?.droppedNodes, 0)
    assert.equal(read.parts.nodes?.surfaceFloor, undefined)
    assert.equal(read.parts.files?.fileOpsFloor, undefined)
    assert.equal(read.parts.commands?.commandsFloor, undefined)
    assert.deepEqual(read.parts.commands?.commandStats, { runs: 1, failed: 0, ms: 0, bg: 0 })
    const partial = factsOf({ rev: 1, parts: { commands: { commands: [], commandStats: { failed: 2 } } } })
    assert.deepEqual(partial?.parts.commands?.commandStats, { runs: 0, failed: 2, ms: 0, bg: 0 })
    assert.deepEqual(read.missing, ['nodes'])
    const bare = factsOf({ rev: 1, parts: { series: [] } })
    assert.ok(bare !== null)
    assert.equal(bare.parts.head, undefined)
  })

  test('a command part without stats or floors decodes to bare rows', () => {
    const read = factsOf({
      rev: 1,
      parts: { commands: { commands: [{ seq: 1, time: T0, tool: 'bash', cmd: 'ls', start: T0, status: 'completed', err: false }] } },
    })
    assert.ok(read !== null)
    assert.equal(read.parts.commands?.commands.length, 1)
    assert.equal(read.parts.commands?.commandsFloor, undefined)
    assert.equal(read.parts.commands?.commandStats, undefined)
  })

  test('tolerates parts with bad member shapes instead of throwing', () => {
    const read = factsOf({
      rev: 1,
      parts: { head: 'nope', series: 'bad', nodes: { nodes: 1, archive: [] }, files: { fileOps: 3 }, commands: { commands: 'x', commandStats: 'y' }, spans: {} },
    })
    assert.ok(read !== null)
    assert.equal(read.parts.head, undefined)
    assert.equal(read.parts.series, undefined)
    assert.equal(read.parts.nodes, undefined)
    assert.equal(read.parts.files, undefined)
    assert.equal(read.parts.commands, undefined)
    assert.equal(read.parts.spans, undefined)
  })
})

describe('DetailStore over the facts protocol', () => {
  function storeOf(readCore: () => Promise<unknown>, readPart: (part: FactPart, window: unknown) => Promise<unknown> = async () => null) {
    const fetchers = {
      core: async () => readCore() as never,
      part: async (part: FactPart, window: unknown) => readPart(part, window) as never,
    }
    return new DetailStore(fetchers, 0)
  }

  test('the core read lands the head and series; collections wait for an explicit part request', async () => {
    const parts: FactPart[] = []
    const store = storeOf(async () => core(4), async (part) => {
      parts.push(part)
      if (part === 'files') return { rev: 4, parts: { files: { fileOps: [] } } }
      if (part === 'spans') return { rev: 4, parts: { spans: [] } }
      return { rev: 4, parts: {} }
    })
    store.subscribe(() => {})
    store.request(4)
    await until(() => store.getSnapshot().detail !== null, 'the core never landed')
    const detail = store.getSnapshot().detail as ContextTimelineDetail
    assert.equal(detail.rev, 4)
    assert.equal(detail.head?.detailRev, 4)
    assert.equal(detail.requests.length, 1, 'the series fills requests until the full part lands')
    assert.equal(parts.length, 0, 'no collection is read before a card asks for it')
    store.ensurePart('files')
    store.ensurePart('spans', { spansTail: 2000 })
    await until(() => parts.includes('files') && parts.includes('spans'), 'the explicit parts were never read')
    store.release()
  })

  test('every window field participates in the replay decision', async () => {
    const windows: unknown[] = []
    const store = storeOf(async () => core(1), async (part, window) => {
      if (part === 'nodes') windows.push(window)
      return { rev: 1, parts: { nodes: { nodes: [], archive: [], droppedNodes: 0 } } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('nodes', {})
    await until(() => windows.length === 1, 'the base window never fired')
    for (const window of [{ requestsTail: 3 }, { nodesTail: 4 }, { eventsTail: 5 }, { filesTail: 6 }, { commandsTail: 7 }, { spansTail: 8 }]) {
      store.ensurePart('nodes', window as never)
      await until(() => windows.length > 1, 'the changed window never fired')
    }
    assert.equal(windows.length, 7)
    assert.deepEqual(windows, [{}, { requestsTail: 3 }, { nodesTail: 4 }, { eventsTail: 5 }, { filesTail: 6 }, { commandsTail: 7 }, { spansTail: 8 }])
    store.release()
  })

  test('a changed window invalidates the fetched part; an unchanged one replays', async () => {
    const windows: unknown[] = []
    const store = storeOf(async () => core(2), async (part, window) => {
      if (part !== 'spans') return { rev: 2, parts: {} }
      windows.push(window)
      return { rev: 2, parts: { spans: [{ kind: 'text', start: 1, end: 2 }] } }
    })
    store.subscribe(() => {})
    store.request(2)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('spans', { spansTail: 600 })
    await until(() => windows.length === 1, 'the narrow spans read never fired')
    store.ensurePart('spans', { spansTail: 600 })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(windows.length, 1, 'the same window replays')
    store.ensurePart('spans', { spansTail: 2000 })
    await until(() => windows.length === 2, 'the wider spans read never fired')
    assert.deepEqual(windows, [{ spansTail: 600 }, { spansTail: 2000 }])
    store.release()
  })

  test('ensurePart fetches once per revision and merges collections', async () => {
    const calls: FactPart[] = []
    const store = storeOf(async () => core(2), async (part) => {
      calls.push(part)
      if (part === 'nodes') {
        return {
          rev: 2,
          parts: { nodes: { nodes: [{ seq: 2, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0 } },
        }
      }
      if (part === 'requests') return { rev: 2, parts: { requests: [{ seq: 2, time: T0, system: 1, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1 }] } }
      return { rev: 2, parts: {} }
    })
    store.subscribe(() => {})
    store.request(2)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('nodes', { nodesTail: 10 })
    await until(() => store.getSnapshot().detail?.nodes.length === 1, 'the nodes part never merged')
    store.ensurePart('nodes', { nodesTail: 10 })
    store.ensurePart('requests')
    await until(() => store.getSnapshot().detail?.requests[0]?.system === 1, 'the full requests part never replaced the series')
    assert.equal(calls.filter(part => part === 'nodes').length, 1, 'a fetched part is not fetched twice for the same revision')
    store.release()
  })

  test('discards a part from a newer revision and catches the core up', async () => {
    let coreReads = 0
    const store = storeOf(
      async () => { coreReads++; return core(coreReads === 1 ? 2 : 3) },
      async () => ({ rev: 3, parts: { nodes: { nodes: [{ seq: 3, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0 } } }),
    )
    store.subscribe(() => {})
    store.request(2)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('nodes')
    await until(() => store.getSnapshot().detail?.rev === 3, 'the newer revision never landed')
    assert.equal(coreReads, 2)
  })

  test('marks a missing part unavailable until the next core revision', async () => {
    let rev = 1
    const partCalls: string[] = []
    const store = storeOf(async () => core(rev), async (part) => {
      partCalls.push(part)
      return { rev, parts: {}, missing: part === 'commands' ? ['commands'] : undefined }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('commands')
    await until(() => partCalls.includes('commands'), 'the missing part was never requested')
    store.ensurePart('commands')
    assert.equal(partCalls.filter(part => part === 'commands').length, 1, 'a missing part is not retried for the same revision')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next core revision never landed')
    await until(() => partCalls.filter(part => part === 'commands').length >= 2, 'a new revision retries the missing part')
  })

  test('a core read without head or series still yields an empty base', async () => {
    const store = storeOf(async () => ({ rev: 1, live: true, parts: {} }), async () => null)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the bare core never landed')
    const detail = store.getSnapshot().detail as ContextTimelineDetail
    assert.equal(detail.head, undefined)
    assert.deepEqual(detail.requests, [])
    store.ensurePart('commands')
    store.release()
  })

  test('a command part without floors or stats merges as bare rows', async () => {
    const store = storeOf(async () => core(1), async () => ({
      rev: 1,
      parts: { commands: { commands: [{ seq: 1, time: T0, tool: 'bash', cmd: 'ls', start: T0, status: 'completed', err: false }] } },
    }))
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('commands')
    await until(() => store.getSnapshot().detail?.commands?.length === 1, 'the bare commands never merged')
    assert.equal(store.getSnapshot().detail?.commandsFloor, undefined)
    assert.equal(store.getSnapshot().detail?.commandStats, undefined)
  })

  test('merges every collection part with its floor watermarks', async () => {
    const store = storeOf(async () => ({ rev: 1, live: true, parts: { head: head(1) as never } }), async (part) => {
      if (part === 'events') return { rev: 1, parts: { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] } }
      if (part === 'files') return { rev: 1, parts: { files: { fileOps: [], fileOpsFloor: 2 } } }
      if (part === 'commands') return { rev: 1, parts: { commands: { commands: [], commandsFloor: 3, commandStats: { runs: 2, failed: 0, ms: 1, bg: 0 } } } }
      if (part === 'spans') return { rev: 1, parts: { spans: [{ kind: 'text', start: 1, end: 2 }] } }
      return {
        rev: 1,
        parts: { nodes: { nodes: [{ seq: 1, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0, surfaceFloor: 5, archiveFloor: 4 } },
      }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    for (const part of ['events', 'files', 'commands', 'spans', 'nodes'] as FactPart[]) store.ensurePart(part)
    await until(() => store.getSnapshot().detail?.nodes.length === 1, 'the collections never merged')
    const detail = store.getSnapshot().detail as ContextTimelineDetail
    assert.equal(detail.events.length, 1)
    assert.equal(detail.fileOpsFloor, 2)
    assert.equal(detail.commandsFloor, 3)
    assert.equal(detail.commandStats?.runs, 2)
    assert.equal(detail.spans?.length, 1)
    assert.equal(detail.surfaceFloor, 5)
    assert.equal(detail.archiveFloor, 4)
  })

  test('a null part result changes nothing and a reset discards in-flight parts', async () => {
    let release!: (value: unknown) => void
    const store = storeOf(async () => core(1), async () => new Promise(resolve => { release = resolve }))
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('nodes')
    store.release()
    release({ rev: 1, parts: { nodes: { nodes: [{ seq: 1, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0 } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail, null, 'a part from a released generation is dropped')
    const nullStore = storeOf(async () => core(1), async () => null)
    nullStore.subscribe(() => {})
    nullStore.request(1)
    await until(() => nullStore.hasPayload, 'the core never landed')
    nullStore.ensurePart('nodes')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(nullStore.getSnapshot().detail?.nodes.length, 0)
  })

  test('a degraded core series is rejected so the legacy detail route can serve it', async () => {
    const legacyDetail: ContextTimelineDetail = {
      rev: 1,
      requests: [{ seq: 1, time: 1, total: 1 }, { seq: 2, time: 2, total: 2 }, { seq: 3, time: 3, total: 3 }] as never,
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
    }
    let legacyReads = 0
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1) as never }, missing: ['series'] }),
      part: async () => null,
      legacy: async () => { legacyReads++; return legacyDetail },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the fallback detail never landed')
    assert.equal(legacyReads, 1)
    assert.equal(store.getSnapshot().detail?.requests.length, 3)
  })

  test('fails when the core read is empty and no legacy fetcher exists', async () => {
    const store = new DetailStore({ core: async () => null, part: async () => null }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().failed, 'the empty read never settled')
    assert.equal(store.getSnapshot().detail, null)
  })

  test('keeps the ledger on a part failure and retries it', async () => {
    let fail = true
    const store = storeOf(async () => core(1), async () => {
      if (fail) throw new Error('part offline')
      return { rev: 1, parts: { nodes: { nodes: [{ seq: 1, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0 } } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('nodes')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(store.getSnapshot().detail?.nodes.length, 0, 'the failed part changed nothing')
    fail = false
    store.ensurePart('nodes')
    await until(() => store.getSnapshot().detail?.nodes.length === 1, 'the retried part never merged')
  })

  test('an empty session id falls back to the legacy store factory', () => {
    assert.ok(detailStoreOf(''))
    resetTimelineDetailStores()
  })

  test('facts bytes count the merged collections', () => {
    const detail: ContextTimelineDetail = {
      rev: 1,
      requests: [{ seq: 1, time: T0, total: 1 } as never],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
      fileOps: [],
      commands: [],
      spans: [],
    }
    assert.equal(detailBytesOf(detail), 2048 + 180 + 0 + 0 + 0)
  })
})

describe('makeFactsFetchers over HTTP', () => {
  test('posts core and part requests with the expected bodies and decodes both shapes', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string }) => {
      const url = String(input)
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      requests.push({ url, body })
      if (body.parts !== undefined && Array.isArray(body.parts) && (body.parts as string[]).includes('head')) {
        return { ok: true, status: 200, json: async () => factsResponse(5, { head: head(5), series: series(5) }) }
      }
      return { ok: true, status: 200, json: async () => factsResponse(5, { nodes: { nodes: [], archive: [], droppedNodes: 0 } }) }
    })
    const fetchers = makeFactsFetchers('s1')
    assert.ok(fetchers !== undefined)
    assert.equal(makeFactsFetchers(''), undefined)
    const core = await fetchers.core()
    assert.ok(core !== null && 'parts' in core)
    assert.equal(requests[0]?.url, 'api/dsh-context/facts')
    assert.deepEqual(requests[0]?.body, { sessionId: 's1', parts: ['head', 'series'] })
    const part = await fetchers.part('nodes', { nodesTail: 10 })
    assert.equal(part !== null, true)
    assert.deepEqual(requests[1]?.body, { sessionId: 's1', parts: ['nodes'], window: { nodesTail: 10 } })
  })
})

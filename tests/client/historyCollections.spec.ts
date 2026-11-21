// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DetailStore } from '../../src/client/timelineSource'
import type { TimingSpan } from '../../src/shared/types'
import { head, T0 } from './helpers/factsFixtures'
import { fileOp, node, pageOf, request } from './helpers/historyFixtures'
import { until } from './helpers/kit'

describe('history collections', () => {
  test('queues a collection requested before the core detail lands', async () => {
    let releaseCore: (() => void) | undefined
    const coreGate = new Promise<void>(resolve => { releaseCore = resolve })
    const store = new DetailStore({
      core: async () => {
        await coreGate
        return { rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }
      },
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(1)])
        if (part === 'events') return pageOf(part, [{ seq: 1, time: T0, kind: 'inject' }])
        if (part === 'archive') return pageOf(part, [])
        if (part === 'nodes') return pageOf(part, [node(2), node(3)])
        return pageOf(part, [])
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    store.ensurePart('nodes')
    assert.equal(store.getSnapshot().detail, null)
    releaseCore?.()
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.nodes.length === 2, 'the queued nodes never landed')
    store.release()
  })

  test('loads full nodes and archive only when the browser asks for them', async () => {
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(1)])
        if (part === 'events') return pageOf(part, [{ seq: 1, time: T0, kind: 'inject' }])
        if (part === 'archive') return pageOf(part, [node(2), node(3)])
        if (part === 'nodes') return pageOf(part, [node(4), node(5)])
        return pageOf(part, [])
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    assert.equal(store.getSnapshot().detail?.nodes.length, 0)
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('nodes')
    await until(() => store.getSnapshot().detail?.nodes.length === 2, 'the nodes never landed')
    assert.deepEqual(store.getSnapshot().detail?.archive.map(row => row.seq), [2, 3])
    assert.equal(store.getSnapshot().detail?.droppedNodes, 0)
    assert.equal(store.getSnapshot().detail?.surfaceFloor, undefined)
    store.release()
  })

  test('loads full files, archive and spans independently of nodes', async () => {
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(1)])
        if (part === 'events') return pageOf(part, [{ seq: 1, time: T0, kind: 'inject' }])
        if (part === 'archive') return pageOf(part, [node(2)])
        if (part === 'files') return pageOf(part, [fileOp(3, 'a.ts'), fileOp(4, 'b.ts')])
        if (part === 'spans') return pageOf(part, [{ kind: 'ttft', start: 1, end: 2 }, { kind: 'other', start: 2, end: 3 }] as TimingSpan[])
        return pageOf(part, [])
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    store.ensurePart('spans')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 2, 'the files never landed')
    await until(() => store.getSnapshot().detail?.spans?.length === 2, 'the spans never landed')
    assert.deepEqual(store.getSnapshot().detail?.archive.map(row => row.seq), [2])
    assert.equal(store.getSnapshot().detail?.fileOpsFloor, undefined)
    store.release()
  })

  test('refreshes append-only collections and reloads nodes when archive changes', async () => {
    let rev = 1
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'nodes') return rev === 1 ? pageOf(part, [node(1), node(2)], rev) : pageOf(part, [node(1), node(2), node(5)], rev)
        if (part === 'archive') return rev === 1 ? pageOf(part, [], rev) : pageOf(part, [node(3)], rev)
        if (part === 'files') return rev === 1 ? pageOf(part, [fileOp(1, 'a.ts')], rev) : pageOf(part, [fileOp(1, 'a.ts'), fileOp(2, 'b.ts')], rev)
        if (part === 'spans') return rev === 1 ? pageOf(part, [{ kind: 'ttft', start: 1, end: 2 }] as TimingSpan[], rev) : pageOf(part, [{ kind: 'ttft', start: 1, end: 2 }, { kind: 'other', start: 2, end: 3 }] as TimingSpan[], rev)
        return pageOf(part, [], rev)
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('nodes')
    await until(() => store.getSnapshot().detail?.nodes.length === 2, 'the nodes never landed')
    store.ensurePart('files')
    store.ensurePart('spans')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    await until(() => store.getSnapshot().detail?.spans?.length === 1, 'the spans never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.some(row => row.seq === 2) === true, 'the core refresh never landed')
    await until(() => store.getSnapshot().detail?.archive.length === 1, 'the archive refresh never landed')
    await until(() => store.getSnapshot().detail?.nodes.length === 3, 'the nodes refresh never landed')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 2, 'the files refresh never landed')
    await until(() => store.getSnapshot().detail?.spans?.length === 2, 'the spans refresh never landed')
    store.release()
  })

  test('walks index pages and appends a multi-page tail without rebuilding the prefix', async () => {
    let rev = 1
    let filePages = 0
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part, cursor) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        const total = part === 'files' ? (rev === 1 ? 1 : 2_500) : (rev === 1 ? 1_001 : 2_502)
        if (part === 'files') filePages++
        const all = Array.from({ length: total }, (_, index) => part === 'files'
          ? fileOp(index + 1, 'f' + String(index + 1))
          : { kind: 'ttft' as const, start: index, end: index + 1 })
        const end = cursor?.beforeIndex ?? all.length
        const start = Math.max(0, end - 1_000)
        return {
          rev,
          live: true,
          part,
          rows: all.slice(start, end),
          first: start,
          last: end - 1,
          total,
          atStart: start === 0,
          atEnd: end === total,
          ...(start > 0 ? { beforeIndex: start } : {}),
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    store.ensurePart('files')
    store.ensurePart('spans')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    await until(() => store.getSnapshot().detail?.spans?.length === 1_001, 'the spans never landed')
    const filesBefore = store.getSnapshot().detail?.fileOps
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.fileOps?.length === 2_500, 'the files tail never landed')
    await until(() => store.getSnapshot().detail?.spans?.length === 2_502, 'the spans tail never landed')
    assert.notEqual(store.getSnapshot().detail?.fileOps, filesBefore)
    assert.equal(store.getSnapshot().detail?.fileOps?.[0]?.path, 'f1')
    store.ensurePart('files')
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(filePages >= 4)
    store.release()
  })

  test('retries a failed collection and keeps loaded collections on refresh failure', async () => {
    let rev = 1
    let fileCalls = 0
    let failRefresh = false
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        if (part === 'files') {
          fileCalls++
          if (fileCalls === 1 || failRefresh) throw new Error('files failed')
          return pageOf(part, [fileOp(1, 'a.ts')], rev)
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files retry never landed', 500)
    rev = 2
    failRefresh = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => fileCalls >= 3, 'the failed refresh never ran')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(store.getSnapshot().detail?.fileOps?.map(row => row.path), ['a.ts'])
    store.release()
  })

  test('releasing during a collection read cancels the queue', async () => {
    let releaseArchive: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseArchive = resolve })
    let archiveCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(1)])
        if (part === 'events') return pageOf(part, [{ seq: 1, time: T0, kind: 'inject' }])
        if (part === 'archive') {
          archiveCalls++
          await gate
          return pageOf(part, [node(2)])
        }
        return pageOf(part, [])
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => archiveCalls === 1, 'the archive read never started')
    store.release()
    releaseArchive?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail, null)
  })

  test('a collection read restarts when the revision advances mid-flight', async () => {
    let rev = 1
    let block = true
    let releaseFiles: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFiles = resolve })
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        if (part === 'files') {
          const pageRev = rev
          if (block) {
            block = false
            await gate
          }
          return pageOf(part, pageRev === 1 ? [fileOp(1, 'f1')] : [fileOp(1, 'f1'), fileOp(pageRev, 'f' + String(pageRev))], pageRev)
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => !block, 'the files read never started')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    releaseFiles?.()
    await until(() => store.getSnapshot().detail?.fileOps?.length === 2, 'the restarted collection read never landed')
    store.release()
  })

  test('keeps loaded collections when an archive refresh fails', async () => {
    let rev = 1
    let failRefresh = false
    let archiveCalls = 0
    let fileCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') {
          archiveCalls++
          if (failRefresh) return null
          return pageOf(part, [], rev)
        }
        if (part === 'files') {
          fileCalls++
          if (failRefresh) throw new Error('files refresh failed')
          return pageOf(part, [fileOp(1, 'a.ts')], rev)
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    rev = 2
    failRefresh = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => archiveCalls >= 2 && fileCalls >= 2, 'the failed collection refresh never ran')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(store.getSnapshot().detail?.fileOps?.map(row => row.path), ['a.ts'])
    store.release()
  })

  test('restarts a refresh when the revision advances mid-flight', async () => {
    let rev = 1
    let block = false
    let releaseFiles: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFiles = resolve })
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        if (part === 'files') {
          const pageRev = rev
          if (block) {
            block = false
            await gate
          }
          return pageOf(part, pageRev === 1 ? [fileOp(1, 'f1')] : [fileOp(1, 'f1'), fileOp(pageRev, 'f' + String(pageRev))], pageRev)
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    rev = 2
    block = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => !block, 'the files refresh never blocked')
    rev = 3
    store.request(3)
    await until(() => store.getSnapshot().detail?.rev === 3, 'the newer revision never landed')
    releaseFiles?.()
    await until(() => store.getSnapshot().detail?.fileOps?.length === 2, 'the restarted refresh never landed')
    store.release()
  })

  test('parking cancels a collection walk and resumes on the next subscriber', async () => {
    let releaseFiles: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFiles = resolve })
    let blocked = false
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(1)])
        if (part === 'events') return pageOf(part, [{ seq: 1, time: T0, kind: 'inject' }])
        if (part === 'archive') return pageOf(part, [])
        if (part === 'files') {
          if (blocked) {
            blocked = false
            await gate
          }
          return pageOf(part, [fileOp(1, 'a.ts')])
        }
        return pageOf(part, [])
      },
    }, 0)
    const off = store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    blocked = true
    store.ensurePart('files')
    await until(() => !blocked, 'the files walk never blocked')
    off()
    releaseFiles?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail?.fileOps, undefined)
    store.subscribe(() => {})
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the collection never resumed')
    store.release()
  })

  test('does not schedule a collection retry after the last subscriber leaves', async () => {
    let rev = 1
    let releaseFiles: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFiles = resolve })
    let blocked = false
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        if (part === 'files') {
          if (blocked) {
            blocked = false
            await gate
            return null
          }
          return pageOf(part, [fileOp(1, 'a.ts')], rev)
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    const off = store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    rev = 2
    blocked = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => !blocked, 'the files refresh never blocked')
    off()
    releaseFiles?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(store.getSnapshot().detail?.fileOps?.map(row => row.path), ['a.ts'])
    store.release()
  })

  test('parking aborts an append-only refresh before later pages', async () => {
    let rev = 1
    let blocked = false
    let releaseFiles: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFiles = resolve })
    const all = Array.from({ length: 2_001 }, (_, index) => fileOp(index + 1, 'f' + String(index + 1)))
    let fileCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part, cursor) => {
        if (part === 'requests') return pageOf(part, [request(rev)], rev)
        if (part === 'events') return pageOf(part, [{ seq: rev, time: T0, kind: 'inject' }], rev)
        if (part === 'archive') return pageOf(part, [], rev)
        if (part === 'files') {
          fileCalls++
          if (rev === 2 && cursor?.beforeIndex === 1_001 && blocked) {
            blocked = false
            await gate
          }
          const rows = rev === 1 ? [fileOp(1, 'f1')] : all
          const end = cursor?.beforeIndex ?? rows.length
          const start = Math.max(0, end - 1_000)
          return {
            rev,
            live: true,
            part,
            rows: rows.slice(start, end),
            first: start,
            last: end - 1,
            total: rows.length,
            atStart: start === 0,
            atEnd: end === rows.length,
            ...(start > 0 ? { beforeIndex: start } : {}),
          }
        }
        return pageOf(part, [], rev)
      },
    }, 0)
    const off = store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never landed')
    store.ensurePart('files')
    await until(() => store.getSnapshot().detail?.fileOps?.length === 1, 'the files never landed')
    rev = 2
    blocked = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => fileCalls === 3 && !blocked, 'the refresh never reached its second page')
    off()
    releaseFiles?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fileCalls, 3, 'no later page is fetched after parking')
    assert.deepEqual(store.getSnapshot().detail?.fileOps?.map(row => row.path), ['f1'], 'the partial refresh is not published')
    store.release()
  })
})

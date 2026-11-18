import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'vitest'
import {
  createOverviewCache,
  type CacheFs,
  type CachedSession,
  type DurableIdentity,
  type OverviewCache,
} from '../../src/host/overviewCache'
import { stableHashOf, type HostSession } from '../../src/host/overviewCorpus'

interface Rig {
  root: string
  path: string
  identity: DurableIdentity
  fs: CacheFs
  reads: string[]
  writes: string[]
  blockWrite: () => { entered: Promise<void>; release: () => void }
}

let rig: Rig

beforeEach(async () => {
  const root = await mkdtemp(join('.tmp', 'dsh-context-cache-shards-'))
  const log = join(root, 'source.jsonl')
  await writeFile(log, 'synthetic')
  const info = await stat(log)
  const identity = { path: log, sizeBytes: info.size, mtimeMs: info.mtimeMs }
  const reads: string[] = []
  const writes: string[] = []
  let gated: { entered: () => void; gate: Promise<void>; release: () => void } | null = null
  const fs: CacheFs = {
    stat: async path => {
      const value = await stat(path)
      return { size: value.size, mtimeMs: value.mtimeMs }
    },
    readFile: async path => {
      reads.push(path)
      return await readFile(path, 'utf8')
    },
    writeFile: async (path, data) => {
      if (gated !== null) {
        const current = gated
        gated = null
        current.entered()
        await current.gate
      }
      await writeFile(path, data, 'utf8')
      writes.push(path)
    },
    rename: async (from, to) => { await rename(from, to) },
    mkdir: async path => { await mkdir(path, { recursive: true }) },
    rm: async path => { await rm(path, { force: true }) },
  }
  rig = {
    root,
    path: join(root, 'cache.v3'),
    identity,
    fs,
    reads,
    writes,
    blockWrite: () => {
      let entered!: () => void
      let release!: () => void
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      gated = { entered, gate, release }
      return { entered: enteredPromise, release }
    },
  }
})

afterEach(async () => {
  await rm(rig.root, { recursive: true, force: true })
})

function shardOf(id: string): number {
  return stableHashOf([id]) & 63
}

function shardPath(id: string): string {
  return join(rig.path, `shard-${String(shardOf(id)).padStart(2, '0')}.json`)
}

function sessionOf(id: string, title = `Session ${id}`): HostSession {
  return {
    id,
    title,
    updatedAt: 1,
    blank: false,
    signature: `sig-${id}`,
    timeline: null,
    activity: null,
    materialization: {
      asOfSeq: 0,
      facts: { id, createdAt: 1 },
      signature: `sig-${id}`,
      values: {
        contextTimeline: {
          ok: true,
          current: {
            system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0,
          },
          counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
        },
        contextActivity: { days: {} },
        title,
        sessionListMetadata: { blank: false, lastPromptAt: 1 },
      },
    },
  }
}

function recordOf(id: string, title?: string): CachedSession {
  return { session: sessionOf(id, title), identity: rig.identity }
}

function known(ids: readonly string[]): Map<string, DurableIdentity | null> {
  return new Map(ids.map(id => [id, rig.identity]))
}

async function seed(cache: OverviewCache, ids: readonly string[]): Promise<void> {
  assert.equal(await cache.save(ids.map(id => recordOf(id))), true)
  await cache.flush()
}

describe('overview cache shards and capacity', () => {
  test('subset loads read only their stable shards and corruption stays isolated', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs })
    const ids = Array.from({ length: 96 }, (_, index) => `session-${index}`)
    await seed(cache, ids)
    const first = ids[0]
    const other = ids.find(id => shardOf(id) !== shardOf(first))
    assert.ok(other !== undefined)
    rig.reads.length = 0
    const subset = await cache.load(new Set([first]), known([first]))
    assert.deepEqual([...subset.sessions.keys()], [first])
    assert.deepEqual(rig.reads, [shardPath(first)])
    rig.reads.length = 0
    const probed = await cache.probe(new Set([other]))
    assert.deepEqual([...probed.warm], [other])
    assert.deepEqual(rig.reads, [shardPath(other)])
    await writeFile(shardPath(first), '{broken')
    const isolated = await cache.load(new Set([first, other]), known([first, other]))
    assert.deepEqual([...isolated.sessions.keys()], [other])
    assert.deepEqual([...isolated.rebuild], [])
    cache.dispose()
  })

  test('empty prune rewrites nothing and a later empty prune is also inert', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs })
    const ids = Array.from({ length: 70 }, (_, index) => `session-${index}`)
    await seed(cache, ids)
    rig.writes.length = 0
    assert.equal(await cache.save([], new Set(ids)), true)
    await cache.flush()
    assert.equal(rig.writes.length, 0)
    assert.equal(await cache.save([], new Set()), true)
    await cache.flush()
    const shards = await readdir(rig.path)
    assert.equal(rig.writes.length, shards.filter(name => name.startsWith('shard-')).length)
    rig.writes.length = 0
    assert.equal(await cache.save([], new Set()), true)
    await cache.flush()
    assert.equal(rig.writes.length, 0)
    cache.dispose()
  })

  test('record capacity waits, times out, and recovers after the active batch drains', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs, maxPendingRecords: 1, capacityWaitMs: 20, debounceMs: 60000 })
    const gate = rig.blockWrite()
    assert.equal(await cache.save([recordOf('a')]), true)
    const flushing = cache.flush()
    await gate.entered
    assert.equal(await cache.save([recordOf('b')]), true)
    assert.equal(await cache.save([recordOf('c')]), false)
    const waiting = cache.save([recordOf('d')])
    gate.release()
    await flushing
    assert.equal(await waiting, true)
    assert.equal(await cache.save([recordOf('c')]), true)
    await cache.flush()
    const loaded = await cache.load(new Set(['a', 'b', 'c', 'd']), known(['a', 'b', 'c', 'd']))
    assert.deepEqual([...loaded.sessions.keys()].sort(), ['a', 'b', 'c', 'd'])
    cache.dispose()
  })

  test('an oversized record is accepted alone and a disposed waiter is rejected', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs, maxPendingBytes: 1, capacityWaitMs: 60000, debounceMs: 60000 })
    const gate = rig.blockWrite()
    assert.equal(await cache.save([recordOf('large', '界'.repeat(1000))]), true)
    const flushing = cache.flush()
    await gate.entered
    assert.equal(await cache.save([recordOf('pending')]), true)
    const waiting = cache.save([recordOf('waiting')])
    cache.dispose()
    assert.equal(await waiting, false)
    gate.release()
    await flushing
    assert.equal(await cache.save([recordOf('after-dispose')]), false)
  })

  test('a multi-record save stops accepting when disposed between records', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs, debounceMs: 60000 })
    const saving = cache.save([recordOf('a'), recordOf('b')])
    cache.dispose()
    assert.equal(await saving, false)
    await cache.flush()
  })

  test('pending records deduplicate by id and debounce is not extended indefinitely', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs, debounceMs: 5 })
    assert.equal(await cache.save([recordOf('a', 'first')]), true)
    await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(await cache.save([recordOf('a', '界'), recordOf('b')]), true)
    await new Promise(resolve => setTimeout(resolve, 15))
    const loaded = await cache.load(new Set(['a', 'b']), known(['a', 'b']))
    assert.equal(loaded.sessions.get('a')?.title, '界')
    assert.deepEqual([...loaded.sessions.keys()].sort(), ['a', 'b'])
    assert.ok(rig.writes.length > 0)
    cache.dispose()
  })

  test('legacy files are never read and are removed only after a successful flush', async () => {
    const parent = join(rig.root, 'storages', 'dsh-context')
    const path = join(parent, 'overview-cache.v3')
    await mkdir(parent, { recursive: true })
    const legacy = ['overview-cache.v1.json', 'overview-cache.v2.json'].map(name => join(parent, name))
    for (const file of legacy) await writeFile(file, JSON.stringify({ format: 2, sessions: [recordOf('old')] }))
    const cache = createOverviewCache({ path, fs: rig.fs })
    assert.equal((await cache.load(new Set(['old']), known(['old']))).sessions.size, 0)
    for (const file of legacy) assert.equal((await stat(file)).isFile(), true)
    assert.equal(await cache.save([recordOf('new')]), true)
    await cache.flush()
    for (const file of legacy) await assert.rejects(stat(file))
    cache.dispose()

    for (const file of legacy) await writeFile(file, 'legacy')
    const failingFs = { ...rig.fs, mkdir: async () => { throw new Error('mkdir failed') } }
    const failing = createOverviewCache({ path: join(parent, 'other.v3'), fs: failingFs })
    await failing.save([recordOf('new')])
    await failing.flush()
    for (const file of legacy) assert.equal((await stat(file)).isFile(), true)
    failing.dispose()
  })

  test('a save arriving during legacy cleanup schedules the following drain', async () => {
    const legacy = join(rig.root, 'overview-cache.v1.json')
    await writeFile(legacy, 'legacy')
    const originalRm = rig.fs.rm
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    rig.fs.rm = async path => {
      if (first && path === legacy) {
        first = false
        entered()
        await gate
      }
      await originalRm?.(path)
    }
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs })
    assert.equal(await cache.save([recordOf('a')]), true)
    const flushing = cache.flush()
    await enteredPromise
    assert.equal(await cache.save([recordOf('b')]), true)
    release()
    await flushing
    const loaded = await cache.load(new Set(['a', 'b']), known(['a', 'b']))
    assert.deepEqual([...loaded.sessions.keys()].sort(), ['a', 'b'])
    cache.dispose()
  })

  test('loads retry across a batch switch so accepted overlays cannot disappear', async () => {
    const cache = createOverviewCache({ path: rig.path, fs: rig.fs, debounceMs: 60000 })
    await seed(cache, ['a'])
    const initialWrites = rig.writes.length
    assert.equal(await cache.save([recordOf('b')]), true)
    const gate = rig.blockWrite()
    const flushing = cache.flush()
    await gate.entered
    assert.equal(await cache.save([recordOf('c')]), true)
    const originalRead = rig.fs.readFile
    let releaseRead!: () => void
    let readStarted!: () => void
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve })
    let pause = true
    rig.fs.readFile = async path => {
      if (pause) {
        pause = false
        readStarted()
        await readGate
      }
      return await originalRead(path)
    }
    const loading = cache.load(new Set(['b', 'c']), known(['b', 'c']))
    await readStartedPromise
    gate.release()
    for (let index = 0; index < 1500 && rig.writes.length < initialWrites + 2; index++) await new Promise(resolve => setTimeout(resolve, 2))
    releaseRead()
    assert.ok(rig.writes.length >= initialWrites + 2, 'the next batch started before the read resumed')
    await Promise.all([flushing, loading])
    const loaded = await loading
    assert.deepEqual([...loaded.sessions.keys()].sort(), ['b', 'c'])
    cache.dispose()
  })
})

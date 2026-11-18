import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import {
  OVERVIEW_CACHE_FILE,
  OVERVIEW_CACHE_FORMAT,
  createOverviewCache,
  identityKey,
  overviewCachePath,
  overviewFoldVersions,
  type CacheFs,
  type CachedSession,
  type DurableIdentity,
} from '../../src/host/overviewCache'
import { stableHashOf, type HostSession } from '../../src/host/overviewCorpus'

interface WriteCounts {
  writes: number
  deletes: number
}

function sessionOf(id: string, options: { signature?: string; activity?: HostSession['activity']; timeline?: HostSession['timeline'] } = {}): HostSession {
  const session: HostSession = {
    id,
    title: `Session ${id}`,
    cwd: `/repo/${id}`,
    updatedAt: 1_700_000_000_000,
    blank: false,
    signature: options.signature ?? `sig-${id}`,
    timeline: options.timeline === undefined
      ? {
        current: {
          system: 1,
          tools: 2,
          user: 3,
          inject: 0,
          skill: 0,
          assistant: 4,
          assistantReasoning: 1,
          assistantAnswerTokens: 2,
          assistantCallTokens: 1,
          tool: 5,
          total: 15,
        },
        total: 15,
        turns: 2,
        steps: 3,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        model: 'deepseek-v4-flash',
        lastUser: 'hello',
        timing: {
          wallMs: 100,
          ttftMs: 10,
          genMs: 80,
          calls: 1,
          toolsMs: 20,
          toolCalls: 1,
          tools: { bash: { calls: 1, ms: 20 } },
          reasoningMs: 5,
          toolBusyMs: 60,
        },
        generatedReasoning: 1,
        generatedAnswerTokens: 2,
        generatedCallTokens: 3,
      }
      : options.timeline,
    activity: options.activity === undefined
      ? {
        days: {
          '2026-11-01': {
            tokens: 18,
            requests: 2,
            turns: 1,
            toolCalls: 1,
            toolsMs: 20,
            wallMs: 100,
            cost: { deepseek: { model: { off: { uncached: 10, cacheRead: 2, cacheWrite: 1, output: 5 } } } },
            skills: { skill: { n: 1, last: 10 } },
            tools: { bash: { n: 1, last: 20 } },
            cmds: { 'git status': { n: 1, last: 30 } },
          },
        },
      }
      : options.activity,
  }
  return withMaterialization(session)
}

function withMaterialization(session: HostSession): HostSession {
  const timeline = session.timeline
  const current = timeline?.current ?? {
    system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0,
  }
  return {
    ...session,
    materialization: {
      asOfSeq: 1,
      facts: {
        id: session.id,
        createdAt: session.updatedAt,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
        ...(session.origin === undefined ? {} : { origin: session.origin }),
      },
      signature: session.signature,
      values: {
        contextTimeline: {
          ok: true,
          current,
          counts: {
            turns: timeline?.turns ?? 0,
            steps: timeline?.steps ?? 0,
            injects: 0,
            compactions: 0,
            prunes: 0,
          },
          ...(timeline?.contextWindow === undefined ? {} : { contextWindow: timeline.contextWindow }),
          ...(timeline?.maxOutputTokens === undefined ? {} : { maxOutputTokens: timeline.maxOutputTokens }),
          ...(timeline?.model === undefined ? {} : { model: timeline.model }),
          ...(timeline?.lastUser === undefined ? {} : { lastUser: timeline.lastUser }),
          ...(timeline?.timing === undefined ? {} : { timing: timeline.timing }),
          ...(timeline?.generatedReasoning === undefined ? {} : { generatedReasoning: timeline.generatedReasoning }),
          ...(timeline?.generatedAnswerTokens === undefined ? {} : { generatedAnswerTokens: timeline.generatedAnswerTokens }),
          ...(timeline?.generatedCallTokens === undefined ? {} : { generatedCallTokens: timeline.generatedCallTokens }),
        },
        contextActivity: session.activity ?? { days: {} },
        title: session.title,
        sessionListMetadata: { blank: session.blank, lastPromptAt: session.updatedAt },
      },
    },
  }
}

function identityOf(path: string, sizeBytes = 100, mtimeMs = 1_000): DurableIdentity {
  return { path, sizeBytes, mtimeMs }
}

interface FakeFs extends CacheFs {
  files: Map<string, string>
  stats: Map<string, { size: number; mtimeMs: number }>
  mkdirs: string[]
  renames: [string, string][]
  reads: string[]
  counts: WriteCounts
  failWrite: boolean
  failMkdir: boolean
  failRename: boolean
}

function fakeFs(): FakeFs {
  const files = new Map<string, string>()
  const stats = new Map<string, { size: number; mtimeMs: number }>()
  const fs: FakeFs = {
    files,
    stats,
    mkdirs: [],
    renames: [],
    reads: [],
    counts: { writes: 0, deletes: 0 },
    failWrite: false,
    failMkdir: false,
    failRename: false,
    async stat(path) {
      const info = stats.get(path)
      if (info === undefined) throw new Error(`ENOENT: ${path}`)
      return info
    },
    async readFile(path) {
      fs.reads.push(path)
      const data = files.get(path)
      if (data === undefined) throw new Error(`ENOENT: ${path}`)
      return data
    },
    async writeFile(path, data) {
      fs.counts.writes++
      if (fs.failWrite) throw new Error('write failed')
      files.set(path, data)
      stats.set(path, { size: data.length, mtimeMs: 7 })
    },
    async rename(from, to) {
      fs.renames.push([from, to])
      if (fs.failRename) throw new Error('rename failed')
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      const info = stats.get(from)
      files.delete(from)
      stats.delete(from)
      files.set(to, data)
      if (info !== undefined) stats.set(to, info)
    },
    async mkdir(path) {
      fs.mkdirs.push(path)
      if (fs.failMkdir) throw new Error('mkdir failed')
    },
    async rm(path) {
      fs.counts.deletes++
      files.delete(path)
      stats.delete(path)
    },
  }
  return fs
}

function shardOf(id: string): number {
  return stableHashOf([id]) & 63
}

function shardPath(root: string, id: string): string {
  return join(root, `shard-${String(shardOf(id)).padStart(2, '0')}.json`)
}

function canonicalOf(session: HostSession, identity: DurableIdentity | null, versions: unknown = overviewFoldVersions()): unknown {
  return { materialization: session.materialization, identity, versions }
}

function storeRaw(fs: FakeFs, path: string, sessions: unknown, format: unknown = OVERVIEW_CACHE_FORMAT): void {
  fs.files.set(path, JSON.stringify({ format, savedAt: 1, sessions }))
}

function storeSessions(fs: FakeFs, root: string, records: { session: HostSession; identity: DurableIdentity | null; versions?: unknown }[]): void {
  const shards = new Map<number, unknown[]>()
  for (const record of records) {
    const shard = shardOf(record.session.id)
    const rows = shards.get(shard) ?? []
    rows.push(canonicalOf(record.session, record.identity, record.versions))
    shards.set(shard, rows)
  }
  for (const [shard, sessions] of shards) {
    storeRaw(fs, join(root, `shard-${String(shard).padStart(2, '0')}.json`), sessions)
  }
}

function savedRecord(id: string, identity: DurableIdentity | null = identityOf(`/logs/${id}`, 1, 1)): CachedSession {
  return { session: sessionOf(id), identity }
}

const PATH = '/home/.dsh/storages/dsh-context/overview-cache.v3'

describe('overviewCache', () => {
  test('resolves the cache path and identity keys', () => {
    assert.equal(overviewCachePath({ DSH_HOME: '/data/dsh' }, '/home/user'), join('/data/dsh', 'storages', 'dsh-context', OVERVIEW_CACHE_FILE))
    assert.equal(overviewCachePath({ DSH_HOME: '   ' }, '/home/user'), join('/home/user', '.dsh', 'storages', 'dsh-context', OVERVIEW_CACHE_FILE))
    assert.equal(identityKey(null), '?')
    assert.equal(identityKey(undefined), '?')
    assert.equal(identityKey(identityOf('/a', 2, 3)), '/a\u00002\u00003')
  })

  test('missing and malformed target shards read as empty', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    const target = shardPath(PATH, 'a')
    for (const content of [
      'not json',
      JSON.stringify({ format: OVERVIEW_CACHE_FORMAT + 1, sessions: [] }),
      JSON.stringify({ format: OVERVIEW_CACHE_FORMAT, sessions: 'nope' }),
      JSON.stringify([]),
      JSON.stringify(null),
    ]) {
      fs.files.set(target, content)
      const loaded = await cache.load(new Set(['a']))
      assert.equal(loaded.sessions.size, 0)
      assert.equal(loaded.identities.size, 0)
      assert.equal(loaded.rebuild.size, 0)
    }
  })

  test('load validates identities and reuses only unchanged canonical records', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, statConcurrency: 2 })
    storeSessions(fs, PATH, [
      savedRecord('bad-identity'),
      { session: sessionOf('no-identity'), identity: null },
      savedRecord('same', identityOf('/logs/same', 10, 100)),
      savedRecord('changed', identityOf('/logs/changed', 10, 100)),
      savedRecord('gone', identityOf('/logs/gone', 10, 100)),
    ])
    fs.files.set(shardPath(PATH, 'bad-identity'), JSON.stringify({ format: 3, sessions: [{ materialization: sessionOf('bad-identity').materialization, identity: 'bad' }] }))
    fs.stats.set('/logs/same', { size: 10, mtimeMs: 100 })
    fs.stats.set('/logs/changed', { size: 11, mtimeMs: 101 })
    const loaded = await cache.load(new Set(['bad-identity', 'no-identity', 'same', 'changed', 'gone']))
    assert.deepEqual([...loaded.sessions.keys()], ['same'])
    assert.deepEqual([...loaded.identities.keys()].sort(), ['changed', 'gone', 'no-identity', 'same'])
    assert.equal(loaded.identities.has('bad-identity'), false)
    assert.deepEqual(loaded.identities.get('changed'), { path: '/logs/changed', sizeBytes: 11, mtimeMs: 101 })
    assert.equal(loaded.identities.get('gone'), null)
    assert.deepEqual([...loaded.rebuild].sort(), ['changed', 'gone', 'no-identity'])
  })

  test('known identities avoid source stats and a fold mismatch rebuilds', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    storeSessions(fs, PATH, [
      savedRecord('same', identityOf('/logs/same', 10, 100)),
      savedRecord('known-null', identityOf('/logs/null', 10, 100)),
      savedRecord('known-other', identityOf('/logs/other', 10, 100)),
      { ...savedRecord('old-version'), versions: { timeline: -1, activity: -1, config: 'old' } },
    ])
    const known = new Map<string, DurableIdentity | null>([
      ['same', identityOf('/logs/same', 10, 100)],
      ['known-null', null],
      ['known-other', identityOf('/logs/other', 12, 120)],
    ])
    const loaded = await cache.load(new Set(['same', 'known-null', 'known-other']), known)
    assert.deepEqual([...loaded.sessions.keys()], ['same'])
    assert.deepEqual([...loaded.rebuild].sort(), ['known-null', 'known-other'])
    fs.stats.set('/logs/old-version', { size: 1, mtimeMs: 1 })
    const old = await cache.load(new Set(['old-version']))
    assert.deepEqual([...old.rebuild], ['old-version'])
    assert.equal(fs.stats.has('/logs/same'), false)
  })

  test('refresh validates every known source identity', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, statConcurrency: 2 })
    fs.stats.set('/logs/same', { size: 10, mtimeMs: 100 })
    fs.stats.set('/logs/changed', { size: 11, mtimeMs: 101 })
    const known = new Map<string, DurableIdentity | null>([
      ['same', identityOf('/logs/same', 10, 100)],
      ['changed', identityOf('/logs/changed', 10, 100)],
      ['gone', identityOf('/logs/gone', 10, 100)],
      ['unvalidatable', null],
      ['other', identityOf('/logs/other', 1, 1)],
    ])
    const refreshed = await cache.refresh(new Set(['same', 'changed', 'gone', 'unvalidatable', 'missing', 'other']), known)
    assert.deepEqual(refreshed.identities.get('same'), identityOf('/logs/same', 10, 100))
    assert.deepEqual(refreshed.identities.get('changed'), { path: '/logs/changed', sizeBytes: 11, mtimeMs: 101 })
    assert.equal(refreshed.identities.get('gone'), null)
    assert.equal(refreshed.identities.get('other'), null)
    assert.equal(refreshed.identities.has('unvalidatable'), false)
    assert.equal(refreshed.identities.has('missing'), false)
    assert.deepEqual([...refreshed.changed].sort(), ['changed', 'gone', 'other'])
    assert.equal((await cache.refresh(new Set(['a']), new Map())).changed.size, 0)
  })

  test('capture derives identities from persistence snapshots and stats', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, captureConcurrency: 1 })
    fs.stats.set('/logs/ok', { size: 5, mtimeMs: 42 })
    const host = {
      stat: async (id: string): Promise<unknown> => {
        if (id === 'throws') throw new Error('stat broke')
        if (id === 'junk') return 'junk'
        if (id === 'nopath') return { sizeBytes: 5, location: {} }
        if (id === 'nosize') return { location: { path: '/logs/ok' } }
        if (id === 'badsize') return { sizeBytes: 'big', location: { path: '/logs/ok' } }
        if (id === 'empty-path') return { sizeBytes: 5, location: { path: '' } }
        if (id === 'nofile') return { sizeBytes: 5, location: { path: '/logs/missing' } }
        return { sizeBytes: 5, location: { path: '/logs/ok' } }
      },
    }
    const captured = await cache.capture(['ok', 'throws', 'junk', 'nopath', 'nosize', 'badsize', 'empty-path', 'nofile'], host)
    assert.deepEqual(captured.get('ok'), { path: '/logs/ok', sizeBytes: 5, mtimeMs: 42 })
    for (const id of ['throws', 'junk', 'nopath', 'nosize', 'badsize', 'empty-path', 'nofile']) assert.equal(captured.get(id), null, id)
    assert.equal((await cache.capture(['ok'], {})).get('ok'), null)
    assert.equal((await cache.capture([], host)).size, 0)
  })

  test('save writes only canonical records and loading shares validated object graphs', async () => {
    const fs = fakeFs()
    fs.stats.set('/logs/a', { size: 1, mtimeMs: 1 })
    const cache = createOverviewCache({ path: PATH, fs, debounceMs: 60000 })
    assert.equal(await cache.save([savedRecord('a')]), true)
    assert.equal(fs.counts.writes, 0)
    await cache.flush()
    const target = shardPath(PATH, 'a')
    const body = JSON.parse(fs.files.get(target) ?? '{}') as { format: number; sessions: Record<string, unknown>[] }
    assert.equal(body.format, 3)
    assert.deepEqual(Object.keys(body.sessions[0]).sort(), ['identity', 'materialization', 'versions'])
    assert.equal('session' in body.sessions[0], false)
    assert.equal('costRead' in (body.sessions[0].materialization as Record<string, unknown>), false)
    const loaded = await cache.load(new Set(['a']))
    const session = loaded.sessions.get('a')
    assert.ok(session?.materialization !== undefined)
    assert.strictEqual(session.activity, session.materialization.values.contextActivity)
    assert.strictEqual(session.timeline?.current, (session.materialization.values.contextTimeline as HostSession['timeline'] & object).current)
    const timeline = session.materialization.values.contextTimeline as { timing?: unknown }
    assert.strictEqual(session.timeline?.timing, timeline.timing)
    assert.equal(session.timeline?.contextWindow, 128000)
    assert.equal(session.timeline?.generatedCallTokens, 3)
    assert.equal(await cache.save([savedRecord('a')]), true)
    await cache.flush()
    const probed = await cache.probe(new Set(['a']))
    assert.deepEqual([...probed.warm], ['a'])
    assert.equal('sessions' in probed, false)
  })

  test('hostile materialization, facts, identities, and versions never become warm', async () => {
    const fs = fakeFs()
    const ids = ['bad-watermark', 'bad-facts', 'bad-activity', 'bad-versions', 'bad-version-null',
      'bad-version-string', 'bad-version-activity', 'bad-version-config', 'bad-path', 'no-size', 'no-mtime', 'valid']
    for (const id of ids) fs.stats.set(`/logs/${id}`, { size: 1, mtimeMs: 1 })
    const valid = sessionOf('valid')
    const records = ids.map(id => {
      const session = sessionOf(id)
      const materialization = structuredClone(session.materialization) as NonNullable<HostSession['materialization']>
      if (id === 'bad-watermark') materialization.asOfSeq = 'bad' as never
      if (id === 'bad-facts') materialization.facts.createdAt = 'bad' as never
      if (id === 'bad-activity') materialization.values.contextActivity = { days: { bad: { tokens: 'bad' } } }
      const versions = id === 'bad-versions' ? { timeline: 1.5, activity: 1, config: 'bad' }
        : id === 'bad-version-null' ? null
          : id === 'bad-version-string' ? { timeline: '1', activity: 1, config: 'bad' }
            : id === 'bad-version-activity' ? { timeline: 1, activity: 1.5, config: 'bad' }
              : id === 'bad-version-config' ? { timeline: 1, activity: 1, config: 7 }
                : overviewFoldVersions()
      const identity = id === 'bad-path' ? { path: '', sizeBytes: 1, mtimeMs: 1 }
        : id === 'no-size' ? { path: `/logs/${id}`, mtimeMs: 1 }
          : id === 'no-mtime' ? { path: `/logs/${id}`, sizeBytes: 1 }
            : identityOf(`/logs/${id}`, 1, 1)
      return { materialization, identity, versions }
    })
    const byShard = new Map<number, unknown[]>()
    for (const [index, record] of records.entries()) {
      const id = ids[index]
      const shard = shardOf(id)
      byShard.set(shard, [...byShard.get(shard) ?? [], record])
    }
    for (const [shard, sessions] of byShard) storeRaw(fs, join(PATH, `shard-${String(shard).padStart(2, '0')}.json`), sessions)
    const cache = createOverviewCache({ path: PATH, fs })
    const loaded = await cache.load(new Set(ids))
    assert.deepEqual([...loaded.sessions.keys()], ['valid'])
    assert.equal(loaded.sessions.get('valid')?.materialization?.facts.id, valid.id)
    assert.deepEqual([...loaded.rebuild].sort(), ['bad-version-activity', 'bad-version-config', 'bad-version-null',
      'bad-version-string', 'bad-versions'].sort())
  })

  test('flush serializes active and pending batches and dispose drains accepted records', async () => {
    const fs = fakeFs()
    const writeFile = fs.writeFile
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    fs.writeFile = async (path, data) => {
      if (first) {
        first = false
        entered()
        await gate
      }
      await writeFile(path, data)
    }
    const cache = createOverviewCache({ path: PATH, fs })
    assert.equal(await cache.save([savedRecord('a')]), true)
    const active = cache.flush()
    await waiting
    const stagedSave = cache.save([savedRecord('b')])
    const staged = cache.flush()
    release()
    await Promise.all([active, stagedSave, staged])
    assert.deepEqual([...(await cache.load(new Set(['a', 'b']), new Map())).rebuild].sort(), ['a', 'b'])
    assert.equal(await cache.save([savedRecord('c')]), true)
    await cache.dispose()
    assert.equal(await cache.save([savedRecord('d')]), false)
    await cache.dispose()
    const files = [...fs.files.values()].flatMap(value => (JSON.parse(value) as { sessions: { materialization: { facts: { id: string } } }[] }).sessions)
    assert.deepEqual(files.map(record => record.materialization.facts.id).sort(), ['a', 'b', 'c'])
  })

  test('serialization failures reject a save and later records recover', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, debounceMs: 1 })
    const cyclic = sessionOf('cyclic')
    ;(cyclic.materialization as NonNullable<HostSession['materialization']> & { cycle?: unknown }).cycle = cyclic
    assert.equal(await cache.save([{ session: cyclic, identity: null }]), false)
    assert.equal(await cache.save([savedRecord('valid')]), true)
    await cache.flush()
    const loaded = await cache.load(new Set(['valid'], ), new Map([['valid', null]]))
    assert.deepEqual([...loaded.rebuild], ['valid'])
    assert.equal(await cache.save([{ session: cyclic, identity: null }]), false)
    cache.dispose()
  })

  test('write failures stay best-effort and clean temporary files', async () => {
    for (const [label, configure] of [
      ['mkdir', (fs: FakeFs) => { fs.failMkdir = true }],
      ['write', (fs: FakeFs) => { fs.failWrite = true }],
      ['rename', (fs: FakeFs) => { fs.failRename = true }],
    ] as const) {
      const fs = fakeFs()
      configure(fs)
      const cache = createOverviewCache({ path: PATH, fs })
      assert.equal(await cache.save([savedRecord('a')]), true)
      await cache.flush()
      assert.equal(fs.files.has(shardPath(PATH, 'a')), false, label)
      if (label !== 'mkdir') assert.equal(fs.counts.deletes, 1)
      cache.dispose()
    }
    const withoutRm = fakeFs()
    delete withoutRm.rm
    const cache = createOverviewCache({ path: PATH, fs: withoutRm })
    await cache.save([savedRecord('a')])
    await cache.flush()
    cache.dispose()
  })

  test('failed shard writes retain accepted overlays and recover on a later flush', async () => {
    const fs = fakeFs()
    for (const id of ['a', 'b']) fs.stats.set(`/logs/${id}`, { size: 1, mtimeMs: 1 })
    const cache = createOverviewCache({ path: PATH, fs })
    await cache.save([savedRecord('a')])
    fs.failWrite = true
    await cache.flush()
    await cache.save([savedRecord('b')])
    const accepted = await cache.load(new Set(['a', 'b']))
    assert.deepEqual([...accepted.sessions.keys()].sort(), ['a', 'b'])
    assert.equal(fs.files.has(shardPath(PATH, 'a')), false)
    fs.failWrite = false
    await cache.flush()
    assert.equal(fs.files.has(shardPath(PATH, 'a')), true)
    assert.equal(fs.files.has(shardPath(PATH, 'b')), true)
    const persisted = await cache.load(new Set(['a', 'b']))
    assert.deepEqual([...persisted.sessions.keys()].sort(), ['a', 'b'])
    await cache.dispose()
  })

  test('a real file-system roundtrip validates sources and contains occupied paths', async () => {
    const root = await mkdtemp(join('.tmp', 'dsh-context-overview-cache-'))
    const path = join(root, 'nested', 'overview-cache.v3')
    try {
      const cache = createOverviewCache({ path })
      await cache.save([{ session: sessionOf('a'), identity: null }])
      await cache.flush()
      assert.equal((await cache.load(new Set(['a']))).sessions.size, 0)
      cache.dispose()
      const { stat, writeFile } = await import('node:fs/promises')
      const logPath = join(root, 'log.jsonl')
      await writeFile(logPath, 'first line')
      const logInfo = await stat(logPath)
      const identity = { path: logPath, sizeBytes: logInfo.size, mtimeMs: logInfo.mtimeMs }
      const warm = createOverviewCache({ path })
      await warm.save([{ session: sessionOf('b'), identity }])
      await warm.flush()
      assert.deepEqual([...(await warm.load(new Set(['b']))).sessions.keys()], ['b'])
      await writeFile(logPath, 'a longer second line')
      const changed = await warm.load(new Set(['b']))
      assert.deepEqual([...changed.rebuild], ['b'])
      assert.ok((changed.identities.get('b')?.sizeBytes ?? 0) > identity.sizeBytes)
      warm.dispose()
      const target = join(root, 'occupied')
      await mkdir(target, { recursive: true })
      const failing = createOverviewCache({ path: target })
      await failing.save([{ session: sessionOf('b'), identity: null }])
      await failing.flush()
      failing.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('full-corpus prune and isolated upserts preserve pending order', async () => {
    const fs = fakeFs()
    for (const id of ['a', 'b', 'c']) fs.stats.set(`/logs/${id}`, { size: 1, mtimeMs: 1 })
    const cache = createOverviewCache({ path: PATH, fs })
    await cache.save(['a', 'b'].map(id => savedRecord(id)))
    await cache.flush()
    const prune = cache.save([savedRecord('a')], new Set(['a']))
    const isolated = cache.save([savedRecord('c')])
    assert.equal(await prune, true)
    assert.equal(await isolated, true)
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()].sort(), ['a', 'c'])
    await cache.flush()
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()].sort(), ['a', 'c'])
    const isolatedAgain = cache.save([savedRecord('a')])
    const isolatedBeforePrune = cache.save([savedRecord('c')])
    const pruned = cache.save([savedRecord('a')], new Set(['a']))
    assert.equal(await isolatedAgain, true)
    assert.equal(await isolatedBeforePrune, true)
    assert.equal(await pruned, true)
    await cache.flush()
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()], ['a'])
    const earlier = cache.save([savedRecord('c'), savedRecord('b')])
    const finalPrune = cache.save([savedRecord('a')], new Set(['a']))
    assert.equal(await earlier, true)
    assert.equal(await finalPrune, true)
    await cache.flush()
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()], ['a'])
  })

  test('an older multi-record save cannot overwrite a newer value for the same id', async () => {
    const fs = fakeFs()
    fs.stats.set('/logs/a', { size: 1, mtimeMs: 1 })
    fs.stats.set('/logs/b', { size: 1, mtimeMs: 1 })
    const cache = createOverviewCache({ path: PATH, fs, debounceMs: 60000 })
    const oldB = savedRecord('b')
    oldB.session.title = 'old'
    assert.ok(oldB.session.materialization !== undefined)
    oldB.session.materialization.values.title = 'old'
    const older = cache.save([savedRecord('a'), oldB])
    const newer = cache.save([savedRecord('b')])
    assert.equal(await older, true)
    assert.equal(await newer, true)
    await cache.flush()
    const loaded = await cache.load(new Set(['a', 'b']))
    assert.equal(loaded.sessions.get('b')?.title, 'Session b')
    cache.dispose()
  })

  test('pending records are readable before debounce and stay scoped to requested ids', async () => {
    const fs = fakeFs()
    for (const id of ['a', 'b', 'c']) fs.stats.set(`/logs/${id}`, { size: 1, mtimeMs: 1 })
    const cache = createOverviewCache({ path: PATH, fs, debounceMs: 60000 })
    storeSessions(fs, PATH, [savedRecord('a')])
    await cache.save([savedRecord('b')])
    assert.deepEqual([...(await cache.load(new Set(['a', 'b']))).sessions.keys()].sort(), ['a', 'b'])
    await cache.save([savedRecord('c')])
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()].sort(), ['a', 'b', 'c'])
    assert.deepEqual([...(await cache.load(new Set(['a']))).sessions.keys()], ['a'])
    await cache.flush()
    assert.deepEqual([...(await cache.load(new Set(['a', 'b', 'c']))).sessions.keys()].sort(), ['a', 'b', 'c'])
    const withoutMaterialization = sessionOf('incomplete')
    delete withoutMaterialization.materialization
    assert.equal(await cache.save([{ session: withoutMaterialization, identity: null }]), true)
    const defaults = createOverviewCache()
    defaults.dispose()
    cache.dispose()
  })
})

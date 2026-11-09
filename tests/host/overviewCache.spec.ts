import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import {
  OVERVIEW_CACHE_FILE,
  OVERVIEW_CACHE_FORMAT,
  createOverviewCache,
  identityKey,
  overviewCachePath,
  type CacheFs,
  type CachedSession,
  type DurableIdentity,
} from '../../src/host/overviewCache'
import type { HostSession } from '../../src/host/overviewCorpus'

interface WriteCounts {
  writes: number
  deletes: number
}

function sessionOf(id: string, options: { signature?: string; activity?: HostSession['activity']; timeline?: HostSession['timeline'] } = {}): HostSession {
  return {
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
        cost: { deepseek: { model: { off: { uncached: 10, cacheRead: 2, cacheWrite: 1, output: 5 } } } },
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
}

function identityOf(path: string, sizeBytes = 100, mtimeMs = 1_000): DurableIdentity {
  return { path, sizeBytes, mtimeMs }
}

interface FakeFs extends CacheFs {
  files: Map<string, string>
  stats: Map<string, { size: number; mtimeMs: number }>
  mkdirs: string[]
  renames: [string, string][]
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

function storeFile(fs: FakeFs, path: string, sessions: unknown, format: unknown = OVERVIEW_CACHE_FORMAT, savedAt = 1): void {
  fs.files.set(path, JSON.stringify({ format, savedAt, sessions }))
}

const PATH = '/home/.dsh/storages/dsh-context/overview-cache.v1.json'

describe('overviewCache', () => {
  test('resolves the cache path from DSH_HOME or the user home and hashes identities', () => {
    assert.equal(overviewCachePath({ DSH_HOME: '/data/dsh' }, '/home/user'), join('/data/dsh', 'storages', 'dsh-context', OVERVIEW_CACHE_FILE))
    assert.equal(overviewCachePath({ DSH_HOME: '   ' }, '/home/user'), join('/home/user', '.dsh', 'storages', 'dsh-context', OVERVIEW_CACHE_FILE))
    assert.equal(overviewCachePath({}, '/home/user'), join('/home/user', '.dsh', 'storages', 'dsh-context', OVERVIEW_CACHE_FILE))
    assert.equal(identityKey(null), '?')
    assert.equal(identityKey(undefined), '?')
    assert.equal(identityKey(identityOf('/a', 2, 3)), '/a\u00002\u00003')
  })

  test('a missing or malformed cache file reads as no records', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    for (const content of [
      'not json',
      JSON.stringify({ format: 2, savedAt: 0, sessions: [] }),
      JSON.stringify({ format: OVERVIEW_CACHE_FORMAT, savedAt: 0, sessions: 'nope' }),
      JSON.stringify([]),
      JSON.stringify(null),
    ]) {
      fs.files.set(PATH, content)
      const loaded = await cache.load(new Set(['a']))
      assert.deepEqual([...loaded.sessions.keys()], [])
      assert.deepEqual([...loaded.identities.keys()], [])
      assert.deepEqual([...loaded.rebuild], [])
    }
  })

  test('load rebuilds changed, missing, and unvalidatable records and reuses the unchanged ones', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, statConcurrency: 2 })
    storeFile(fs, PATH, [
      { session: 'junk' },
      { session: sessionOf('dropped-id'), identity: identityOf('/logs/dropped', 1, 1) },
      { session: sessionOf('bad-identity'), identity: 'nope' },
      { session: sessionOf('no-identity'), identity: null },
      { session: sessionOf('same'), identity: identityOf('/logs/same', 10, 100) },
      { session: sessionOf('changed'), identity: identityOf('/logs/changed', 10, 100) },
      { session: sessionOf('gone'), identity: identityOf('/logs/gone', 10, 100) },
    ])
    fs.stats.set('/logs/same', { size: 10, mtimeMs: 100 })
    fs.stats.set('/logs/changed', { size: 11, mtimeMs: 101 })
    const loaded = await cache.load(new Set(['bad-identity', 'no-identity', 'same', 'changed', 'gone']))
    assert.deepEqual([...loaded.sessions.keys()], ['same'])
    assert.equal(loaded.sessions.get('same')?.id, 'same')
    assert.deepEqual([...loaded.identities.keys()].sort(), ['changed', 'gone', 'no-identity', 'same'])
    assert.equal(loaded.identities.has('bad-identity'), false, 'a record with an invalid identity is dropped whole')
    assert.deepEqual(loaded.identities.get('changed'), { path: '/logs/changed', sizeBytes: 11, mtimeMs: 101 })
    assert.equal(loaded.identities.get('gone'), null)
    assert.equal(loaded.identities.get('no-identity'), null)
    assert.deepEqual([...loaded.rebuild].sort(), ['changed', 'gone', 'no-identity'])
  })

  test('load with known identities compares identity strings without touching the file system', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    storeFile(fs, PATH, [
      { session: sessionOf('same'), identity: identityOf('/logs/same', 10, 100) },
      { session: sessionOf('missing-in-known'), identity: identityOf('/logs/miss', 10, 100) },
      { session: sessionOf('known-null'), identity: identityOf('/logs/nulls', 10, 100) },
      { session: sessionOf('known-other'), identity: identityOf('/logs/other', 10, 100) },
    ])
    const known = new Map<string, DurableIdentity | null>([
      ['same', identityOf('/logs/same', 10, 100)],
      ['known-null', null],
      ['known-other', identityOf('/logs/other', 12, 120)],
    ])
    const loaded = await cache.load(new Set(['same', 'missing-in-known', 'known-null', 'known-other']), known)
    assert.deepEqual([...loaded.sessions.keys()], ['same'])
    assert.deepEqual([...loaded.rebuild].sort(), ['known-null', 'known-other', 'missing-in-known'])
    assert.deepEqual(loaded.identities.get('known-other'), identityOf('/logs/other', 12, 120))
    assert.equal(loaded.identities.get('missing-in-known'), null)
  })

  test('load drops sessions whose stored shape is not a valid host session', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    const timeline = sessionOf('full')
    storeFile(fs, PATH, [
      { session: { ...timeline, id: '' }, identity: identityOf('/logs/empty-id', 1, 1) },
      { session: { ...timeline, title: 7 }, identity: identityOf('/logs/bad-title', 1, 1) },
      { session: { ...timeline, updatedAt: 'soon' }, identity: identityOf('/logs/bad-time', 1, 1) },
      { session: { ...timeline, blank: 'no' }, identity: identityOf('/logs/bad-blank', 1, 1) },
      { session: { ...timeline, signature: 7 }, identity: identityOf('/logs/bad-sig', 1, 1) },
      { session: { ...timeline, timeline: 'junk', activity: 7 }, identity: identityOf('/logs/full', 1, 1) },
      { session: { ...timeline, cwd: 7, parentSession: 7, origin: 'fork' } },
      { session: 'junk', identity: identityOf('/logs/junk', 1, 1) },
      { session: { id: 'abs' }, identity: identityOf('/logs/abs', 1, 1) },
    ])
    fs.stats.set('/logs/full', { size: 1, mtimeMs: 1 })
    const loaded = await cache.load(new Set(['full', 'abs']))
    assert.deepEqual([...loaded.sessions.keys()], ['full'])
    assert.equal(loaded.sessions.get('full')?.timeline, null, 'a hostile timeline degrades to null')
    assert.equal(loaded.sessions.get('full')?.activity, null, 'a hostile activity ledger degrades to null')
  })

  test('refresh keeps equal identities, records changed ones, and treats stat failures as unvalidatable', async () => {
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
  })

  test('capture derives identities from the persistence snapshot plus a file stat', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, statConcurrency: 1 })
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
    for (const id of ['throws', 'junk', 'nopath', 'nosize', 'badsize', 'empty-path', 'nofile']) {
      assert.equal(captured.get(id), null, id)
    }
    const withoutStat = await cache.capture(['ok'], {})
    assert.deepEqual([...withoutStat.keys()], ['ok'])
    assert.equal(withoutStat.get('ok'), null)
    const empty = await cache.capture([], host)
    assert.equal(empty.size, 0)
  })

  test('save debounces one atomic write, flush forces it, and dispose writes the pending records', async () => {
    const fs = fakeFs()
    let clock = 0
    const cache = createOverviewCache({ path: PATH, fs, now: () => (clock += 1), debounceMs: 5 })
    cache.save([{ session: sessionOf('a'), identity: identityOf('/logs/a', 1, 1) }])
    cache.save([{ session: sessionOf('b'), identity: null }])
    assert.equal(fs.counts.writes, 0, 'the debounce has not fired yet')
    await cache.flush()
    assert.equal(fs.counts.writes, 1)
    assert.deepEqual(fs.renames.at(-1), [`${PATH}.tmp`, PATH])
    const body = JSON.parse(fs.files.get(PATH) ?? '{}') as { format: number; savedAt: number; sessions: CachedSession[] }
    assert.equal(body.format, OVERVIEW_CACHE_FORMAT)
    assert.equal(body.savedAt, 1)
    assert.deepEqual(body.sessions.map(record => record.session.id).sort(), ['a', 'b'], 'staged saves merge by session id')
    await cache.flush()
    assert.equal(fs.counts.writes, 1, 'flushing nothing writes nothing')
    cache.save([{ session: sessionOf('c'), identity: null }])
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(fs.counts.writes, 2, 'the debounce writes once for the latest records')
    cache.save([{ session: sessionOf('d'), identity: null }])
    cache.dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(JSON.parse(fs.files.get(PATH) ?? '{}').sessions.map((record: CachedSession) => record.session.id), ['d'])
    cache.dispose()
    cache.save([{ session: sessionOf('e'), identity: null }])
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.deepEqual(JSON.parse(fs.files.get(PATH) ?? '{}').sessions.map((record: CachedSession) => record.session.id), ['d'], 'a disposed cache writes nothing else')
  })

  test('write failures stay best-effort and clean the temporary file', async () => {
    for (const [label, configure] of [
      ['mkdir', (fs: FakeFs) => { fs.failMkdir = true }],
      ['write', (fs: FakeFs) => { fs.failWrite = true }],
      ['rename', (fs: FakeFs) => { fs.failRename = true }],
    ] as const) {
      const fs = fakeFs()
      configure(fs)
      const cache = createOverviewCache({ path: PATH, fs })
      cache.save([{ session: sessionOf('a'), identity: null }])
      await cache.flush()
      assert.equal(fs.files.has(PATH), false, label)
      if (label !== 'mkdir') assert.equal(fs.counts.deletes, fs.failWrite || fs.failRename ? 1 : 0)
      cache.dispose()
    }
    const fs = fakeFs()
    fs.stats.set('/logs/a', { size: 1, mtimeMs: 1 })
    storeFile(fs, PATH, [{ session: sessionOf('a'), identity: identityOf('/logs/a', 1, 1) }])
    const cache = createOverviewCache({ path: PATH, fs })
    const loaded = await cache.load(new Set(['a']))
    assert.deepEqual([...loaded.sessions.keys()], ['a'], 'a failed write never breaks a later load')
  })

  test('a real cache roundtrip persists and validates through the default node file system', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-overview-cache-'))
    const path = join(root, 'nested', 'overview-cache.v1.json')
    try {
      const cache = createOverviewCache({ path })
      cache.save([{ session: sessionOf('a'), identity: null }])
      await cache.flush()
      const loaded = await cache.load(new Set(['a']))
      assert.deepEqual([...loaded.sessions.keys()], [], 'a null identity record is never reusable')
      cache.dispose()
      const { stat, writeFile } = await import('node:fs/promises')
      const logPath = join(root, 'log.jsonl')
      await writeFile(logPath, 'first line')
      const logInfo = await stat(logPath)
      const identity = { path: logPath, sizeBytes: logInfo.size, mtimeMs: logInfo.mtimeMs }
      const warm = createOverviewCache({ path })
      warm.save([{ session: sessionOf('b'), identity }])
      await warm.flush()
      const warmLoaded = await warm.load(new Set(['b']))
      assert.deepEqual([...warmLoaded.sessions.keys()], ['b'], 'a real unchanged log validates through node fs.stat')
      warm.save([{ session: sessionOf('b'), identity }])
      await warm.flush()
      await writeFile(logPath, 'a longer second line')
      const changed = await warm.load(new Set(['b']))
      assert.deepEqual([...changed.sessions.keys()], [])
      assert.deepEqual([...changed.rebuild], ['b'])
      assert.ok((changed.identities.get('b')?.sizeBytes ?? 0) > identity.sizeBytes)
      warm.dispose()
      const target = join(root, 'occupied')
      await mkdir(target, { recursive: true })
      const failing = createOverviewCache({ path: target })
      failing.save([{ session: sessionOf('b'), identity: null }])
      await failing.flush()
      failing.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('parses the full host-session shape and degrades hostile members to null', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    const base = sessionOf('base')
    storeFile(fs, PATH, [
      { session: base, identity: identityOf('/logs/base', 1, 1) },
      { session: { ...base, id: 'minimal', timeline: { total: 1, turns: 0, current: null }, activity: null, cwd: '', parentSession: '', origin: 'fork' }, identity: identityOf('/logs/minimal', 1, 1) },
      { session: { ...base, id: 'hostile-current', timeline: { current: 'junk', total: 'x', turns: 'y', steps: 'z' }, activity: { days: 'junk' } }, identity: identityOf('/logs/hostile-current', 1, 1) },
      {
        session: {
          ...base,
          id: 'hostile-activity',
          timeline: null,
          activity: {
            days: {
              '2026-11-01': { tokens: 'x', requests: 1, cost: 'junk', turns: 'no', toolCalls: 2, toolsMs: null, skills: 'junk' },
              junk: 'nope',
              '2026-11-02': { tokens: 1, requests: 1, cost: { p: { m: { off: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } } },
            },
          },
        },
        identity: identityOf('/logs/hostile-activity', 1, 1),
      },
      {
        session: {
          ...base,
          id: 'junk-tallies',
          timeline: { current: { system: 1 }, total: 1, turns: 1, steps: 0, contextWindow: 'x', maxOutputTokens: null, model: '', lastUser: '', cost: 'junk', timing: { wallMs: 1 }, generatedReasoning: 'x' },
          activity: { days: { '2026-11-01': { tokens: 1, requests: 1, skills: { good: { n: 1, last: 2 }, bad: { n: 'x', last: 1 }, empty: {} }, tools: {}, cmds: 'junk' } } },
        },
        identity: identityOf('/logs/junk-tallies', 1, 1),
      },
      {
        session: {
          ...base,
          id: 'full-timing',
          timeline: { ...base.timeline, current: { system: 1, total: 2 }, timing: { ...base.timeline?.timing, reasoningMs: 'x', tools: { bash: { calls: 1, ms: 2 }, junk: {} } }, cost: { p: { m: { off: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } } } },
        },
        identity: identityOf('/logs/full-timing', 1, 1),
      },
      { session: { ...base, id: 'child', parentSession: 'parent', origin: 'subagent' }, identity: identityOf('/logs/child', 1, 1) },
      { session: base, identity: { path: '/logs/no-size' } },
      { session: base, identity: { path: '', sizeBytes: 1, mtimeMs: 1 } },
      { session: base, identity: { path: 7, sizeBytes: 1, mtimeMs: 1 } },
      { session: base, identity: { path: '/logs/no-mtime', sizeBytes: 1 } },
      null,
    ])
    for (const id of ['base', 'minimal', 'hostile-current', 'hostile-activity', 'junk-tallies', 'full-timing', 'child']) {
      fs.stats.set(`/logs/${id}`, { size: 1, mtimeMs: 1 })
    }
    const loaded = await cache.load(new Set(['base', 'minimal', 'hostile-current', 'hostile-activity', 'junk-tallies', 'full-timing', 'child']))
    const full = loaded.sessions.get('base')
    assert.ok(full !== undefined)
    assert.equal(full.timeline?.current?.assistantReasoning, 1)
    assert.equal(full.timeline?.timing?.reasoningMs, 5)
    assert.deepEqual(full.activity?.days['2026-11-01'].skills, { skill: { n: 1, last: 10 } })
    const minimal = loaded.sessions.get('minimal')
    assert.ok(minimal !== undefined)
    assert.equal(minimal.cwd, undefined)
    assert.equal(minimal.parentSession, undefined)
    assert.equal(minimal.origin, undefined)
    assert.equal(minimal.timeline?.current, null)
    assert.equal(minimal.activity, null)
    const hostileCurrent = loaded.sessions.get('hostile-current')
    assert.ok(hostileCurrent !== undefined)
    assert.equal(hostileCurrent.timeline?.total, 0)
    assert.equal(hostileCurrent.timeline?.turns, 0)
    assert.equal(hostileCurrent.activity, null)
    const hostileActivity = loaded.sessions.get('hostile-activity')
    assert.ok(hostileActivity !== undefined)
    assert.equal(hostileActivity.activity?.days['2026-11-01'].tokens, 0)
    assert.equal(hostileActivity.activity?.days['2026-11-01'].toolCalls, 2)
    assert.equal(hostileActivity.activity?.days['2026-11-01'].skills, undefined)
    assert.ok(hostileActivity.activity?.days['2026-11-02'].cost !== undefined)
    assert.equal(hostileActivity.timeline, null)
    const junkTallies = loaded.sessions.get('junk-tallies')
    assert.ok(junkTallies !== undefined)
    assert.ok(junkTallies.timeline !== null)
    assert.equal(junkTallies.timeline?.current?.system, 1)
    assert.equal(junkTallies.timeline?.steps, 0)
    assert.equal(junkTallies.timeline?.cost, undefined)
    assert.equal(junkTallies.timeline?.timing, undefined)
    assert.deepEqual(junkTallies.activity?.days['2026-11-01'].skills, { good: { n: 1, last: 2 } })
    assert.equal(junkTallies.activity?.days['2026-11-01'].tools, undefined)
    const fullTiming = loaded.sessions.get('full-timing')
    assert.ok(fullTiming !== undefined)
    assert.deepEqual(fullTiming.timeline?.timing?.tools.bash, { calls: 1, ms: 2 })
    assert.equal(fullTiming.timeline?.timing?.reasoningMs, undefined)
    assert.ok(fullTiming.timeline?.cost !== undefined)
    const child = loaded.sessions.get('child')
    assert.ok(child !== undefined)
    assert.equal(child.parentSession, 'parent')
    assert.equal(child.origin, 'subagent')
  })

  test('load with known identities compares the stored null identity against the known one', async () => {
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs, statConcurrency: 1 })
    storeFile(fs, PATH, [
      { session: sessionOf('stored-null'), identity: null },
      { session: sessionOf('vanished'), identity: identityOf('/logs/vanished', 1, 1) },
    ])
    const known = new Map<string, DurableIdentity | null>([
      ['stored-null', identityOf('/logs/stored-null', 1, 1)],
      ['vanished', identityOf('/logs/vanished', 1, 1)],
    ])
    const loaded = await cache.load(new Set(['stored-null', 'vanished']), known)
    assert.deepEqual([...loaded.sessions.keys()], ['vanished'], 'only the record whose identity matches the known one is reusable')
    assert.deepEqual([...loaded.rebuild], ['stored-null'])
    assert.deepEqual(loaded.identities.get('stored-null'), identityOf('/logs/stored-null', 1, 1))
    assert.deepEqual(loaded.identities.get('vanished'), identityOf('/logs/vanished', 1, 1))
  })

  test('an empty cache constructor and an empty refresh stay inert', async () => {
    const defaults = createOverviewCache()
    defaults.dispose()
    const fs = fakeFs()
    const cache = createOverviewCache({ path: PATH, fs })
    const refreshed = await cache.refresh(new Set(['a']), new Map())
    assert.equal(refreshed.identities.size, 0)
    assert.equal(refreshed.changed.size, 0)
  })

  test('a staged save is readable before the write debounce lands, and later saves merge by id', async () => {
    const fs = fakeFs()
    fs.stats.set('/logs/a', { size: 10, mtimeMs: 100 })
    fs.stats.set('/logs/b', { size: 20, mtimeMs: 200 })
    fs.stats.set('/logs/c', { size: 30, mtimeMs: 300 })
    const cache = createOverviewCache({ path: PATH, fs })
    storeFile(fs, PATH, [{ session: sessionOf('a'), identity: identityOf('/logs/a', 10, 100) }])
    cache.save([{ session: sessionOf('b'), identity: identityOf('/logs/b', 20, 200) }])
    const staged = await cache.load(new Set(['a', 'b']))
    assert.deepEqual([...staged.sessions.keys()].sort(), ['a', 'b'], 'the file row and the pending row both serve')
    cache.save([{ session: sessionOf('c'), identity: identityOf('/logs/c', 30, 300) }])
    const merged = await cache.load(new Set(['a', 'b', 'c']))
    assert.deepEqual([...merged.sessions.keys()].sort(), ['a', 'b', 'c'], 'a later save keeps the previously staged record')
    const narrowed = await cache.load(new Set(['a']))
    assert.deepEqual([...narrowed.sessions.keys()], ['a'], 'a staged record outside the requested ids stays staged')
    await cache.flush()
    const persisted = await cache.load(new Set(['b', 'c']))
    assert.deepEqual([...persisted.sessions.keys()].sort(), ['b', 'c'], 'the flush writes exactly the merged pending records')
  })
})

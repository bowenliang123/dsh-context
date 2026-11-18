import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { filesOf } from './hashing.mjs'

const args = process.argv.slice(2)
const option = (name: string): string => {
  const index = args.indexOf(`--${name}`)
  const value = index < 0 ? undefined : args[index + 1]
  if (value === undefined) throw new Error(`missing --${name}`)
  return value
}
const source = resolve(option('source'))
const fixture = resolve(option('fixture'))
const work = resolve(option('work'))
const output = resolve(option('output'))
const subsetSize = Number(process.env.DSH_BENCH_SUBSET ?? '64')
const parsed = JSON.parse(await readFile(fixture, 'utf8')) as { sessions?: unknown }
if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) throw new Error('fixture has no sessions')
const originalRecords = parsed.sessions as import('../../src/host/overviewCache').CachedSession[]
const ids = new Set(originalRecords.map(record => record.session.id))
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })
process.env.DSH_HOME = work
const sourceModule = await import(pathToFileURL(source).href) as typeof import('../../src/host/overviewCache')
const { createOverviewCache, OVERVIEW_CACHE_FORMAT } = sourceModule
const records = OVERVIEW_CACHE_FORMAT < 3 ? originalRecords : originalRecords.map((record) => {
  const session = record.session
  const materialization = session.materialization
  if (materialization === undefined) return record
  return {
    ...record,
    session: {
      ...session,
      materialization: {
        ...materialization,
        facts: {
          id: session.id,
          createdAt: session.updatedAt,
          ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
          ...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
          ...(session.origin === undefined ? {} : { origin: session.origin }),
        },
        signature: session.signature,
      },
    },
  }
})
for (const record of records) {
  if (record.identity === null) continue
  const info = await stat(record.identity.path)
  record.identity = { ...record.identity, sizeBytes: info.size, mtimeMs: info.mtimeMs }
}

interface Phase {
  reads: number
  readBytes: number
  writes: number
  writeBytes: number
  renames: number
  deletes: number
  stats: number
}

const phase = (): Phase => ({ reads: 0, readBytes: 0, writes: 0, writeBytes: 0, renames: 0, deletes: 0, stats: 0 })
let current = phase()
const fs = {
  stat: async (path: string) => {
    current.stats++
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  },
  readFile: async (path: string) => {
    const data = await readFile(path, 'utf8')
    current.reads++
    current.readBytes += Buffer.byteLength(data)
    return data
  },
  writeFile: async (path: string, data: string) => {
    await writeFile(path, data, 'utf8')
    current.writes++
    current.writeBytes += Buffer.byteLength(data)
  },
  rename: async (from: string, to: string) => {
    await rename(from, to)
    current.renames++
  },
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true })
  },
  rm: async (path: string) => {
    await rm(path, { force: true })
    current.deletes++
  },
}
const take = (): Phase => {
  const taken = current
  current = phase()
  return taken
}
const cache = createOverviewCache({ fs, debounceMs: 60000 })
const coldStarted = performance.now()
await cache.save(records, ids)
await cache.flush()
const cold = { ...take(), ms: performance.now() - coldStarted }
const warmStarted = performance.now()
const warmLoad = await cache.load(ids)
const warm = { ...take(), ms: performance.now() - warmStarted, sessions: warmLoad.sessions.size }
assert.equal(warmLoad.sessions.size, records.length)
const subset = new Set([...ids].slice(0, subsetSize))
const subsetStarted = performance.now()
const subsetLoad = await cache.load(subset)
const subsetReport = { ...take(), ms: performance.now() - subsetStarted, sessions: subsetLoad.sessions.size }
assert.equal(subsetLoad.sessions.size, subset.size)
const retained = new Set([...ids].filter((_, index) => index % 2 === 0))
const pruneStarted = performance.now()
await cache.save([], retained)
await cache.flush()
const prune = { ...take(), ms: performance.now() - pruneStarted }
const prunedLoad = await cache.load(retained)
assert.equal(prunedLoad.sessions.size, retained.size)
const pruneVerification = take()
const files = await filesOf(join(work, 'storages', 'dsh-context'), true)
const sizes = await Promise.all(files.map(async file => (await stat(file)).size))
const report = {
  source,
  fixture,
  records: records.length,
  cold,
  warm,
  subset: subsetReport,
  prune,
  pruneVerification,
  final: {
    files: files.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    maxFileBytes: Math.max(0, ...sizes),
  },
}
await cache.flush()
await cache.dispose()
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report)}\n`)

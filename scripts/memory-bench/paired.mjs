import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { hashFile, hashTree } from './hashing.mjs'
import { option } from './options.mjs'

const execFile = promisify(execFileCallback)
const v2 = resolve(option('v2', '.tmp/memory-bench/baseline-plugin/lib/index.js'))
const v3 = resolve(option('v3', '.tmp/memory-bench/candidate-plugin/lib/index.js'))
const corpus = resolve(option('corpus', '.tmp/memory-bench/corpus/corpus-smoke'))
const count = option('count', '64')
const pairs = Number(option('pairs', '7'))
const root = resolve(option('root', '.tmp/memory-bench/paired'))
const idleMs = option('idle-ms', '22000')
const baselineMetaPath = resolve(option('baseline-meta', '.tmp/memory-bench/baseline.json'))
const candidateMetaPath = resolve(option('candidate-meta', '.tmp/memory-bench/candidate.json'))
const runPath = fileURLToPath(new URL('run.mjs', import.meta.url))
const runner = (plugin, label, pair) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [runPath,
    '--plugin', plugin,
    '--corpus', corpus,
    '--count', count,
    '--root', resolve(root, 'raw'),
    '--label', `${label}-p${pair}`,
    '--pairs', '1',
    '--modes', 'pair',
    '--idle-ms', idleMs,
    '--corpus-sha256', corpusSha256,
    '--plugin-sha256', metadataByLabel[label].hostSha256,
    '--dsh-commit', dshCommit,
    '--config', JSON.stringify(metadataByLabel[label].config),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject)
  child.on('close', code => {
    if (code !== 0) {
      reject(new Error(`${label} pair ${pair} exited ${code}\n${stdout}\n${stderr}`))
      return
    }
    const manifest = resolve(root, 'raw', `${label}-p${pair}-summary.json`)
    resolveRun(readFile(manifest, 'utf8').then(JSON.parse))
  })
})

const baselineMeta = JSON.parse(await readFile(baselineMetaPath, 'utf8'))
const candidateMeta = JSON.parse(await readFile(candidateMetaPath, 'utf8'))
const dshRoot = resolve(option('dsh-root', '../deepseek-harness'))
const dshCommit = (await execFile('git', ['-C', dshRoot, 'rev-parse', 'HEAD'])).stdout.trim()
assert.equal(baselineMeta.node, process.version)
assert.equal(candidateMeta.node, process.version)
assert.equal(baselineMeta.dshCommit, dshCommit)
assert.equal(candidateMeta.dshCommit, dshCommit)
assert.equal(baselineMeta.hostSha256, await hashFile(v2))
assert.equal(candidateMeta.hostSha256, await hashFile(v3))
assert.equal(baselineMeta.clientSha256, await hashFile(resolve(v2, '../client.js')))
assert.equal(candidateMeta.clientSha256, await hashFile(resolve(v3, '../client.js')))
const corpusSha256 = (await hashTree(corpus)).sha256
assert.equal(baselineMeta.corpusSha256, corpusSha256)
assert.equal(candidateMeta.corpusSha256, corpusSha256)
assert.deepEqual(baselineMeta.config, candidateMeta.config)
const metadataByLabel = { v2: baselineMeta, v3: candidateMeta }

const samples = { v2: [], v3: [] }
const orders = []
await mkdir(root, { recursive: true })
for (let pair = 0; pair < pairs; pair++) {
  const order = pair % 2 === 0 ? ['v2', 'v3'] : ['v3', 'v2']
  orders.push(order)
  for (const label of order) {
    const plugin = label === 'v2' ? v2 : v3
    const report = await runner(plugin, label, pair)
    samples[label].push(...report.map(sample => ({ ...sample, pair })))
  }
}

const byMode = (label, mode) => samples[label].filter(sample => sample.mode === mode)
  .sort((left, right) => left.pair - right.pair).map(sample => sample.report)
for (const mode of ['cold', 'warm']) {
  const left = byMode('v2', mode)
  const right = byMode('v3', mode)
  assert.equal(left.length, pairs)
  assert.equal(right.length, pairs)
  for (let pair = 0; pair < pairs; pair++) {
    for (const [label, report] of [['v2', left[pair]], ['v3', right[pair]]]) {
      const metadata = metadataByLabel[label]
      assert.equal(report.node, process.version, `${mode} pair ${pair} ${label} node`)
      assert.equal(report.dshCommit, dshCommit, `${mode} pair ${pair} ${label} dsh commit`)
      assert.equal(report.pluginSha256, metadata.hostSha256, `${mode} pair ${pair} ${label} plugin hash`)
      assert.equal(report.corpusSha256, corpusSha256, `${mode} pair ${pair} ${label} corpus hash`)
      assert.deepEqual(report.config, metadata.config, `${mode} pair ${pair} ${label} config`)
    }
    assert.deepEqual(right[pair].semanticParts, left[pair].semanticParts, `${mode} pair ${pair} semantic mismatch`)
    assert.equal(right[pair].pageIdsSha256, left[pair].pageIdsSha256)
    assert.deepEqual(right[pair].coverage, left[pair].coverage)
    assert.deepEqual(right[pair].summary, left[pair].summary)
  }
}

const metrics = {
  firstCompleteOverviewMs: report => report.firstCompleteOverviewMs,
  peakWorkingSetBytes: report => report.peakWorkingSetBytes,
  activeRssBytes: report => report.activeMemory.rssBytes,
  activeHeapUsedBytes: report => report.activeMemory.heapUsedBytes,
  idleRssBytes: report => report.idleMemory.rssBytes,
  idleHeapUsedBytes: report => report.idleMemory.heapUsedBytes,
  eventLoopP95Ms: report => report.activeLoop.p95Ms,
  eventLoopP99Ms: report => report.activeLoop.p99Ms,
  eventLoopMaxMs: report => report.activeLoop.maxMs,
  headsMs: report => report.headsMs,
  snapshotMs: report => report.snapshotMs,
  cacheBytes: report => report.cache.bytes,
  maxCacheFileBytes: report => report.cache.maxFileBytes,
  pageMs: report => report.pageMs,
  bootMs: report => report.bootMs,
}
const median = values => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
const summarize = values => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
  values,
})
const cacheIoPath = fileURLToPath(new URL('cache-io.ts', import.meta.url))
const runCacheIo = async label => {
  const source = resolve(option(`${label}-source`, label === 'v2'
    ? '.tmp/memory-bench/baseline-src/host/overviewCache.ts'
    : 'src/host/overviewCache.ts'))
  const fixture = resolve(root, 'raw', `v2-p0-0-work/storages/dsh-context/overview-cache.v2.json`)
  const work = resolve(root, `${label}-cache-io-work`)
  const output = resolve(root, `${label}-cache-io.json`)
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm'
  const child = spawn(command, [...(process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : []),
    '--dir', dshRoot, 'exec', 'tsx', cacheIoPath,
    '--source', source, '--fixture', fixture, '--work', work, '--output', output], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolveExit => child.once('close', resolveExit))
  if (code !== 0) throw new Error(`${label} cache I/O failed\n${stdout}\n${stderr}`)
  const report = JSON.parse(await readFile(output, 'utf8'))
  return {
    ...report,
    writeAmplification: {
      cold: report.cold.writeBytes / report.final.bytes,
      prune: report.prune.writeBytes / report.final.bytes,
    },
  }
}

const result = { pairs, corpus, count, idleMs: Number(idleMs), orders, dshCommit, corpusSha256,
  baselineMetadata: baselineMeta, candidateMetadata: candidateMeta, modes: {}, io: {} }
result.io.v2 = await runCacheIo('v2')
result.io.v3 = await runCacheIo('v3')
for (const mode of ['cold', 'warm']) {
  const left = byMode('v2', mode)
  const right = byMode('v3', mode)
  const modeResult = { v2: {}, v3: {}, pairedDifference: {} }
  for (const [name, metric] of Object.entries(metrics)) {
    const leftValues = left.map(metric)
    const rightValues = right.map(metric)
    const differences = rightValues.map((value, index) => value - leftValues[index])
    modeResult.v2[name] = summarize(leftValues)
    modeResult.v3[name] = summarize(rightValues)
    modeResult.pairedDifference[name] = {
      ...summarize(differences),
      crossesZero: Math.min(...differences) <= 0 && Math.max(...differences) >= 0,
    }
  }
  result.modes[mode] = modeResult
}
await writeFile(resolve(root, 'paired-summary.json'), `${JSON.stringify(result, null, 2)}\n`)
for (const mode of ['cold', 'warm']) {
  for (const name of ['firstCompleteOverviewMs', 'peakWorkingSetBytes', 'idleRssBytes', 'idleHeapUsedBytes', 'cacheBytes']) {
    const metric = result.modes[mode]
    process.stdout.write(`${JSON.stringify({ mode, metric: name,
      v2Median: metric.v2[name].median,
      v3Median: metric.v3[name].median,
      differenceMedian: metric.pairedDifference[name].median,
      differenceRange: [metric.pairedDifference[name].min, metric.pairedDifference[name].max],
      crossesZero: metric.pairedDifference[name].crossesZero,
    })}\n`)
  }
}
process.stdout.write(`${resolve(root, 'paired-summary.json')}\n`)

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hashFile, hashTree } from './hashing.mjs'
import { option } from './options.mjs'

const execFile = promisify(execFileCallback)
const root = resolve(option('root', '.tmp/memory-bench'))
const dshRoot = resolve(option('dsh-root', '../deepseek-harness'))
const v2Source = resolve(option('v2', join(root, 'baseline-plugin')))
const v2SourceDir = resolve(option('v2-source', join(root, 'baseline-src')))
const v3Source = resolve(option('v3', '.'))
const count = Number(option('count', '1158'))
const smokeCount = Number(option('smoke-count', '64'))
const worker = resolve(dshRoot, 'benchmarks/.dsh-build/session-corpus/session-corpus.worker.js')
const corpusRoot = join(root, 'corpus')
const mainCorpus = join(corpusRoot, 'corpus-main')
const smokeCorpus = join(corpusRoot, 'corpus-smoke')

const run = async (command, args, cwd = process.cwd()) => {
  const result = await execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  return result.stdout.trim()
}

const freeze = async (source, destination, label, metadata) => {
  if (source !== destination) {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    for (const entry of ['lib', 'package.json', 'cordis.patch.yml', 'locale']) {
      await cp(join(source, entry), join(destination, entry), { recursive: true })
    }
  }
  const hostSha256 = await hashFile(join(destination, 'lib/index.js'))
  const clientSha256 = await hashFile(join(destination, 'lib/client.js'))
  const path = join(root, `${label}.json`)
  await writeFile(path, `${JSON.stringify({
    label,
    node: process.version,
    ...metadata,
    hostSha256,
    clientSha256,
    artifacts: relative(process.cwd(), destination).replaceAll('\\', '/'),
    inputHashes: relative(process.cwd(), join(root, 'input-hashes.sha256')).replaceAll('\\', '/'),
  }, null, 2)}\n`)
  return path
}

await stat(worker)
await rm(corpusRoot, { recursive: true, force: true })
await mkdir(corpusRoot, { recursive: true })
const anchors = await run(process.execPath, ['--expose-gc', worker, corpusRoot, 'anchors',
  ...Array.from({ length: 22 }, (_, index) => String(index))])
await writeFile(join(root, 'anchors.json'), `${anchors}\n`)
const seedMain = await run(process.execPath, ['--expose-gc', worker, corpusRoot, 'seed', 'main', String(count)])
const seedSmoke = await run(process.execPath, ['--expose-gc', worker, corpusRoot, 'seed', 'smoke', String(smokeCount)])
await writeFile(join(root, 'seed-main.json'), `${seedMain}\n`)
await writeFile(join(root, 'seed-smoke.json'), `${seedSmoke}\n`)
const mainHash = await hashTree(mainCorpus)
const smokeHash = await hashTree(smokeCorpus)
await writeFile(join(root, 'input-files.sha256'), `${mainHash.lines.join('\n')}\n`)
await writeFile(join(root, 'input-hashes.sha256'), `${createHash('sha256')
  .update(mainHash.lines.join('\n')).update(seedMain).update(seedSmoke).update(anchors).digest('hex')}\n`)
await writeFile(join(root, 'corpus-main.sha256'), `${mainHash.sha256}\n`)
await writeFile(join(root, 'corpus-smoke.sha256'), `${smokeHash.sha256}\n`)
const dshCommit = await run('git', ['-C', dshRoot, 'rev-parse', 'HEAD'])
const metadata = {
  dshCommit,
  corpusSha256: smokeHash.sha256,
  corpusMainSha256: mainHash.sha256,
  count,
  smokeCount,
  config: {
    workerChunkEvents: 2000,
    workerMinEvents: 30000,
    cacheShards: 64,
    maxPendingRecords: 256,
    maxPendingBytes: 8 * 1024 * 1024,
    capacityWaitMs: 5000,
    idleMs: 22000,
  },
}
if (v2SourceDir !== join(root, 'baseline-src')) {
  await rm(join(root, 'baseline-src'), { recursive: true, force: true })
  await cp(v2SourceDir, join(root, 'baseline-src'), { recursive: true })
}
const baseline = await freeze(v2Source, join(root, 'baseline-plugin'), 'baseline', metadata)
const candidate = await freeze(v3Source, join(root, 'candidate-plugin'), 'candidate', metadata)
await writeFile(join(root, 'prepare-summary.json'), `${JSON.stringify({ baseline, candidate, ...metadata }, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ baseline, candidate, ...metadata })}\n`)

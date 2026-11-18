import { spawn } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { option } from './options.mjs'

const plugin = resolve(option('plugin', 'lib/index.js'))
const corpus = resolve(option('corpus', '.tmp/memory-bench/corpus/corpus-main'))
const dshRoot = resolve(option('dsh-root', '../deepseek-harness'))
const root = resolve(option('root', '.tmp/memory-bench/runs'))
const label = option('label', 'run')
const count = option('count', '1158')
const pairs = Number(option('pairs', '1'))
const modes = option('modes', 'pair').split(',')
const idleMs = option('idle-ms', '22000')
const coverageTimeoutMs = option('coverage-timeout-ms', '900000')
const corpusSha256 = option('corpus-sha256', '')
const pluginSha256 = option('plugin-sha256', '')
const dshCommit = option('dsh-commit', '')
const benchConfig = option('config', '{}')
const debug = option('debug', '0')
const hostPath = fileURLToPath(new URL('host.mjs', import.meta.url))
const offlinePath = pathToFileURL(fileURLToPath(new URL('offline.mjs', import.meta.url))).href

const run = (mode, work, output) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, ['--expose-gc', '--import', offlinePath, hostPath], {
    env: {
      ...process.env,
      DSH_BENCH_DSH_ROOT: dshRoot,
      DSH_BENCH_CORPUS: corpus,
      DSH_BENCH_WORK: work,
      DSH_BENCH_PLUGIN: plugin,
      DSH_BENCH_COUNT: count,
      DSH_BENCH_MODE: mode,
      DSH_BENCH_IDLE_MS: idleMs,
      DSH_BENCH_COVERAGE_TIMEOUT_MS: coverageTimeoutMs,
      DSH_BENCH_CORPUS_SHA256: corpusSha256,
      DSH_BENCH_PLUGIN_SHA256: pluginSha256,
      DSH_BENCH_DSH_COMMIT: dshCommit,
      DSH_BENCH_CONFIG: benchConfig,
      DSH_BENCH_DEBUG: debug,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => {
    stderr += chunk
    if (debug === '1') process.stderr.write(chunk)
  })
  child.on('error', reject)
  child.on('close', code => {
    void (async () => {
      await writeFile(`${output}.stdout.log`, stdout)
      await writeFile(`${output}.stderr.log`, stderr)
      if (code !== 0) throw new Error(`${label} ${mode} exited ${code}\n${stdout}\n${stderr}`)
      const line = stdout.trim().split(/\r?\n/).reverse().find(value => value.startsWith('{'))
      if (line === undefined) throw new Error(`${label} ${mode} emitted no report\n${stdout}\n${stderr}`)
      const report = JSON.parse(line)
      report.label = label
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
      resolveRun(report)
    })().catch(reject)
  })
})

await mkdir(root, { recursive: true })
const summary = []
for (let pair = 0; pair < pairs; pair++) {
  const work = resolve(root, `${label}-${pair}-work`)
  for (const mode of modes) {
    const actualModes = mode === 'pair' ? ['cold', 'warm'] : [mode]
    for (const actualMode of actualModes) {
      const output = resolve(root, `${label}-${pair}-${actualMode}.json`)
      if (actualMode === 'cold') {
        await rm(work, { recursive: true, force: true })
        await mkdir(work, { recursive: true })
        await cp(resolve(corpus, 'storages'), resolve(work, 'projection-storages'), { recursive: true })
      }
      const report = await run(actualMode, work, output)
      summary.push({ pair, mode: actualMode, output, report })
      process.stdout.write(`${JSON.stringify({ label, pair, mode: actualMode,
        firstCompleteOverviewMs: report.firstCompleteOverviewMs,
        peakWorkingSetBytes: report.peakWorkingSetBytes,
        activeHeapUsedBytes: report.activeMemory.heapUsedBytes,
        idleHeapUsedBytes: report.idleMemory.heapUsedBytes,
        cacheBytes: report.cache.bytes,
      })}\n`)
    }
  }
}
const manifest = resolve(root, `${label}-summary.json`)
await writeFile(manifest, `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(`${manifest}\n`)

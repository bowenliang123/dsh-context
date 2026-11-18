import { spawn } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dshRoot = resolve(process.env.DSH_BENCH_DSH_ROOT ?? '../deepseek-harness')
const offlinePath = pathToFileURL(fileURLToPath(new URL('offline.mjs', import.meta.url))).href
const cliPath = resolve(dshRoot, 'apps/cli/lib/bin.js')

export async function startBenchmarkWeb({ plugin, corpus, work, port = '0', debug = false }) {
  const pluginRoot = resolve(plugin)
  const corpusRoot = resolve(corpus)
  const workRoot = resolve(work)
  const home = resolve(workRoot, 'home')
  const projection = resolve(workRoot, 'projection-storages')
  const profilePlugin = resolve(home, 'profiles/web/node_modules/dsh-context')
  await rm(workRoot, { recursive: true, force: true })
  await mkdir(profilePlugin, { recursive: true })
  await cp(pluginRoot, profilePlugin, { recursive: true })
  await cp(resolve(corpusRoot, 'storages'), projection, { recursive: true })
  const patch = [
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${JSON.stringify(resolve(corpusRoot, 'sessions'))}`,
    '    compression: zstd',
    '- id: storage-json',
    '  config:',
    `    root: ${JSON.stringify(projection)}`,
    '- id: deepseek-account',
    '  disabled: true',
    '- id: llm-deepseek-account',
    '  disabled: true',
    '- insert:',
    '    - id: dsh-context',
    '      name: dsh-context',
    '',
  ].join('\n')
  const patchPath = resolve(workRoot, 'benchmark.patch.yml')
  await writeFile(patchPath, patch)
  const child = spawn(process.execPath, [
    '--import', offlinePath,
    cliPath,
    '--profile', 'web',
    '--patch', patchPath,
    '--no-open',
    '--port', port,
  ], {
    cwd: workRoot,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (debug) process.stdout.write(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
    if (debug) process.stderr.write(chunk)
  })
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`dsh web did not announce a URL\n${stdout}\n${stderr}`))
    }, 120000)
    const check = () => {
      const match = stdout.match(/dsh web: (https?:\/\/\S+)/)
      if (match !== null) {
        clearTimeout(timeout)
        resolveUrl(match[1])
      }
    }
    child.stdout.on('data', check)
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`dsh web exited ${code}\n${stdout}\n${stderr}`))
    })
  })
  const stop = async () => {
    if (child.exitCode !== null) return
    child.kill()
    await new Promise(resolveStop => child.once('exit', resolveStop))
  }
  return { url, stop, work: workRoot, logs: () => ({ stdout, stderr }) }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(`--${name}`)
    if (index < 0) throw new Error(`missing --${name}`)
    return args[index + 1]
  }
  const server = await startBenchmarkWeb({
    plugin: option('plugin'),
    corpus: option('corpus'),
    work: option('work'),
    debug: true,
  })
  process.stdout.write(`${server.url}\n`)
  if (args.includes('--url-file')) {
    const index = args.indexOf('--url-file')
    await writeFile(resolve(args[index + 1]), `${server.url}\n`)
  }
  const stop = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

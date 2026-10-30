import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPids, supervise, terminatePids } from './proc.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsdownEntry = path.join(root, 'node_modules', 'tsdown', 'dist', 'run.mjs')

if (!existsSync(tsdownEntry)) {
  console.error('tsdown is not installed; run pnpm install first')
  process.exit(1)
}

const separator = '[\\\\/]'
const trimmedRoot = root.replace(/[\\/]+$/, '')
const rootParts = trimmedRoot
  .split(/[\\/]+/)
  .filter(Boolean)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const rootPattern = `${trimmedRoot.startsWith('/') && rootParts.length > 0 ? separator : ''}${rootParts.join(separator)}`
const pattern = `${rootPattern}${separator}node_modules${separator}(\\.bin${separator}\\.\\.${separator})?tsdown${separator}dist${separator}run\\.mjs"? --watch`

let stale = []
try {
  stale = findPids(pattern).filter(pid => pid !== process.pid)
} catch (error) {
  console.warn(`warning: could not scan for stale watch instances: ${error.message}`)
}
for (const pid of stale) console.log(`killing stale watch (pid ${pid})`)
await terminatePids(stale)

const WATCH_HEAP_MB = 192
const nodeOptions = `--expose-gc --max-old-space-size=${WATCH_HEAP_MB}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`
const child = spawn(process.execPath, [tsdownEntry, '--watch'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DSH_CTX_WATCH: '1', NODE_OPTIONS: nodeOptions },
})
supervise(child)

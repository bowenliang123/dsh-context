import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { supervise } from './proc.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [script, ...args] = process.argv.slice(2)

if (!script) {
  console.error('usage: node scripts/run-bash.mjs <script> [args...]')
  process.exit(1)
}

function gitRoots() {
  const roots = []
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    roots.push(
      path.resolve(execPath, '..', '..', '..'),
      path.resolve(execPath, '..', '..'),
    )
  } catch {}
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
    if (base) roots.push(path.join(base, 'Git'))
  }
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'))
  return roots
}

function resolveBash() {
  if (process.env.DSH_CTX_BASH) return process.env.DSH_CTX_BASH
  if (process.platform !== 'win32') return 'bash'
  for (const gitRoot of gitRoots()) {
    for (const candidate of [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const bash = resolveBash()
if (!bash) {
  console.error('Git Bash was not found. Install Git for Windows, or set DSH_CTX_BASH to bash.exe.')
  process.exit(1)
}

const target = path.resolve(root, script).split(path.sep).join('/')
const child = spawn(bash, [target, ...args], { cwd: root, stdio: 'inherit', env: process.env })
supervise(child)

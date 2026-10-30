import { execFileSync } from 'node:child_process'
import path from 'node:path'

function parsePids(output) {
  return output
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}

function windowsPids(pattern) {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const command = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $env:DSH_CTX_PROC_PATTERN } | ForEach-Object { $_.ProcessId }"
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CTX_PROC_PATTERN: pattern },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return parsePids(output)
}

function unixPids(pattern) {
  try {
    return parsePids(execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch (error) {
    if (error.status === 1) return []
    if (error.code !== 'ENOENT') throw error
  }
  const matcher = new RegExp(pattern)
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split(/\r?\n/)
    .flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      return match && matcher.test(match[2]) ? [Number(match[1])] : []
    })
}

export function findPids(pattern) {
  return process.platform === 'win32' ? windowsPids(pattern) : unixPids(pattern)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function terminate(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

export async function terminatePids(pids) {
  for (const pid of pids) terminate(pid)
  if (process.platform === 'win32' || pids.length === 0) return
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (const pid of pids.filter(isAlive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

export function supervise(child) {
  let running = true
  const stop = () => {
    if (running && child.pid) terminate(child.pid)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
  process.on('exit', stop)
  child.on('exit', code => {
    running = false
    process.exitCode = code ?? 1
  })
  child.on('error', error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

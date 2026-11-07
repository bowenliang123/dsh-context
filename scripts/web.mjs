import { spawn } from 'node:child_process'
import { ancestorPids, findPids, supervise, terminatePids } from './proc.mjs'

const pattern = process.platform === 'win32' ? 'dsh web|@deepseek-ai[\\\\/]dsh[\\\\/].* web' : 'dsh web'

let pids = []
try {
  pids = findPids(pattern)
} catch (error) {
  console.warn(`warning: could not scan for a running dsh web: ${error.message}`)
}
const ownPids = ancestorPids()
const hosting = pids.filter(pid => ownPids.has(pid))
if (hosting.length > 0) {
  console.error(`refusing to replace the running dsh web (pid: ${hosting.join(' ')}): it is this process's own ancestor, so it hosts the session that launched this command. Restart it from outside the session.`)
  process.exit(1)
}
const stale = pids.filter(pid => !ownPids.has(pid))
if (stale.length > 0) {
  console.log(`killing existing dsh web (pid: ${stale.join(' ')})`)
  await terminatePids(stale)
}

const [command, args] = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh web --no-open']]
  : ['dsh', ['web', '--no-open']]
const child = spawn(command, args, { stdio: 'inherit' })
supervise(child)

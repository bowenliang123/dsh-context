import { spawn } from 'node:child_process'
import { findPids, supervise, terminatePids } from './proc.mjs'

const pattern = process.platform === 'win32' ? 'dsh web|@deepseek-ai[\\\\/]dsh[\\\\/].* web' : 'dsh web'

let pids = []
try {
  pids = findPids(pattern).filter(pid => pid !== process.pid)
} catch (error) {
  console.warn(`warning: could not scan for a running dsh web: ${error.message}`)
}
if (pids.length > 0) {
  console.log(`killing existing dsh web (pid: ${pids.join(' ')})`)
  await terminatePids(pids)
}

const [command, args] = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh web --no-open']]
  : ['dsh', ['web', '--no-open']]
const child = spawn(command, args, { stdio: 'inherit' })
supervise(child)

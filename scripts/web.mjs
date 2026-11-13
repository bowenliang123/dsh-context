import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ancestorPids, findPids, supervise, terminatePids } from './proc.mjs'

const tmpDir = new URL('../.tmp/', import.meta.url)
const urlFile = new URL('dsh-web-url.txt', tmpDir)
const urlPattern = /^dsh web: (https?:\/\/\S+)/u
const maxPendingLength = 65_536

const removeUrl = () => {
  try {
    rmSync(urlFile, { force: true })
  } catch (error) {
    console.warn(`warning: could not remove the dsh web URL: ${error.message}`)
  }
}

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

removeUrl()

let pending = ''
let announced = false
const capture = chunk => {
  const lines = (pending + chunk).split('\n')
  pending = lines.pop() ?? ''
  if (pending.length > maxPendingLength) pending = ''
  for (const line of lines) {
    const match = line.trim().match(urlPattern)
    if (!match) continue
    try {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(urlFile, `${match[1]}\n`)
      announced = true
    } catch (error) {
      console.warn(`warning: could not save the dsh web URL: ${error.message}`)
    }
  }
}

const [command, args] = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh web --no-open']]
  : ['dsh', ['web', '--no-open']]
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'] })
child.stdout.setEncoding('utf8')
child.stdout.pipe(process.stdout, { end: false })
child.stdout.on('data', capture)
child.on('exit', () => {
  child.stdout.destroy()
  removeUrl()
  if (!announced) console.warn('warning: dsh web printed no URL; .tmp/dsh-web-url.txt was not written')
})
supervise(child)

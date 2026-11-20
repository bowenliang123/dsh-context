import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const tmpDir = new URL('../.tmp/', import.meta.url)

const statePath = name => new URL(name, tmpDir)

export const statePid = name => {
  try {
    const match = /^pid:\s*([1-9]\d*)\s*$/u.exec(readFileSync(statePath(name), 'utf8').split('\n')[0])
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

const formatStartTime = at => {
  const pad = value => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export const stateHeader = (pid, startedAt) => `pid: ${pid}\nstart time: ${formatStartTime(startedAt)}\n`

export const writeState = (name, content) => {
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(statePath(name), content)
    return true
  } catch (error) {
    console.warn(`warning: could not save .tmp/${name}: ${error.message}`)
    return false
  }
}

export const removeState = name => {
  try {
    rmSync(statePath(name), { force: true })
  } catch (error) {
    console.warn(`warning: could not remove .tmp/${name}: ${error.message}`)
  }
}

export const removeOwnState = (name, pid) => {
  if (pid !== undefined && statePid(name) === pid) removeState(name)
}

export const cleanStateOnSignal = (name, pid) => {
  const cleanup = () => removeOwnState(name, pid)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, cleanup)
  return cleanup
}

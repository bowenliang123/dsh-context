import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const tmpDir = new URL('../.tmp/', import.meta.url)

const statePath = name => new URL(name, tmpDir)

export const statePid = name => {
  try {
    const pid = Number(readFileSync(statePath(name), 'utf8').split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

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

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const filesOf = async (root, allowMissing = false) => {
  const files = []
  const visit = async path => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  await visit(root)
  return files.sort()
}

export const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex')

export const hashTree = async root => {
  const hash = createHash('sha256')
  const lines = []
  for (const path of await filesOf(root)) {
    const digest = await hashFile(path)
    const name = relative(root, path).replaceAll('\\', '/')
    hash.update(name)
    hash.update('\u0000')
    hash.update(digest)
    hash.update('\n')
    lines.push(`${digest}  ${name}`)
  }
  return { sha256: hash.digest('hex'), lines }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function storagePathOf(
  file: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh')
  return join(root, 'storages', 'dsh-context', file)
}

export interface AtomicFs {
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export const NODE_ATOMIC_FS: AtomicFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
}

export async function writeFileAtomic(fs: AtomicFs, path: string, data: string): Promise<void> {
  const temporary = `${path}.tmp`
  await fs.mkdir(dirname(path))
  await fs.writeFile(temporary, data)
  await fs.rename(temporary, path)
}

export interface FileIo {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
}

export const NODE_FILE_IO: FileIo = {
  read: path => readFile(path, 'utf8'),
  write: (path, data) => writeFileAtomic(NODE_ATOMIC_FS, path, data),
}

import type { FileIo } from '../../../src/host/storage'

export interface FakeCacheIo extends FileIo {
  files: Map<string, string>
  reads: number
  writes: number
  failRead: boolean
  failWrite: boolean
}

export function cacheIoOf(): FakeCacheIo {
  const state: FakeCacheIo = {
    files: new Map<string, string>(),
    reads: 0,
    writes: 0,
    failRead: false,
    failWrite: false,
    async read(path: string): Promise<string> {
      state.reads++
      if (state.failRead) throw new Error('read failed')
      const body = state.files.get(path)
      if (body === undefined) throw new Error(`missing ${path}`)
      return body
    },
    async write(path: string, data: string): Promise<void> {
      state.writes++
      if (state.failWrite) throw new Error('write failed')
      state.files.set(path, data)
    },
  }
  return state
}

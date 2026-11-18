import { getHeapStatistics } from 'node:v8'

export interface HeapReading {
  used: number
  limit: number
}

export interface ColdReadOptions {
  priority?: 'foreground' | 'background'
}

export interface ColdReadGate {
  admit<T>(read: () => Promise<T>, options?: ColdReadOptions): Promise<T | undefined>
}

interface ColdReadJob {
  read: () => Promise<unknown>
  priority: 'foreground' | 'background'
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const HIGH_WATER = 2 / 3

const MAX_WAITING_READS = 64

function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  const queue: ColdReadJob[] = []
  let running = false
  const pump = (): void => {
    if (running || queue.length === 0) return
    running = true
    const foreground = queue.findIndex(job => job.priority === 'foreground')
    const [job] = queue.splice(foreground < 0 ? 0 : foreground, 1)
    void (async () => {
      try {
        job.resolve(clear() ? await job.read() : undefined)
      } catch (error) {
        job.reject(error)
      } finally {
        running = false
        pump()
      }
    })()
  }
  return {
    admit<T>(read: () => Promise<T>, options: ColdReadOptions = {}): Promise<T | undefined> {
      return new Promise<T | undefined>((resolve, reject) => {
        if (queue.length >= MAX_WAITING_READS) {
          resolve(undefined)
          return
        }
        queue.push({
          read,
          priority: options.priority ?? 'foreground',
          resolve: (value) => { resolve(value as T | undefined) },
          reject,
        })
        pump()
      })
    },
  }
}

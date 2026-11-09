import type { Worker } from 'node:worker_threads'
import type { Config } from '../../../src/host/config'
import { createFoldPool, startFoldWorkerChannel, type FoldedOverview, type FoldPool, type FoldPort } from '../../../src/host/foldWorker'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type { FoldedOverview, FoldPool }

export interface FakeWorker {
  on(event: string, handler: (...args: unknown[]) => void): unknown
  postMessage(message: unknown): void
  terminate(): Promise<number>
  emit(event: string, ...args: unknown[]): void
}

function foldPortPair(): [FoldPort, FoldPort, (message: unknown) => void, Map<string, ((message: unknown) => void)[]>] {
  const clientEvents = new Map<string, ((message: unknown) => void)[]>()
  const workerEvents = new Map<string, ((message: unknown) => void)[]>()
  const register = (map: Map<string, ((message: unknown) => void)[]>, event: string, handler: unknown): unknown => {
    const handlers = map.get(event) ?? []
    handlers.push(handler as (message: unknown) => void)
    map.set(event, handlers)
    return undefined
  }
  const deliver = (map: Map<string, ((message: unknown) => void)[]>, message: unknown): void => {
    for (const handler of map.get('message') ?? []) queueMicrotask(() => handler(message))
  }
  const client = {
    on: (event: string, handler: unknown) => register(clientEvents, event, handler),
    postMessage: (message: unknown) => { deliver(workerEvents, message) },
  } as unknown as FoldPort
  const worker = {
    on: (event: string, handler: unknown) => register(workerEvents, event, handler),
    postMessage: (message: unknown) => { deliver(clientEvents, message) },
  } as unknown as FoldPort
  return [client, worker, (message: unknown) => { deliver(workerEvents, message) }, clientEvents]
}

export function inProcessPool(overrides: { terminate?: () => Promise<number> } = {}): FoldPool & { worker: FakeWorker; sendToWorker(message: unknown): void; dispose(): void } {
  const [client, workerSide, inject, clientEvents] = foldPortPair()
  startFoldWorkerChannel(workerSide)
  const fakeWorker = {
    on: (event: string, handler: (...args: unknown[]) => void) => client.on(event, handler),
    postMessage: (message: unknown) => { client.postMessage(message) },
    terminate: overrides.terminate ?? (async () => 0),
    emit: (event: string, ...args: unknown[]): void => {
      for (const handler of clientEvents.get(event) ?? []) handler(args.length > 1 ? args : args[0])
    },
  }
  const pool = createFoldPool(() => fakeWorker as unknown as Worker) as FoldPool & { worker: FakeWorker; sendToWorker(message: unknown): void; dispose(): void }
  pool.worker = fakeWorker as unknown as FakeWorker
  pool.sendToWorker = (message: unknown) => { inject(message) }
  return pool
}

export async function foldInProcess(
  config: Config,
  events: readonly SessionEvent[],
): Promise<FoldedOverview> {
  const pool = inProcessPool()
  try {
    return await pool.fold(config, events)
  } finally {
    pool.dispose()
  }
}

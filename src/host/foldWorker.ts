import { fileURLToPath } from 'node:url'
import { parentPort, Worker, type MessagePort } from 'node:worker_threads'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config'
import type { ActivityState } from './activity'
import { createContextActivityDefinition } from './activity'
import type { WiredProjection } from './projection'
import { asRecord } from './record'
import type { TimelineState } from './foldState'
import { createContextTimelineDefinition } from './timeline'

export interface FoldedOverview {
  timeline: unknown
  activity: unknown
  lastPromptAt: number
  blank: boolean
  title?: string
}

export interface FoldPool {
  fold(config: Config, events: readonly SessionEvent[]): Promise<FoldedOverview>
  dispose(): void
}

const WORKER_CHUNK_EVENTS = 2_000

const FOLD_WORKER_BOOTSTRAP = `
const { pathToFileURL } = require('node:url')
const { parentPort, workerData } = require('node:worker_threads')
import(pathToFileURL(workerData.entry).href)
  .then(module => module.startFoldWorkerChannel())
  .catch(error => parentPort.postMessage({ kind: 'failed', message: String((error && error.message) || error) }))
`

type TimelineDef = WiredProjection<'contextTimeline', TimelineState>
type ActivityDef = WiredProjection<'contextActivity', ActivityState>

class OverviewFolder {
  private readonly timeline: TimelineDef
  private readonly activity: ActivityDef
  private timelineState: TimelineState
  private activityState: ActivityState
  private lastPromptAt = 0
  private blank = true
  private title: string | null = null

  constructor(config: Config) {
    this.timeline = createContextTimelineDefinition(config, () => true)
    this.activity = createContextActivityDefinition()
    this.timelineState = this.timeline.init()
    this.activityState = this.activity.init()
  }

  apply(events: readonly SessionEvent[]): void {
    for (const event of events) {
      this.timelineState = this.timeline.apply(this.timelineState, event)
      this.activityState = this.activity.apply(this.activityState, event)
      const eventType: string = event.type
      const data = asRecord((event as { data?: unknown }).data)
      if (eventType === 'turn/start') this.blank = false
      if (eventType === 'session/title') {
        const title = data?.title
        if (typeof title === 'string' && title !== '') this.title = title
      }
      const source = asRecord(data?.source)
      if (eventType === 'user/message' && source?.kind === 'user'
        && typeof event.time === 'number' && Number.isFinite(event.time)) {
        this.lastPromptAt = event.time
      }
    }
  }

  end(): FoldedOverview {
    return {
      timeline: this.timeline.wire.viewSchema.parse(this.timeline.wire.view(this.timelineState)),
      activity: this.activity.wire.viewSchema.parse(this.activity.wire.view(this.activityState)),
      lastPromptAt: this.lastPromptAt,
      blank: this.blank,
      ...(this.title === null ? {} : { title: this.title }),
    }
  }
}

export type FoldPort = Pick<MessagePort, 'on' | 'postMessage'>

export function startFoldWorkerChannel(port: FoldPort | null = parentPort): void {
  if (port === null) return
  let folder: OverviewFolder | null = null
  port.on('message', (message: unknown) => {
    const data = asRecord(message)
    if (data === null) return
    try {
      if (data.kind === 'begin') {
        folder = new OverviewFolder(asRecord(data.config) ?? {})
      } else if (data.kind === 'chunk' && folder !== null && Array.isArray(data.events)) {
        folder.apply(data.events as SessionEvent[])
        port.postMessage({ kind: 'ack' })
      } else if (data.kind === 'end' && folder !== null) {
        const done = folder.end()
        folder = null
        port.postMessage({ kind: 'done', ...done })
      }
    } catch (error) {
      folder = null
      port.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  })
}

interface PendingFold {
  config: Config
  events: readonly SessionEvent[]
  resolve: (value: FoldedOverview) => void
  reject: (error: Error) => void
}

interface FoldPoolOptions {
  maxQueue?: number
  idleMs?: number
}

function spawnFoldWorker(): Worker {
  return new Worker(FOLD_WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { entry: fileURLToPath(new URL('./index.js', import.meta.url)) },
  })
}

export function createFoldPool(spawnWorker: () => Worker = spawnFoldWorker, options: FoldPoolOptions = {}): FoldPool {
  const maxQueue = options.maxQueue ?? 32
  const idleMs = options.idleMs ?? 20_000
  const wired = new WeakSet<Worker>()
  let worker: Worker | null = null
  let pending: PendingFold | null = null
  let queue: PendingFold[] = []
  let offset = 0
  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const clearIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }

  const scheduleIdle = (): void => {
    clearIdle()
    if (disposed || worker === null || pending !== null || queue.length > 0 || idleMs < 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      const active = worker as Worker
      worker = null
      void active.terminate().catch(() => {})
    }, idleMs)
    ;(idleTimer as { unref?: () => void }).unref?.()
  }

  const sendNext = (): void => {
    const current = pending
    const active = worker
    if (current === null || active === null) return
    try {
      if (offset >= current.events.length) {
        active.postMessage({ kind: 'end' })
        return
      }
      active.postMessage({ kind: 'chunk', events: current.events.slice(offset, offset + WORKER_CHUNK_EVENTS) })
      offset += WORKER_CHUNK_EVENTS
    } catch (error) {
      failCurrent(error instanceof Error ? error : new Error(String(error)), active)
    }
  }

  const pump = (): void => {
    if (disposed || pending !== null) return
    if (queue.length === 0) {
      scheduleIdle()
      return
    }
    clearIdle()
    pending = queue.splice(0, 1)[0]
    offset = 0
    try {
      const active = ensure()
      active.postMessage({ kind: 'begin', config: pending.config })
      sendNext()
    } catch (error) {
      failCurrent(error instanceof Error ? error : new Error(String(error)), worker)
    }
  }

  const failCurrent = (error: Error, failed: Worker | null): void => {
    clearIdle()
    const current = pending
    pending = null
    worker = null
    current?.reject(error)
    if (failed !== null) void failed.terminate().catch(() => {})
    pump()
  }

  const fail = (error: Error, failed: Worker): void => {
    if (worker !== failed) return
    failCurrent(error, failed)
  }

  const wire = (next: Worker): void => {
    if (wired.has(next)) return
    wired.add(next)
    next.on('message', (message: unknown) => {
      if (worker !== next) return
      const data = asRecord(message)
      if (data === null) return
      if (data.kind === 'failed') {
        fail(new Error(typeof data.message === 'string' ? data.message : 'fold worker failed'), next)
        return
      }
      if (data.kind === 'ack') {
        sendNext()
        return
      }
      if (data.kind !== 'done' || pending === null) return
      const current = pending
      pending = null
      current.resolve({
        timeline: data.timeline,
        activity: data.activity,
        lastPromptAt: typeof data.lastPromptAt === 'number' && Number.isFinite(data.lastPromptAt) ? data.lastPromptAt : 0,
        blank: data.blank === true,
        ...(typeof data.title === 'string' && data.title !== '' ? { title: data.title } : {}),
      })
      pump()
    })
    next.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)), next)
    })
    next.on('exit', () => {
      if (worker !== next) return
      failCurrent(new Error('fold worker exited'), next)
    })
  }

  const ensure = (): Worker => {
    if (worker !== null) return worker
    const next = spawnWorker()
    worker = next
    wire(next)
    return next
  }

  return {
    fold: (config, events) => new Promise<FoldedOverview>((resolve, reject) => {
      if (disposed) {
        reject(new Error('fold worker disposed'))
        return
      }
      if (queue.length >= maxQueue) {
        reject(new Error('fold worker queue is full'))
        return
      }
      queue.push({ config, events, resolve, reject })
      pump()
    }),
    dispose: () => {
      if (disposed) return
      disposed = true
      clearIdle()
      const active = pending
      pending = null
      active?.reject(new Error('fold worker disposed'))
      for (const job of queue) job.reject(new Error('fold worker disposed'))
      queue = []
      const current = worker
      worker = null
      if (current !== null) void current.terminate().catch(() => {})
    },
  }
}

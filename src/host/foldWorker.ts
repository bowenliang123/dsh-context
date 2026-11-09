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
  private prompted = false

  constructor(config: Config) {
    this.timeline = createContextTimelineDefinition(config, () => false)
    this.activity = createContextActivityDefinition()
    this.timelineState = this.timeline.init()
    this.activityState = this.activity.init()
  }

  apply(events: readonly SessionEvent[]): void {
    for (const event of events) {
      this.timelineState = this.timeline.apply(this.timelineState, event)
      this.activityState = this.activity.apply(this.activityState, event)
      if (event.type === 'user/message' && typeof event.time === 'number' && event.time > this.lastPromptAt) {
        this.lastPromptAt = event.time
        this.prompted = true
      }
    }
  }

  end(): FoldedOverview {
    return {
      timeline: this.timeline.wire.viewSchema.parse(this.timeline.wire.view(this.timelineState)),
      activity: this.activity.wire.viewSchema.parse(this.activity.wire.view(this.activityState)),
      lastPromptAt: this.lastPromptAt,
      blank: !this.prompted,
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
  resolve: (value: FoldedOverview) => void
  reject: (error: Error) => void
}

function spawnFoldWorker(): Worker {
  return new Worker(FOLD_WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { entry: fileURLToPath(new URL('./index.js', import.meta.url)) },
  })
}

export function createFoldPool(spawnWorker: () => Worker = spawnFoldWorker): FoldPool {
  let worker: Worker | null = null
  let pending: PendingFold | null = null
  const fail = (error: Error): void => {
    const current = pending
    pending = null
    worker = null
    current?.reject(error)
  }
  const wire = (next: Worker): void => {
    next.on('message', (message: unknown) => {
      const data = asRecord(message)
      if (data === null) return
      if (data.kind === 'failed') {
        fail(new Error(typeof data.message === 'string' ? data.message : 'fold worker failed'))
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
      })
    })
    next.on('error', (error) => { fail(error instanceof Error ? error : new Error(String(error))) })
    next.on('exit', () => {
      const wasPending = pending !== null
      worker = null
      if (wasPending) fail(new Error('fold worker exited'))
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
      if (pending !== null) {
        reject(new Error('fold worker is busy'))
        return
      }
      pending = { resolve, reject }
      const active = ensure()
      active.postMessage({ kind: 'begin', config })
      for (let start = 0; start < events.length; start += WORKER_CHUNK_EVENTS) {
        active.postMessage({ kind: 'chunk', events: events.slice(start, start + WORKER_CHUNK_EVENTS) })
      }
      active.postMessage({ kind: 'end' })
    }),
    dispose: () => {
      if (pending !== null) {
        const current = pending
        pending = null
        current.reject(new Error('fold worker disposed'))
      }
      void worker?.terminate().catch(() => {})
      worker = null
    },
  }
}

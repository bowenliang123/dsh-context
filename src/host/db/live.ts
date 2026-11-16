import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { FoldBounds } from '../config'
import { applyTimeline } from '../fold'
import { createTimelineState } from '../foldState'
import type { TimelineEvent, TimelineState } from '../foldState'
import { asRecord } from '../record'
import { admissionRows, admitRows } from './admission'
import type { Db } from './db'
import { bumpGeneration, setMeta } from './db'
import { applyFoldEvents, decodeStateJson, writeSessionFold, deleteSessionChildRows } from './foldSession'
import { RowsSink, writeBatch } from './rows'
import { foldState, sessions } from './schema'
import { eq } from 'drizzle-orm'

const LIVE_BUFFER_MAX = 4_096

const LIVE_EVENT_FLUSH = 200

const LIVE_DEBOUNCE_MS = 2_000

const LIVE_ENTRIES_MAX = 64

interface SessionLike {
  id: unknown
  header?: unknown
}

interface ObserveFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

interface LiveEntry {
  header: SessionHeader
  state: TimelineState | null
  stateSeq: number
  buffer: TimelineEvent[]
  seed: Promise<void> | null
  sink: RowsSink
  timer: ReturnType<typeof setTimeout> | null
  pendingRows: number
  touched: number
  writtenSeq: number
}

export interface LiveOptions {
  observe?: () => ObserveFace | undefined
  pluginOf?: (name: string) => string | undefined
  debounceMs?: number
  eventFlush?: number
  entriesMax?: number
  bufferMax?: number
  onFlush?: () => void
}

function isEvent(value: unknown): value is TimelineEvent {
  return value !== null && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

function seqOf(event: TimelineEvent): number {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
}

export class LiveWriter {
  private readonly entries = new Map<string, LiveEntry>()
  private tick = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly db: Db,
    private readonly bounds: FoldBounds,
    private readonly options: LiveOptions = {},
  ) {
    ctx.on('session/created', (session: SessionLike) => {
      if (this.disposed) return
      if (typeof session.id === 'string') this.admit(session.id, session.header)
    })
    ctx.on('session/event', (session: SessionLike, event: unknown) => {
      if (this.disposed) return
      if (typeof session.id === 'string' && isEvent(event)) this.advance(session.id, event, session.header)
    })
    ctx.on('session/disposed', (session: SessionLike) => {
      if (this.disposed) return
      if (typeof session.id === 'string') this.retire(session.id)
    })
  }

  isLive(id: string): boolean {
    return this.entries.has(id)
  }

  async warm(id: string, rawHeader: unknown): Promise<boolean> {
    if (this.disposed) return false
    const entry = this.entryOf(id, rawHeader)
    if (entry === undefined) return false
    this.ensureSeed(id, entry)
    await (entry.seed as Promise<void>)
    if (entry.state === null) return false
    this.flushEntry(id, entry)
    return true
  }

  private admit(id: string, rawHeader: unknown): void {
    if (!this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get()) {
      const header = asRecord(rawHeader)
      if (header === null) return
      const rows = admissionRows(this.ctx, [{ id, header, live: true }])
      admitRows(this.db, rows)
    }
  }

  private entryOf(id: string, rawHeader: unknown): LiveEntry | undefined {
    let entry = this.entries.get(id)
    if (entry !== undefined) {
      entry.touched = ++this.tick
      return entry
    }
    const header = asRecord(rawHeader)
    if (header === null) return undefined
    this.admit(id, header)
    entry = {
      header: header as unknown as SessionHeader,
      state: null,
      stateSeq: -1,
      buffer: [],
      seed: null,
      sink: new RowsSink(id, this.options.pluginOf, 0),
      timer: null,
      pendingRows: 0,
      touched: ++this.tick,
      writtenSeq: -2,
    }
    this.entries.set(id, entry)
    this.evict(id)
    return entry
  }

  private evict(keep: string): void {
    const max = this.options.entriesMax ?? LIVE_ENTRIES_MAX
    while (this.entries.size > max) {
      let oldest: string | undefined
      let oldestTick = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.entries) {
        if (id === keep || entry.seed !== null || entry.touched >= oldestTick) continue
        oldest = id
        oldestTick = entry.touched
      }
      if (oldest === undefined) return
      const entry = this.entries.get(oldest) as LiveEntry
      this.flushEntry(oldest, entry)
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.entries.delete(oldest)
    }
  }

  private advance(id: string, event: TimelineEvent, rawHeader: unknown): void {
    const entry = this.entryOf(id, rawHeader)
    if (entry === undefined) return
    if (entry.state === null) {
      if (entry.buffer.length >= (this.options.bufferMax ?? LIVE_BUFFER_MAX)) {
        entry.buffer = []
      }
      entry.buffer.push(event)
      this.ensureSeed(id, entry)
      return
    }
    const seq = seqOf(event)
    if (seq >= 0 && seq <= entry.stateSeq) return
    if (seq >= 0 && entry.stateSeq >= 0 && seq > entry.stateSeq + 1) {
      entry.state = null
      entry.stateSeq = -1
      entry.buffer = [event]
      entry.sink = new RowsSink(id, this.options.pluginOf, 0)
      this.ensureSeed(id, entry)
      return
    }
    const before = entry.sink.drainSize()
    entry.state = applyTimeline(entry.state, event, this.bounds, entry.sink)
    entry.stateSeq = Math.max(entry.stateSeq, seq)
    entry.pendingRows += Math.max(0, entry.sink.drainSize() - before)
    const flushNow = event.type === 'step/end' || event.type === 'turn/end'
      || event.type === 'session/end-seed'
    if (flushNow || entry.pendingRows >= (this.options.eventFlush ?? LIVE_EVENT_FLUSH)) {
      this.flushEntry(id, entry)
      return
    }
    this.schedule(id, entry)
  }

  private schedule(id: string, entry: LiveEntry): void {
    if (entry.timer !== null) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.flushEntry(id, entry)
    }, this.options.debounceMs ?? LIVE_DEBOUNCE_MS)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  private ensureSeed(id: string, entry: LiveEntry): void {
    if (entry.seed !== null) return
    entry.seed = this.seed(id, entry).finally(() => {
      entry.seed = null
    })
  }

  private async seed(id: string, entry: LiveEntry): Promise<void> {
    const observe = this.options.observe?.() ?? (this.ctx.get('sessionQuery') as ObserveFace | undefined)
    let events: TimelineEvent[] = []
    if (typeof observe?.observeSession === 'function') {
      try {
        const observation = asRecord(await observe.observeSession(id, { projectionMode: 'none' }))
        const raw = observation?.events
        if (Array.isArray(raw)) events = raw.filter(isEvent)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-context: live seed for "${id}" failed: ${String(error)}`)
      }
    }
    if (this.entries.get(id) !== entry) return
    const stored = this.db.select({ lastSeq: foldState.lastSeq, stateJson: foldState.stateJson })
      .from(foldState).where(eq(foldState.sessionId, id)).get()
    const base = stored === undefined ? null : decodeStateJson(stored.stateJson)
    if (base === null && events.length === 0) {
      entry.state = null
      return
    }
    let baseSeq = base !== null && stored !== undefined ? stored.lastSeq : -1
    let firstTail: number | undefined
    if (base !== null) {
      const first = events.find(event => seqOf(event) > baseSeq)
      if (first !== undefined) firstTail = seqOf(first)
    }
    const usableBase = base !== null && (firstTail === undefined || firstTail <= baseSeq + 1) ? base : null
    if (usableBase === null) baseSeq = -1
    let state = usableBase ?? createTimelineState()
    state.isSeeded =  entry.header.isSeeded
    if (usableBase === null) deleteSessionChildRows(this.db, id)
    const sink = new RowsSink(id, this.options.pluginOf, state.nextSpanSeq)
    const tail = events.filter(event => seqOf(event) > baseSeq)
    const folded = applyFoldEvents(this.db, id, state, tail, this.bounds, sink)
    state = folded.state
    let stateSeq = Math.max(baseSeq, folded.lastSeq)
    const buffered = entry.buffer.splice(0)
    for (const event of buffered) {
      const seq = seqOf(event)
      if (seq >= 0 && seq <= stateSeq) continue
      if (seq > stateSeq + 1) {
        entry.state = null
        entry.buffer = buffered.filter(candidate => seqOf(candidate) > stateSeq)
        return
      }
      state = applyTimeline(state, event, this.bounds, sink)
      stateSeq = Math.max(stateSeq, seq)
    }
    if (sink.drainSize() > 0) writeBatch(this.db, sink.take(), id)
    entry.state = state
    entry.stateSeq = stateSeq
    entry.sink = sink
    entry.pendingRows = 0
    this.flushEntry(id, entry)
  }

  flushEntry(id: string, entry: LiveEntry): void {
    if (entry.state === null) return
    const batch = entry.sink.take()
    const hasBatch = batch.headerEpochs.length + batch.requests.length + batch.steps.length + batch.toolCalls.length
      + batch.surfaces.length + batch.systems.length + batch.events.length + batch.fileOps.length
      + batch.skillLoads.length + batch.spans.length + batch.stepPatches.length + batch.requestPatches.length
      + batch.toolPatches.length + batch.eventPatches.length + batch.surfacePatches.length + batch.systemPatches.length > 0
    if (hasBatch) writeBatch(this.db, batch, id)
    if (hasBatch || entry.stateSeq !== entry.writtenSeq) {
      writeSessionFold(this.db, {
        sessionId: id,
        title: entry.header.id,
        cwd: typeof (entry.header as unknown as Record<string, unknown>).cwd === 'string'
          ? (entry.header as unknown as Record<string, unknown>).cwd as string
          : null,
        isSeeded:  entry.header.isSeeded,
        pluginOf: this.options.pluginOf,

      }, entry.state, entry.stateSeq, 'ok')
      bumpGeneration(this.db)
      entry.writtenSeq = entry.stateSeq
      entry.pendingRows = 0
      this.options.onFlush?.()
    }
  }

  private retire(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.flushEntry(id, entry)
    this.entries.delete(id)
  }

  flushAll(): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.flushEntry(id, entry)
    }
    this.entries.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.flushAll()
    this.disposed = true
    setMeta(this.db, 'clean_shutdown', '1')
  }
}

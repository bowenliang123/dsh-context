import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { type ColdReadGate } from './coldRead'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import { asRecord } from './record'
import type { TimelineEvent, TimelineState } from './foldState'

const FOLD_LOG_YIELD_EVENTS = 1_000

const SHADOW_ENTRIES_MAX = 8

const SHADOW_BUFFER_MAX = 512

interface SessionLike {
  id: unknown
}

interface ObserveFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

interface ShadowEntry {
  state: TimelineState | null
  stateSeq: number
  buffer: TimelineEvent[]
  seed: Promise<void> | null
  touched: number
}

function seqOf(event: unknown): number {
  return typeof (event as { seq?: unknown } | null)?.seq === 'number'
    ? (event as { seq: number }).seq
    : -1
}

function isEvent(event: unknown): event is TimelineEvent {
  return event !== null && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string'
}

export async function foldLog(
  events: readonly unknown[],
  bounds: FoldBounds,
  aborted?: () => boolean,
): Promise<{ state: TimelineState; lastSeq: number }> {
  let state = createTimelineState()
  let lastSeq = -1
  let folded = 0
  for (const raw of events) {
    if (isEvent(raw)) {
      state = applyTimeline(state, raw, bounds)
      lastSeq = Math.max(lastSeq, seqOf(raw))
    }
    if (++folded % FOLD_LOG_YIELD_EVENTS === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (aborted?.() === true) break
    }
  }
  return { state, lastSeq }
}

export class DetailShadow {
  private readonly entries = new Map<string, ShadowEntry>()
  private ticks = 0

  constructor(
    ctx: Context,
    private readonly bounds: FoldBounds,
    private readonly coldReads: ColdReadGate,
    private readonly observeOf: () => ((id: string, options: unknown) => Promise<unknown>) | undefined,
  ) {
    ctx.effect(() => () => {
      this.entries.clear()
    }, 'dsh-context.detailShadow')
    ctx.on('session/event', (session: SessionLike, event: unknown) => {
      if (typeof session.id !== 'string') return
      this.advance(session.id, event)
    })
    ctx.on('session/disposed', (session: SessionLike) => {
      if (typeof session.id === 'string') this.entries.delete(session.id)
    })
  }

  private advance(id: string, event: unknown): void {
    const entry = this.entries.get(id)
    if (entry === undefined || !isEvent(event)) return
    if (entry.state !== null) {
      const seq = seqOf(event)
      if (seq <= entry.stateSeq) return
      entry.state = applyTimeline(entry.state, event, this.bounds)
      entry.stateSeq = seq
      return
    }
    if (entry.buffer.length >= SHADOW_BUFFER_MAX) {
      this.entries.delete(id)
      return
    }
    entry.buffer.push(event)
  }

  async stateOf(id: string): Promise<TimelineState | null> {
    let entry = this.entries.get(id)
    if (entry === undefined) {
      entry = { state: null, buffer: [], seed: null, touched: this.ticks, stateSeq: -1 }
      this.entries.set(id, entry)
      entry.seed = this.seed(id, entry)
      this.evict(id)
    }
    entry.touched = ++this.ticks
    await entry.seed
    return this.entries.get(id) === entry ? entry.state : null
  }

  private evict(keep: string): void {
    while (this.entries.size > SHADOW_ENTRIES_MAX) {
      let oldest: string | undefined
      let oldestTick = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.entries) {
        if (id === keep || entry.state === null) continue
        if (entry.touched < oldestTick) {
          oldest = id
          oldestTick = entry.touched
        }
      }
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }

  private async seed(id: string, entry: ShadowEntry): Promise<void> {
    try {
      const observe = this.observeOf()
      if (observe === undefined) {
        this.entries.delete(id)
        return
      }
      const observation = await this.coldReads.admit(() => observe(id, { projectionMode: 'none' }))
      if (this.entries.get(id) !== entry) return
      if (observation === undefined) {
        this.entries.delete(id)
        return
      }
      const events = asRecord(observation)?.events
      if (!Array.isArray(events)) {
        this.entries.delete(id)
        return
      }
      const folded = await foldLog(events, this.bounds, () => this.entries.get(id) !== entry)
      if (this.entries.get(id) !== entry) return
      let { state, lastSeq } = folded
      for (const raw of entry.buffer) {
        const seq = seqOf(raw)
        if (seq <= lastSeq) continue
        state = applyTimeline(state, raw, this.bounds)
        lastSeq = seq
      }
      entry.state = state
      entry.stateSeq = lastSeq
      entry.buffer = []
    } catch (error: unknown) {
      this.entries.delete(id)
      throw error
    }
  }
}

export function observeFaceOf(ctx: Context): ((id: string, options: unknown) => Promise<unknown>) | undefined {
  const query = ctx.get('sessionQuery') as ObserveFace | undefined
  const observe = typeof query?.observeSession === 'function' ? query.observeSession.bind(query) : undefined
  return observe !== undefined ? (id, options) => observe(id, options) : undefined
}

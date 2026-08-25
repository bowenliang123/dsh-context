// A faithful in-memory implementation of the harness client context the
// plugin's `apply` consumes. Every member implements the DOCUMENTED contract
// (cordis effect/inject semantics, locale fallback chain, slot registry,
// sessions provide channel) rather than a test-specific stub — registrations
// and disposals behave the way the real harness's do, so specs assert through
// the same seams the production runtime uses.

import type { ClientCtx, LocaleService, SessionProvideDescriptorLike, SlotRegistration, SlotsService } from '../../../src/client/services'
import { makeTranslate } from './kit'

export interface SlotEntry {
  registration: SlotRegistration
  component: (props: { sessionId?: string } & Record<string, unknown>) => unknown
}

export class TestSlots implements SlotsService {
  readonly entries: SlotEntry[] = []

  inject(_name: string, callback: () => unknown): unknown {
    // slots.inject is a declaration injection riding the caller's effect:
    // the callback runs synchronously and returns the register() disposer.
    return callback()
  }

  register(registration: SlotRegistration, component: (props: { sessionId?: string } & Record<string, unknown>) => unknown): unknown {
    const entry: SlotEntry = { registration, component }
    this.entries.push(entry)
    return () => {
      const i = this.entries.indexOf(entry)
      if (i >= 0) this.entries.splice(i, 1)
    }
  }

  /** Every registration for a slot name (list slots keep several). */
  of(name: string): SlotEntry[] {
    return this.entries.filter(e => e.registration.name === name)
  }
}

export class TestLocale implements LocaleService {
  readonly namespaces = new Map<string, Record<string, Record<string, string>>>()

  constructor(readonly active = 'en') {}

  register(ns: string, dicts: Record<string, Record<string, string>>): () => void {
    this.namespaces.set(ns, dicts)
    return () => {
      this.namespaces.delete(ns)
    }
  }

  bind(ns: string): (key: string, params?: Record<string, string | number>) => string {
    return makeTranslate(this.active as 'en' | 'zh', this.namespaces.get(ns))
  }

  getLocale(): { active: string } {
    return { active: this.active }
  }
}

export interface TestClientCtxOptions {
  locale?: 'en' | 'zh'
  services?: Record<string, unknown>
}

/**
 * A client ctx with cordis semantics: `inject` runs its callback once every
 * requested service exists (services are armed via options.services or
 * setService — arming later replays pending callbacks, like cordis), and
 * `effect` collects disposers that `dispose()` runs LIFO.
 */
export class TestClientCtx {
  readonly slots = new TestSlots()
  readonly locale: TestLocale
  private readonly services = new Map<string, unknown>()
  private readonly pending: { deps: string[]; cb: (ctx: TestClientCtx) => void }[] = []
  private readonly disposers: (() => void)[] = []

  constructor(options: TestClientCtxOptions = {}) {
    this.locale = new TestLocale(options.locale ?? 'en')
    for (const [k, v] of Object.entries(options.services ?? {})) this.setService(k, v)
  }

  get(name: string): unknown {
    return this.services.get(name)
  }

  setService(name: string, service: unknown): void {
    this.services.set(name, service)
    // Cordis surfaces services as context properties (ctx.settingsScope …).
    if (!(name in this)) {
      Object.defineProperty(this, name, { get: () => this.services.get(name), configurable: true })
    }
    // Cordis replays waiting injects once their dependency list completes.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.deps.every(d => this.services.has(d))) {
        this.pending.splice(i, 1)
        p.cb(this)
      }
    }
  }

  inject(deps: string[] | Record<string, unknown>, cb: (ctx: TestClientCtx) => void): void {
    const list = Array.isArray(deps) ? deps : Object.keys(deps)
    if (list.every(d => this.services.has(d))) cb(this)
    else this.pending.push({ deps: list, cb })
  }

  effect(fn: () => (() => void) | void, _label?: string): () => void {
    const dispose = fn()
    const d = typeof dispose === 'function' ? dispose : () => {}
    this.disposers.push(d)
    return d
  }

  dispose(): void {
    while (this.disposers.length > 0) this.disposers.pop()?.()
  }
}

export function asClientCtx(ctx: TestClientCtx): ClientCtx {
  return ctx as unknown as ClientCtx
}

/** A real sessions face with the documented provide/scope contract. */
export class TestSessions {
  readonly provided: SessionProvideDescriptorLike[] = []
  readonly bails: { scope: unknown; event: string; payload: unknown }[] = []

  provide(descriptor: SessionProvideDescriptorLike): () => void {
    this.provided.push(descriptor)
    return () => {
      const i = this.provided.indexOf(descriptor)
      if (i >= 0) this.provided.splice(i, 1)
    }
  }

  scope(_id: string): { bail(subject: unknown, event: string, payload: unknown): boolean } | undefined {
    return {
      bail: (subject, event, payload) => {
        this.bails.push({ scope: subject, event, payload })
        return true
      },
    }
  }
}

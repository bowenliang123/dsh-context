import type { ClientCtx, LocaleService, SlotRegistration, SlotsService } from '../../../src/client/services'
import { makeTranslate } from './kit'

export interface SlotEntry {
  registration: SlotRegistration
  component: (props: { sessionId?: string } & Record<string, unknown>) => unknown
}

export class TestSlots implements SlotsService {
  readonly seated: SlotEntry[] = []

  inject(_name: string, callback: () => unknown): unknown {
    return callback()
  }

  register(registration: SlotRegistration, component: (props: { sessionId?: string } & Record<string, unknown>) => unknown): unknown {
    const entry: SlotEntry = { registration, component }
    this.seated.push(entry)
    return () => {
      const i = this.seated.indexOf(entry)
      if (i >= 0) this.seated.splice(i, 1)
    }
  }

  entries(name: string): {
    component: SlotEntry['component']
    options: { key?: string; id?: string; order?: number; priority?: number }
    locale?: string
  }[] {
    return this.of(name).map(e => ({
      component: e.component,
      options: {
        ...(e.registration.key !== undefined ? { key: e.registration.key } : {}),
        ...(e.registration.id !== undefined ? { id: e.registration.id } : {}),
        ...(e.registration.order !== undefined ? { order: e.registration.order } : {}),
      },
      ...(e.registration.locale !== undefined ? { locale: e.registration.locale } : {}),
    }))
  }

  of(name: string): SlotEntry[] {
    return this.seated.filter(e => e.registration.name === name)
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
    return makeTranslate(this.active, this.namespaces.get(ns))
  }

  getLocale(): { active: string } {
    return { active: this.active }
  }
}

export interface TestClientCtxOptions {
  locale?: string
  services?: Record<string, unknown>
}

export class TestClientCtx {
  readonly slots = new TestSlots()
  readonly locale: TestLocale
  private readonly services = new Map<string, unknown>()
  private readonly pending: { deps: string[]; cb: (ctx: TestClientCtx) => (() => void) | void }[] = []
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
    if (!(name in this)) {
      Object.defineProperty(this, name, { get: () => this.services.get(name), configurable: true })
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]
      if (p.deps.every(d => this.services.has(d))) {
        this.pending.splice(i, 1)
        p.cb(this)
      }
    }
  }

  inject(deps: string[] | Record<string, unknown>, cb: (ctx: TestClientCtx) => (() => void) | void): { dispose: () => Promise<void> } {
    const list = Array.isArray(deps) ? deps : Object.keys(deps)
    let ran = false
    let disposed = false
    let retired = false
    let inner: (() => void) | undefined
    const fiber = {
      dispose: async () => {
        if (disposed) return
        disposed = true
        const i = this.pending.findIndex(p => p.cb === wrapped)
        if (i >= 0) {
          this.pending.splice(i, 1)
          return
        }
        if (ran && inner !== undefined && !retired) {
          inner()
        }
      },
    }
    const wrapped = (ctx: TestClientCtx): void => {
      ran = true
      const dispose = cb(ctx)
      if (typeof dispose === 'function') {
        inner = () => {
          if (retired) return
          retired = true
          dispose()
        }
        this.disposers.push(inner)
      }
    }
    if (list.every(d => this.services.has(d))) wrapped(this)
    else this.pending.push({ deps: list, cb: wrapped })
    return fiber
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

export class TestSessions {
  readonly bails: { scope: unknown; event: string; payload: unknown }[] = []

  scope(_id: string): { bail(subject: unknown, event: string, payload: unknown): boolean } | undefined {
    return {
      bail: (subject, event, payload) => {
        this.bails.push({ scope: subject, event, payload })
        return true
      },
    }
  }
}

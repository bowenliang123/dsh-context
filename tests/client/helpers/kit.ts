// Client test kit: real dictionaries, real React rendering, and a faithful harness-context implementation
// (the documented cordis/locale/slots contracts, not mocks of plugin code), shared by every client spec.

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import type { Translate } from '../../../src/client/i18n'
import { makeViewKit, type ViewKit } from '../../../src/client/viewkit'
import type { SurfaceNode } from '../../../src/shared/types'

/** A user-category surface node fixture with a non-trivial token figure — the card specs' shared shape. */
export function surfaceNode(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

/** A minimal user-category surface node fixture, seq first — the assemble/brief specs' shared shape. */
export function surfaceNodeAt(seq: number, over: Partial<SurfaceNode> = {}): SurfaceNode {
  return { seq, cat: 'user', tokens: 1, ...over }
}

/** The harness locale chain: active-locale dictionary → en → the key itself,
 * with `{name}` interpolation. Built over the plugin's REAL dictionaries, so
 * assertions exercise the shipped strings rather than a test copy. */
export function makeTranslate(active: 'en' | 'zh' = 'en', dicts?: Record<string, Record<string, string>>): Translate {
  const table: Record<string, Record<string, string>> = dicts ?? { zh: DICT_ZH, en: DICT_EN }
  return (key, params) => {
    let s = table[active]?.[key] ?? table.en[key] ?? key
    if (params) for (const k in params) s = s.replace('{' + k + '}', String(params[k]))
    return s
  }
}

export function makeKit(active: 'en' | 'zh' = 'en'): ViewKit {
  return makeViewKit(makeTranslate(active))
}

export interface Mounted {
  container: HTMLElement
  root: Root
  update(el: ReactElement): Promise<void>
  unmount(): Promise<void>
}

/** Mount a real React tree in jsdom, effects flushed through act. */
export async function mount(el: ReactElement): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(el)
  })
  return {
    container,
    root,
    async update(next) {
      await act(async () => {
        root.render(next)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Flush pending promises/effects (image loads, deferred setState). */
export async function flush(): Promise<void> {
  await act(async () => {})
}

/** Poll until the predicate holds, one short act() scope per tick: timers and
 * promise chains only get to run while a scope's sleep is awaiting, so the
 * state updates they land are act-attributed (no React act() warnings) and
 * committed when the scope exits — the check between ticks sees them. Real
 * timers ride the store's own debounce; `message` labels the give-up failure. */
export async function until(fn: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await act(async () => {
      if (fn()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    if (fn()) return
  }
  throw new Error(message)
}

/** Silence a deliberately-thrown render error: React 18 dev replays a failed
 * render through a fake DOM event, which jsdom reports as an uncaught window
 * error and vitest forwards to an uncaughtException — a user error listener
 * that prevents the default keeps the throw inside the test. Returns the cleanup that restores normal error reporting. */
export function silenceWindowErrors(): () => void {
  const onError = (e: Event) => { e.preventDefault() }
  window.addEventListener('error', onError)
  return () => { window.removeEventListener('error', onError) }
}

export function text(container: HTMLElement): string {
  return container.textContent ?? ''
}

export function query<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const el = container.querySelector<T>(selector)
  if (el === null) throw new Error(`element not found: ${selector}`)
  return el
}

export function queryAll<T extends Element = HTMLElement>(container: ParentNode, selector: string): T[] {
  return [...container.querySelectorAll<T>(selector)]
}

/** Click through act so React processes the dispatch synchronously. */
export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

/** Pointer hover. React 18 synthesizes onMouseEnter/onMouseLeave from the
 * BUBBLING mouseover/mouseout pair — dispatching raw mouseenter/leave (they do not bubble) never reaches React's handlers. */
export async function hover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

export async function unhover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
}

/** Keyboard focus. React synthesizes onFocus/onBlur from the BUBBLING focusin/focusout pair. */
export async function focus(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

export async function blur(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

export async function keydown(key: string, target: HTMLElement | Window = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** Dispatch a real wheel gesture on an element and report whether a listener canceled it. */
export function wheel(el: Element, deltaX: number, deltaY: number): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

export type { ReactElement, ReactNode }

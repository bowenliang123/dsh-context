// Client test kit: real dictionaries, real React rendering, and a faithful
// harness-context implementation (the documented cordis/locale/slots
// contracts, not mocks of plugin code). Shared by every client spec so each
// test file stays small and stateless.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement, ReactNode } from 'react'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import type { Translate } from '../../../src/client/i18n'
import { makeViewKit, type ViewKit } from '../../../src/client/viewkit'

/**
 * The harness locale chain: active-locale dictionary → en → the key itself,
 * with `{name}` interpolation. Built over the plugin's REAL dictionaries, so
 * assertions exercise the shipped strings rather than a test copy.
 */
export function makeTranslate(active: 'en' | 'zh' = 'en', dicts?: Record<string, Record<string, string>>): Translate {
  const table = dicts ?? { zh: DICT_ZH, en: DICT_EN }
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
  /** Re-render with new props (act-wrapped). */
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

/**
 * Pointer hover. React 18 synthesizes onMouseEnter/onMouseLeave from the
 * BUBBLING mouseover/mouseout pair — dispatching raw mouseenter/leave (they
 * do not bubble) never reaches React's handlers.
 */
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

/** Dispatch a real keydown (Escape etc.) on window, act-wrapped. */
export async function keydown(key: string, target: HTMLElement | Window = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

export type { ReactElement, ReactNode }

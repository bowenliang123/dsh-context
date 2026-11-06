import { afterEach } from 'vitest'
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DICTS } from '../../../src/client/i18n'
import type { Translate } from '../../../src/client/i18n'
import { makeViewKit, type ViewKit } from '../../../src/client/viewkit'
import type { SurfaceNode } from '../../../src/shared/types'

export function surfaceNode(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

export function surfaceNodeAt(seq: number, over: Partial<SurfaceNode> = {}): SurfaceNode {
  return { seq, cat: 'user', tokens: 1, ...over }
}

export function makeTranslate(active = 'en', dicts: Record<string, Record<string, string>> = DICTS): Translate {
  return (key, params) => {
    let s = dicts[active]?.[key] ?? dicts.en[key] ?? key
    if (params) for (const k in params) s = s.replace('{' + k + '}', String(params[k]))
    return s
  }
}

export function makeKit(active = 'en'): ViewKit {
  return makeViewKit(makeTranslate(active))
}

export interface Mounted {
  container: HTMLElement
  root: Root
  update(el: ReactElement): Promise<void>
  unmount(): Promise<void>
}

const mounted = new Set<Mounted>()

export async function cleanupMounts(): Promise<void> {
  for (const m of [...mounted]) await m.unmount()
}

afterEach(cleanupMounts)

export async function mount(el: ReactElement): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(el)
  })
  const handle: Mounted = {
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
      mounted.delete(handle)
    },
  }
  mounted.add(handle)
  return handle
}

export function pinScroll(el: HTMLElement, initial = 0): void {
  let value = initial
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next },
  })
}

export async function flush(): Promise<void> {
  await act(async () => {})
}

export async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

export async function fireScroll(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new Event('scroll'))
  })
}

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

export function silenceWindowErrors(): () => void {
  const onError = (e: Event) => { e.preventDefault() }
  window.addEventListener('error', onError)
  return () => { window.removeEventListener('error', onError) }
}

export function text(container: HTMLElement): string {
  return container.textContent ?? ''
}

export function tipRows(tip: HTMLElement): (string | null)[] {
  return ['.lc-bar-tip-head', '.lc-bar-tip-fig', '.lc-bar-tip-note']
    .map(sel => tip.querySelector<HTMLElement>(sel)?.textContent ?? null)
}

export function query<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const el = container.querySelector<T>(selector)
  if (el === null) throw new Error(`element not found: ${selector}`)
  return el
}

export function queryAll<T extends Element = HTMLElement>(container: ParentNode, selector: string): T[] {
  return [...container.querySelectorAll<T>(selector)]
}

export function pinRect(el: Element, width: number, height = 0): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
  })
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

export async function typeText(el: HTMLTextAreaElement | HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

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

export async function press(
  target: HTMLElement,
  init: KeyboardEventInit,
): Promise<{ ev: KeyboardEvent; reachedDocument: boolean }> {
  let reachedDocument = false
  const listener = (): void => { reachedDocument = true }
  document.addEventListener('keydown', listener)
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  try {
    await act(async () => { target.dispatchEvent(ev) })
  } finally {
    document.removeEventListener('keydown', listener)
  }
  return { ev, reachedDocument }
}

export function wheel(el: Element, deltaX: number, deltaY: number): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

export type { ReactElement, ReactNode }

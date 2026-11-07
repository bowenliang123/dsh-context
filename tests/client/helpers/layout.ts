import { vi } from 'vitest'

interface Size {
  width?: number
  height?: number
}

interface RectConfig {
  selector: string
  heightOf: (index: number) => number
  gap: number
  width: number
}

interface ListRectConfig {
  className: string
  width: number
  height: number
}

const realRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as () => DOMRect

let sizes: Record<string, Size> = {}
let rectConfig: RectConfig | null = null
let listRectConfig: ListRectConfig | null = null
const saved: [string, PropertyDescriptor | undefined][] = []
let installed = false

function makeRect(top: number, width: number, height: number): DOMRect {
  return {
    top, y: top, bottom: top + height, left: 0, x: 0, right: width, width, height, toJSON: () => ({}),
  } as DOMRect
}

function sizeOf(el: HTMLElement, axis: keyof Size): number | undefined {
  for (const cls of Object.keys(sizes)) {
    if (!el.classList.contains(cls)) continue
    const value = sizes[cls][axis]
    if (value !== undefined) return value
  }
  return undefined
}

function metricOf(el: HTMLElement, name: 'clientWidth' | 'clientHeight'): number {
  const own = sizeOf(el, name === 'clientWidth' ? 'width' : 'height')
  if (own !== undefined) return own
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name)
  return descriptor?.get === undefined ? 0 : Number(descriptor.get.call(el))
}

function rectFor(el: HTMLElement): DOMRect | null {
  if (listRectConfig !== null && el.classList.contains(listRectConfig.className)) {
    return makeRect(0, listRectConfig.width, listRectConfig.height)
  }
  if (rectConfig === null || !el.classList.contains(rectConfig.selector)) return null
  const parent = el.parentElement
  const siblings = parent === null
    ? [el]
    : ([...parent.children].filter(child => child instanceof HTMLElement && child.classList.contains(rectConfig!.selector)) as HTMLElement[])
  const index = Math.max(0, siblings.indexOf(el))
  let top = 0
  for (let i = 0; i < index; i++) top += rectConfig.heightOf(i) + rectConfig.gap
  return makeRect(top, rectConfig.width, rectConfig.heightOf(index))
}

function install(): void {
  if (installed) return
  installed = true
  for (const name of ['clientWidth', 'clientHeight'] as const) {
    saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement): number {
        return metricOf(this, name)
      },
    })
  }
  saved.push(['getBoundingClientRect', Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')])
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      return rectFor(this) ?? realRect.call(this)
    },
  })
}

export function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe = (): void => {}
    unobserve = (): void => {}
    disconnect = (): void => {}
  })
}

export function stubClientSizes(next: Record<string, Size>): void {
  install()
  sizes = { ...sizes, ...next }
}

export function stubRowRects(selector: string, heightOf: (index: number) => number, gap: number, width = 500): void {
  install()
  rectConfig = { selector, heightOf, gap, width }
}

export function stubListRect(className: string, width: number, height: number): void {
  install()
  listRectConfig = { className, width, height }
}

export function restoreLayout(): void {
  if (!installed) return
  for (let i = saved.length - 1; i >= 0; i--) {
    const [name, descriptor] = saved[i]
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, descriptor)
  }
  saved.length = 0
  installed = false
  sizes = {}
  rectConfig = null
  listRectConfig = null
}
